package hera

import (
	"context"
	"fmt"
	"github.com/finbox/hermes/backend-go/internal/dynvars"
	"net"
	"net/url"
	"regexp"
	"strings"
)

// Target validation: what Hera is allowed to point load at.
//
// This is the security boundary of the whole feature. Hera turns an
// authenticated web app into a load generator aimed at any URL the host can
// reach, so:
//
//   - the allow-list is DEFAULT-DENY. With no HERA_TARGET_ALLOW, the only
//     permitted target is this instance's own /mock demo API.
//   - the deny-list is HARDCODED and cannot be widened by configuration.
//     Env vars get copy-pasted between environments; cloud metadata must not
//     become reachable because someone pasted a permissive value.
//   - hosts are RESOLVED and PINNED before the run. A name check alone is
//     worthless: evil.example.com can resolve to 169.254.169.254, and it can
//     resolve differently on the second lookup (DNS rebinding).
//
// Every rejection message here is part of the cross-backend contract — the
// parity fixture asserts Node and Go produce identical strings, because a
// divergence would mean one backend is a bypass for the other.
// Mirrors backend/src/hera/target.ts.

type ResolvedTarget struct {
	OK     bool   `json:"ok"`
	Reason string `json:"reason,omitempty"`
	// Host as written, after variable resolution.
	Host   string `json:"host,omitempty"`
	Port   string `json:"port,omitempty"`
	Scheme string `json:"scheme,omitempty"`
	// ResolvedIP is the address the script is pinned to, so k6 never re-resolves.
	ResolvedIP string `json:"resolvedIp,omitempty"`
	// AllIPs is every address the host resolved to, for the audit trail.
	AllIPs []string `json:"allIps,omitempty"`
	// SelfMock is true for the deliberate self-/mock exception.
	SelfMock bool `json:"selfMock,omitempty"`
}

// ResolveFn looks a hostname up. Injected so the parity fixture can stub it.
type ResolveFn func(host string) ([]string, error)

type TargetOptions struct {
	Limits Limits
	// SelfPort is this instance's own listening port, for the self-origin rule.
	SelfPort string
	Resolve  ResolveFn
}

var tokenRe = regexp.MustCompile(`\{\{\s*([^}\s]+)\s*\}\}`)

/*
Interpolate mirrors VarScope.Resolve: up to 5 passes, unknown tokens literal.

Dynamic variables ({{$guid}} etc.) are left literal too, on purpose: this feeds
the preflight PREVIEW, and a URL reading .../items?id={{$guid}} is more honest
than one showing a UUID that will not be the one sent. Preflight already reports
such tokens as runtime tokens. Host validation uses InterpolateForTarget.
*/
func Interpolate(text string, vars map[string]string) string {
	out := text
	for pass := 0; pass < 5; pass++ {
		if !strings.Contains(out, "{{") {
			break
		}
		before := out
		out = tokenRe.ReplaceAllStringFunc(out, func(whole string) string {
			m := tokenRe.FindStringSubmatch(whole)
			if m == nil {
				return whole
			}
			if v, ok := vars[m[1]]; ok {
				return v
			}
			return whole
		})
		if out == before {
			break
		}
	}
	return out
}

/*
InterpolateForTarget is the interpolation used to decide WHERE a request goes.

Same as Interpolate, except dynamic variables collapse to a fixed placeholder
(dynvars.Placeholder). Two reasons: a host must be validated and pinned to one IP
before the run starts, which is impossible if part of it is random; and the
target parity harness compares both engines byte for byte, so a live UUID here
would make every comparison fail.
*/
func InterpolateForTarget(text string, vars map[string]string) string {
	out := text
	for pass := 0; pass < 5; pass++ {
		if !strings.Contains(out, "{{") {
			break
		}
		before := out
		out = tokenRe.ReplaceAllStringFunc(out, func(whole string) string {
			m := tokenRe.FindStringSubmatch(whole)
			if m == nil {
				return whole
			}
			if p, ok := dynvars.Placeholder(m[1]); ok {
				return p
			}
			if v, ok := vars[m[1]]; ok {
				return v
			}
			return whole
		})
		if out == before {
			break
		}
	}
	return out
}

