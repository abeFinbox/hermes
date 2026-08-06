package server

// Hera (k6 load testing) routes. Kept in its own file rather than growing
// routes2.go. Mirrors backend/src/routes/hera.ts route-for-route.
//
// Two things about the permission shape are deliberate:
//
//   - LAUNCH is admin-only by default (HERA_ALLOW_MODERATOR=1 widens it). It is
//     gated explicitly here rather than by falling through EnforcePermissions,
//     because loosening later is easy and tightening later breaks workflows.
//   - STOP is in the isExecute whitelist in auth.go, so every role including
//     read-only npc can hit the brakes. That is the ONLY Hera route in there.

import (
	"net/http"
	"os"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/finbox/hermes/backend-go/internal/auth"
	"github.com/finbox/hermes/backend-go/internal/hera"
	"github.com/finbox/hermes/backend-go/internal/web"
	"github.com/go-chi/chi/v5"
)

func heraSelfPort() string {
	if p := os.Getenv("PORT"); p != "" {
		return p
	}
	return "4001"
}

// Launch rate limit, keyed by USER not IP: one NAT'd office is one IP.
const (
	launchWindow = 10 * time.Minute
	launchMax    = 3
)

var (
	launchMu sync.Mutex
	launches = map[string][]time.Time{}
)

