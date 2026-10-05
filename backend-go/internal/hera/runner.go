package hera

import (
	"encoding/json"
	"fmt"
	"log"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"

	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/store"
)

// Run orchestration: validate -> generate -> spawn -> sample -> finalise.
//
// Mirrors backend/src/hera/runner.ts.

const (
	// PersistInterval is how often progress is written to the DB. Also the lock
	// heartbeat cadence.
	PersistInterval = 2 * time.Second
	// MaxSamplesBytes caps the persisted samples blob.
	MaxSamplesBytes = 256 * 1024
)

type RequestedConfig struct {
	SuiteID     string `json:"suiteId"`
	Vus         int    `json:"vus"`
	DurationSec int    `json:"durationSec"`
	// Mode is the shape of the run; absent or unknown means flat.
	Mode string `json:"mode"`
	// RatePerSec is the target requests/s for "rate" mode; nil means the ceiling.
	RatePerSec   *int `json:"ratePerSec"`
	ThinkTimeMs  int  `json:"thinkTimeMs"`
	P95Ms        *int `json:"p95Ms"`
	ErrorRatePct *int `json:"errorRatePct"`
}

type AppliedConfig struct {
	SuiteID string `json:"suiteId"`
	LoadConfig
}

type ClampResult struct {
	Applied AppliedConfig
	Notes   []string
}

type PreflightStep struct {
	StepID           string         `json:"stepId"`
	Name             string         `json:"name"`
	Method           string         `json:"method"`
	URL              string         `json:"url"`
	ResolvedURL      string         `json:"resolvedUrl"`
	UnresolvedTokens []string       `json:"unresolvedTokens"`
	Target           ResolvedTarget `json:"target"`
}

type PreflightHost struct {
	Origin   string `json:"origin"`
	Requests int    `json:"requests"`
	External bool   `json:"external"`
}

type Finding struct {
	Level   string `json:"level"`
	Message string `json:"message"`
}

type PreflightEstimate struct {
	RequestsPerIteration int    `json:"requestsPerIteration"`
	Unbounded            bool   `json:"unbounded"`
	Note                 string `json:"note"`
}

type PreflightResult struct {
	OK            bool              `json:"ok"`
	Steps         []PreflightStep   `json:"steps"`
	Hosts         []PreflightHost   `json:"hosts"`
	Findings      []Finding         `json:"findings"`
	Estimate      PreflightEstimate `json:"estimate"`
	SecretsNeeded []string          `json:"secretsNeeded"`
}

// ---------- variables & files ----------

// BuildSeedVars merges the layers, mirroring VarScope's
// runtime > environment > global > suite.
//
// Written lowest-priority-first so each layer overwrites the one below it: suite
// variables are the fallback a suite ships with, globals override them, and the
// selected environment overrides both.
//
// Every virtual user starts from this map, so an environment chosen at launch is
// what the whole load test runs against.
func BuildSeedVars(suite model.Suite, envID string) map[string]string {
	out := map[string]string{}
	for _, v := range suite.Variables {
		out[v.Key] = v.Value
	}
	if globals, err := store.GetGlobals(); err == nil {
		for _, g := range globals {
			out[g.Key] = g.Value
		}
	}
	for _, e := range store.GetEnvVars(envID) {
		out[e.Key] = e.Value
	}
	return out
}

type collectedFiles struct {
	Paths      map[string]string
	Metas      map[string]FileMeta
	TotalBytes int64
	Missing    []string
}

func CollectFiles(suite model.Suite) collectedFiles {
	out := collectedFiles{Paths: map[string]string{}, Metas: map[string]FileMeta{}}
	for _, step := range suite.Steps {
		if !step.Enabled {
			continue
		}
		for _, part := range step.Request.Body.FormData {
			if part.Type != "file" || part.FileID == "" {
				continue
			}
			if _, seen := out.Paths[part.FileID]; seen {
				continue
			}
			row, err := store.GetFileRow(part.FileID)
			if err != nil || row == nil {
				out.Missing = append(out.Missing, step.Name+" / "+part.Key)
				continue
			}
			path := filepath.Join(store.FilesDir, row.StoredName)
			fi, serr := os.Stat(path)
			if serr != nil {
				out.Missing = append(out.Missing, step.Name+" / "+part.Key)
				continue
			}
			out.TotalBytes += fi.Size()
			out.Paths[part.FileID] = path
			mime := row.Mime
			if mime == "" {
				mime = "application/octet-stream"
			}
			out.Metas[part.FileID] = FileMeta{Filename: row.OriginalName, Mime: mime}
		}
	}
	return out
}

