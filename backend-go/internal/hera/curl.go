// A paste-runnable cURL for one Hera step.
//
// Why this exists: a load test tells you a step is 100% red, and the next thing
// anyone does is try the request by hand. Rebuilding it from the suite editor is
// error-prone precisely when you are in a hurry.
//
// It must reproduce what k6 ACTUALLY sent, so the construction order mirrors
// heraBuildRequest in prelude.go exactly: url interpolation, then query params
// appended, then headers, then auth (which overwrites Authorization), then the
// Host override, then the body and its default Content-Type. If those two ever
// disagree, this command "works" while the run fails and sends everyone chasing
// the wrong thing.
//
// Secrets: values ARE resolved, including secret variables, exactly like the
// single-step Send curl (internal/runner buildCurl with redact=false). That is
// the whole point — a masked Authorization header reproduces a 401 that has
// nothing to do with the one you are debugging. It is therefore built ON DEMAND
// and never persisted, and the route is gated to the roles that may launch a run.
//
// Mirrors backend/src/hera/curl.ts — the output is byte-compared by
// cmd/hera-curl-runner against its Node half.
package hera

import (
	"encoding/base64"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/model"
)

// curlQuote is POSIX single-quoting: the only safe way to paste an arbitrary
// value.
func curlQuote(s string) string {
	return "'" + strings.ReplaceAll(s, "'", `'\''`) + "'"
}

// encodeURIComponent mirrors JavaScript's function of the same name, which is
// what the generated script uses for query params.
//
// Deliberately NOT net/url.QueryEscape: that encodes a space as "+" and escapes
// !, ', (, ), * — so the two backends would emit different curl text for the same
// step, and the harness would (correctly) fail.
func encodeURIComponent(s string) string {
	const unreserved = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_.!~*'()"
	const hex = "0123456789ABCDEF"
	var b strings.Builder
	for i := 0; i < len(s); i++ {
		c := s[i]
		if strings.IndexByte(unreserved, c) >= 0 {
			b.WriteByte(c)
			continue
		}
		b.WriteByte('%')
		b.WriteByte(hex[c>>4])
		b.WriteByte(hex[c&0x0f])
	}
	return b.String()
}

type StepCurlInput struct {
	Step model.Step
	// SeedVars are the statically resolvable variables, merged global < suite.
	SeedVars map[string]string
	// FileMetas maps fileId -> filename / mime for form-data file parts.
	FileMetas map[string]FileMeta
	// HostHeader is the Host override, when the run pinned one.
	HostHeader string
}

// header keeps insertion order: it is what the emitted -H lines follow, and the
// two languages must agree on it. Overwriting a key keeps its first position,
// matching a JS object's own behaviour in the prelude.
type curlHeaders struct {
	keys []string
	vals map[string]string
}

func (h *curlHeaders) set(k, v string) {
	if h.vals == nil {
		h.vals = map[string]string{}
	}
	if _, seen := h.vals[k]; !seen {
		h.keys = append(h.keys, k)
	}
	h.vals[k] = v
}

func (h *curlHeaders) has(k string) bool {
	_, ok := h.vals[k]
	return ok
}

func BuildStepCurl(in StepCurlInput) string {
	step := in.Step
	interp := func(s string) string { return Interpolate(s, in.SeedVars) }

	method := strings.ToUpper(step.Request.Method)
	if method == "" {
		method = "GET"
	}

	url := interp(step.Request.URL)
	qs := []string{}
	for _, p := range step.Request.Params {
		if !p.Enabled || p.Key == "" {
			continue
		}
		qs = append(qs, encodeURIComponent(interp(p.Key))+"="+encodeURIComponent(interp(p.Value)))
	}
	if len(qs) > 0 {
		sep := "?"
		if strings.Contains(url, "?") {
			sep = "&"
		}
		url = url + sep + strings.Join(qs, "&")
	}

	headers := &curlHeaders{}
	for _, h := range step.Request.Headers {
		if !h.Enabled || h.Key == "" {
			continue
		}
		headers.set(h.Key, interp(h.Value))
	}
	switch step.Request.Auth.Type {
	case "bearer":
		headers.set("Authorization", "Bearer "+interp(step.Request.Auth.Token))
	case "basic":
		raw := interp(step.Request.Auth.Username) + ":" + interp(step.Request.Auth.Password)
		headers.set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(raw)))
	}
	if in.HostHeader != "" {
		headers.set("Host", in.HostHeader)
	}

	mode := step.Request.Body.Mode
	content := step.Request.Body.Content
	if !headers.has("Content-Type") {
		if mode == "json" {
			headers.set("Content-Type", "application/json")
		} else if mode == "form" {
			headers.set("Content-Type", "application/x-www-form-urlencoded")
		}
	}

	lines := []string{"curl -X " + method + " " + curlQuote(url)}
	for _, k := range headers.keys {
		lines = append(lines, "-H "+curlQuote(k+": "+headers.vals[k]))
	}

	if mode == "json" || mode == "raw" || mode == "form" {
		lines = append(lines, "--data-raw "+curlQuote(interp(content)))
	} else if mode == "form-data" {
		for _, f := range step.Request.Body.FormData {
			if !f.Enabled || f.Key == "" {
				continue
			}
			key := interp(f.Key)
			if f.Type == "file" {
				meta, ok := in.FileMetas[f.FileID]
				if !ok {
					meta = FileMeta{Filename: "file", Mime: "application/octet-stream"}
				}
				lines = append(lines, "-F "+curlQuote(key+"=@"+meta.Filename+";type="+meta.Mime))
			} else {
				lines = append(lines, "-F "+curlQuote(key+"="+interp(f.Value)))
			}
		}
	}

	// Hera runs with redirects: 0, so a 302 is a result rather than a hop. curl
	// does not follow redirects by default either, so this needs no flag — but say
	// so, because "curl showed 302 and the app works in a browser" is a trap.
	return strings.Join(lines, " \\\n  ")
}
