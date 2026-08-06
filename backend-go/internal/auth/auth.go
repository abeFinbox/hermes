// Package auth ports backend/src/auth.ts: svg-captcha login, JWT cookie
// sessions, and admin user management. The cookie name, JWT claims and secret
// match the Node backend exactly so a token minted by either validates on both.
package auth

import (
	"context"
	"crypto/rand"
	"database/sql"
	"math/big"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/store"
	"github.com/finbox/hermes/backend-go/internal/web"
	"github.com/go-chi/chi/v5"
	"github.com/golang-jwt/jwt/v5"
	"golang.org/x/crypto/bcrypt"
)

const (
	cookieName    = "ats_token"
	captchaTTL    = 5 * time.Minute
	sessionMaxAge = 12 * time.Hour
)

type User struct {
	ID       string `json:"id"`
	Username string `json:"username"`
	IsAdmin  bool   `json:"isAdmin"`
	Role     string `json:"role"` // admin | moderator | npc
}

var validRoles = map[string]bool{"admin": true, "moderator": true, "npc": true}

// roleOr derives a role from a possibly-empty stored value, falling back via
// the legacy is_admin flag (for rows/tokens predating the role column).
func roleOr(role string, isAdmin bool) string {
	if validRoles[role] {
		return role
	}
	if isAdmin {
		return "admin"
	}
	return "moderator"
}

type ctxKey string

const userKey ctxKey = "user"

// ---- captcha store (in-memory, single-use) ----

type captchaEntry struct {
	text    string
	expires time.Time
}

var (
	captchaMu sync.Mutex
	captchas  = map[string]captchaEntry{}
)

// ---- naive per-IP rate limit: 10 attempts / minute ----

var (
	attemptsMu sync.Mutex
	attempts   = map[string][]time.Time{}
)

func rateLimited(ip string) bool {
	attemptsMu.Lock()
	defer attemptsMu.Unlock()
	now := time.Now()
	kept := attempts[ip][:0]
	for _, t := range attempts[ip] {
		if now.Sub(t) < time.Minute {
			kept = append(kept, t)
		}
	}
	kept = append(kept, now)
	attempts[ip] = kept
	return len(kept) > 10
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	host := r.RemoteAddr
	if i := strings.LastIndex(host, ":"); i >= 0 {
		host = host[:i]
	}
	if host == "" {
		return "unknown"
	}
	return host
}

// ---- JWT ----

func signToken(u User) (string, error) {
	claims := jwt.MapClaims{
		"sub":      u.ID,
		"username": u.Username,
		"isAdmin":  u.IsAdmin,
		"role":     u.Role,
		"exp":      time.Now().Add(sessionMaxAge).Unix(),
	}
	return jwt.NewWithClaims(jwt.SigningMethodHS256, claims).SignedString([]byte(store.JWTSecret))
}

func parseToken(tok string) (*User, error) {
	parsed, err := jwt.Parse(tok, func(t *jwt.Token) (interface{}, error) {
		return []byte(store.JWTSecret), nil
	}, jwt.WithValidMethods([]string{"HS256"}))
	if err != nil || !parsed.Valid {
		return nil, err
	}
	claims, ok := parsed.Claims.(jwt.MapClaims)
	if !ok {
		return nil, jwt.ErrTokenInvalidClaims
	}
	u := &User{}
	if v, ok := claims["sub"].(string); ok {
		u.ID = v
	}
	if v, ok := claims["username"].(string); ok {
		u.Username = v
	}
	if v, ok := claims["isAdmin"].(bool); ok {
		u.IsAdmin = v
	}
	role, _ := claims["role"].(string)
	u.Role = roleOr(role, u.IsAdmin) // tokens predating roles carry only isAdmin
	u.IsAdmin = u.Role == "admin"
	return u, nil
}

