package hera

import (
	"fmt"
	"sort"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/model"
)

// Suite -> k6 script generator.
//
// The output is the parity surface: backend/src/hera/script.ts must produce
// BYTE-IDENTICAL text for the same input, and the fixture harness diffs them.
// Determinism rules that make that possible:
//
//  1. no timestamps, UUIDs or randomness — a run id arrives as __ENV.HERA_RUN_ID
//  2. every map-like collection is emitted in a sorted, explicit order (Go map
//     iteration is deliberately randomised)
//  3. string literals go through jsLiteral below, not encoding/json — Go escapes
//     <, > and & where JSON.stringify does not
//  4. numbers are emitted via intLiteral, never a float formatter

type LoadConfig struct {
	Vus         int `json:"vus"`
	DurationSec int `json:"durationSec"`
	Rps         int `json:"rps"`
	// Mode is the shape of the run. Empty means "constant", which is what every
	// run was before profiles existed — so an old stored config still generates
	// the same script.
	Mode string `json:"mode,omitempty"`
	// RatePerSec is the target arrival rate for "rate" mode; nil means the server
	// ceiling.
	RatePerSec   *int `json:"ratePerSec,omitempty"`
	ThinkTimeMs  int  `json:"thinkTimeMs"`
	P95Ms        *int `json:"p95Ms"`
	ErrorRatePct *int `json:"errorRatePct"`
}

type StepMeta struct {
	StepID string `json:"stepId"`
	Tag    string `json:"tag"`
	Name   string `json:"name"`
	Method string `json:"method"`
	URL    string `json:"url"`
}

type FileMeta struct {
	Filename string `json:"filename"`
	Mime     string `json:"mime"`
}

type GenerateInput struct {
	Suite model.Suite
	// SeedVars are the statically resolvable variables, already merged.
	SeedVars map[string]string
	Load     LoadConfig
	// FilePaths maps fileId -> absolute path on this host.
	FilePaths map[string]string
	// FileMeta maps fileId -> original filename / mime for the multipart part.
	FileMetas map[string]FileMeta
	// HostHeader is an optional Host override from resolve-then-pin.
	HostHeader string
	// Hosts is resolve-then-pin via k6's own DNS override (options.hosts):
	// hostname ("host" or "host:port") -> validated IP. k6 consults it before
	// any lookup, so the run cannot be rebound — but the hostname stays in the
	// URL, so SNI and TLS certificate validation still work (a literal-IP URL
	// breaks HTTPS: the cert has no IP SANs).
	Hosts map[string]string
	// Diag carries failure-diagnostic settings, from server config rather than
	// the suite.
	//
	// Deliberately here and not in LoadConfig: the load config is persisted as
	// applied_config_json and echoed into the launch audit row, and an operator
	// knob does not belong in either. Nil keeps diagnostics off, which is what
	// the parity harness does for the pre-existing fixture cases.
	Diag *DiagConfig
}

type DiagConfig struct {
	Enabled bool `json:"enabled"`
	Max     int  `json:"max"`
	Body    bool `json:"body"`
	BodyMax int  `json:"bodyMax"`
}

// jsLiteral is a deterministic JS string literal. Deliberately not
// encoding/json: Go escapes <, > and & and the two languages disagree on
// U+2028/U+2029. Hand-rolling removes the whole class of divergence.
func jsLiteral(s string) string {
	var b strings.Builder
	b.WriteByte('"')
	for _, ch := range s {
		switch ch {
		case '"':
			b.WriteString("\\\"")
		case '\\':
			b.WriteString("\\\\")
		case '\n':
			b.WriteString("\\n")
		case '\r':
			b.WriteString("\\r")
		case '\t':
			b.WriteString("\\t")
		case 0x08:
			b.WriteString("\\b")
		case 0x0c:
			b.WriteString("\\f")
		case 0x2028:
			b.WriteString("\\u2028")
		case 0x2029:
			b.WriteString("\\u2029")
		default:
			if ch < 0x20 || ch == 0x7f {
				b.WriteString(fmt.Sprintf("\\u%04x", ch))
			} else {
				b.WriteRune(ch)
			}
		}
	}
	b.WriteByte('"')
	return b.String()
}

func intLiteral(n int) string {
	return fmt.Sprintf("%d", n)
}

func boolLiteral(v bool) string {
	if v {
		return "true"
	}
	return "false"
}

// percentLiteral turns an integer percent into a fixed-decimal rate literal by
// integer math only. Neither language's float formatter is involved, because
// they disagree (0.025 vs 2.5e-02) and the output must be byte-identical.
func percentLiteral(pct int) string {
	p := pct
	if p < 0 {
		p = 0
	}
	if p > 100 {
		p = 100
	}
	if p == 100 {
		return "1"
	}
	return fmt.Sprintf("0.%02d", p)
}

