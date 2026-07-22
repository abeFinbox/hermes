// Package postman ports backend/src/postman.ts (import) and
// postman-export.ts (export): Postman Collection v2.0/v2.1 <-> Hermes suites.
package postman

import (
	"encoding/json"
	"fmt"
	"net/url"
	"regexp"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/model"
)

// ---------------- import ----------------

type TreeNode struct {
	Type     string     `json:"type"` // folder | request
	Name     string     `json:"name"`
	Method   string     `json:"method,omitempty"`
	URL      string     `json:"url,omitempty"`
	StepID   string     `json:"stepId,omitempty"`
	Children []TreeNode `json:"children,omitempty"`
}

type ImportResult struct {
	Name      string
	Steps     []model.Step
	Tree      []TreeNode
	Variables []model.KV // key/value only (enabled unused on import)
}

func asKVList(list interface{}) []model.KV {
	arr, ok := list.([]interface{})
	if !ok {
		return []model.KV{}
	}
	out := []model.KV{}
	for _, it := range arr {
		m, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		key, ok := m["key"].(string)
		if !ok {
			continue
		}
		out = append(out, model.KV{Key: key, Value: str(m["value"]), Enabled: !truthy(m["disabled"])})
	}
	return out
}

func urlToString(u interface{}) string {
	switch v := u.(type) {
	case string:
		return v
	case map[string]interface{}:
		if raw, ok := v["raw"].(string); ok && raw != "" {
			return raw
		}
		protocol := ""
		if p, ok := v["protocol"].(string); ok && p != "" {
			protocol = p + "://"
		}
		host := ""
		if h, ok := v["host"].([]interface{}); ok {
			host = joinStr(h, ".")
		} else if h, ok := v["host"].(string); ok {
			host = h
		}
		port := ""
		if p := str(v["port"]); p != "" {
			port = ":" + p
		}
		path := ""
		if p, ok := v["path"].([]interface{}); ok {
			path = "/" + joinStr(p, "/")
		} else if p := str(v["path"]); p != "" {
			path = "/" + p
		}
		query := ""
		if q, ok := v["query"].([]interface{}); ok && len(q) > 0 {
			var parts []string
			for _, qi := range q {
				qm, _ := qi.(map[string]interface{})
				if qm == nil || truthy(qm["disabled"]) {
					continue
				}
				parts = append(parts, fmt.Sprintf("%s=%s", str(qm["key"]), str(qm["value"])))
			}
			if len(parts) > 0 {
				query = "?" + strings.Join(parts, "&")
			}
		}
		return protocol + host + port + path + query
	}
	return ""
}

func queryFromURL(u interface{}) []model.KV {
	m, ok := u.(map[string]interface{})
	if !ok {
		return []model.KV{}
	}
	q, ok := m["query"].([]interface{})
	if !ok {
		return []model.KV{}
	}
	out := []model.KV{}
	for _, qi := range q {
		qm, ok := qi.(map[string]interface{})
		if !ok {
			continue
		}
		key, ok := qm["key"].(string)
		if !ok {
			continue
		}
		out = append(out, model.KV{Key: key, Value: str(qm["value"]), Enabled: !truthy(qm["disabled"])})
	}
	return out
}

func bodyFromPostman(body interface{}) model.Body {
	m, ok := body.(map[string]interface{})
	if !ok || m["mode"] == nil {
		return model.Body{Mode: "none", Content: ""}
	}
	mode, _ := m["mode"].(string)
	switch mode {
	case "raw":
		lang := ""
		if opts, ok := m["options"].(map[string]interface{}); ok {
			if raw, ok := opts["raw"].(map[string]interface{}); ok {
				lang, _ = raw["language"].(string)
			}
		}
		outMode := "raw"
		if lang == "json" {
			outMode = "json"
		}
		return model.Body{Mode: outMode, Content: str(m["raw"])}
	case "urlencoded":
		var pairs []string
		if arr, ok := m["urlencoded"].([]interface{}); ok {
			for _, it := range arr {
				p, _ := it.(map[string]interface{})
				if p == nil || truthy(p["disabled"]) {
					continue
				}
				pairs = append(pairs, url.QueryEscape(str(p["key"]))+"="+url.QueryEscape(str(p["value"])))
			}
		}
		return model.Body{Mode: "form", Content: strings.Join(pairs, "&")}
	case "formdata":
		fields := []model.FormDataField{}
		if arr, ok := m["formdata"].([]interface{}); ok {
			for _, it := range arr {
				p, _ := it.(map[string]interface{})
				if p == nil || str(p["key"]) == "" {
					continue
				}
				typ := "text"
				value := str(p["value"])
				if t, _ := p["type"].(string); t == "file" {
					typ = "file"
					value = ""
				}
				fields = append(fields, model.FormDataField{
					ID: model.NewID(), Key: str(p["key"]), Type: typ, Value: value, FileID: "", Enabled: !truthy(p["disabled"]),
				})
			}
		}
		return model.Body{Mode: "form-data", Content: "", FormData: fields}
	case "graphql":
		gq, _ := json.Marshal(m["graphql"])
		return model.Body{Mode: "json", Content: string(gq)}
	default:
		if s, ok := m[mode].(string); ok {
			return model.Body{Mode: "raw", Content: s}
		}
		b, _ := json.Marshal(m[mode])
		return model.Body{Mode: "raw", Content: string(b)}
	}
}