var tokenScan = regexp.MustCompile(`\{\{\s*([^}\s]+)\s*\}\}`)

func tokensIn(text string) []string {
	seen := map[string]bool{}
	out := []string{}
	for _, m := range tokenScan.FindAllStringSubmatch(text, -1) {
		if !seen[m[1]] {
			seen[m[1]] = true
			out = append(out, m[1])
		}
	}
	return out
}

// ---------- caps ----------

func ClampConfig(req RequestedConfig, limits Limits, capMillicores int) ClampResult {
	notes := []string{}
	maxVus := limits.MaxVus
	if capMillicores > 0 {
		byCPU := capMillicores / MillicoresPerVu
		if byCPU < 1 {
			byCPU = 1
		}
		if byCPU < maxVus {
			maxVus = byCPU
			notes = append(notes, fmt.Sprintf("Virtual users capped to %d by the CPU available to this instance.", byCPU))
		}
	}

	wantVus := req.Vus
	if wantVus < 1 {
		wantVus = 1
	}
	vus := wantVus
	if vus > maxVus {
		vus = maxVus
		notes = append(notes, fmt.Sprintf("Virtual users reduced from %d to %d (server limit).", wantVus, vus))
	}

	wantDur := req.DurationSec
	if wantDur < 1 {
		wantDur = 1
	}
	dur := wantDur
	if dur > limits.MaxDurationSec {
		dur = limits.MaxDurationSec
		notes = append(notes, fmt.Sprintf("Duration reduced from %ds to %ds (server limit).", wantDur, dur))
	}

	think := req.ThinkTimeMs
	if think < 0 {
		think = 0
	}
	if think > 60000 {
		think = 60000
	}

	var p95 *int
	if req.P95Ms != nil {
		v := *req.P95Ms
		if v < 1 {
			v = 1
		}
		p95 = &v
	}
	var errPct *int
	if req.ErrorRatePct != nil {
		v := *req.ErrorRatePct
		if v < 0 {
			v = 0
		}
		if v > 100 {
			v = 100
		}
		errPct = &v
	}

	// An unknown mode falls back to flat rather than failing the launch: a client
	// sending a mode this build does not have should still get a run.
	mode := req.Mode
	if mode != "" && !IsMode(mode) {
		notes = append(notes, fmt.Sprintf("Unknown load mode %q — ran flat instead.", mode))
	}
	if !IsMode(mode) {
		mode = "constant"
	}
	// Derived AFTER the vus/duration clamps, so a shape can never exceed a cap
	// the flat run would have respected.
	profile := DeriveProfile(mode, vus, dur, limits.MaxRps, req.RatePerSec)
	notes = append(notes, profile.Notes...)

	return ClampResult{
		Applied: AppliedConfig{
			SuiteID: req.SuiteID,
			LoadConfig: LoadConfig{
				Vus: vus, DurationSec: dur, Rps: limits.MaxRps, Mode: profile.Mode, RatePerSec: profile.RatePerSec,
				ThinkTimeMs: think, P95Ms: p95, ErrorRatePct: errPct,
			},
		},
		Notes: notes,
	}
}

/*
hostPort composes "host" or "host:port" for k6's DNS override map and for the
origin strings shown and audited.

IPv6 literals MUST be bracketed. Without this, localhost resolving to ::1
produced the pair `localhost:4099 -> ::1:4099`, which k6 parses as host ::1 with
NO port, then dials port 0 — every request in the run fails with "can't assign
requested address" (errno 49). Verified on macOS, where localhost resolves to
::1 first.
*/
func hostPort(host, port string) string {
	h := host
	if strings.Contains(h, ":") {
		h = "[" + h + "]"
	}
	if port == "" {
		return h
	}
	return h + ":" + port
}

// ---------- preflight ----------

