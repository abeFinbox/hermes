package runner

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"mime/multipart"
	"net/http"
	"net/textproto"
	"net/url"
	"os"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"sync"
	"time"

	"github.com/finbox/hermes/backend-go/internal/dynvars"
	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/store"
	"github.com/ohler55/ojg/jp"
	"github.com/ohler55/ojg/oj"
)

const maxStoredBody = 64 * 1024               // request-body preview cap
const maxRunResponseBody = 5 * 1024 * 1024    // persisted-run response cap (single-step Send is uncapped)
const maxPollMs = 5 * 60 * 1000 // hard cap on total polling duration per step
const maxPollAttemptBody = 8 * 1024 // per-attempt body kept for poll history
const maxPollAttempts = 50          // keep the most recent N attempts

// sleepCtx waits d, returning false early if ctx is cancelled (run stopped).
func sleepCtx(ctx context.Context, d time.Duration) bool {
	t := time.NewTimer(d)
	defer t.Stop()
	select {
	case <-ctx.Done():
		return false
	case <-t.C:
		return true
	}
}

// ---------- variable resolution ----------

// VarScope resolves {{variables}} with runtime > environment > global > suite
// precedence, mirroring the TS VarScope (see Get for why suite is last).
type VarScope struct {
	globalVars   map[string]string
	envVars      map[string]string
	suiteVars    map[string]string
	runtimeVars  map[string]string
	secretValues map[string]bool // non-empty secret variable values → used to redact curl
	GlobalsDirty bool
}

// NewVarScope builds a scope with no environment layer.
func NewVarScope(suite model.Suite) *VarScope {
	return NewVarScopeEnv(suite, "")
}

// NewVarScopeEnv layers one environment's variables over the globals. An empty
// or unknown envID gives an empty layer, so a deleted environment degrades to
// "no environment" rather than breaking every run that referenced it.
func NewVarScopeEnv(suite model.Suite, envID string) *VarScope {
	vs := &VarScope{
		globalVars:   map[string]string{},
		envVars:      map[string]string{},
		suiteVars:    map[string]string{},
		runtimeVars:  map[string]string{},
		secretValues: map[string]bool{},
	}
	if globals, err := store.GetGlobals(); err == nil {
		for _, g := range globals {
			vs.globalVars[g.Key] = g.Value
			if g.Secret && g.Value != "" {
				vs.secretValues[g.Value] = true
			}
		}
	}
	for _, e := range store.GetEnvVars(envID) {
		vs.envVars[e.Key] = e.Value
		if e.Secret && e.Value != "" {
			vs.secretValues[e.Value] = true
		}
	}
	for _, v := range suite.Variables {
		vs.suiteVars[v.Key] = v.Value
		if v.Secret && v.Value != "" {
			vs.secretValues[v.Value] = true
		}
	}
	return vs
}

/*
Get resolves in order: runtime > environment > global > suite.

This deliberately does NOT match Postman, where collection (suite) variables
outrank the environment and globals. The reason is what suite variables actually
are here: mostly values carried in by a Postman import — a base_url pointing at
whatever host the collection was recorded against. With Postman's order those
imported values silently shadowed the environment, so switching environment
changed nothing. Suite variables are therefore the FALLBACK layer.

Captures are unaffected: a capture with scope "suite" also writes the runtime
layer (see Set), which is still the top of the chain.
*/
func (vs *VarScope) Get(key string) (string, bool) {
	// Dynamic variables are generated, not looked up, and are checked FIRST: no
	// scope can shadow them because a stored variable name can never start with
	// '$'. Evaluated per call, so two {{$guid}} differ — see package dynvars.
	if v, ok := dynvars.Value(key); ok {
		return v, true
	}
	if v, ok := vs.runtimeVars[key]; ok {
		return v, true
	}
	if v, ok := vs.envVars[key]; ok {
		return v, true
	}
	if v, ok := vs.globalVars[key]; ok {
		return v, true
	}
	if v, ok := vs.suiteVars[key]; ok {
		return v, true
	}
	return "", false
}

// Set writes into one scope layer.
//
// NOTE on scope "global" while an environment is selected: the write lands in
// global_variables as asked, but a same-named environment variable still wins on
// read for the rest of the run (see Get) — the environment is the more specific
// layer. Capture to suite/runtime scope if the value must be the one that
// resolves; both also write the runtime layer, which outranks everything.
func (vs *VarScope) Set(key, value, scope string) {
	switch scope {
	case "global":
		vs.globalVars[key] = value
		_ = store.SetGlobal(key, value, false)
		vs.GlobalsDirty = true
	case "suite":
		vs.suiteVars[key] = value
		vs.runtimeVars[key] = value
	default:
		vs.runtimeVars[key] = value
	}
}