// launchRateLimited peeks only — it does NOT consume a slot.
//
// The limit exists to bound load generation, and a rejected launch generates
// none. Counting attempts would let a fumbled config lock someone out of the
// feature, so slots are consumed in recordLaunch once a run actually starts.
func launchRateLimited(userID string) bool {
	launchMu.Lock()
	defer launchMu.Unlock()
	cutoff := time.Now().Add(-launchWindow)
	kept := []time.Time{}
	for _, t := range launches[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	launches[userID] = kept
	return len(kept) >= launchMax
}

func recordLaunch(userID string) {
	launchMu.Lock()
	defer launchMu.Unlock()
	cutoff := time.Now().Add(-launchWindow)
	kept := []time.Time{}
	for _, t := range launches[userID] {
		if t.After(cutoff) {
			kept = append(kept, t)
		}
	}
	launches[userID] = append(kept, time.Now())
}

func heraCanLaunch(role string) bool {
	if role == "admin" {
		return true
	}
	return role == "moderator" && hera.GetLimits().AllowModerator
}

type heraCapabilitiesResponse struct {
	Available      bool    `json:"available"`
	Enabled        bool    `json:"enabled"`
	Version        *string `json:"version"`
	Platform       *string `json:"platform"`
	Reason         string  `json:"reason,omitempty"`
	MaxVus         int     `json:"maxVus"`
	MaxDurationSec int     `json:"maxDurationSec"`
	MaxRps         int     `json:"maxRps"`
	MaxRequests    int     `json:"maxRequests"`
	AllowModerator bool    `json:"allowModerator"`
	// SelfMockOnly is true when no HERA_TARGET_ALLOW is set, i.e. only this
	// instance's /mock API may be targeted.
	SelfMockOnly bool `json:"selfMockOnly"`
	CanLaunch    bool `json:"canLaunch"`
}

func heraCapabilities(recheck bool, role string) heraCapabilitiesResponse {
	if recheck {
		hera.ResetCapability()
	}
	limits := hera.GetLimits()
	cap := hera.GetCapability()
	reason := cap.Reason
	if !limits.Enabled {
		reason = "Hera is turned off on this instance (HERA_ENABLED=0)."
	}
	return heraCapabilitiesResponse{
		Available:      limits.Enabled && cap.Available,
		Enabled:        limits.Enabled,
		Version:        cap.Version,
		Platform:       cap.Platform,
		Reason:         reason,
		MaxVus:         limits.MaxVus,
		MaxDurationSec: limits.MaxDurationSec,
		MaxRps:         limits.MaxRps,
		MaxRequests:    limits.MaxRequests,
		AllowModerator: limits.AllowModerator,
		SelfMockOnly:   len(limits.TargetAllow) == 0,
		CanLaunch:      heraCanLaunch(role),
	}
}

func heraRouter() chi.Router {
	r := chi.NewRouter()

	r.Get("/capabilities", func(w http.ResponseWriter, r *http.Request) {
		role := ""
		if u := auth.UserFrom(r); u != nil {
			role = u.Role
		}
		web.JSON(w, 200, heraCapabilities(r.URL.Query().Get("recheck") == "1", role))
	})

	r.Get("/preflight", func(w http.ResponseWriter, r *http.Request) {
		suite, _ := getSuite(r.URL.Query().Get("suiteId"))
		if suite == nil {
			web.Err(w, 404, "Suite not found")
			return
		}
		web.JSON(w, 200, hera.Preflight(*suite, hera.GetLimits(), heraSelfPort()))
	})

	r.Get("/", func(w http.ResponseWriter, r *http.Request) {
		web.JSON(w, 200, hera.ListRuns(r.URL.Query().Get("suiteId")))
	})

	r.Post("/", func(w http.ResponseWriter, r *http.Request) {
		u := auth.UserFrom(r)
		role := ""
		if u != nil {
			role = u.Role
		}
		if !heraCanLaunch(role) {
			msg := "Only an admin can start a load test."
			if role == "moderator" {
				msg = "Only an admin can start a load test on this instance. Set HERA_ALLOW_MODERATOR=1 to allow moderators."
			}
			web.Err(w, 403, msg)
			return
		}
		var body hera.RequestedConfig
		if err := web.Decode(r, &body); err != nil {
			web.Err(w, 400, "Invalid request body")
			return
		}
		suite, _ := getSuite(body.SuiteID)
		if suite == nil {
			web.Err(w, 404, "Suite not found")
			return
		}
		if launchRateLimited(u.ID) {
			web.Err(w, 429, "Too many load tests started recently — 3 per 10 minutes. Wait before starting another.")
			return
		}
		body.SuiteID = suite.ID
		clamped := hera.ClampConfig(body, hera.GetLimits(), 0)
		result := hera.StartRun(hera.StartRunInput{
			Suite:      *suite,
			Applied:    clamped.Applied,
			ClampNotes: clamped.Notes,
			Actor: hera.Actor{
				ID: u.ID, Username: u.Username, Role: u.Role, IP: clientIP(r),
			},
			SelfPort: heraSelfPort(),
		})
		if !result.OK {
			web.Err(w, result.Status, result.Error)
			return
		}
		recordLaunch(u.ID) // only a run that actually started consumes a slot
		web.JSON(w, 202, map[string]interface{}{
			"id": result.ID, "status": "queued",
			"appliedConfig": clamped.Applied, "clampNotes": clamped.Notes,
		})
	})

	r.Get("/{id}", func(w http.ResponseWriter, r *http.Request) {
		var since *int
		if v := r.URL.Query().Get("since"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				since = &n
			}
		}
		run := hera.GetRun(chi.URLParam(r, "id"), since)
		if run == nil {
			web.Err(w, 404, "Load test not found")
			return
		}
		web.JSON(w, 200, run)
	})

	r.Post("/{id}/stop", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if hera.GetRun(id, nil) == nil {
			web.Err(w, 404, "Load test not found")
			return
		}
		if !hera.StopRun(id) {
			web.Err(w, 409, "Run is not active (already finished, or running on the other backend).")
			return
		}
		web.JSON(w, 200, map[string]interface{}{"ok": true, "status": "stopping"})
	})

	r.Delete("/{id}", func(w http.ResponseWriter, r *http.Request) {
		id := chi.URLParam(r, "id")
		if hera.IsRunActive(id) {
			web.Err(w, 409, "Stop the run before deleting it.")
			return
		}
		// The hera_audit trail deliberately survives this.
		hera.DeleteRun(id)
		web.JSON(w, 200, map[string]bool{"ok": true})
	})

	return r
}

func clientIP(r *http.Request) string {
	if xff := r.Header.Get("X-Forwarded-For"); xff != "" {
		return strings.TrimSpace(strings.Split(xff, ",")[0])
	}
	if host, _, err := splitHostPort(r.RemoteAddr); err == nil {
		return host
	}
	return r.RemoteAddr
}

func splitHostPort(addr string) (string, string, error) {
	i := strings.LastIndex(addr, ":")
	if i < 0 {
		return addr, "", nil
	}
	return strings.Trim(addr[:i], "[]"), addr[i+1:], nil
}