func Preflight(suite model.Suite, limits Limits, selfPort string, envID string) PreflightResult {
	seed := BuildSeedVars(suite, envID)
	findings := []Finding{}
	steps := []PreflightStep{}
	hostOrder := []string{}
	hostCounts := map[string]*PreflightHost{}

	enabled := []model.Step{}
	for _, s := range suite.Steps {
		if s.Enabled {
			enabled = append(enabled, s)
		}
	}

	anyPolling := false
	scriptSteps := 0
	respTimeAssertions := 0

	for _, step := range enabled {
		resolved := Interpolate(step.Request.URL, seed)
		target := ValidateTarget(step.Request.URL, seed, TargetOptions{
			Limits: limits, SelfPort: selfPort, Resolve: DefaultResolver,
		})
		method := strings.ToUpper(step.Request.Method)
		if method == "" {
			method = "GET"
		}
		steps = append(steps, PreflightStep{
			StepID: step.ID, Name: step.Name, Method: method, URL: step.Request.URL,
			ResolvedURL: resolved, UnresolvedTokens: tokensIn(resolved), Target: target,
		})
		if target.OK && target.Host != "" {
			origin := target.Scheme + "://" + hostPort(target.Host, target.Port)
			if h, ok := hostCounts[origin]; ok {
				h.Requests++
			} else {
				hostCounts[origin] = &PreflightHost{Origin: origin, Requests: 1, External: !target.SelfMock}
				hostOrder = append(hostOrder, origin)
			}
		}
		if step.Polling != nil && step.Polling.Enabled {
			anyPolling = true
		}
		if strings.TrimSpace(step.Validations.Script) != "" || strings.TrimSpace(step.Captures.Script) != "" {
			scriptSteps++
		}
		for _, a := range step.Validations.Visual {
			if a.Type == "response-time-below" {
				respTimeAssertions++
			}
		}
	}

	if len(enabled) == 0 {
		findings = append(findings, Finding{"error", "This suite has no enabled steps, so there is nothing to load-test."})
	}
	for _, s := range steps {
		if !s.Target.OK {
			findings = append(findings, Finding{"error", s.Name + ": " + s.Target.Reason})
		}
	}
	if scriptSteps > 0 {
		findings = append(findings, Finding{"info", fmt.Sprintf(
			"%d step(s) use capture/validation scripts. They run unchanged on the Hera shim, with three differences: variables.set(..., 'global') is iteration-local, console.log only emits for the first iteration of VU 1, and there is no 2-second per-script timeout.", scriptSteps)})
	}
	if anyPolling {
		findings = append(findings, Finding{"warn",
			"Polling is enabled, so the request count is unbounded — the rps cap and the run duration are the real limits. Expect few completed iterations, and read hera_poll_wait_ms for time-to-completion."})
	}
	if respTimeAssertions > 0 {
		findings = append(findings, Finding{"info", fmt.Sprintf(
			"%d response-time assertion(s) will run as checks. Consider setting the p95 threshold instead — under load a per-request limit fails noisily.", respTimeAssertions)})
	}

	files := CollectFiles(suite)
	if len(files.Missing) > 0 {
		findings = append(findings, Finding{"error", fmt.Sprintf(
			"Attached file missing from the store for: %s. Re-attach it before running.", strings.Join(files.Missing, ", "))})
	}
	if files.TotalBytes > 1024*1024 {
		findings = append(findings, Finding{"warn", fmt.Sprintf(
			"Attached files total %.1f MB. k6 loads init data per virtual user, so memory grows with the VU count.",
			float64(files.TotalBytes)/1024/1024)})
	}

	secretsNeeded := []string{}
	for _, v := range suite.Variables {
		if v.Secret && v.Value == "" {
			secretsNeeded = append(secretsNeeded, v.Key)
		}
	}
	if len(secretsNeeded) > 0 {
		findings = append(findings, Finding{"warn", fmt.Sprintf(
			"These secret variables are empty and will be sent blank: %s.", strings.Join(secretsNeeded, ", "))})
	}

	cap := GetCapability()
	if !limits.Enabled {
		findings = append(findings, Finding{"error", "Hera is turned off on this instance (HERA_ENABLED=0)."})
	} else if !cap.Available {
		reason := cap.Reason
		if reason == "" {
			reason = "k6 is not available."
		}
		findings = append(findings, Finding{"error", reason})
	}

	ok := true
	for _, f := range findings {
		if f.Level == "error" {
			ok = false
		}
	}
	hosts := make([]PreflightHost, 0, len(hostOrder))
	for _, o := range hostOrder {
		hosts = append(hosts, *hostCounts[o])
	}
	note := fmt.Sprintf("About %d request(s) per iteration.", len(enabled))
	if anyPolling {
		note = "Unbounded — polling re-sends until its stop condition or timeout."
	}
	return PreflightResult{
		OK: ok, Steps: steps, Hosts: hosts, Findings: findings,
		Estimate:      PreflightEstimate{RequestsPerIteration: len(enabled), Unbounded: anyPolling, Note: note},
		SecretsNeeded: secretsNeeded,
	}
}