// RequireAuth is middleware that rejects requests without a valid session.
func RequireAuth(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		c, err := r.Cookie(cookieName)
		if err != nil || c.Value == "" {
			web.Err(w, http.StatusUnauthorized, "Not authenticated")
			return
		}
		u, err := parseToken(c.Value)
		if err != nil || u == nil {
			web.Err(w, http.StatusUnauthorized, "Session expired")
			return
		}
		next.ServeHTTP(w, r.WithContext(withUser(r, u)))
	})
}

func requireAdmin(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFrom(r)
		if u == nil || u.Role != "admin" {
			web.Err(w, http.StatusForbidden, "Admin only")
			return
		}
		next.ServeHTTP(w, r)
	})
}

// EnforcePermissions is role-based middleware for the data API. It matches the
// Node enforcePermissions() exactly, but against the FULL request path
// (e.g. "/api/suites/123") since chi middleware runs before route mounting.
//   - GET always allowed, except Docs are hidden from npc.
//   - Suite/run execution allowed for every role (npc = read-only + execute).
//   - DELETE is admin-only; other writes need admin or moderator.
func EnforcePermissions(next http.Handler) http.Handler {
	execRe := regexp.MustCompile(`^/api/runs/[^/]+/(stop|report)$`)
	heraStopRe := regexp.MustCompile(`^/api/hera/[^/]+/stop$`)
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		u := UserFrom(r)
		if u == nil {
			web.Err(w, http.StatusUnauthorized, "Not authenticated")
			return
		}
		role, m, p := u.Role, r.Method, r.URL.Path

		if m == http.MethodGet {
			if strings.HasPrefix(p, "/api/docs") && role == "npc" {
				web.Err(w, http.StatusForbidden, "Your role does not have access to the docs")
				return
			}
			next.ServeHTTP(w, r)
			return
		}

		// NOTE ON HERA: only the STOP route is listed. Stopping is a safety
		// action, so every role including read-only npc must be able to hit the
		// brakes. Starting a load test is deliberately NOT here — it is gated to
		// admin (or moderator with HERA_ALLOW_MODERATOR=1) inside
		// server/hera_routes.go. Do not "fix" this by pattern-matching the
		// /api/runs entries above.
		isExecute := (p == "/api/runs" && m == http.MethodPost) ||
			(p == "/api/runs/step" && m == http.MethodPost) ||
			(execRe.MatchString(p) && m == http.MethodPost) ||
			(heraStopRe.MatchString(p) && m == http.MethodPost)
		if isExecute {
			next.ServeHTTP(w, r)
			return
		}

		if m == http.MethodDelete {
			if role == "admin" {
				next.ServeHTTP(w, r)
				return
			}
			web.Err(w, http.StatusForbidden, "Your role cannot delete items")
			return
		}

		if role == "admin" || role == "moderator" {
			next.ServeHTTP(w, r)
			return
		}
		web.Err(w, http.StatusForbidden, "Your role has read-only access")
	})
}

func withUser(r *http.Request, u *User) context.Context {
	return context.WithValue(r.Context(), userKey, u)
}

// UserFrom returns the authenticated user attached by RequireAuth, or nil.
func UserFrom(r *http.Request) *User {
	u, _ := r.Context().Value(userKey).(*User)
	return u
}

func newUUID() string { return model.NewID() }

// ---- routers ----

// Router builds /api/auth.
func Router() chi.Router {
	r := chi.NewRouter()
	r.Get("/captcha", captchaHandler)
	r.Get("/captcha-required", captchaRequiredHandler)
	r.Post("/login", loginHandler)
	r.Post("/logout", logoutHandler)
	r.With(RequireAuth).Get("/me", meHandler)
	r.With(RequireAuth).Post("/change-password", changePasswordHandler)
	return r
}

// UsersRouter builds /api/users (admin only).
func UsersRouter() chi.Router {
	r := chi.NewRouter()
	r.Use(RequireAuth, requireAdmin)
	r.Get("/", listUsers)
	r.Post("/", createUser)
	r.Patch("/{id}", patchUser)
	r.Delete("/{id}", deleteUser)
	return r
}

