// Package web holds small HTTP helpers shared by the route handlers.
package web

import (
	"encoding/json"
	"net/http"
)

// JSON writes v as a JSON response with the given status.
func JSON(w http.ResponseWriter, status int, v interface{}) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

// Err writes {"error": msg} with the given status. Extra key/value pairs are
// merged into the object (used e.g. for {captchaFailed:true}).
func Err(w http.ResponseWriter, status int, msg string, extra ...map[string]interface{}) {
	body := map[string]interface{}{"error": msg}
	for _, m := range extra {
		for k, v := range m {
			body[k] = v
		}
	}
	JSON(w, status, body)
}

// Decode reads a JSON body into v. A missing/empty body is not an error
// (matches Express `req.body || {}`), leaving v at its zero value.
func Decode(r *http.Request, v interface{}) error {
	if r.Body == nil {
		return nil
	}
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(v); err != nil {
		if err.Error() == "EOF" {
			return nil
		}
		return err
	}
	return nil
}
