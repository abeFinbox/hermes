package postman

import (
	"encoding/json"
	"net/url"
	"regexp"
	"strconv"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/model"
)

// Suite -> Postman Collection v2.1 (reverse of import), ported from
// backend/src/postman-export.ts.

// j mirrors JSON.stringify for a single value (quoted, escaped where a string).
func j(v interface{}) string {
	b, _ := json.Marshal(v)
	return string(b)
}

var accessorRe = regexp.MustCompile(`^\$((?:\.[A-Za-z_$][\w$]*|\[\d+\])+)$`)

// jsonAccessor: "$.data.token" -> "pm.response.json().data.token" (simple paths).
func jsonAccessor(expr string) (string, bool) {
	m := accessorRe.FindStringSubmatch(strings.TrimSpace(expr))
	if m == nil {
		return "", false
	}
	return "pm.response.json()" + m[1], true
}

func assertionLines(a model.Assertion) []string {
	name := j(model.DescribeAssertion(a))
	switch a.Type {
	case "status-equals":
		return []string{"pm.test(" + name + ", function () { pm.response.to.have.status(" + strconv.Itoa(atoiOr(a.Expected, 0)) + "); });"}
	case "body-contains":
		return []string{"pm.test(" + name + ", function () { pm.expect(pm.response.text()).to.include(" + j(a.Expected) + "); });"}
	case "header-equals":
		return []string{"pm.test(" + name + ", function () { pm.expect(pm.response.headers.get(" + j(a.Expression) + ")).to.eql(" + j(a.Expected) + "); });"}
	case "response-time-below":
		return []string{"pm.test(" + name + ", function () { pm.expect(pm.response.responseTime).to.be.below(" + strconv.Itoa(atoiOr(a.Expected, 0)) + "); });"}
	case "jsonpath-exists":
		acc, ok := jsonAccessor(a.Expression)
		if !ok {
			return []string{"// skipped (complex JSONPath): " + model.DescribeAssertion(a)}
		}
		return []string{"pm.test(" + name + ", function () { pm.expect(" + acc + ").to.not.eql(undefined); });"}
	case "jsonpath-equals":
		acc, ok := jsonAccessor(a.Expression)
		if !ok {
			return []string{"// skipped (complex JSONPath): " + model.DescribeAssertion(a)}
		}
		return []string{"pm.test(" + name + ", function () { pm.expect(String(" + acc + ")).to.eql(" + j(a.Expected) + "); });"}
	}
	return []string{}
}

func captureLines(c model.CaptureRule) []string {
	if c.TargetVariable == "" {
		return []string{}
	}
	set := func(value string) string {
		return "pm.collectionVariables.set(" + j(c.TargetVariable) + ", " + value + ");"
	}
	switch c.Source {
	case "status":
		return []string{set("String(pm.response.code)")}
	case "header":
		return []string{set("pm.response.headers.get(" + j(c.Expression) + ")")}
	case "body-text":
		return []string{set("pm.response.text()")}
	case "body-jsonpath":
		acc, ok := jsonAccessor(c.Expression)
		if !ok {
			return []string{"// skipped capture (complex JSONPath " + j(c.Expression) + ") -> {{" + c.TargetVariable + "}}"}
		}
		return []string{set(acc)}
	}
	return []string{}
}

func commentBlock(title, code string) []string {
	out := []string{"// --- " + title + " (Hermes sandbox script, not pm-compatible — for reference) ---"}
	for _, l := range strings.Split(code, "\n") {
		out = append(out, "// "+l)
	}
	return out
}

func buildEvents(step model.Step) []interface{} {
	if len(step.PostmanEvents) > 0 {
		return step.PostmanEvents
	}
	var lines []string
	for _, a := range step.Validations.Visual {
		lines = append(lines, assertionLines(a)...)
	}
	for _, c := range step.Captures.Visual {
		lines = append(lines, captureLines(c)...)
	}
	if strings.TrimSpace(step.Validations.Script) != "" {
		lines = append(lines, commentBlock("validation script", step.Validations.Script)...)
	}
	if strings.TrimSpace(step.Captures.Script) != "" {
		lines = append(lines, commentBlock("capture script", step.Captures.Script)...)
	}
	if len(lines) == 0 {
		return nil
	}
	return []interface{}{map[string]interface{}{
		"listen": "test",
		"script": map[string]interface{}{"type": "text/javascript", "exec": lines},
	}}
}