// ---------- run lifecycle ----------

// activeRun is registered BEFORE k6 is spawned, so a stop that arrives during
// the spawn window is remembered instead of being dropped with a 409.
type activeRun struct {
	mu            sync.Mutex
	handle        *RunHandle
	collector     *ProgressCollector
	stopRequested bool
	stopTimer     chan struct{}
	// logs is the live k6 output, served by GET /api/hera/{id}/logs while this
	// run is ours. Its own mutex guards it, so it is read without taking a.mu.
	logs *LogRing
}

// requestStop marks the intent and forwards it if k6 is already running.
func (a *activeRun) requestStop() {
	a.mu.Lock()
	a.stopRequested = true
	h := a.handle
	a.mu.Unlock()
	if h != nil {
		h.Stop()
	}
}

// logsOrNew returns the run's ring, creating one if the entry predates it or is
// missing entirely. Nil-safe: a run can be gone by the time execute looks.
func (a *activeRun) logsOrNew() *LogRing {
	if a == nil {
		return NewLogRing(GetLimits().LogLines, MaxLogRingBytes)
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.logs == nil {
		a.logs = NewLogRing(GetLimits().LogLines, MaxLogRingBytes)
	}
	return a.logs
}

// attach records the handle and reports whether a stop was already requested.
func (a *activeRun) attach(h *RunHandle, c *ProgressCollector) bool {
	a.mu.Lock()
	a.handle = h
	a.collector = c
	requested := a.stopRequested
	a.mu.Unlock()
	return requested
}

var (
	activeMu   sync.Mutex
	activeRuns = map[string]*activeRun{}
)

func IsRunActive(id string) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	_, ok := activeRuns[id]
	return ok
}

func StopRun(id string) bool {
	activeMu.Lock()
	r, ok := activeRuns[id]
	activeMu.Unlock()
	if !ok {
		return false
	}
	r.requestStop()
	return true
}

type Actor struct {
	ID       string
	Username string
	Role     string
	IP       string
}

type StartRunInput struct {
	Suite      model.Suite
	Applied    AppliedConfig
	ClampNotes []string
	Actor      Actor
	SelfPort   string
	// EnvID selects the environment the VUs resolve variables against; "" means
	// globals + suite only.
	EnvID string
}

type StartRunResult struct {
	OK     bool
	ID     string
	Status int
	Error  string
}

func trimSamples(samples []Sample) string {
	raw, _ := json.Marshal(samples)
	for len(raw) > MaxSamplesBytes && len(samples) > 2 {
		kept := make([]Sample, 0, len(samples)/2+1)
		for i, s := range samples {
			if i%2 == 0 {
				kept = append(kept, s)
			}
		}
		samples = kept
		raw, _ = json.Marshal(samples)
	}
	return string(raw)
}

func Audit(event, runID string, actor Actor, suiteID string, hosts []string, detail interface{}) {
	hostsJSON, _ := json.Marshal(hosts)
	detailJSON, _ := json.Marshal(detail)
	var runRef interface{}
	if runID != "" {
		runRef = runID
	}
	_, _ = store.DB.Exec(
		`INSERT INTO hera_audit (id, at, event, run_id, user_id, username, role, source_ip, backend, suite_id, target_hosts_json, detail_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'go', ?, ?, ?)`,
		model.NewID(), time.Now().UTC().Format(time.RFC3339), event, runRef,
		actor.ID, actor.Username, actor.Role, actor.IP, suiteID, string(hostsJSON), string(detailJSON),
	)
}