// metadataHosts are cloud metadata services by name rather than by address.
var metadataHosts = map[string]bool{
	"metadata":                 true,
	"metadata.google.internal": true,
	"metadata.goog":            true,
}

// hardDeny lists permanently blocked ranges. NOT configurable — see the package
// comment. The link-local case is the important one: without it an authenticated
// user can read cloud IAM credentials through a "load test".
var hardDeny = []struct {
	label string
	match func(ip net.IP, raw string) bool
}{
	{"cloud metadata", func(ip net.IP, raw string) bool {
		if v4 := ip.To4(); v4 != nil {
			if v4[0] == 169 && v4[1] == 254 {
				return true
			}
			return v4.String() == "100.100.100.200" || v4.String() == "192.0.0.192"
		}
		return false
	}},
	{"IPv6 link-local", func(ip net.IP, raw string) bool {
		return ip.To4() == nil && ip.IsLinkLocalUnicast()
	}},
	{"IPv6 unique-local", func(ip net.IP, raw string) bool {
		if ip.To4() != nil {
			return false
		}
		return len(ip) == net.IPv6len && (ip[0] == 0xfc || ip[0] == 0xfd)
	}},
	{"unspecified address", func(ip net.IP, raw string) bool {
		if v4 := ip.To4(); v4 != nil {
			return v4[0] == 0
		}
		return ip.IsUnspecified()
	}},
}

func isLoopback(raw string) bool {
	ip := net.ParseIP(strings.Trim(raw, "[]"))
	return ip != nil && ip.IsLoopback()
}

func ipInCIDR(raw, cidr string) bool {
	_, network, err := net.ParseCIDR(cidr)
	if err != nil {
		return false
	}
	ip := net.ParseIP(strings.Trim(raw, "[]"))
	return ip != nil && network.Contains(ip)
}

// matchesAllow supports: exact host, host:port, *.suffix, or a CIDR.
func matchesAllow(entry, host, port string, ips []string) bool {
	h := strings.ToLower(host)
	if strings.Contains(entry, "/") {
		for _, ip := range ips {
			if ipInCIDR(ip, entry) {
				return true
			}
		}
		return false
	}
	if strings.HasPrefix(entry, "*.") {
		return strings.HasSuffix(h, entry[1:])
	}
	if strings.Contains(entry, ":") {
		return entry == h+":"+port
	}
	return entry == h
}

// ValidateTarget resolves variables in the URL, then validates the origin.
func ValidateTarget(rawURL string, vars map[string]string, opts TargetOptions) ResolvedTarget {
	return validate(InterpolateForTarget(rawURL, vars), opts)
}

const templatedOrigin = "The target host still contains {{...}} after variable resolution, so it cannot be checked against the allow-list. Define the variable, or hard-code the host."

// OriginHasTemplate reports whether the ORIGIN (not the path) still holds a
// template.
//
// Checked before parsing, because the two languages' URL parsers disagree about
// a host containing braces: new URL() accepts it, Go's url.Parse rejects it. A
// templated path like /mock/job/{{jobId}} is perfectly fine and must pass.
func OriginHasTemplate(raw string) bool {
	sep := strings.Index(raw, "://")
	if sep == -1 {
		return false
	}
	after := raw[sep+3:]
	origin := after
	if slash := strings.Index(after, "/"); slash != -1 {
		origin = after[:slash]
	}
	return strings.Contains(origin, "{{") || strings.Contains(origin, "}}")
}