var varRe = regexp.MustCompile(`\{\{\s*([^}\s]+)\s*\}\}`)
var anyVarRe = regexp.MustCompile(`\{\{[^}]+\}\}`)

func (vs *VarScope) Resolve(text string) string {
	if text == "" {
		return text
	}
	out := text
	for i := 0; i < 5 && anyVarRe.MatchString(out); i++ {
		out = varRe.ReplaceAllStringFunc(out, func(m string) string {
			key := varRe.FindStringSubmatch(m)[1]
			if v, ok := vs.Get(key); ok {
				return v
			}
			return m
		})
	}
	return out
}

func (vs *VarScope) RedactSecrets(text string) string {
	out := text
	for sv := range vs.secretValues {
		out = strings.ReplaceAll(out, sv, "<redacted>")
	}
	return out
}

func (vs *VarScope) UnresolvedIn(text string) []string {
	resolved := vs.Resolve(text)
	var out []string
	for _, m := range varRe.FindAllStringSubmatch(resolved, -1) {
		out = append(out, m[1])
	}
	return out
}

// ---------- visual assertions & captures ----------

// jsonPathFirst returns the first JSONPath match and whether one existed.
func jsonPathFirst(bodyText, expression string) (interface{}, bool, error) {
	data, err := oj.ParseString(bodyText)
	if err != nil {
		return nil, false, err
	}
	path := expression
	if !strings.HasPrefix(path, "$") {
		path = "$." + path
	}
	expr, err := jp.ParseString(path)
	if err != nil {
		return nil, false, err
	}
	results := expr.Get(data)
	if len(results) == 0 {
		return nil, false, nil
	}
	return results[0], true, nil
}

// stringifyValue mirrors `typeof v === 'string' ? v : JSON.stringify(v)`.
func stringifyValue(v interface{}) string {
	if s, ok := v.(string); ok {
		return s
	}
	b, _ := json.Marshal(v)
	return string(b)
}

func runVisualAssertion(a model.Assertion, resp SandboxResponse) model.AssertionResult {
	name := model.DescribeAssertion(a)
	res := model.AssertionResult{Name: name}
	switch a.Type {
	case "status-equals":
		exp := atoiOr(a.Expected, 0)
		res.Passed = resp.Status == exp
		if !res.Passed {
			res.Message = fmt.Sprintf("got %d", resp.Status)
		}
	case "jsonpath-exists":
		_, found, err := jsonPathFirst(resp.BodyText, a.Expression)
		if err != nil {
			return model.AssertionResult{Name: name, Passed: false, Message: err.Error()}
		}
		res.Passed = found
		if !found {
			res.Message = "path not found"
		}
	case "jsonpath-equals":
		v, found, err := jsonPathFirst(resp.BodyText, a.Expression)
		if err != nil {
			return model.AssertionResult{Name: name, Passed: false, Message: err.Error()}
		}
		actual := ""
		if found {
			actual = stringifyValue(v)
		}
		res.Passed = found && actual == a.Expected
		if !res.Passed {
			res.Message = "got " + actual
		}
	case "header-equals":
		actual, ok := resp.Headers[strings.ToLower(a.Expression)]
		res.Passed = ok && actual == a.Expected
		if !res.Passed {
			shown := "(missing)"
			if ok {
				shown = actual
			}
			res.Message = "got " + shown
		}
	case "body-contains":
		res.Passed = strings.Contains(resp.BodyText, a.Expected)
		if !res.Passed {
			res.Message = "text not found in body"
		}
	case "response-time-below":
		limit := atoiOr(a.Expected, 0)
		res.Passed = resp.Time < float64(limit)
		if !res.Passed {
			res.Message = fmt.Sprintf("took %sms", trimFloat(resp.Time))
		}
	default:
		res.Passed = false
		res.Message = "unknown assertion type " + a.Type
	}
	return res
}

