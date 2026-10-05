// Package model holds the domain types, ported from backend/src/types.ts.
// JSON tags reproduce the exact wire shapes the React frontend expects, so the
// Go backend is contract-identical to the Node one.
package model

import "github.com/google/uuid"

type KV struct {
	Key     string `json:"key"`
	Value   string `json:"value"`
	Enabled bool   `json:"enabled"`
}

// FormDataField is one part of a multipart/form-data body.
type FormDataField struct {
	ID      string `json:"id"`
	Key     string `json:"key"`
	Type    string `json:"type"` // text | file
	Value   string `json:"value"`
	FileID  string `json:"fileId"`
	Enabled bool   `json:"enabled"`
}

type Body struct {
	Mode        string          `json:"mode"` // none | raw | json | form | form-data
	Content     string          `json:"content"`
	FormData    []FormDataField `json:"formData,omitempty"`
	SendWithGet bool            `json:"sendWithGet,omitempty"`
}

// Auth mirrors the TS discriminated union. Fields are all optional so the same
// struct round-trips none/bearer/basic without losing data.
type Auth struct {
	Type     string `json:"type"` // none | bearer | basic
	Token    string `json:"token,omitempty"`
	Username string `json:"username,omitempty"`
	Password string `json:"password,omitempty"`
}

type StepRequest struct {
	Method  string `json:"method"`
	URL     string `json:"url"`
	Headers []KV   `json:"headers"`
	Params  []KV   `json:"params"`
	Body    Body   `json:"body"`
	Auth    Auth   `json:"auth"`
}

type Assertion struct {
	ID         string `json:"id"`
	Type       string `json:"type"`
	Expression string `json:"expression,omitempty"`
	Expected   string `json:"expected,omitempty"`
}

type CaptureRule struct {
	ID             string `json:"id"`
	Source         string `json:"source"` // body-jsonpath | header | status | body-text
	Expression     string `json:"expression"`
	TargetVariable string `json:"targetVariable"`
	Scope          string `json:"scope"` // suite | global
}

type Validations struct {
	Visual []Assertion `json:"visual"`
	Script string      `json:"script"`
}

type Captures struct {
	Visual []CaptureRule `json:"visual"`
	Script string        `json:"script"`
}

// StepPolling re-sends the request on an interval until the stop script calls
// stop() or the timeout elapses. Off by default.
type StepPolling struct {
	Enabled    bool   `json:"enabled"`
	IntervalMs int    `json:"intervalMs"`
	TimeoutMs  int    `json:"timeoutMs"`
	StopScript string `json:"stopScript"`
}

type Step struct {
	ID            string        `json:"id"`
	Name          string        `json:"name"`
	Enabled       bool          `json:"enabled"`
	FolderPath    string        `json:"folderPath"`
	Request       StepRequest   `json:"request"`
	Validations   Validations   `json:"validations"`
	Captures      Captures      `json:"captures"`
	Polling       *StepPolling  `json:"polling,omitempty"`
	PostmanEvents []interface{} `json:"postmanEvents,omitempty"`
	SourceRequest *StepRequest  `json:"sourceRequest,omitempty"`
}

type SuiteVariable struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Secret bool   `json:"secret"`
}

type SuiteSettings struct {
	StopOnFailure       bool `json:"stopOnFailure"`
	DefaultCycles       int  `json:"defaultCycles"`
	RunCapturesOnFailure bool `json:"runCapturesOnFailure"`
	RequestTimeoutMs    int  `json:"requestTimeoutMs"`
}

type Suite struct {
	ID           string          `json:"id"`
	Name         string          `json:"name"`
	Description  string          `json:"description"`
	CollectionID *string         `json:"collectionId"`
	Steps        []Step          `json:"steps"`
	Variables    []SuiteVariable `json:"variables"`
	Settings     SuiteSettings   `json:"settings"`
	// DefaultEnvID is the environment pre-selected for runs of this suite.
	DefaultEnvID *string `json:"defaultEnvId"`
	CreatedAt    string  `json:"createdAt"`
	UpdatedAt    string  `json:"updatedAt"`
}

type GlobalVariable struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Secret bool   `json:"secret"`
}

// EnvironmentVariable is one variable inside an environment — same shape as a
// global or suite variable.
type EnvironmentVariable struct {
	Key    string `json:"key"`
	Value  string `json:"value"`
	Secret bool   `json:"secret"`
}

// Environment is a named, reusable variable set (dev, staging, custom...).
// The most specific layer below runtime captures:
// runtime > environment > global > suite.
type Environment struct {
	ID          string                `json:"id"`
	Name        string                `json:"name"`
	Description string                `json:"description"`
	Variables   []EnvironmentVariable `json:"variables"`
	CreatedAt   string                `json:"createdAt"`
	UpdatedAt   string                `json:"updatedAt"`
}

type AssertionResult struct {
	Name    string `json:"name"`
	Passed  bool   `json:"passed"`
	Message string `json:"message,omitempty"`
}