func authFromPostman(auth interface{}) model.Auth {
	m, ok := auth.(map[string]interface{})
	if !ok {
		return model.Auth{Type: "none"}
	}
	typ, _ := m["type"].(string)
	if typ == "" || typ == "noauth" {
		return model.Auth{Type: "none"}
	}
	grab := func(listKey, key string) string {
		arr, ok := m[listKey].([]interface{})
		if !ok {
			return ""
		}
		for _, it := range arr {
			im, _ := it.(map[string]interface{})
			if im != nil && im["key"] == key {
				return str(im["value"])
			}
		}
		return ""
	}
	switch typ {
	case "bearer":
		return model.Auth{Type: "bearer", Token: grab("bearer", "token")}
	case "basic":
		return model.Auth{Type: "basic", Username: grab("basic", "username"), Password: grab("basic", "password")}
	}
	return model.Auth{Type: "none"}
}

func requestFromPostman(r interface{}) model.StepRequest {
	if s, ok := r.(string); ok {
		req := model.EmptyRequest()
		req.URL = s
		return req
	}
	m, ok := r.(map[string]interface{})
	if !ok {
		return model.EmptyRequest()
	}
	method := "GET"
	if v, ok := m["method"].(string); ok && v != "" {
		method = strings.ToUpper(v)
	}
	return model.StepRequest{
		Method:  method,
		URL:     urlToString(m["url"]),
		Headers: asKVList(m["header"]),
		Params:  queryFromURL(m["url"]),
		Body:    bodyFromPostman(m["body"]),
		Auth:    authFromPostman(m["auth"]),
	}
}

func walk(items []interface{}, folderPath []string, steps *[]model.Step, tree *[]TreeNode) {
	for _, it := range items {
		item, ok := it.(map[string]interface{})
		if !ok {
			continue
		}
		if sub, ok := item["item"].([]interface{}); ok {
			node := TreeNode{Type: "folder", Name: strOr(item["name"], "Folder"), Children: []TreeNode{}}
			walk(sub, append(append([]string{}, folderPath...), node.Name), steps, &node.Children)
			*tree = append(*tree, node)
		} else if item["request"] != nil {
			request := requestFromPostman(item["request"])
			snapshot := request // value copy; deep enough since slices are rebuilt on edit
			step := model.Step{
				ID:            model.NewID(),
				Name:          strOr(item["name"], firstNonEmpty(request.URL, "Request")),
				Enabled:       true,
				FolderPath:    strings.Join(folderPath, " / "),
				Request:       request,
				SourceRequest: &snapshot,
				Validations:   model.Validations{Visual: []model.Assertion{}, Script: ""},
				Captures:      model.Captures{Visual: []model.CaptureRule{}, Script: ""},
			}
			if ev, ok := item["event"].([]interface{}); ok {
				step.PostmanEvents = ev
			}
			*steps = append(*steps, step)
			*tree = append(*tree, TreeNode{Type: "request", Name: step.Name, Method: request.Method, URL: request.URL, StepID: step.ID})
		}
	}
}

var schemaRe = regexp.MustCompile(`collection/v2\.[01]`)

// ImportCollection normalizes a parsed Postman collection into a suite skeleton.
func ImportCollection(raw interface{}) (*ImportResult, error) {
	m, ok := raw.(map[string]interface{})
	if !ok {
		return nil, fmt.Errorf("Not a JSON object")
	}
	info, _ := m["info"].(map[string]interface{})
	items, hasItems := m["item"].([]interface{})
	if info == nil || !hasItems {
		return nil, fmt.Errorf(`Not a Postman collection: missing "info" or "item"`)
	}
	if schema, _ := info["schema"].(string); schema != "" && !schemaRe.MatchString(schema) {
		return nil, fmt.Errorf("Unsupported schema (%s); only Postman collection v2.0/v2.1 is supported", schema)
	}
	steps := []model.Step{}
	tree := []TreeNode{}
	walk(items, nil, &steps, &tree)

	variables := []model.KV{}
	if arr, ok := m["variable"].([]interface{}); ok {
		for _, it := range arr {
			vm, _ := it.(map[string]interface{})
			if vm == nil {
				continue
			}
			if key, ok := vm["key"].(string); ok {
				variables = append(variables, model.KV{Key: key, Value: str(vm["value"])})
			}
		}
	}
	return &ImportResult{Name: strOr(info["name"], "Imported collection"), Steps: steps, Tree: tree, Variables: variables}, nil
}

// ---------------- helpers ----------------

func str(v interface{}) string {
	switch x := v.(type) {
	case nil:
		return ""
	case string:
		return x
	case float64:
		// mirror String(number): integers without ".0"
		if x == float64(int64(x)) {
			return fmt.Sprintf("%d", int64(x))
		}
		return fmt.Sprintf("%v", x)
	case bool:
		if x {
			return "true"
		}
		return "false"
	default:
		b, _ := json.Marshal(x)
		return string(b)
	}
}

func strOr(v interface{}, def string) string {
	if s, ok := v.(string); ok && s != "" {
		return s
	}
	return def
}

func firstNonEmpty(a, b string) string {
	if a != "" {
		return a
	}
	return b
}

func truthy(v interface{}) bool {
	switch x := v.(type) {
	case bool:
		return x
	case string:
		return x != ""
	case float64:
		return x != 0
	default:
		return v != nil
	}
}

func joinStr(arr []interface{}, sep string) string {
	parts := make([]string, 0, len(arr))
	for _, a := range arr {
		parts = append(parts, str(a))
	}
	return strings.Join(parts, sep)
}