func runVisualCapture(c model.CaptureRule, resp SandboxResponse) (string, error) {
	switch c.Source {
	case "status":
		return strconv.Itoa(resp.Status), nil
	case "header":
		v, ok := resp.Headers[strings.ToLower(c.Expression)]
		if !ok {
			return "", fmt.Errorf("header %q not present", c.Expression)
		}
		return v, nil
	case "body-text":
		return resp.BodyText, nil
	case "body-jsonpath":
		v, found, err := jsonPathFirst(resp.BodyText, c.Expression)
		if err != nil {
			return "", err
		}
		if !found {
			return "", fmt.Errorf("JSONPath %q matched nothing", c.Expression)
		}
		return stringifyValue(v), nil
	}
	return "", fmt.Errorf("unknown capture source %s", c.Source)
}

// ---------- script bench (try a script against a hand-written response) ----------
//
// Go port of runScriptBench in backend/src/runner/executor.ts. Dry-runs a
// validation / capture / poll-stop script against a response the user types in:
// no HTTP request, and nothing persisted — not even a global-scope capture.

type BenchResponse struct {
	Status     int               `json:"status"`
	StatusText string            `json:"statusText"`
	Headers    map[string]string `json:"headers"`
	TimeMs     float64           `json:"timeMs"`
	Body       string            `json:"body"`
}

type ScriptBenchInput struct {
	Mode             string                `json:"mode"` // validate | capture | poll
	Code             string                `json:"code"`
	VisualAssertions []model.Assertion     `json:"visualAssertions"`
	VisualCaptures   []model.CaptureRule   `json:"visualCaptures"`
	Response         BenchResponse         `json:"response"`
	SuiteVariables   []model.SuiteVariable `json:"suiteVariables"`
	EnvID            string                `json:"envId"`
}

type BenchVariable struct {
	Key   string `json:"key"`
	Value string `json:"value"`
}

type ScriptBenchResult struct {
	Mode          string                `json:"mode"`
	Assertions    []model.AssertionResult `json:"assertions"`
	Captured      []model.CapturedValue   `json:"captured"`
	Logs          []string                `json:"logs"`
	StopRequested bool                    `json:"stopRequested"`
	Failed        bool                    `json:"failed"`
	Error         string                  `json:"error,omitempty"`
	UsedVariables []BenchVariable         `json:"usedVariables"`
}

func RunScriptBench(in ScriptBenchInput) ScriptBenchResult {
	suite := model.Suite{
		ID: "bench", Name: "bench", Steps: []model.Step{},
		Variables: in.SuiteVariables, Settings: model.DefaultSettings(),
	}
	if suite.Variables == nil {
		suite.Variables = []model.SuiteVariable{}
	}
	scope := NewVarScopeEnv(suite, in.EnvID)

	status := in.Response.Status
	if status == 0 {
		status = 200
	}
	statusText := in.Response.StatusText
	if statusText == "" {
		statusText = "OK"
	}
	headers := map[string]string{}
	for k, v := range in.Response.Headers {
		headers[strings.ToLower(k)] = v
	}
	resp := SandboxResponse{
		Status: status, StatusText: statusText, Headers: headers,
		Time: in.Response.TimeMs, BodyText: in.Response.Body,
	}

	assertions := []model.AssertionResult{}
	captured := []model.CapturedValue{}
	usedKeys := map[string]bool{}

	if in.Mode == "validate" {
		for _, a := range in.VisualAssertions {
			assertions = append(assertions, runVisualAssertion(a, resp))
		}
	}
	if in.Mode == "capture" {
		for _, c := range in.VisualCaptures {
			value, err := runVisualCapture(c, resp)
			if err != nil {
				assertions = append(assertions, model.AssertionResult{
					Name: "capture " + c.TargetVariable, Passed: false, Message: err.Error(),
				})
				continue
			}
			// Held in runtime scope even when the rule says "global": a bench run
			// must not write to global_variables. The REPORTED scope stays the
			// rule's own, so the reader still sees where a real run would put it.
			writeScope := c.Scope
			if writeScope == "global" {
				writeScope = "runtime"
			}
			scope.Set(c.TargetVariable, value, writeScope)
			captured = append(captured, model.CapturedValue{Key: c.TargetVariable, Value: value, Scope: c.Scope})
		}
	}

	outcome := RunScript(in.Code, resp, func(key string) (string, bool) {
		usedKeys[key] = true
		return scope.Get(key)
	}, in.Mode)
	assertions = append(assertions, outcome.Tests...)
	// Bench writes are NOT persisted: a global-scope capture here would edit real
	// global variables from a form the user is only experimenting in.
	for _, sv := range outcome.SetVariables {
		captured = append(captured, model.CapturedValue{Key: sv.Key, Value: sv.Value, Scope: sv.Scope})
	}

	failed := outcome.Failed
	for _, a := range assertions {
		if !a.Passed {
			failed = true
		}
	}

	keys := make([]string, 0, len(usedKeys))
	for k := range usedKeys {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	used := make([]BenchVariable, 0, len(keys))
	for _, k := range keys {
		v, _ := scope.Get(k)
		used = append(used, BenchVariable{Key: k, Value: v})
	}

	logs := outcome.Logs
	if logs == nil {
		logs = []string{}
	}
	return ScriptBenchResult{
		Mode: in.Mode, Assertions: assertions, Captured: captured, Logs: logs,
		StopRequested: outcome.StopRequested, Failed: failed, Error: outcome.Error,
		UsedVariables: used,
	}
}

// ---------- step execution ----------

type ExecuteOpts struct {
	Ctx      context.Context
	WithCurl bool
	FullBody bool
}

var sharedClient = &http.Client{
	CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return http.ErrUseLastResponse
		}
		return nil
	},
}

