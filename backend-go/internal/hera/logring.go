// Bounded, in-memory ring of k6 output lines for the live log panel.
//
// Why a ring and not the database: k6 can emit thousands of lines in a minute,
// and writing them through SQLite every 2s would turn a load test into a write
// benchmark. What survives the run is the existing 64KB stderr_tail column; the
// ring is only the live view, and it dies with the process that owns the run.
//
// Line numbers are a MONOTONIC cursor, never reset and never reused, so a
// client polling with ?sinceLine= keeps working across eviction: it asks for
// "after 900", gets whatever of that is still retained, and learns from
// FirstLine that lines 1..N are gone rather than silently seeing a shorter log.
//
// Mirrors backend/src/hera/logring.ts — the eviction order (lines first, then
// bytes) and the redaction rules must match, or the two engines report
// different Dropped counts for the same run.
package hera

import (
	"encoding/json"
	"regexp"
	"strings"
	"sync"
)

type LogLine struct {
	// N is the 1-based monotonic position in the run's output.
	N int `json:"n"`
	// T is k6's own timestamp, or "" for a line that was not JSON.
	T string `json:"t"`
	// Level is error | warning | info | debug, or "raw" when the line was not
	// JSON.
	Level string `json:"level"`
	Msg   string `json:"msg"`
}

type LogSlice struct {
	Lines []LogLine `json:"lines"`
	// Cursor is the total lines ever appended. Pass back as ?sinceLine= to
	// resume.
	Cursor int `json:"cursor"`
	// FirstLine is the position of the oldest retained line; 0 when nothing is
	// retained.
	FirstLine int `json:"firstLine"`
	// Dropped is the lines evicted since the run started.
	Dropped int `json:"dropped"`
}

var (
	userinfoRe = regexp.MustCompile(`//[^/@\s:]+:[^/@\s]*@`)
	secretRe   = regexp.MustCompile(`(?i)((?:password|passwd|token|secret|apikey|api_key)["']?\s*[=:]\s*["']?)[^"'\s,&}]+`)
)

// RedactLine strips credentials that k6 may echo. Metrics sink URLs reach k6 as
// env vars and come back out in connection errors, so this runs before storage:
// the API response and the persisted tail are then both clean.
func RedactLine(s string) string {
	s = userinfoRe.ReplaceAllString(s, "//***@")
	return secretRe.ReplaceAllString(s, "${1}***")
}

// parseLogLine parses one k6 --log-format json line; falls back to keeping it
// verbatim.
func parseLogLine(n int, raw string) LogLine {
	trimmed := strings.TrimSuffix(raw, "\r")
	if strings.HasPrefix(trimmed, "{") {
		var doc struct {
			Level string `json:"level"`
			Msg   *string `json:"msg"`
			Time  string `json:"time"`
		}
		if err := json.Unmarshal([]byte(trimmed), &doc); err == nil && doc.Msg != nil {
			level := strings.ToLower(doc.Level)
			if level == "" {
				level = "info"
			}
			return LogLine{N: n, T: doc.Time, Level: level, Msg: RedactLine(*doc.Msg)}
		}
	}
	return LogLine{N: n, T: "", Level: "raw", Msg: RedactLine(trimmed)}
}

type LogRing struct {
	mu       sync.Mutex
	lines    []LogLine
	bytes    int
	appended int
	evicted  int
	maxLines int
	maxBytes int
}

func NewLogRing(maxLines, maxBytes int) *LogRing {
	if maxBytes <= 0 {
		maxBytes = MaxLogRingBytes
	}
	return &LogRing{maxLines: maxLines, maxBytes: maxBytes}
}

func (r *LogRing) Push(raw string) {
	if raw == "" {
		return
	}
	r.mu.Lock()
	defer r.mu.Unlock()
	r.appended++
	line := parseLogLine(r.appended, raw)
	r.lines = append(r.lines, line)
	r.bytes += len(line.Msg) + len(line.T) + len(line.Level)
	for len(r.lines) > r.maxLines || (r.bytes > r.maxBytes && len(r.lines) > 1) {
		gone := r.lines[0]
		r.lines = r.lines[1:]
		r.bytes -= len(gone.Msg) + len(gone.T) + len(gone.Level)
		r.evicted++
	}
}

func (r *LogRing) Since(sinceLine int) LogSlice {
	r.mu.Lock()
	defer r.mu.Unlock()
	from := sinceLine
	if from < 0 {
		from = 0
	}
	out := []LogLine{}
	for _, l := range r.lines {
		if l.N > from {
			out = append(out, l)
		}
	}
	first := 0
	if len(r.lines) > 0 {
		first = r.lines[0].N
	}
	return LogSlice{Lines: out, Cursor: r.appended, FirstLine: first, Dropped: r.evicted}
}

// SliceFromTail builds a LogSlice from a finished run's stderr_tail, so the same
// route answers for live and terminal runs. Numbering restarts at 1 — the tail
// is a suffix of the output, so its line numbers cannot be the live cursor's,
// and pretending otherwise would let a client stitch two incompatible
// numberings together.
func SliceFromTail(tail string) LogSlice {
	if tail == "" {
		return LogSlice{Lines: []LogLine{}, Cursor: 0, FirstLine: 0, Dropped: 0}
	}
	raw := strings.Split(tail, "\n")
	// A trailing newline yields a final empty element that is not a line.
	if len(raw) > 0 && raw[len(raw)-1] == "" {
		raw = raw[:len(raw)-1]
	}
	lines := make([]LogLine, 0, len(raw))
	for i, s := range raw {
		lines = append(lines, parseLogLine(i+1, s))
	}
	first := 0
	if len(lines) > 0 {
		first = 1
	}
	return LogSlice{Lines: lines, Cursor: len(lines), FirstLine: first, Dropped: 0}
}