func StartRun(in StartRunInput) StartRunResult {
	limits := GetLimits()
	cap := GetCapability()
	if !limits.Enabled || !cap.Available {
		reason := cap.Reason
		if reason == "" {
			reason = "Hera is not available on this instance."
		}
		return StartRunResult{Status: 503, Error: reason}
	}

	envName := store.EnvNameFor(in.EnvID)
	pre := Preflight(in.Suite, limits, in.SelfPort, in.EnvID)
	if !pre.OK {
		msg := "Preflight failed."
		for _, f := range pre.Findings {
			if f.Level == "error" {
				msg = f.Message
				break
			}
		}
		Audit("reject", "", in.Actor, in.Suite.ID, nil, map[string]string{"reason": msg})
		return StartRunResult{Status: 400, Error: msg}
	}

	projected := in.Applied.Rps * in.Applied.DurationSec
	if !pre.Estimate.Unbounded && projected > limits.MaxRequests {
		msg := fmt.Sprintf("This run projects about %d requests, over the %d limit. Lower the duration, or raise HERA_MAX_REQUESTS.", projected, limits.MaxRequests)
		Audit("reject", "", in.Actor, in.Suite.ID, nil, map[string]string{"reason": msg})
		return StartRunResult{Status: 400, Error: msg}
	}

	id := model.NewID()
	if holder := AcquireLock(id); holder != nil {
		short := holder.RunID
		if len(short) > 8 {
			short = short[:8]
		}
		return StartRunResult{Status: 409, Error: fmt.Sprintf(
			"A load test is already running on this database (run %s). Only one runs at a time, so results stay comparable.", short)}
	}

	seed := BuildSeedVars(in.Suite, in.EnvID)
	files := CollectFiles(in.Suite)
	// Resolve-then-pin as a k6 DNS override: hostname -> validated IP. Keeping
	// the hostname in the URL is what lets HTTPS work (a literal-IP URL fails
	// cert validation — no IP SANs). Keyed by host[:non-default-port].
	//
	// When the key carries a port, the VALUE must carry the same port. k6 reads a
	// port-less value as port 0 and then dials it, which fails with
	// "can't assign requested address" (errno 49) on every request — verified.
	pinHosts := map[string]string{}
	for _, s := range pre.Steps {
		if s.Target.OK && s.Target.Host != "" && s.Target.ResolvedIP != "" {
			isDefaultPort := (s.Target.Scheme == "http" && s.Target.Port == "80") ||
				(s.Target.Scheme == "https" && s.Target.Port == "443")
			key := hostPort(s.Target.Host, "")
			val := hostPort(s.Target.ResolvedIP, "")
			if !isDefaultPort {
				key = hostPort(s.Target.Host, s.Target.Port)
				val = hostPort(s.Target.ResolvedIP, s.Target.Port)
			}
			pinHosts[key] = val
		}
	}

	script, metas := GenerateScript(GenerateInput{
		Suite: in.Suite, SeedVars: seed, Load: in.Applied.LoadConfig,
		FilePaths: files.Paths, FileMetas: files.Metas, Hosts: pinHosts,
		Diag: &DiagConfig{Enabled: limits.Diag, Max: limits.DiagMax, Body: limits.DiagBody, BodyMax: limits.DiagBodyMax},
	})

	hosts := make([]string, 0, len(pre.Hosts))
	for _, h := range pre.Hosts {
		hosts = append(hosts, h.Origin)
	}
	sort.Strings(hosts)

	now := time.Now().UTC().Format(time.RFC3339)
	requested := map[string]interface{}{"applied": in.Applied, "clampNotes": in.ClampNotes}
	reqJSON, _ := json.Marshal(requested)
	appliedJSON, _ := json.Marshal(in.Applied)
	hostsJSON, _ := json.Marshal(hosts)
	type stepRow struct {
		StepMeta
		Requests int `json:"requests"`
	}
	rows := make([]stepRow, 0, len(metas))
	for _, m := range metas {
		rows = append(rows, stepRow{m, 0})
	}
	stepsJSON, _ := json.Marshal(rows)

	if _, err := store.DB.Exec(
		`INSERT INTO hera_runs (id, suite_id, suite_name, status, config_json, applied_config_json, target_hosts_json,
		  k6_version, backend, owner_instance, heartbeat_at, started_at, samples_json, steps_json, confidence,
		  created_by_user_id, created_by_username, created_by_role, source_ip, env_id, env_name)
		 VALUES (?, ?, ?, 'queued', ?, ?, ?, ?, 'go', ?, ?, ?, '[]', ?, 'unknown', ?, ?, ?, ?, ?, ?)`,
		id, in.Suite.ID, in.Suite.Name, string(reqJSON), string(appliedJSON), string(hostsJSON),
		derefVersion(cap), store.InstanceID, now, now, string(stepsJSON),
		in.Actor.ID, in.Actor.Username, in.Actor.Role, in.Actor.IP,
		envIDArg(in.EnvID), envName,
	); err != nil {
		ReleaseLock(id)
		return StartRunResult{Status: 500, Error: err.Error()}
	}

	Audit("launch", id, in.Actor, in.Suite.ID, hosts, map[string]interface{}{
		"applied": in.Applied, "clampNotes": in.ClampNotes, "pinned": pinHosts,
		"envId": in.EnvID, "envName": envName,
	})
	envLabel := envName
	if envLabel == "" {
		envLabel = "(none)"
	}
	log.Printf("[hera] launch run=%s by=%s(%s) ip=%s suite=%s env=%s vus=%d duration=%ds rps=%d hosts=%s",
		id, in.Actor.Username, in.Actor.Role, in.Actor.IP, in.Suite.Name, envLabel,
		in.Applied.Vus, in.Applied.DurationSec, in.Applied.Rps, strings.Join(hosts, ","))

	// Register BEFORE spawning so an immediate stop is not lost in the gap
	// between the 202 response and k6 actually starting.
	activeMu.Lock()
	activeRuns[id] = &activeRun{stopTimer: make(chan struct{}), logs: NewLogRing(limits.LogLines, MaxLogRingBytes)}
	activeMu.Unlock()

	// Fire and forget; the UI polls GET /api/hera/:id.
	go execute(id, script, in.Applied)
	return StartRunResult{OK: true, ID: id}
}

