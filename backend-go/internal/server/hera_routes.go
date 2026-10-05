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
	"encoding/json"
	"net/http"
	"os"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/finbox/hermes/backend-go/internal/auth"
	"github.com/finbox/hermes/backend-go/internal/hera"
	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/store"
	"github.com/finbox/hermes/backend-go/internal/web"
	"github.com/go-chi/chi/v5"
)

// curlTokenRe finds {{variables}} a cURL could not resolve statically. Mirrors
// the regex in routes/hera.ts.
var curlTokenRe = regexp.MustCompile(`\{\{\s*([^}\s]+)\s*\}\}`)

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

	// ?envId= is a per-launch override; omitting it previews the suite's default
	// environment, so the preflight matches what POST / would actually run.
	r.Get("/preflight", func(w http.ResponseWriter, r *http.Request) {
		suite, _ := getSuite(r.URL.Query().Get("suiteId"))
		if suite == nil {
			web.Err(w, 404, "Suite not found")
			return
		}
		envID := ""
		if suite.DefaultEnvID != nil {
			envID = *suite.DefaultEnvID
		}
		if r.URL.Query().Has("envId") {
			envID = r.URL.Query().Get("envId")
		}
		if envID != "" && store.GetEnvironment(envID) == nil {
			web.Err(w, 404, "Environment not found")
			return
		}
		pre := hera.Preflight(*suite, hera.GetLimits(), heraSelfPort(), envID)
		// Flattened alongside the preflight fields, matching the Node response.
		raw, err := json.Marshal(pre)
		if err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		merged := map[string]interface{}{}
		_ = json.Unmarshal(raw, &merged)
		if envID == "" {
			merged["envId"] = nil
		} else {
			merged["envId"] = envID
		}
		merged["envName"] = store.EnvNameFor(envID)
		web.JSON(w, 200, merged)
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
		// EnvID rides alongside the load config rather than inside it: the config
		// is persisted as the run's requested/applied JSON, and the environment
		// is recorded in its own columns.
		var wrapper struct {
			hera.RequestedConfig
			// Raw so absent (use the suite default) stays distinct from null (no
			// environment) — see resolveEnvID.
			EnvID json.RawMessage `json:"envId"`
		}
		if err := web.Decode(r, &wrapper); err != nil {
			web.Err(w, 400, "Invalid request body")
			return
		}
		body := wrapper.RequestedConfig
		suite, _ := getSuite(body.SuiteID)
		if suite == nil {
			web.Err(w, 404, "Suite not found")
			return
		}
		envID := resolveEnvID(wrapper.EnvID, suite.DefaultEnvID)
		if envID != "" && store.GetEnvironment(envID) == nil {
			web.Err(w, 404, "Environment not found")
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
			EnvID:    envID,
		})
		if !result.OK {
			web.Err(w, result.Status, result.Error)
			return
		}
		recordLaunch(u.ID) // only a run that actually started consumes a slot
		var envRef interface{}
		if envID != "" {
			envRef = envID
		}
		web.JSON(w, 202, map[string]interface{}{
			"id": result.ID, "status": "queued",
			"appliedConfig": clamped.Applied, "clampNotes": clamped.Notes,
			"envId": envRef, "envName": store.EnvNameFor(envID),
		})
	})

	// Preview the shape of a run before starting one. Pure function of the query,
	// no suite and no side effects, so the launch form can call it on every
	// keystroke.
	//
	// Declared before /{id} so "profile" is not read as a run id.
	//
	// The client never derives stages itself: one implementation per language,
	// both covered by the parity harness, is the whole point.
	r.Get("/profile", func(w http.ResponseWriter, r *http.Request) {
		limits := hera.GetLimits()
		mode := r.URL.Query().Get("mode")
		if !hera.IsMode(mode) {
			mode = "constant"
		}
		clampInt := func(raw string, max int) int {
			v, err := strconv.Atoi(raw)
			if err != nil || v < 1 {
				return 1
			}
			if v > max {
				return max
			}
			return v
		}
		vus := clampInt(r.URL.Query().Get("vus"), limits.MaxVus)
		dur := clampInt(r.URL.Query().Get("durationSec"), limits.MaxDurationSec)
		// NOT pre-clamped: DeriveProfile clamps and explains it, so the preview
		// says the same thing the launch would.
		var target *int
		if raw := r.URL.Query().Get("ratePerSec"); raw != "" {
			if v, err := strconv.Atoi(raw); err == nil && v > 0 {
				target = &v
			}
		}
		profile := hera.DeriveProfile(mode, vus, dur, limits.MaxRps, target)
		modes := []map[string]string{}
		for _, m := range hera.Modes {
			modes = append(modes, map[string]string{"mode": m, "label": hera.ModeLabels[m]})
		}
		web.JSON(w, 200, map[string]interface{}{
			"modes": modes, "maxRps": limits.MaxRps,
			"mode": profile.Mode, "vus": profile.Vus, "durationSec": profile.DurationSec,
			"stages": profile.Stages, "ratePerSec": profile.RatePerSec, "summary": profile.Summary,
			"notes": profile.Notes,
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

	// Live k6 output. Separate from GET /{id} because the log ring lives in the
	// process that spawned k6, while everything else in the payload comes from
	// the shared database: folding them together would produce a field that is
	// authoritative on one engine and empty on the other. See hera.GetRunLogs.
	r.Get("/{id}/logs", func(w http.ResponseWriter, r *http.Request) {
		sinceLine := 0
		if v := r.URL.Query().Get("sinceLine"); v != "" {
			if n, err := strconv.Atoi(v); err == nil {
				sinceLine = n
			}
		}
		logs := hera.GetRunLogs(chi.URLParam(r, "id"), sinceLine)
		if logs == nil {
			web.Err(w, 404, "Load test not found")
			return
		}
		web.JSON(w, 200, logs)
	})

	// A paste-runnable cURL for one step of a run — the first thing anyone wants
	// after seeing a step at 100% errors.
	//
	// Gated to the launch roles, and never persisted, because it resolves REAL
	// values including secret variables. A masked Authorization header would
	// reproduce a 401 that has nothing to do with the one being debugged, which
	// is worse than useless. Same posture as the single-step Send curl.
	//
	// Built from the suite AS IT IS NOW, not as it ran: Hera stores no request
	// snapshot. staleWarning says so when the suite has been edited since.
	r.Get("/{id}/curl", func(w http.ResponseWriter, r *http.Request) {
		u := auth.UserFrom(r)
		role := ""
		if u != nil {
			role = u.Role
		}
		if !heraCanLaunch(role) {
			msg := "Only an admin can see a load-test cURL (it contains real credentials)."
			if role == "moderator" {
				msg = "Only an admin can see a load-test cURL on this instance (it contains real credentials). Set HERA_ALLOW_MODERATOR=1 to allow moderators."
			}
			web.Err(w, 403, msg)
			return
		}
		run := hera.GetRun(chi.URLParam(r, "id"), nil)
		if run == nil {
			web.Err(w, 404, "Load test not found")
			return
		}
		suite, _ := getSuite(run.SuiteID)
		if suite == nil {
			web.Err(w, 404, "The suite this run used has been deleted, so its requests cannot be rebuilt.")
			return
		}
		stepID := r.URL.Query().Get("stepId")
		var step *model.Step
		for i := range suite.Steps {
			if suite.Steps[i].ID == stepID {
				step = &suite.Steps[i]
				break
			}
		}
		if step == nil {
			web.Err(w, 404, "That step is no longer in the suite, so its request cannot be rebuilt.")
			return
		}

		files := hera.CollectFiles(*suite)
		// Rebuilt against the environment the RUN used, not the suite's current
		// default: a cURL resolved against the wrong environment points at the
		// wrong host and reproduces nothing.
		runEnvID := ""
		if run.EnvID != nil {
			runEnvID = *run.EnvID
		}
		curl := hera.BuildStepCurl(hera.StepCurlInput{
			Step: *step, SeedVars: hera.BuildSeedVars(*suite, runEnvID), FileMetas: files.Metas,
		})
		// Variables captured at runtime cannot be resolved statically; the command
		// keeps them as {{name}} and the UI has to say so, or someone pastes a URL
		// with a literal {{session_id}} in it and blames the tool.
		unresolved := []string{}
		seen := map[string]bool{}
		for _, m := range curlTokenRe.FindAllStringSubmatch(curl, -1) {
			if !seen[m[1]] {
				seen[m[1]] = true
				unresolved = append(unresolved, m[1])
			}
		}
		method := strings.ToUpper(step.Request.Method)
		if method == "" {
			method = "GET"
		}
		web.JSON(w, 200, map[string]interface{}{
			"stepId": stepID, "name": step.Name, "method": method, "curl": curl,
			"unresolved": unresolved, "staleWarning": suite.UpdatedAt > run.StartedAt,
		})
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