// StepTag returns s01, s02, ... — stable, unique, and safe inside a k6
// threshold selector.
func StepTag(index int) string {
	return fmt.Sprintf("s%02d", index+1)
}

func enabledSteps(s model.Suite) []model.Step {
	out := []model.Step{}
	for _, st := range s.Steps {
		if st.Enabled {
			out = append(out, st)
		}
	}
	return out
}

// StepMetas describes the enabled steps in execution order.
func StepMetas(s model.Suite) []StepMeta {
	steps := enabledSteps(s)
	metas := make([]StepMeta, 0, len(steps))
	for i, st := range steps {
		method := strings.ToUpper(st.Request.Method)
		if method == "" {
			method = "GET"
		}
		metas = append(metas, StepMeta{
			StepID: st.ID,
			Tag:    StepTag(i),
			Name:   st.Name,
			Method: method,
			URL:    st.Request.URL,
		})
	}
	return metas
}

func emitStepDef(step model.Step, meta StepMeta, in GenerateInput) string {
	L := []string{}
	L = append(L, "  {")
	L = append(L, "    stepId: "+jsLiteral(meta.StepID)+",")
	L = append(L, "    tag: "+jsLiteral(meta.Tag)+",")
	L = append(L, "    name: "+jsLiteral(meta.Name)+",")
	L = append(L, "    method: "+jsLiteral(meta.Method)+",")
	L = append(L, "    url: "+jsLiteral(step.Request.URL)+",")

	hs := []string{}
	for _, h := range step.Request.Headers {
		if h.Enabled && h.Key != "" {
			hs = append(hs, "["+jsLiteral(h.Key)+", "+jsLiteral(h.Value)+"]")
		}
	}
	L = append(L, "    headers: ["+strings.Join(hs, ", ")+"],")

	ps := []string{}
	for _, p := range step.Request.Params {
		if p.Enabled && p.Key != "" {
			ps = append(ps, "["+jsLiteral(p.Key)+", "+jsLiteral(p.Value)+"]")
		}
	}
	L = append(L, "    params: ["+strings.Join(ps, ", ")+"],")

	L = append(L, "    bodyMode: "+jsLiteral(step.Request.Body.Mode)+",")
	L = append(L, "    body: "+jsLiteral(step.Request.Body.Content)+",")

	fd := []string{}
	for _, f := range step.Request.Body.FormData {
		if !f.Enabled || f.Key == "" {
			continue
		}
		if f.Type == "file" {
			fm, ok := in.FileMetas[f.FileID]
			if !ok {
				fm = FileMeta{Filename: "file", Mime: "application/octet-stream"}
			}
			fd = append(fd, "{ kind: \"file\", key: "+jsLiteral(f.Key)+
				", fileId: "+jsLiteral(f.FileID)+
				", filename: "+jsLiteral(fm.Filename)+
				", mime: "+jsLiteral(fm.Mime)+" }")
		} else {
			fd = append(fd, "{ kind: \"text\", key: "+jsLiteral(f.Key)+", value: "+jsLiteral(f.Value)+" }")
		}
	}
	L = append(L, "    formData: ["+strings.Join(fd, ", ")+"],")

	switch step.Request.Auth.Type {
	case "bearer":
		L = append(L, "    auth: { type: \"bearer\", token: "+jsLiteral(step.Request.Auth.Token)+" },")
	case "basic":
		L = append(L, "    auth: { type: \"basic\", username: "+jsLiteral(step.Request.Auth.Username)+
			", password: "+jsLiteral(step.Request.Auth.Password)+" },")
	default:
		L = append(L, "    auth: { type: \"none\" },")
	}

	as := []string{}
	for _, a := range step.Validations.Visual {
		as = append(as, "{ type: "+jsLiteral(a.Type)+
			", expression: "+jsLiteral(a.Expression)+
			", expected: "+jsLiteral(a.Expected)+" }")
	}
	L = append(L, "    assertions: ["+strings.Join(as, ", ")+"],")

	cs := []string{}
	for _, c := range step.Captures.Visual {
		cs = append(cs, "{ source: "+jsLiteral(c.Source)+
			", expression: "+jsLiteral(c.Expression)+
			", target: "+jsLiteral(c.TargetVariable)+
			", scope: "+jsLiteral(c.Scope)+" }")
	}
	L = append(L, "    captures: ["+strings.Join(cs, ", ")+"],")

	L = append(L, "    validateScript: "+jsLiteral(step.Validations.Script)+",")
	L = append(L, "    captureScript: "+jsLiteral(step.Captures.Script)+",")

	if step.Polling != nil && step.Polling.Enabled {
		L = append(L, "    polling: { enabled: true, intervalMs: "+intLiteral(step.Polling.IntervalMs)+
			", timeoutMs: "+intLiteral(step.Polling.TimeoutMs)+
			", stopScript: "+jsLiteral(step.Polling.StopScript)+" },")
	} else {
		L = append(L, "    polling: null,")
	}

	hostHeader := in.HostHeader
	if hostHeader != "" {
		L = append(L, "    hostHeader: "+jsLiteral(hostHeader)+",")
	} else {
		L = append(L, "    hostHeader: null,")
	}
	L = append(L, "  }")
	return strings.Join(L, "\n")
}