type CapturedValue struct {
	Key   string `json:"key"`
	Value string `json:"value"`
	Scope string `json:"scope"` // suite | global | runtime
}

type RequestSnapshot struct {
	Method  string            `json:"method"`
	URL     string            `json:"url"`
	Headers map[string]string `json:"headers"`
	Body    *string           `json:"body,omitempty"`
}

type ResponseSnapshot struct {
	Status        int               `json:"status"`
	StatusText    string            `json:"statusText"`
	Headers       map[string]string `json:"headers"`
	TimeMs        float64           `json:"timeMs"`
	Body          string            `json:"body"`
	BodyTruncated bool              `json:"bodyTruncated"`
}

// PollAttempt is one attempt of a polled request, kept for poll-history UI.
type PollAttempt struct {
	Attempt       int     `json:"attempt"`
	Status        int     `json:"status"`
	StatusText    string  `json:"statusText"`
	TimeMs        float64 `json:"timeMs"`
	Body          string  `json:"body"`
	BodyTruncated bool    `json:"bodyTruncated"`
	Stopped       bool    `json:"stopped"`
}

type StepResult struct {
	StepID       string            `json:"stepId"`
	Name         string            `json:"name"`
	Status       string            `json:"status"` // passed | failed | error | skipped
	Request      *RequestSnapshot  `json:"request,omitempty"`
	Response     *ResponseSnapshot `json:"response,omitempty"`
	Assertions   []AssertionResult `json:"assertions"`
	Captured     []CapturedValue   `json:"captured"`
	Logs         []string          `json:"logs"`
	PollAttempts []PollAttempt     `json:"pollAttempts,omitempty"`
	Error        string            `json:"error,omitempty"`
	Curl         string            `json:"curl,omitempty"`
}

type CycleResult struct {
	Cycle  int          `json:"cycle"`
	Passed bool         `json:"passed"`
	Steps  []StepResult `json:"steps"`
}

type RunSummary struct {
	TotalSteps        int     `json:"totalSteps"`
	PassedSteps       int     `json:"passedSteps"`
	FailedSteps       int     `json:"failedSteps"`
	ErroredSteps      int     `json:"erroredSteps"`
	SkippedSteps      int     `json:"skippedSteps"`
	TotalAssertions   int     `json:"totalAssertions"`
	PassedAssertions  int     `json:"passedAssertions"`
	DurationMs        float64 `json:"durationMs"`
}

type Run struct {
	ID           string        `json:"id"`
	SuiteID      string        `json:"suiteId"`
	SuiteName    string        `json:"suiteName"`
	Status       string        `json:"status"` // running | passed | failed | error | stopped
	Cycles       int           `json:"cycles"`
	StopOnFailure bool         `json:"stopOnFailure"`
	// EnvID / EnvName record the environment this run resolved variables
	// against. The name is stored too, so the record stays readable after the
	// environment is renamed or deleted.
	EnvID        *string       `json:"envId"`
	EnvName      string        `json:"envName"`
	StartedAt    string        `json:"startedAt"`
	FinishedAt   *string       `json:"finishedAt"`
	CycleResults []CycleResult `json:"cycleResults"`
	Summary      *RunSummary   `json:"summary"`
}

// DescribeAssertion renders the human-readable name of an assertion, matching
// describeAssertion() in backend/src/runner/executor.ts. Shared by the executor
// and the Postman exporter.
func DescribeAssertion(a Assertion) string {
	switch a.Type {
	case "status-equals":
		return "status = " + a.Expected
	case "jsonpath-exists":
		return a.Expression + " exists"
	case "jsonpath-equals":
		return a.Expression + " = " + a.Expected
	case "header-equals":
		return "header " + a.Expression + " = " + a.Expected
	case "body-contains":
		return `body contains "` + a.Expected + `"`
	case "response-time-below":
		return "response time < " + a.Expected + "ms"
	default:
		return "assertion"
	}
}

// NewID mirrors crypto.randomUUID().
func NewID() string { return uuid.NewString() }

func DefaultSettings() SuiteSettings {
	return SuiteSettings{StopOnFailure: false, DefaultCycles: 1, RunCapturesOnFailure: true, RequestTimeoutMs: 30000}
}

func EmptyRequest() StepRequest {
	return StepRequest{
		Method:  "GET",
		URL:     "",
		Headers: []KV{},
		Params:  []KV{},
		Body:    Body{Mode: "none", Content: ""},
		Auth:    Auth{Type: "none"},
	}
}

func EmptyStep(name string) Step {
	if name == "" {
		name = "New request"
	}
	return Step{
		ID:          NewID(),
		Name:        name,
		Enabled:     true,
		FolderPath:  "",
		Request:     EmptyRequest(),
		Validations: Validations{Visual: []Assertion{}, Script: ""},
		Captures:    Captures{Visual: []CaptureRule{}, Script: ""},
	}
}