// captchaRequiredHandler lets the login form hide the captcha for allowlisted
// accounts. required:false only for an existing captcha-exempt user.
func captchaRequiredHandler(w http.ResponseWriter, r *http.Request) {
	required := true
	if username := r.URL.Query().Get("username"); username != "" {
		var exempt int
		if err := store.DB.QueryRow("SELECT captcha_exempt FROM users WHERE username = ?", username).Scan(&exempt); err == nil && exempt != 0 {
			required = false
		}
	}
	web.JSON(w, http.StatusOK, map[string]bool{"required": required})
}

func captchaHandler(w http.ResponseWriter, r *http.Request) {
	text := randomCaptchaText(5)
	id := newUUID()
	captchaMu.Lock()
	captchas[id] = captchaEntry{text: strings.ToLower(text), expires: time.Now().Add(captchaTTL)}
	pruneCaptchas()
	captchaMu.Unlock()
	web.JSON(w, http.StatusOK, map[string]string{"id": id, "svg": captchaSVG(text)})
}

func pruneCaptchas() {
	now := time.Now()
	for id, c := range captchas {
		if c.expires.Before(now) {
			delete(captchas, id)
		}
	}
}

type loginReq struct {
	Username    string `json:"username"`
	Password    string `json:"password"`
	CaptchaID   string `json:"captchaId"`
	CaptchaText string `json:"captchaText"`
}

func loginHandler(w http.ResponseWriter, r *http.Request) {
	if rateLimited(clientIP(r)) {
		web.Err(w, http.StatusTooManyRequests, "Too many attempts, wait a minute")
		return
	}
	var req loginReq
	if err := web.Decode(r, &req); err != nil {
		web.Err(w, http.StatusBadRequest, "Invalid request body")
		return
	}
	if req.Username == "" || req.Password == "" {
		web.Err(w, http.StatusBadRequest, "username and password are required")
		return
	}

	var (
		id, username, hash string
		isAdmin            int
		role               string
		captchaExempt      int
	)
	err := store.DB.QueryRow("SELECT id, username, password_hash, is_admin, role, captcha_exempt FROM users WHERE username = ?", req.Username).
		Scan(&id, &username, &hash, &isAdmin, &role, &captchaExempt)
	userExists := err != sql.ErrNoRows
	if err != nil && err != sql.ErrNoRows {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}

	// Skip the captcha for allowlisted accounts (captcha_exempt) or the dev-only
	// CAPTCHA_BYPASS. Rate limiting and password auth still apply.
	bypass := os.Getenv("CAPTCHA_BYPASS") == "1" && req.CaptchaText == "bypass"
	exempt := (userExists && captchaExempt != 0) || bypass
	if !exempt {
		if req.CaptchaID == "" || req.CaptchaText == "" {
			web.Err(w, http.StatusBadRequest, "captcha is required")
			return
		}
		captchaMu.Lock()
		entry, ok := captchas[req.CaptchaID]
		delete(captchas, req.CaptchaID) // single use
		captchaMu.Unlock()
		if !ok || entry.expires.Before(time.Now()) || entry.text != strings.ToLower(strings.TrimSpace(req.CaptchaText)) {
			web.Err(w, http.StatusBadRequest, "Captcha incorrect or expired", map[string]interface{}{"captchaFailed": true})
			return
		}
	}

	if !userExists || bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.Password)) != nil {
		web.Err(w, http.StatusUnauthorized, "Invalid username or password")
		return
	}

	r2 := roleOr(role, isAdmin != 0)
	u := User{ID: id, Username: username, IsAdmin: r2 == "admin", Role: r2}
	tok, err := signToken(u)
	if err != nil {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	http.SetCookie(w, &http.Cookie{
		Name: cookieName, Value: tok, Path: "/", HttpOnly: true,
		SameSite: http.SameSiteLaxMode, MaxAge: int(sessionMaxAge.Seconds()),
	})
	web.JSON(w, http.StatusOK, u)
}