// envIDArg keeps env_id NULL rather than an empty string when no environment
// was chosen, so the column reads the same as the Node backend writes it.
func envIDArg(envID string) interface{} {
	if envID == "" {
		return nil
	}
	return envID
}

func derefVersion(c Capability) string {
	if c.Version == nil {
		return ""
	}
	return *c.Version
}

func execute(id, script string, applied AppliedConfig) {
	defer func() {
		activeMu.Lock()
		delete(activeRuns, id)
		activeMu.Unlock()
		ReleaseLock(id)
	}()

	port, err := PickLoopbackPort()
	if err != nil {
		finalise(id, "error", nil, nil, -1, err.Error(), "", nil, "")
		return
	}
	collector := NewProgressCollector(port)
	collector.Start()
	// The ring was created in StartRun, before the spawn window, so a poll that
	// lands during it gets an empty log rather than "run not found".
	activeMu.Lock()
	logs := activeRuns[id].logsOrNew()
	activeMu.Unlock()
	handle, err := SpawnK6(SpawnOptions{
		Script: script, DurationSec: applied.DurationSec, Rps: applied.Rps, RunID: id, RestPort: port,
		// A shaped run schedules itself from the script; passing --duration would
		// flatten it back.
		ScheduleInScript: SchedulesInScript(DeriveProfile(applied.Mode, applied.Vus, applied.DurationSec, applied.Rps, applied.RatePerSec)),
		OnStderrLine:     logs.Push,
	})
	if err != nil {
		collector.Stop()
		finalise(id, "error", nil, nil, -1, err.Error(), "", nil, "")
		return
	}

	activeMu.Lock()
	entry := activeRuns[id]
	activeMu.Unlock()
	if entry == nil {
		entry = &activeRun{stopTimer: make(chan struct{})}
		activeMu.Lock()
		activeRuns[id] = entry
		activeMu.Unlock()
	}
	stopTimer := entry.stopTimer
	if entry.attach(handle, collector) {
		handle.Stop() // stop arrived while we were spawning
	}

	go func() {
		t := time.NewTicker(PersistInterval)
		defer t.Stop()
		for {
			select {
			case <-stopTimer:
				return
			case <-t.C:
				samples := collector.Samples()
				status := "ramping"
				for _, s := range samples {
					if s.Vus > 0 {
						status = "running"
						break
					}
				}
				_, _ = store.DB.Exec(
					"UPDATE hera_runs SET status = ?, samples_json = ? WHERE id = ? AND status IN ('queued','ramping','running')",
					status, trimSamples(samples), id)
				Heartbeat(id)
			}
		}
	}()

	result := handle.Wait()
	close(stopTimer)
	collector.PollOnce()
	collector.Stop()

	status := StatusForExit(result.ExitCode, result.Killed)
	var steps []StepStats
	var summary *RunSummary
	if result.Summary != nil {
		steps = result.Summary.Steps
		summary = &result.Summary.Summary
	}
	finalise(id, status, summary, steps, result.ExitCode, result.StderrTail, result.ParseError, collector.Samples(), result.Killed)
}