// ExecuteStep runs a single step: build request, send, validate, capture.
func ExecuteStep(step model.Step, scope *VarScope, suite model.Suite, opts ExecuteOpts) model.StepResult {
	ctx := opts.Ctx
	if ctx == nil {
		ctx = context.Background()
	}
	result := model.StepResult{StepID: step.ID, Name: step.Name, Status: "passed", Assertions: []model.AssertionResult{}, Captured: []model.CapturedValue{}, Logs: []string{}}

	method := strings.ToUpper(step.Request.Method)
	reqURL := scope.Resolve(strings.TrimSpace(step.Request.URL))
	headers := map[string]string{}
	for _, h := range step.Request.Headers {
		if h.Enabled && h.Key != "" {
			headers[scope.Resolve(h.Key)] = scope.Resolve(h.Value)
		}
	}

	var params []model.KV
	for _, p := range step.Request.Params {
		if p.Enabled && p.Key != "" {
			params = append(params, p)
		}
	}
	if len(params) > 0 {
		var qsParts []string
		for _, p := range params {
			qsParts = append(qsParts, url.QueryEscape(scope.Resolve(p.Key))+"="+url.QueryEscape(scope.Resolve(p.Value)))
		}
		qs := strings.Join(qsParts, "&")
		base, existing, hasQ := strings.Cut(reqURL, "?")
		if hasQ && existing != "" {
			reqURL = base + "?" + existing + "&" + qs
		} else {
			reqURL = base + "?" + qs
		}
	}

	switch step.Request.Auth.Type {
	case "bearer":
		headers["Authorization"] = "Bearer " + scope.Resolve(step.Request.Auth.Token)
	case "basic":
		cred := base64.StdEncoding.EncodeToString([]byte(scope.Resolve(step.Request.Auth.Username) + ":" + scope.Resolve(step.Request.Auth.Password)))
		headers["Authorization"] = "Basic " + cred
	}

	var bodyBytes []byte
	var bodyPreview *string
	var multipartContentType string
	bodilessMethod := method == "GET" || method == "HEAD"
	sendsBody := step.Request.Body.Mode != "none" && (!bodilessMethod || step.Request.Body.SendWithGet)

	if sendsBody && step.Request.Body.Mode == "form-data" {
		var buf bytes.Buffer
		mw := multipart.NewWriter(&buf)
		var summary []string
		for _, f := range step.Request.Body.FormData {
			if !f.Enabled || f.Key == "" {
				continue
			}
			key := scope.Resolve(f.Key)
			if f.Type == "file" {
				path, name, mime, ok := store.ResolveStoredFile(f.FileID)
				if !ok {
					result.Status = "error"
					result.Error = fmt.Sprintf("Field %q isn't linked to a file in the store. Open this request's form-data body and re-select the file from the dropdown. (A re-uploaded file gets a new id, so re-uploading alone won't fix it — you must pick it again.)", key)
					result.Request = &model.RequestSnapshot{Method: method, URL: reqURL, Headers: redactHeaders(headers)}
					return result
				}
				data, err := os.ReadFile(path)
				if err != nil {
					result.Status = "error"
					result.Error = fmt.Sprintf("Field %q file could not be read: %v", key, err)
					return result
				}
				h := textproto.MIMEHeader{}
				h.Set("Content-Disposition", fmt.Sprintf(`form-data; name="%s"; filename="%s"`, key, name))
				if mime != "" {
					h.Set("Content-Type", mime)
				}
				part, _ := mw.CreatePart(h)
				part.Write(data)
				summary = append(summary, fmt.Sprintf("%s=@%s (%d bytes)", key, name, len(data)))
			} else {
				value := scope.Resolve(f.Value)
				mw.WriteField(key, value)
				summary = append(summary, fmt.Sprintf("%s=%s", key, value))
			}
		}
		mw.Close()
		bodyBytes = buf.Bytes()
		multipartContentType = mw.FormDataContentType()
		p := fmt.Sprintf("multipart/form-data — %d field(s): %s", len(summary), strings.Join(summary, ", "))
		bodyPreview = &p
	} else if sendsBody {
		text := scope.Resolve(step.Request.Body.Content)
		bodyBytes = []byte(text)
		bodyPreview = &text
		if step.Request.Body.Mode == "json" && !hasHeaderCI(headers, "content-type") {
			headers["Content-Type"] = "application/json"
		}
		if step.Request.Body.Mode == "form" && !hasHeaderCI(headers, "content-type") {
			headers["Content-Type"] = "application/x-www-form-urlencoded"
		}
	}

	unresolved := scope.UnresolvedIn(reqURL)
	snap := &model.RequestSnapshot{Method: method, URL: reqURL, Headers: redactHeaders(headers)}
	if bodyPreview != nil {
		bp := *bodyPreview
		if len(bp) > maxStoredBody {
			bp = bp[:maxStoredBody]
		}
		snap.Body = &bp
	}
	result.Request = snap
	// Send (fullBody) gets a paste-runnable curl; persisted runs get a redacted one.
	if opts.WithCurl {
		result.Curl = buildCurl(method, reqURL, headers, step, scope, !opts.FullBody)
	}
	if len(unresolved) > 0 {
		var parts []string
		for _, u := range unresolved {
			parts = append(parts, "{{"+u+"}}")
		}
		result.Status = "error"
		result.Error = "Unresolved variables in URL: " + strings.Join(parts, ", ")
		return result
	}

	// send — one attempt. Returns the response, or done=true with a terminal
	// outcome ('skipped'/'error') already recorded on result.
	sendOnce := func() (SandboxResponse, bool) {
		timeout := time.Duration(suite.Settings.RequestTimeoutMs) * time.Millisecond
		reqCtx, cancel := context.WithTimeout(ctx, timeout)
		defer cancel()
		var bodyReader io.Reader
		if bodyBytes != nil {
			bodyReader = bytes.NewReader(bodyBytes)
		}
		httpReq, err := http.NewRequestWithContext(reqCtx, method, reqURL, bodyReader)
		if err != nil {
			result.Status = "error"
			result.Error = "Request failed: " + err.Error()
			return SandboxResponse{}, true
		}
		for k, v := range headers {
			httpReq.Header.Set(k, v)
		}
		if multipartContentType != "" {
			httpReq.Header.Set("Content-Type", multipartContentType)
		}
		started := time.Now()
		httpResp, err := sharedClient.Do(httpReq)
		if err != nil {
			if ctx.Err() != nil {
				result.Status = "skipped"
				result.Error = "Stopped"
				return SandboxResponse{}, true
			}
			result.Status = "error"
			result.Error = "Request failed: " + err.Error()
			return SandboxResponse{}, true
		}
		defer httpResp.Body.Close()
		rawBody, _ := io.ReadAll(httpResp.Body)
		timeMs := float64(time.Since(started).Milliseconds())
		respHeaders := map[string]string{}
		for k, vals := range httpResp.Header {
			respHeaders[strings.ToLower(k)] = strings.Join(vals, ", ")
		}
		return SandboxResponse{
			Status: httpResp.StatusCode, StatusText: http.StatusText(httpResp.StatusCode),
			Headers: respHeaders, Time: timeMs, BodyText: string(rawBody),
		}, false
	}

	var resp SandboxResponse
	if poll := step.Polling; poll != nil && poll.Enabled && strings.TrimSpace(poll.StopScript) != "" {
		// re-send on an interval until stop() is called or the timeout elapses
		timeoutMs := poll.TimeoutMs
		if timeoutMs < 1000 {
			timeoutMs = 1000
		}
		if timeoutMs > maxPollMs {
			timeoutMs = maxPollMs
		}
		intervalMs := poll.IntervalMs
		if intervalMs < 250 {
			intervalMs = 250
		}
		deadline := time.Now().Add(time.Duration(timeoutMs) * time.Millisecond)
		startedAt := time.Now()
		attemptsLog := []model.PollAttempt{}
		stopped := false
		attempts := 0
		for {
			r, done := sendOnce()
			if done {
				return result
			}
			resp = r
			attempts++
			out := RunScript(poll.StopScript, resp, scope.Get, "poll")
			result.Logs = append(result.Logs, out.Logs...)
			// record this attempt's response so the UI can show poll history
			body := resp.BodyText
			truncated := false
			if len(body) > maxPollAttemptBody {
				body = body[:maxPollAttemptBody]
				truncated = true
			}
			attemptsLog = append(attemptsLog, model.PollAttempt{
				Attempt: attempts, Status: resp.Status, StatusText: resp.StatusText, TimeMs: resp.Time,
				Body: body, BodyTruncated: truncated, Stopped: out.StopRequested,
			})
			if len(attemptsLog) > maxPollAttempts {
				attemptsLog = attemptsLog[len(attemptsLog)-maxPollAttempts:]
			}
			if out.Error != "" {
				result.Assertions = append(result.Assertions, model.AssertionResult{Name: "poll stop condition", Passed: false, Message: out.Error})
				result.Status = "failed"
				break
			}
			if out.StopRequested {
				stopped = true
				break
			}
			if !time.Now().Add(time.Duration(intervalMs) * time.Millisecond).Before(deadline) {
				break
			}
			if ctx.Err() != nil {
				result.Status = "skipped"
				result.Error = "Stopped"
				return result
			}
			if !sleepCtx(ctx, time.Duration(intervalMs)*time.Millisecond) {
				result.Status = "skipped"
				result.Error = "Stopped"
				return result
			}
		}
		result.PollAttempts = attemptsLog
		result.Logs = append(result.Logs, fmt.Sprintf("[poll] %d attempt(s) over %dms", attempts, time.Since(startedAt).Milliseconds()))
		if !stopped && result.Status == "passed" {
			result.Assertions = append(result.Assertions, model.AssertionResult{Name: "polling", Passed: false, Message: fmt.Sprintf("Stop condition not met within %dms (%d attempts)", timeoutMs, attempts)})
			result.Status = "failed"
		}
	} else {
		r, done := sendOnce()
		if done {
			return result
		}
		resp = r
	}

	// Single-step Send (opts.FullBody) is for debugging — keep the FULL body.
	// Persisted runs cap it so the runs table doesn't bloat across cycles/steps.
	bodyCap := maxRunResponseBody
	if opts.FullBody {
		bodyCap = len(resp.BodyText)
	}
	storedBody := resp.BodyText
	if len(storedBody) > bodyCap {
		storedBody = storedBody[:bodyCap]
	}
	result.Response = &model.ResponseSnapshot{
		Status: resp.Status, StatusText: resp.StatusText, Headers: resp.Headers,
		TimeMs: resp.Time, Body: storedBody, BodyTruncated: len(resp.BodyText) > bodyCap,
	}

	// validations: visual then script
	for _, a := range step.Validations.Visual {
		r := runVisualAssertion(a, resp)
		result.Assertions = append(result.Assertions, r)
		if !r.Passed {
			result.Status = "failed"
		}
	}
	if strings.TrimSpace(step.Validations.Script) != "" {
		out := RunScript(step.Validations.Script, resp, scope.Get, "validate")
		result.Assertions = append(result.Assertions, out.Tests...)
		result.Logs = append(result.Logs, out.Logs...)
		if out.Error != "" {
			result.Assertions = append(result.Assertions, model.AssertionResult{Name: "validation script", Passed: false, Message: out.Error})
		}
		if out.Failed {
			result.Status = "failed"
		}
	}

	// captures: run unless step failed and suite says not to
	shouldCapture := result.Status == "passed" || suite.Settings.RunCapturesOnFailure
	if shouldCapture {
		for _, c := range step.Captures.Visual {
			if c.TargetVariable == "" {
				continue
			}
			value, err := runVisualCapture(c, resp)
			if err != nil {
				result.Assertions = append(result.Assertions, model.AssertionResult{Name: "capture " + c.TargetVariable, Passed: false, Message: err.Error()})
				if result.Status == "passed" {
					result.Status = "failed"
				}
				continue
			}
			scope.Set(c.TargetVariable, value, c.Scope)
			result.Captured = append(result.Captured, model.CapturedValue{Key: c.TargetVariable, Value: value, Scope: c.Scope})
		}
		if strings.TrimSpace(step.Captures.Script) != "" {
			out := RunScript(step.Captures.Script, resp, scope.Get, "capture")
			result.Logs = append(result.Logs, out.Logs...)
			for _, sv := range out.SetVariables {
				scope.Set(sv.Key, sv.Value, sv.Scope)
				result.Captured = append(result.Captured, model.CapturedValue{Key: sv.Key, Value: sv.Value, Scope: sv.Scope})
			}
			if out.Error != "" {
				result.Assertions = append(result.Assertions, model.AssertionResult{Name: "capture script", Passed: false, Message: out.Error})
				if result.Status == "passed" {
					result.Status = "failed"
				}
			}
		}
	}

	return result
}

