// Package dynvars implements the dynamic variables — {{$guid}}, {{$timestamp}}
// and friends — that are generated at resolve time instead of being looked up
// in a scope.
//
// They exist for the two things people kept hand-rolling with a seed step: a
// fresh id per request, and "now" in a payload.
//
// Evaluated PER CALL, like Postman: two {{$guid}} in one body are two different
// UUIDs, and the same token in step 1 and step 5 differs. To send one value in
// several places, capture it once and use {{link_id}} from then on.
//
// A user variable can never collide: variable names must match ^[A-Za-z_]
// everywhere they are accepted, so a leading '$' is impossible.
//
// Line-for-line mirror of backend/src/dynamic-vars.ts (and, as JS, of the k6
// prelude in internal/hera/prelude.go).
package dynvars

import (
	"fmt"
	"math/rand"
	"strconv"
	"time"
)

// Spec describes one dynamic variable for the docs/UI.
type Spec struct {
	Name        string `json:"name"`
	Description string `json:"description"`
	Example     string `json:"example"`
}

// All is the supported set, in the order the docs list them.
var All = []Spec{
	{"$guid", "Random UUID v4 — a fresh id per request", "3f2b9c74-5e41-4a8f-b0d2-9c1e77a4e5b3"},
	{"$randomInt", "Random integer, 0–1000", "742"},
	{"$randomHex", "16 random hex characters", "a3f19c02b7d45e68"},
	{"$timestamp", "Current Unix time in seconds", "1788945353"},
	{"$epochMillis", "Current Unix time in milliseconds", "1788945353514"},
	{"$isoTimestamp", "Current UTC time, ISO 8601", "2026-09-09T09:15:53.514Z"},
	{"$date", "Today's date in UTC, YYYY-MM-DD", "2026-09-09"},
}

// IsDynamic reports whether key names a dynamic variable ('$' included).
func IsDynamic(key string) bool {
	for _, s := range All {
		if s.Name == key {
			return true
		}
	}
	return false
}

func hex(n int) string {
	const digits = "0123456789abcdef"
	b := make([]byte, n)
	for i := range b {
		b[i] = digits[rand.Intn(16)]
	}
	return string(b)
}

// uuidV4 built from math/rand.
//
// Not crypto-strong, and deliberately so: this matches the Node backend and the
// k6 prelude, and a test id does not need unpredictability — it needs to be
// different every time and identical in shape everywhere.
func uuidV4() string {
	variant := strconv.FormatInt(int64(8+rand.Intn(4)), 16) // 8, 9, a or b
	return fmt.Sprintf("%s-%s-4%s-%s%s-%s", hex(8), hex(4), hex(3), variant, hex(3), hex(12))
}

// Value returns the value for one dynamic variable. ok is false when key is not
// one of them, which callers use to fall through to the normal scope lookup.
func Value(key string) (value string, ok bool) {
	return ValueAt(key, time.Now().UTC())
}

// ValueAt is Value with the clock injected, for tests.
func ValueAt(key string, now time.Time) (string, bool) {
	switch key {
	case "$guid":
		return uuidV4(), true
	case "$randomInt":
		return strconv.Itoa(rand.Intn(1001)), true
	case "$randomHex":
		return hex(16), true
	case "$timestamp":
		return strconv.FormatInt(now.Unix(), 10), true
	case "$epochMillis":
		return strconv.FormatInt(now.UnixMilli(), 10), true
	case "$isoTimestamp":
		// Milliseconds + 'Z', matching JavaScript's Date.toISOString().
		return now.Format("2006-01-02T15:04:05.000Z"), true
	case "$date":
		return now.Format("2006-01-02"), true
	}
	return "", false
}

// Placeholder is the stable stand-in used where a value must NOT vary:
// preflight target validation and the statically resolved cURL.
//
// A host that depends on a random token cannot be validated (it would resolve to
// something else at run time), and the parity harness compares both engines byte
// for byte — a live UUID there would make every comparison fail.
func Placeholder(key string) (string, bool) {
	switch key {
	case "$guid":
		return "00000000-0000-4000-8000-000000000000", true
	case "$randomInt":
		return "0", true
	case "$randomHex":
		return "0000000000000000", true
	case "$timestamp":
		return "0", true
	case "$epochMillis":
		return "0", true
	case "$isoTimestamp":
		return "1970-01-01T00:00:00.000Z", true
	case "$date":
		return "1970-01-01", true
	}
	return "", false
}