func finalise(id, status string, summary *RunSummary, steps []StepStats, exitCode int,
	stderrTail, parseError string, samples []Sample, killed string) {
	// A run that produced no summary cannot be called passed, whatever k6 said.
	if status == "passed" && summary == nil {
		status = "error"
	}
	stderr := stderrTail
	if parseError != "" {
		stderr = parseError + "\n" + stderrTail
	}
	if len(stderr) > MaxStderrBytes {
		stderr = stderr[len(stderr)-MaxStderrBytes:]
	}
	var summaryJSON interface{}
	if summary != nil {
		b, _ := json.Marshal(summary)
		summaryJSON = string(b)
	}
	if steps == nil {
		steps = []StepStats{}
	}
	stepsJSON, _ := json.Marshal(steps)
	if samples == nil {
		samples = []Sample{}
	}
	now := time.Now().UTC().Format(time.RFC3339)
	_, _ = store.DB.Exec(
		`UPDATE hera_runs SET status = ?, finished_at = ?, summary_json = ?, samples_json = ?, steps_json = ?,
		  stderr_tail = ?, exit_code = ?, heartbeat_at = ? WHERE id = ?`,
		status, now, summaryJSON, trimSamples(samples), string(stepsJSON), stderr, exitCode, now, id)
	log.Printf("[hera] finish run=%s status=%s exit=%d killed=%s", id, status, exitCode, orDash(killed))
	detail, _ := json.Marshal(map[string]interface{}{"status": status, "exitCode": exitCode, "killed": killed})
	_, _ = store.DB.Exec(
		`INSERT INTO hera_audit (id, at, event, run_id, backend, detail_json) VALUES (?, ?, 'finish', ?, 'go', ?)`,
		model.NewID(), now, id, string(detail))
}

func orDash(s string) string {
	if s == "" {
		return "-"
	}
	return s
}

// ---------- reads ----------

type RunListItem struct {
	ID         string          `json:"id"`
	SuiteID    string          `json:"suiteId"`
	SuiteName  string          `json:"suiteName"`
	Status     string          `json:"status"`
	EnvID      *string         `json:"envId"`
	EnvName    string          `json:"envName"`
	Config     json.RawMessage `json:"config"`
	StartedAt  string          `json:"startedAt"`
	FinishedAt *string         `json:"finishedAt"`
	Summary    json.RawMessage `json:"summary"`
	Confidence string          `json:"confidence"`
	K6Version  string          `json:"k6Version"`
	Backend    string          `json:"backend"`
	ExitCode   *int            `json:"exitCode"`
}

type RunDetail struct {
	RunListItem
	RequestedConfig json.RawMessage `json:"requestedConfig"`
	TargetHosts     json.RawMessage `json:"targetHosts"`
	Steps           json.RawMessage `json:"steps"`
	Samples         []Sample        `json:"samples"`
	SampleCount     int             `json:"sampleCount"`
	StderrTail      string          `json:"stderrTail"`
}

const runCols = `id, suite_id, suite_name, status, config_json, applied_config_json, target_hosts_json,
 k6_version, backend, exit_code, started_at, finished_at, summary_json, samples_json, steps_json, stderr_tail, confidence,
 env_id, env_name`

type rawRun struct {
	item        RunListItem
	requested   string
	targetHosts string
	samples     string
	steps       string
	stderr      string
}

func scanRun(scan func(dest ...interface{}) error) (*rawRun, error) {
	var (
		id, suiteID, suiteName, status, configJSON, appliedJSON, hostsJSON string
		k6Version, backend, samplesJSON, stepsJSON, stderr, confidence     string
		exitCode                                                           *int
		startedAt                                                          string
		finishedAt, summaryJSON, envID                                     *string
		envName                                                            string
	)
	if err := scan(&id, &suiteID, &suiteName, &status, &configJSON, &appliedJSON, &hostsJSON,
		&k6Version, &backend, &exitCode, &startedAt, &finishedAt, &summaryJSON, &samplesJSON, &stepsJSON, &stderr, &confidence,
		&envID, &envName); err != nil {
		return nil, err
	}
	item := RunListItem{
		ID: id, SuiteID: suiteID, SuiteName: suiteName, Status: status,
		EnvID: envID, EnvName: envName,
		Config: json.RawMessage(appliedJSON), StartedAt: startedAt, FinishedAt: finishedAt,
		Confidence: confidence, K6Version: k6Version, Backend: backend, ExitCode: exitCode,
	}
	if summaryJSON != nil {
		item.Summary = json.RawMessage(*summaryJSON)
	}
	return &rawRun{item: item, requested: configJSON, targetHosts: hostsJSON, samples: samplesJSON, steps: stepsJSON, stderr: stderr}, nil
}