var redactRe = regexp.MustCompile(`(?i)authorization|api-key|x-api-key|cookie`)

func redactHeaders(headers map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range headers {
		if redactRe.MatchString(k) {
			cut := v
			if len(cut) > 12 {
				cut = cut[:12]
			}
			out[k] = cut + "…(redacted)"
		} else {
			out[k] = v
		}
	}
	return out
}

func buildCurl(method, reqURL string, headers map[string]string, step model.Step, scope *VarScope, redact bool) string {
	q := func(s string) string { return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'" }
	mask := func(s string) string {
		if redact {
			return scope.RedactSecrets(s)
		}
		return s
	}
	lines := []string{fmt.Sprintf("curl -X %s %s", method, q(mask(reqURL)))}
	for k, v := range headers {
		// If redacting, mask secret values; also truncate sensitive headers
		if redact {
			v = mask(v)
			if redactRe.MatchString(k) && len(v) > 12 {
				v = v[:12] + "…(redacted)"
			}
		}
		lines = append(lines, "-H "+q(k+": "+v))
	}
	body := step.Request.Body
	bodilessMethod := method == "GET" || method == "HEAD"
	sendsBody := body.Mode != "none" && (!bodilessMethod || body.SendWithGet)
	if sendsBody {
		if body.Mode == "form-data" {
			for _, f := range body.FormData {
				if !f.Enabled || f.Key == "" {
					continue
				}
				key := scope.Resolve(f.Key)
				if f.Type == "file" {
					_, name, _, ok := store.ResolveStoredFile(f.FileID)
					if !ok {
						name = "<missing-file>"
					}
					lines = append(lines, "-F "+q(mask(key)+"=@"+name))
				} else {
					lines = append(lines, "-F "+q(mask(key)+"="+mask(scope.Resolve(f.Value))))
				}
			}
		} else {
			lines = append(lines, "--data-raw "+q(mask(scope.Resolve(body.Content))))
		}
	}
	return strings.Join(lines, " \\\n  ")
}

// ---------- run orchestration ----------

type runControl struct {
	ctx    context.Context
	cancel context.CancelFunc
}

var (
	activeMu   sync.Mutex
	activeRuns = map[string]*runControl{}
)

// StopRun requests cancellation of an in-flight run. False if not active here.
func StopRun(runID string) bool {
	activeMu.Lock()
	defer activeMu.Unlock()
	ctrl, ok := activeRuns[runID]
	if !ok {
		return false
	}
	ctrl.cancel()
	return true
}

func nowISO() string { return time.Now().UTC().Format(time.RFC3339Nano) }

// StartRun persists a running Run and kicks off execution in the background.
// envID selects the environment layer; "" means globals + suite only.
func StartRun(suite model.Suite, cycles int, stopOnFailure bool, envID string) model.Run {
	var envPtr *string
	if envID != "" {
		id := envID
		envPtr = &id
	}
	run := model.Run{
		ID: model.NewID(), SuiteID: suite.ID, SuiteName: suite.Name, Status: "running",
		Cycles: cycles, StopOnFailure: stopOnFailure,
		EnvID: envPtr, EnvName: store.EnvNameFor(envID), StartedAt: nowISO(),
		CycleResults: []model.CycleResult{}, Summary: nil,
	}
	persistRun(run)
	ctx, cancel := context.WithCancel(context.Background())
	activeMu.Lock()
	activeRuns[run.ID] = &runControl{ctx: ctx, cancel: cancel}
	activeMu.Unlock()
	go executeRun(run, suite, ctx)
	return run
}

func executeRun(run model.Run, suite model.Suite, ctx context.Context) {
	startedMs := time.Now()
	cancelled := func() bool { return ctx.Err() != nil }

	for cycle := 1; cycle <= run.Cycles && !cancelled(); cycle++ {
		envID := ""
		if run.EnvID != nil {
			envID = *run.EnvID
		}
		scope := NewVarScopeEnv(suite, envID) // fresh scope per cycle; globals persist across cycles
		cr := model.CycleResult{Cycle: cycle, Passed: true, Steps: []model.StepResult{}}
		run.CycleResults = append(run.CycleResults, cr)
		idx := len(run.CycleResults) - 1
		aborted := false
		for _, step := range suite.Steps {
			if !step.Enabled || aborted || cancelled() {
				run.CycleResults[idx].Steps = append(run.CycleResults[idx].Steps, model.StepResult{
					StepID: step.ID, Name: step.Name, Status: "skipped",
					Assertions: []model.AssertionResult{}, Captured: []model.CapturedValue{}, Logs: []string{},
				})
				continue
			}
			sr := ExecuteStep(step, scope, suite, ExecuteOpts{Ctx: ctx, WithCurl: true})
			run.CycleResults[idx].Steps = append(run.CycleResults[idx].Steps, sr)
			if sr.Status != "passed" {
				run.CycleResults[idx].Passed = false
				if run.StopOnFailure && !cancelled() {
					aborted = true
				}
			}
			persistRun(run) // progressive persistence for live polling
		}
		if !run.CycleResults[idx].Passed && run.StopOnFailure && !cancelled() {
			break
		}
	}

	if cancelled() {
		run.Status = "stopped"
	} else {
		allPassed := true
		for _, c := range run.CycleResults {
			if !c.Passed {
				allPassed = false
				break
			}
		}
		if allPassed {
			run.Status = "passed"
		} else {
			run.Status = "failed"
		}
	}

	activeMu.Lock()
	delete(activeRuns, run.ID)
	activeMu.Unlock()

	fin := nowISO()
	run.FinishedAt = &fin
	summary := summarize(run, float64(time.Since(startedMs).Milliseconds()))
	run.Summary = &summary
	persistRun(run)
}

func summarize(run model.Run, durationMs float64) model.RunSummary {
	s := model.RunSummary{DurationMs: durationMs}
	for _, c := range run.CycleResults {
		for _, st := range c.Steps {
			s.TotalSteps++
			switch st.Status {
			case "passed":
				s.PassedSteps++
			case "failed":
				s.FailedSteps++
			case "error":
				s.ErroredSteps++
			default:
				s.SkippedSteps++
			}
			s.TotalAssertions += len(st.Assertions)
			for _, a := range st.Assertions {
				if a.Passed {
					s.PassedAssertions++
				}
			}
		}
	}
	return s
}

func persistRun(run model.Run) {
	cycleJSON, _ := json.Marshal(run.CycleResults)
	var summaryJSON interface{}
	if run.Summary != nil {
		b, _ := json.Marshal(run.Summary)
		summaryJSON = string(b)
	}
	var finished interface{}
	if run.FinishedAt != nil {
		finished = *run.FinishedAt
	}
	stopVal := 0
	if run.StopOnFailure {
		stopVal = 1
	}
	var envID interface{}
	if run.EnvID != nil {
		envID = *run.EnvID
	}
	_, _ = store.DB.Exec(
		`INSERT INTO runs (id, suite_id, suite_name, status, cycles, stop_on_failure, env_id, env_name, started_at, finished_at, cycle_results_json, summary_json)
		 VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
		 ON CONFLICT(id) DO UPDATE SET status = excluded.status, finished_at = excluded.finished_at,
		   cycle_results_json = excluded.cycle_results_json, summary_json = excluded.summary_json`,
		run.ID, run.SuiteID, run.SuiteName, run.Status, run.Cycles, stopVal,
		envID, run.EnvName,
		run.StartedAt, finished, string(cycleJSON), summaryJSON,
	)
}

// ---------- small helpers ----------

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return def
}

func hasHeaderCI(headers map[string]string, name string) bool {
	for k := range headers {
		if strings.EqualFold(k, name) {
			return true
		}
	}
	return false
}

func trimFloat(f float64) string {
	if f == float64(int64(f)) {
		return strconv.FormatInt(int64(f), 10)
	}
	return strconv.FormatFloat(f, 'f', -1, 64)
}
