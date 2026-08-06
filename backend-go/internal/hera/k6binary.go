package hera

import (
	"context"
	"errors"
	"fmt"
	"io/fs"
	"os/exec"
	"regexp"
	"strings"
	"sync"
	"time"
)

// k6 capability probe.
//
// This backend's Docker image is distroless — no shell, no package manager — so
// there is no way to introspect it except by asking the running process. That
// makes this probe a hard requirement rather than a nicety: it is also what lets
// a build without k6 (--target runtime-slim) degrade to a disabled button
// instead of a 500 on submit.
//
// Mirrors backend/src/hera/k6-binary.ts.

type Capability struct {
	Available bool    `json:"available"`
	Version   *string `json:"version"`
	Platform  *string `json:"platform"`
	// Reason is why it is unavailable — shown verbatim in the UI.
	Reason string `json:"reason,omitempty"`
}

const probeTimeout = 5 * time.Second

// `k6 v2.0.0 (commit/devel, go1.26.3, darwin/arm64)`
var versionRe = regexp.MustCompile(`(?i)^k6\s+(v[0-9][^\s(]*)(?:.*?,\s*([a-z0-9]+/[a-z0-9]+)\s*\))?`)

var (
	capOnce sync.Once
	capMu   sync.Mutex
	capVal  Capability
)

// ParseK6Version pulls the version and platform out of `k6 version` output.
func ParseK6Version(out string) (version, platform string) {
	m := versionRe.FindStringSubmatch(strings.TrimSpace(out))
	if m == nil {
		return "", ""
	}
	return m[1], m[2]
}

func probeK6() Capability {
	bin := GetLimits().K6Bin
	if bin == "" {
		bin = "k6"
	}
	ctx, cancel := context.WithTimeout(context.Background(), probeTimeout)
	defer cancel()

	out, err := exec.CommandContext(ctx, bin, "version").CombinedOutput()
	if err != nil {
		reason := fmt.Sprintf("k6 could not be started: %s", firstLine(string(out), err))
		// exec.ErrNotFound covers a failed PATH lookup; an absolute path that
		// does not exist surfaces as ENOENT instead. Both are "not installed",
		// and the message must match the Node backend's word for word.
		if errors.Is(err, exec.ErrNotFound) || errors.Is(err, fs.ErrNotExist) {
			reason = fmt.Sprintf("k6 not found (looked for %q). Install k6 on the host running this backend, or set HERA_K6_BIN.", bin)
		}
		return Capability{Available: false, Reason: reason}
	}
	version, platform := ParseK6Version(string(out))
	if version == "" {
		s := strings.TrimSpace(string(out))
		if len(s) > 120 {
			s = s[:120]
		}
		return Capability{
			Available: false,
			Reason:    fmt.Sprintf("%q version produced unrecognised output: %s", bin, s),
		}
	}
	c := Capability{Available: true, Version: &version}
	if platform != "" {
		c.Platform = &platform
	}
	return c
}

func firstLine(out string, err error) string {
	s := strings.TrimSpace(out)
	if s == "" {
		s = err.Error()
	}
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = s[:i]
	}
	return s
}

// GetCapability returns the cached probe result — a binary does not appear
// mid-process.
func GetCapability() Capability {
	capOnce.Do(func() {
		c := probeK6()
		capMu.Lock()
		capVal = c
		capMu.Unlock()
	})
	capMu.Lock()
	defer capMu.Unlock()
	return capVal
}

// ResetCapability re-probes on the next call (used by the UI's "recheck").
func ResetCapability() {
	c := probeK6()
	capMu.Lock()
	capVal = c
	capMu.Unlock()
	capOnce.Do(func() {}) // ensure Once is consumed so GetCapability returns capVal
}