func logoutHandler(w http.ResponseWriter, r *http.Request) {
	http.SetCookie(w, &http.Cookie{Name: cookieName, Value: "", Path: "/", MaxAge: -1})
	web.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func meHandler(w http.ResponseWriter, r *http.Request) {
	web.JSON(w, http.StatusOK, UserFrom(r))
}

type changePasswordReq struct {
	CurrentPassword string `json:"currentPassword"`
	NewPassword     string `json:"newPassword"`
}

func changePasswordHandler(w http.ResponseWriter, r *http.Request) {
	var req changePasswordReq
	_ = web.Decode(r, &req)
	if req.CurrentPassword == "" || req.NewPassword == "" {
		web.Err(w, http.StatusBadRequest, "Both passwords required")
		return
	}
	if len(req.NewPassword) < 6 {
		web.Err(w, http.StatusBadRequest, "New password must be at least 6 characters")
		return
	}
	u := UserFrom(r)
	var hash string
	if err := store.DB.QueryRow("SELECT password_hash FROM users WHERE id = ?", u.ID).Scan(&hash); err != nil ||
		bcrypt.CompareHashAndPassword([]byte(hash), []byte(req.CurrentPassword)) != nil {
		web.Err(w, http.StatusBadRequest, "Current password is incorrect")
		return
	}
	newHash, _ := bcrypt.GenerateFromPassword([]byte(req.NewPassword), 10)
	if _, err := store.DB.Exec("UPDATE users SET password_hash = ? WHERE id = ?", string(newHash), u.ID); err != nil {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	web.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func listUsers(w http.ResponseWriter, r *http.Request) {
	rows, err := store.DB.Query("SELECT id, username, is_admin, role, captcha_exempt, created_at FROM users ORDER BY created_at")
	if err != nil {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	defer rows.Close()
	out := []map[string]interface{}{}
	for rows.Next() {
		var id, username, createdAt, role string
		var isAdmin, captchaExempt int
		if err := rows.Scan(&id, &username, &isAdmin, &role, &captchaExempt, &createdAt); err != nil {
			web.Err(w, http.StatusInternalServerError, err.Error())
			return
		}
		r2 := roleOr(role, isAdmin != 0)
		out = append(out, map[string]interface{}{"id": id, "username": username, "role": r2, "isAdmin": r2 == "admin", "captchaExempt": captchaExempt != 0, "createdAt": createdAt})
	}
	web.JSON(w, http.StatusOK, out)
}

type createUserReq struct {
	Username      string `json:"username"`
	Password      string `json:"password"`
	Role          string `json:"role"`
	CaptchaExempt bool   `json:"captchaExempt"`
}

func createUser(w http.ResponseWriter, r *http.Request) {
	var req createUserReq
	_ = web.Decode(r, &req)
	if req.Username == "" || req.Password == "" {
		web.Err(w, http.StatusBadRequest, "username and password required")
		return
	}
	if len(req.Password) < 6 {
		web.Err(w, http.StatusBadRequest, "Password must be at least 6 characters")
		return
	}
	role := req.Role
	if !validRoles[role] {
		role = "moderator"
	}
	var dummy int
	if err := store.DB.QueryRow("SELECT 1 FROM users WHERE username = ?", req.Username).Scan(&dummy); err != sql.ErrNoRows {
		web.Err(w, http.StatusConflict, "Username already exists")
		return
	}
	id := newUUID()
	admin := 0
	if role == "admin" {
		admin = 1
	}
	exempt := 0
	if req.CaptchaExempt {
		exempt = 1
	}
	hash, _ := bcrypt.GenerateFromPassword([]byte(req.Password), 10)
	if _, err := store.DB.Exec(
		"INSERT INTO users (id, username, password_hash, is_admin, role, captcha_exempt, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
		id, req.Username, string(hash), admin, role, exempt, time.Now().UTC().Format(time.RFC3339Nano),
	); err != nil {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	web.JSON(w, http.StatusCreated, map[string]interface{}{"id": id, "username": req.Username, "role": role, "isAdmin": role == "admin", "captchaExempt": req.CaptchaExempt})
}

type patchUserReq struct {
	CaptchaExempt *bool   `json:"captchaExempt"`
	Role          *string `json:"role"`
}

// patchUser toggles captcha exemption (and optionally role) for a user.
func patchUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	var req patchUserReq
	_ = web.Decode(r, &req)
	var dummy string
	if err := store.DB.QueryRow("SELECT id FROM users WHERE id = ?", id).Scan(&dummy); err == sql.ErrNoRows {
		web.Err(w, http.StatusNotFound, "User not found")
		return
	}
	if req.CaptchaExempt != nil {
		v := 0
		if *req.CaptchaExempt {
			v = 1
		}
		store.DB.Exec("UPDATE users SET captcha_exempt = ? WHERE id = ?", v, id)
	}
	if req.Role != nil && validRoles[*req.Role] {
		admin := 0
		if *req.Role == "admin" {
			admin = 1
		}
		store.DB.Exec("UPDATE users SET role = ?, is_admin = ? WHERE id = ?", *req.Role, admin, id)
	}
	web.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

func deleteUser(w http.ResponseWriter, r *http.Request) {
	id := chi.URLParam(r, "id")
	if u := UserFrom(r); u != nil && id == u.ID {
		web.Err(w, http.StatusBadRequest, "Cannot delete yourself")
		return
	}
	if _, err := store.DB.Exec("DELETE FROM users WHERE id = ?", id); err != nil {
		web.Err(w, http.StatusInternalServerError, err.Error())
		return
	}
	web.JSON(w, http.StatusOK, map[string]bool{"ok": true})
}

// ---- captcha rendering ----

const captchaAlphabet = "abcdefghjkmnpqrstuvwxyz23456789" // svg-captcha ignoreChars '0o1ilI' analog

func randomCaptchaText(n int) string {
	b := make([]byte, n)
	for i := range b {
		idx, _ := rand.Int(rand.Reader, big.NewInt(int64(len(captchaAlphabet))))
		b[i] = captchaAlphabet[idx.Int64()]
	}
	return string(b)
}

func randInt(max int) int {
	n, _ := rand.Int(rand.Reader, big.NewInt(int64(max)))
	return int(n.Int64())
}

// captchaSVG renders the text as a self-contained inline SVG with jittered
// glyphs and noise lines. Not byte-identical to svg-captcha, but it satisfies
// the same {id, svg} contract the Login page renders via innerHTML.
func captchaSVG(text string) string {
	const w, h = 150, 50
	i := strconv.Itoa
	var b strings.Builder
	b.WriteString(`<svg xmlns="http://www.w3.org/2000/svg" width="150" height="50" viewBox="0 0 150 50">`)
	// noise lines
	for k := 0; k < 3; k++ {
		b.WriteString(`<path d="M` + i(randInt(w)) + " " + i(randInt(h)) +
			" L" + i(randInt(w)) + " " + i(randInt(h)) +
			`" stroke="#888" stroke-width="1" fill="none" opacity="0.6"/>`)
	}
	step := w / (len(text) + 1)
	for idx, ch := range text {
		x := step*(idx+1) - 6
		y := 34 + randInt(8) - 4
		rot := randInt(30) - 15
		b.WriteString(`<text x="` + i(x) + `" y="` + i(y) +
			`" font-size="28" font-family="monospace" transform="rotate(` + i(rot) + " " + i(x) + " " + i(y) +
			`)" fill="#333">` + string(ch) + `</text>`)
	}
	b.WriteString(`</svg>`)
	return b.String()
}
