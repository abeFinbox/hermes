// Package hera implements load testing by generating a k6 script from a suite
// and running the real k6 binary.
//
// Every knob is env-overridable but then clamped in code, in the same style as
// the existing run-cycles clamp and MAX_POLL_MS in internal/runner. A load
// generator that trusts its input is a weapon, so the ceilings are not advisory.
//
// Values are identical in backend/src/hera/config.ts.
package hera

import (
	"os"
	"strconv"
	"strings"
)

type Limits struct {
	Enabled        bool
	MaxVus         int
	MaxDurationSec int
	MaxRps         int
	MaxRequests    int
	// AllowModerator extends launch permission from admin-only to moderators.
	AllowModerator bool
	// AllowConstrained runs even when the detected CPU quota is too low for
	// trustworthy numbers.
	AllowConstrained bool
	// TargetAllow lists hosts Hera may target. EMPTY means default-deny: only
	// this instance's own /mock API over loopback.
	TargetAllow []string
	// K6Bin is an explicit binary path; empty means "look on PATH".
	K6Bin string
	// LogLines is how many lines of k6 output are kept in memory per run, for
	// the live log panel.
	LogLines int
	// Diag emits a diagnostic line when a step fails, so a red step is
	// explainable.
	Diag bool
	// DiagMax is diagnostic lines per step, PER VU: the real ceiling is
	// DiagMax * vus.
	DiagMax int
	// DiagBody includes a response-body snippet in diagnostics.
	//
	// ON by default: the status code alone rarely explains a 4xx, and the error
	// message in the body is the thing an operator actually needs. The trade-off
	// is real — these lines are persisted in stderr_tail, so response payloads
	// sit at rest in the run row until it is deleted — which is why the snippet
	// is hard-truncated and why HERA_DIAG_BODY=0 turns it off for instances
	// pointed at production data.
	DiagBody bool
	// DiagBodyMax is the hard truncation for that snippet.
	DiagBodyMax int
}

// Defaults / ceilings. The ceiling is the most a deployment may raise a value to.
const (
	DefaultMaxVus         = 20
	CeilingMaxVus         = 100
	DefaultMaxDurationSec = 60
	CeilingMaxDurationSec = 300 // matches MaxPollMs (300000ms)
	DefaultMaxRps         = 200
	CeilingMaxRps         = 1000
	DefaultMaxRequests    = 20000
	CeilingMaxRequests    = 100000
	DefaultLogLines       = 2000
	MinLogLines           = 100
	CeilingLogLines       = 20000
	DefaultDiagMax        = 3
	CeilingDiagMax        = 50
	DefaultDiagBodyMax    = 512
	CeilingDiagBodyMax    = 2048

	// MaxLogRingBytes is the bytes of parsed log lines held per run,
	// independent of MaxStderrBytes. The ring evicts on whichever bound trips
	// first: lines, then bytes.
	MaxLogRingBytes = 512 * 1024

	// MinMillicores is the minimum CPU for latency numbers worth trusting.
	MinMillicores = 1000
	// MillicoresPerVu is the CPU headroom to reserve per virtual user.
	MillicoresPerVu = 50
)

func intEnv(name string, dflt, min, ceiling int) int {
	raw, err := strconv.Atoi(strings.TrimSpace(os.Getenv(name)))
	if err != nil || raw <= 0 {
		return dflt
	}
	if raw < min {
		return min
	}
	if raw > ceiling {
		return ceiling
	}
	return raw
}

func boolEnv(name string, dflt bool) bool {
	raw := strings.ToLower(strings.TrimSpace(os.Getenv(name)))
	if raw == "" {
		return dflt
	}
	return raw == "1" || raw == "true" || raw == "yes"
}

func GetLimits() Limits {
	allow := []string{}
	for _, s := range strings.Split(os.Getenv("HERA_TARGET_ALLOW"), ",") {
		if t := strings.ToLower(strings.TrimSpace(s)); t != "" {
			allow = append(allow, t)
		}
	}
	return Limits{
		Enabled:          boolEnv("HERA_ENABLED", true),
		MaxVus:           intEnv("HERA_MAX_VUS", DefaultMaxVus, 1, CeilingMaxVus),
		MaxDurationSec:   intEnv("HERA_MAX_DURATION_SEC", DefaultMaxDurationSec, 1, CeilingMaxDurationSec),
		MaxRps:           intEnv("HERA_MAX_RPS", DefaultMaxRps, 1, CeilingMaxRps),
		MaxRequests:      intEnv("HERA_MAX_REQUESTS", DefaultMaxRequests, 1, CeilingMaxRequests),
		AllowModerator:   boolEnv("HERA_ALLOW_MODERATOR", false),
		AllowConstrained: boolEnv("HERA_ALLOW_CONSTRAINED", false),
		TargetAllow:      allow,
		K6Bin:            strings.TrimSpace(os.Getenv("HERA_K6_BIN")),
		LogLines:         intEnv("HERA_LOG_LINES", DefaultLogLines, MinLogLines, CeilingLogLines),
		Diag:             boolEnv("HERA_DIAG", true),
		DiagMax:          intEnv("HERA_DIAG_MAX", DefaultDiagMax, 1, CeilingDiagMax),
		DiagBody:         boolEnv("HERA_DIAG_BODY", true),
		DiagBodyMax:      intEnv("HERA_DIAG_BODY_MAX", DefaultDiagBodyMax, 32, CeilingDiagBodyMax),
	}
}