func validate(raw string, opts TargetOptions) ResolvedTarget {
	if OriginHasTemplate(raw) {
		return ResolvedTarget{Reason: templatedOrigin}
	}
	notAbsolute := ResolvedTarget{Reason: fmt.Sprintf("Target is not an absolute http(s) URL: %s", raw)}
	parsed, err := url.Parse(raw)
	if err != nil || parsed.Scheme == "" {
		return notAbsolute
	}

	scheme := strings.ToLower(parsed.Scheme)
	if scheme != "http" && scheme != "https" {
		return ResolvedTarget{Reason: fmt.Sprintf(`Only http and https targets are allowed (got "%s").`, scheme)}
	}

	host := strings.ToLower(parsed.Hostname())
	if host == "" {
		return notAbsolute
	}
	port := parsed.Port()
	if port == "" {
		if scheme == "https" {
			port = "443"
		} else {
			port = "80"
		}
	}

	if metadataHosts[host] {
		return ResolvedTarget{Reason: fmt.Sprintf(`Target "%s" is a cloud metadata endpoint and is permanently blocked.`, host)}
	}

	var ips []string
	if net.ParseIP(strings.Trim(host, "[]")) != nil {
		ips = []string{host}
	} else {
		resolved, rerr := opts.Resolve(host)
		// The underlying resolver message differs between Node and Go, so it is
		// deliberately not included — the string is part of the parity contract.
		if rerr != nil || len(resolved) == 0 {
			return ResolvedTarget{Reason: fmt.Sprintf(`Could not resolve host "%s".`, host)}
		}
		ips = resolved
	}

	// Check EVERY address, not just the first: a name that resolves to one good
	// and one blocked address must be rejected.
	for _, raw := range ips {
		ip := net.ParseIP(strings.Trim(raw, "[]"))
		if ip == nil {
			continue
		}
		for _, d := range hardDeny {
			if d.match(ip, raw) {
				return ResolvedTarget{Reason: fmt.Sprintf(
					`Target "%s" resolves to %s, which is in a permanently blocked range (%s).`, host, raw, d.label)}
			}
		}
	}

	// The self-origin rule: hammering our own API takes the UI down with it, and
	// /mock is the one path that is safe (and is the default-deny target).
	selfOrigin := false
	for _, ip := range ips {
		if isLoopback(ip) && port == opts.SelfPort {
			selfOrigin = true
			break
		}
	}
	path := parsed.Path
	if path == "" {
		path = "/"
	}
	isMockPath := path == "/mock" || strings.HasPrefix(path, "/mock/")
	if selfOrigin && !isMockPath {
		return ResolvedTarget{Reason: fmt.Sprintf(
			`Pointing Hera at this Hermes instance is only allowed under /mock (got "%s") — load-testing your own API takes the UI down with it.`, path)}
	}

	allowed := selfOrigin && isMockPath
	if !allowed {
		for _, e := range opts.Limits.TargetAllow {
			if matchesAllow(e, host, port, ips) {
				allowed = true
				break
			}
		}
	}
	if !allowed {
		if len(opts.Limits.TargetAllow) == 0 {
			return ResolvedTarget{Reason: fmt.Sprintf(
				`No HERA_TARGET_ALLOW is configured, so Hera may only target this instance's own /mock API. Set HERA_TARGET_ALLOW to load-test "%s".`, host)}
		}
		return ResolvedTarget{Reason: fmt.Sprintf(`Target host "%s" is not in HERA_TARGET_ALLOW.`, host)}
	}

	return ResolvedTarget{
		OK:         true,
		Host:       host,
		Port:       port,
		Scheme:     scheme,
		ResolvedIP: ips[0],
		AllIPs:     ips,
		SelfMock:   selfOrigin && isMockPath,
	}
}

// DefaultResolver looks up A and AAAA records via the system resolver.
func DefaultResolver(host string) ([]string, error) {
	addrs, err := net.DefaultResolver.LookupIPAddr(context.Background(), host)
	if err != nil {
		return nil, err
	}
	out := make([]string, 0, len(addrs))
	for _, a := range addrs {
		out = append(out, a.IP.String())
	}
	return out, nil
}