func buildRequest(step model.Step) map[string]interface{} {
	r := step.Request
	request := map[string]interface{}{"method": r.Method}

	var enabledParams []model.KV
	for _, p := range r.Params {
		if p.Key != "" {
			enabledParams = append(enabledParams, p)
		}
	}
	if len(enabledParams) > 0 {
		var qsParts []string
		for _, p := range enabledParams {
			if p.Enabled {
				qsParts = append(qsParts, p.Key+"="+p.Value)
			}
		}
		qs := strings.Join(qsParts, "&")
		raw := r.URL
		if qs != "" {
			sep := "?"
			if strings.Contains(r.URL, "?") {
				sep = "&"
			}
			raw = r.URL + sep + qs
		}
		query := make([]map[string]interface{}, 0, len(enabledParams))
		for _, p := range enabledParams {
			q := map[string]interface{}{"key": p.Key, "value": p.Value}
			if !p.Enabled {
				q["disabled"] = true
			}
			query = append(query, q)
		}
		request["url"] = map[string]interface{}{"raw": raw, "query": query}
	} else {
		request["url"] = r.URL
	}

	if len(r.Headers) > 0 {
		var headers []map[string]interface{}
		for _, h := range r.Headers {
			if h.Key == "" {
				continue
			}
			hm := map[string]interface{}{"key": h.Key, "value": h.Value}
			if !h.Enabled {
				hm["disabled"] = true
			}
			headers = append(headers, hm)
		}
		if headers != nil {
			request["header"] = headers
		}
	}

	switch r.Body.Mode {
	case "json", "raw":
		body := map[string]interface{}{"mode": "raw", "raw": r.Body.Content}
		if r.Body.Mode == "json" {
			body["options"] = map[string]interface{}{"raw": map[string]interface{}{"language": "json"}}
		}
		request["body"] = body
	case "form":
		var pairs []map[string]interface{}
		for _, pair := range strings.Split(r.Body.Content, "&") {
			if pair == "" {
				continue
			}
			kv := strings.SplitN(pair, "=", 2)
			val := ""
			if len(kv) > 1 {
				val = kv[1]
			}
			pairs = append(pairs, map[string]interface{}{"key": safeDecode(kv[0]), "value": safeDecode(val)})
		}
		request["body"] = map[string]interface{}{"mode": "urlencoded", "urlencoded": pairs}
	case "form-data":
		var fd []map[string]interface{}
		for _, f := range r.Body.FormData {
			if f.Key == "" {
				continue
			}
			var part map[string]interface{}
			if f.Type == "file" {
				part = map[string]interface{}{"key": f.Key, "type": "file", "src": nil}
			} else {
				part = map[string]interface{}{"key": f.Key, "type": "text", "value": f.Value}
			}
			if !f.Enabled {
				part["disabled"] = true
			}
			fd = append(fd, part)
		}
		request["body"] = map[string]interface{}{"mode": "formdata", "formdata": fd}
	}

	switch r.Auth.Type {
	case "bearer":
		request["auth"] = map[string]interface{}{"type": "bearer", "bearer": []map[string]interface{}{{"key": "token", "value": r.Auth.Token, "type": "string"}}}
	case "basic":
		request["auth"] = map[string]interface{}{"type": "basic", "basic": []map[string]interface{}{
			{"key": "username", "value": r.Auth.Username, "type": "string"},
			{"key": "password", "value": r.Auth.Password, "type": "string"},
		}}
	}
	return request
}

func safeDecode(s string) string {
	// PathUnescape mirrors decodeURIComponent: decodes %XX, leaves '+' as-is
	// (QueryUnescape would wrongly turn '+' into a space).
	if d, err := url.PathUnescape(s); err == nil {
		return d
	}
	return s
}

// ExportSuiteAsCollection converts a suite to a Postman v2.1 collection object.
func ExportSuiteAsCollection(suite model.Suite) map[string]interface{} {
	root := []interface{}{}
	folderItems := map[string]*[]interface{}{}

	var childrenFor func(path string) *[]interface{}
	childrenFor = func(path string) *[]interface{} {
		if path == "" {
			return &root
		}
		if ex, ok := folderItems[path]; ok {
			return ex
		}
		parts := strings.Split(path, " / ")
		parent := childrenFor(strings.Join(parts[:len(parts)-1], " / "))
		items := []interface{}{}
		folder := map[string]interface{}{"name": parts[len(parts)-1], "item": &items}
		*parent = append(*parent, folder)
		folderItems[path] = &items
		return &items
	}

	for _, step := range suite.Steps {
		item := map[string]interface{}{"name": step.Name, "request": buildRequest(step)}
		if events := buildEvents(step); events != nil {
			item["event"] = events
		}
		dst := childrenFor(step.FolderPath)
		*dst = append(*dst, item)
	}

	info := map[string]interface{}{
		"_postman_id": suite.ID,
		"name":        suite.Name,
		"schema":      "https://schema.getpostman.com/json/collection/v2.1.0/collection.json",
	}
	if suite.Description != "" {
		info["description"] = suite.Description
	}

	variables := make([]map[string]interface{}, 0, len(suite.Variables))
	for _, v := range suite.Variables {
		val := v.Value
		if v.Secret {
			val = ""
		}
		variables = append(variables, map[string]interface{}{"key": v.Key, "value": val})
	}

	return map[string]interface{}{
		"info":     info,
		"variable": variables,
		"item":     resolveItems(root),
	}
}

// resolveItems walks the tree turning the *[]interface{} folder pointers into
// concrete slices for JSON marshalling.
func resolveItems(items []interface{}) []interface{} {
	out := make([]interface{}, 0, len(items))
	for _, it := range items {
		m, ok := it.(map[string]interface{})
		if !ok {
			out = append(out, it)
			continue
		}
		if sub, ok := m["item"].(*[]interface{}); ok {
			m["item"] = resolveItems(*sub)
		}
		out = append(out, m)
	}
	return out
}

func atoiOr(s string, def int) int {
	if n, err := strconv.Atoi(strings.TrimSpace(s)); err == nil {
		return n
	}
	return def
}
