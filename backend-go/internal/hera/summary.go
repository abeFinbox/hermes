package hera

import (
	"encoding/json"
	"strings"
)

// The frozen document Hera reads back from k6.
//
// k6's own summary shape is version-coupled, so the extraction lives inside the
// generated script's handleSummary (see prelude.go) and both backends only ever
// parse THIS shape. That collapses all k6-version risk into one string that the
// script-parity fixture already covers.
//
// Mirrors backend/src/hera/summary.ts.

type Trend struct {
	Min float64 `json:"min"`
	Avg float64 `json:"avg"`
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	P95 float64 `json:"p95"`
	P99 float64 `json:"p99"`
	Max float64 `json:"max"`
}

type StepStats struct {
	StepID       string  `json:"stepId"`
	Name         string  `json:"name"`
	Method       string  `json:"method"`
	URL          string  `json:"url"`
	Requests     float64 `json:"requests"`
	ErrorRate    float64 `json:"errorRate"`
	Latency      *Trend  `json:"latency"`
	PollAttempts *Trend  `json:"pollAttempts"`
	PollWaitMs   *Trend  `json:"pollWaitMs"`
	ScriptErrors float64 `json:"scriptErrors"`
}

type RunSummary struct {
	Requests               float64 `json:"requests"`
	ErrorRate              float64 `json:"errorRate"`
	Rps                    float64 `json:"rps"`
	Iterations             float64 `json:"iterations"`
	IterationDuration      *Trend  `json:"iterationDuration"`
	Latency                *Trend  `json:"latency"`
	ChecksPassed           float64 `json:"checksPassed"`
	ChecksTotal            float64 `json:"checksTotal"`
	ScriptErrors           float64 `json:"scriptErrors"`
	SuppressedGlobalWrites float64 `json:"suppressedGlobalWrites"`
	DataSent               float64 `json:"dataSent"`
	DataReceived           float64 `json:"dataReceived"`
	DroppedIterations      float64 `json:"droppedIterations"`
	VusMax                 float64 `json:"vusMax"`
}

type SummaryDoc struct {
	HeraSchema       int         `json:"heraSchema"`
	Summary          RunSummary  `json:"summary"`
	Steps            []StepStats `json:"steps"`
	ThresholdsFailed []string    `json:"thresholdsFailed"`
}

const SummarySchema = 1

// ParseSummary pulls the summary out of k6's stdout.
//
// With --quiet the generated script's handleSummary is the only thing that
// writes to stdout, but scan from the end anyway so a stray line cannot break
// the parse.
func ParseSummary(stdout string) (*SummaryDoc, string) {
	lines := []string{}
	for _, l := range strings.Split(stdout, "\n") {
		if t := strings.TrimSpace(l); t != "" {
			lines = append(lines, t)
		}
	}
	for i := len(lines) - 1; i >= 0; i-- {
		line := lines[i]
		if !strings.HasPrefix(line, "{") {
			continue
		}
		var doc SummaryDoc
		if err := json.Unmarshal([]byte(line), &doc); err != nil {
			continue // a partial line is not fatal — keep scanning
		}
		if doc.HeraSchema == SummarySchema {
			return &doc, ""
		}
	}
	if len(lines) == 0 {
		return nil, "k6 produced no output, so there is no summary to read."
	}
	return nil, "k6 produced output but no Hera summary line — the run most likely died before finishing."
}