func ListRuns(suiteID string) []RunListItem {
	var rows interface {
		Next() bool
		Scan(...interface{}) error
		Close() error
	}
	var err error
	if suiteID != "" {
		rows, err = store.DB.Query("SELECT "+runCols+" FROM hera_runs WHERE suite_id = ? ORDER BY started_at DESC LIMIT 100", suiteID)
	} else {
		rows, err = store.DB.Query("SELECT " + runCols + " FROM hera_runs ORDER BY started_at DESC LIMIT 100")
	}
	if err != nil {
		return []RunListItem{}
	}
	defer rows.Close()
	out := []RunListItem{}
	for rows.Next() {
		r, err := scanRun(rows.Scan)
		if err == nil {
			out = append(out, r.item)
		}
	}
	return out
}

func GetRun(id string, since *int) *RunDetail {
	row := store.DB.QueryRow("SELECT "+runCols+" FROM hera_runs WHERE id = ?", id)
	r, err := scanRun(row.Scan)
	if err != nil {
		return nil
	}
	all := []Sample{}
	_ = json.Unmarshal([]byte(r.samples), &all)
	filtered := all
	if since != nil {
		filtered = []Sample{}
		for _, s := range all {
			if s.T > *since {
				filtered = append(filtered, s)
			}
		}
	}
	return &RunDetail{
		RunListItem:     r.item,
		RequestedConfig: json.RawMessage(r.requested),
		TargetHosts:     json.RawMessage(r.targetHosts),
		Steps:           json.RawMessage(r.steps),
		Samples:         filtered,
		SampleCount:     len(all),
		StderrTail:      r.stderr,
	}
}

type RunLogs struct {
	LogSlice
	// RunBackend is which engine owns the row; the client uses it to re-target,
	// not to error.
	RunBackend string `json:"runBackend"`
	// Live is true while these lines are still arriving.
	Live bool `json:"live"`
	// Available is false when this process cannot see the run's logs at all.
	Available bool `json:"available"`
	// Source is where these lines came from, and the ONLY safe way to merge them.
	//
	// "live" numbering is the run's monotonic cursor, so a client appends what it
	// gets and passes Cursor back as ?sinceLine=. "tail" numbering restarts at 1
	// — the persisted column is a 64KB suffix of the output, not the whole of it
	// — so a client seeing "tail" must REPLACE its buffer rather than append, or
	// it shows every line twice the moment a run finishes. "none" means no lines
	// exist here at all; keep whatever you already have.
	Source string `json:"source"`
	Reason string `json:"reason,omitempty"`
}

// GetRunLogs returns logs for one run, from memory while we own it and from
// stderr_tail once it is over.
//
// The awkward case is a live run owned by the OTHER backend: both are up against
// one database, and a ring lives in the process that spawned k6. There is
// nothing to serve, so this says so explicitly instead of returning an empty
// list that reads as "k6 printed nothing".
func GetRunLogs(id string, sinceLine int) *RunLogs {
	var backend, status, tail string
	err := store.DB.QueryRow("SELECT backend, status, stderr_tail FROM hera_runs WHERE id = ?", id).
		Scan(&backend, &status, &tail)
	if err != nil {
		return nil
	}
	activeMu.Lock()
	entry := activeRuns[id]
	activeMu.Unlock()
	if entry != nil {
		if ring := entry.logsOrNew(); ring != nil {
			return &RunLogs{LogSlice: ring.Since(sinceLine), RunBackend: backend, Live: true, Available: true, Source: "live"}
		}
	}
	for _, s := range store.HeraActiveStatuses {
		if s == status {
			return &RunLogs{
				LogSlice:   LogSlice{Lines: []LogLine{}},
				RunBackend: backend,
				Live:       false,
				Available:  false,
				Source:     "none",
				Reason:     "This run is owned by the " + backend + " backend. Live output is only available there.",
			}
		}
	}
	return &RunLogs{LogSlice: SliceFromTail(tail), RunBackend: backend, Live: false, Available: true, Source: "tail"}
}

func DeleteRun(id string) {
	_, _ = store.DB.Exec("DELETE FROM hera_runs WHERE id = ?", id)
}