// GenerateScript renders the k6 script and the step metadata describing it.
func GenerateScript(in GenerateInput) (string, []StepMeta) {
	steps := enabledSteps(in.Suite)
	metas := StepMetas(in.Suite)
	load := in.Load
	L := []string{}

	L = append(L, "// Generated by Hermes / Hera — do not edit.")
	L = append(L, "// One iteration = the whole suite, chained, walked by one virtual user.")
	L = append(L, "// Suite: "+strings.NewReplacer("\r", " ", "\n", " ").Replace(in.Suite.Name))
	L = append(L, "")
	L = append(L, "import http from 'k6/http';")
	L = append(L, "import { check, group, sleep } from 'k6';")
	L = append(L, "import { Counter, Trend } from 'k6/metrics';")
	L = append(L, "import { b64encode } from 'k6/encoding';")
	L = append(L, "")

	// Metrics. hera_script_errors carries a count==0 threshold because a thrown
	// exception in a VU exits 0 — the exit code alone can never be the verdict.
	L = append(L, "var heraScriptErrors = new Counter('hera_script_errors');")
	L = append(L, "var heraGlobalWrites = new Counter('hera_suppressed_global_writes');")
	L = append(L, "var heraPollAttempts = new Trend('hera_poll_attempts');")
	L = append(L, "var heraPollWaitMs = new Trend('hera_poll_wait_ms', true);")
	L = append(L, "")

	L = append(L, "var HERA_STOP_ON_FAILURE = "+boolLiteral(in.Suite.Settings.StopOnFailure)+";")
	L = append(L, "var HERA_RUN_CAPTURES_ON_FAILURE = "+boolLiteral(in.Suite.Settings.RunCapturesOnFailure)+";")
	L = append(L, "var HERA_THINK_TIME_MS = "+intLiteral(load.ThinkTimeMs)+";")
	diag := in.Diag
	if diag == nil {
		diag = &DiagConfig{}
	}
	L = append(L, "var HERA_DIAG = "+boolLiteral(diag.Enabled)+";")
	L = append(L, "var HERA_DIAG_MAX = "+intLiteral(diag.Max)+";")
	L = append(L, "var HERA_DIAG_BODY = "+boolLiteral(diag.Body)+";")
	L = append(L, "var HERA_DIAG_BODY_MAX = "+intLiteral(diag.BodyMax)+";")
	L = append(L, "")

	// Files opened at init scope — k6 requires open() there. The bytes already
	// live in the managed file store, so nothing new is written to disk.
	fileIDs := make([]string, 0, len(in.FilePaths))
	for id := range in.FilePaths {
		fileIDs = append(fileIDs, id)
	}
	sort.Strings(fileIDs)
	if len(fileIDs) > 0 {
		L = append(L, "var HERA_FILES = {")
		for _, id := range fileIDs {
			L = append(L, "  "+jsLiteral(id)+": open("+jsLiteral(in.FilePaths[id])+", 'b'),")
		}
		L = append(L, "};")
	} else {
		L = append(L, "var HERA_FILES = {};")
	}
	L = append(L, "")

	// Seed variables as sorted pairs, so both languages emit the same order.
	seedKeys := make([]string, 0, len(in.SeedVars))
	for k := range in.SeedVars {
		seedKeys = append(seedKeys, k)
	}
	sort.Strings(seedKeys)
	L = append(L, "var HERA_SEED = [")
	for _, k := range seedKeys {
		L = append(L, "  ["+jsLiteral(k)+", "+jsLiteral(in.SeedVars[k])+"],")
	}
	L = append(L, "];")
	L = append(L, "")

	defs := make([]string, 0, len(steps))
	for i, st := range steps {
		defs = append(defs, emitStepDef(st, metas[i], in))
	}
	L = append(L, "var HERA_STEPS = [")
	L = append(L, strings.Join(defs, ",\n"))
	L = append(L, "];")
	L = append(L, "")

	// Thresholds. Per-step sub-metrics only appear in the summary when a
	// threshold names them, so each step gets always-true thresholds purely to
	// surface its numbers. The real pass/fail thresholds come after.
	th := []string{}
	th = append(th, "  'hera_script_errors': ['count==0'],")
	for _, m := range metas {
		sel := "{hera_step:" + m.Tag + "}"
		th = append(th, "  'http_req_duration"+sel+"': ['max>=0'],")
		th = append(th, "  'http_req_failed"+sel+"': ['rate>=0'],")
		th = append(th, "  'http_reqs"+sel+"': ['count>=0'],")
		// Without this the per-step script-error count is always reported as 0,
		// because a tagged sub-metric only reaches the summary if a threshold
		// names it — and then you cannot tell WHICH step's script is broken.
		th = append(th, "  'hera_script_errors"+sel+"': ['count>=0'],")
	}
	for i, st := range steps {
		if st.Polling != nil && st.Polling.Enabled {
			sel := "{hera_step:" + metas[i].Tag + "}"
			th = append(th, "  'hera_poll_attempts"+sel+"': ['max>=0'],")
			th = append(th, "  'hera_poll_wait_ms"+sel+"': ['max>=0'],")
		}
	}
	if load.P95Ms != nil {
		th = append(th, "  'http_req_duration': ['p(95)<"+intLiteral(*load.P95Ms)+"'],")
	}
	if load.ErrorRatePct != nil {
		th = append(th, "  'http_req_failed': ['rate<"+percentLiteral(*load.ErrorRatePct)+"'],")
	}

	// The profile decides HOW the run is scheduled. Exactly one of scenarios,
	// stages or vus+duration is emitted: k6 accepts more than one and then
	// silently prefers a different combination than the reader expects.
	mode := load.Mode
	if !IsMode(mode) {
		mode = "constant"
	}
	profile := DeriveProfile(mode, load.Vus, load.DurationSec, load.Rps, load.RatePerSec)

	L = append(L, "export var options = {")
	if profile.RatePerSec != nil {
		L = append(L, "  scenarios: {")
		L = append(L, "    hera: {")
		// Arrival-rate, not VU-driven: throughput stays fixed while the target
		// slows down, which is the only way to see a queue actually build.
		L = append(L, "      executor: 'constant-arrival-rate',")
		L = append(L, "      rate: "+intLiteral(*profile.RatePerSec)+",")
		L = append(L, "      timeUnit: '1s',")
		L = append(L, "      duration: '"+intLiteral(profile.DurationSec)+"s',")
		L = append(L, "      preAllocatedVUs: "+intLiteral(profile.Vus)+",")
		L = append(L, "      maxVUs: "+intLiteral(profile.Vus)+",")
		L = append(L, "    },")
		L = append(L, "  },")
	} else if len(profile.Stages) > 0 {
		L = append(L, "  stages: [")
		for _, s := range profile.Stages {
			L = append(L, "    { duration: '"+intLiteral(s.DurationSec)+"s', target: "+intLiteral(s.Target)+" },")
		}
		L = append(L, "  ],")
	} else {
		L = append(L, "  vus: "+intLiteral(profile.Vus)+",")
		L = append(L, "  duration: '"+intLiteral(profile.DurationSec)+"s',")
	}
	L = append(L, "  rps: "+intLiteral(load.Rps)+",")
	L = append(L, "  maxRedirects: 0,")
	// Resolve-then-pin as a k6 DNS override: each hostname is forced to the IP we
	// validated, but the hostname stays in the request so TLS/SNI still work.
	hostKeys := make([]string, 0, len(in.Hosts))
	for h := range in.Hosts {
		hostKeys = append(hostKeys, h)
	}
	sort.Strings(hostKeys)
	if len(hostKeys) > 0 {
		L = append(L, "  hosts: {")
		for _, h := range hostKeys {
			L = append(L, "    "+jsLiteral(h)+": "+jsLiteral(in.Hosts[h])+",")
		}
		L = append(L, "  },")
	}
	L = append(L, "  summaryTrendStats: ['min', 'avg', 'med', 'p(90)', 'p(95)', 'p(99)', 'max'],")
	L = append(L, "  thresholds: {")
	L = append(L, strings.Join(th, "\n"))
	L = append(L, "  },")
	L = append(L, "};")

	L = append(L, heraPrelude)

	return strings.Join(L, "\n"), metas
}
