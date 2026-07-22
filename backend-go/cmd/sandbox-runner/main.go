// sandbox-runner reads a JSON array of sandbox test cases and emits, for each,
// the SandboxOutcome produced by the Go/goja sandbox. It is the Go half of the
// parity harness — the Node half (backend/tools/sandbox-runner.ts) reads the
// same input and must produce identical output.
package main

import (
	"encoding/json"
	"fmt"
	"os"

	"github.com/finbox/hermes/backend-go/internal/runner"
)

type testCase struct {
	Name      string                  `json:"name"`
	Code      string                  `json:"code"`
	Mode      string                  `json:"mode"`
	Response  runner.SandboxResponse  `json:"response"`
	Variables map[string]string       `json:"variables"`
}

type result struct {
	Name    string                 `json:"name"`
	Outcome runner.SandboxOutcome  `json:"outcome"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: sandbox-runner <cases.json>")
		os.Exit(2)
	}
	raw, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, "read:", err)
		os.Exit(1)
	}
	var cases []testCase
	if err := json.Unmarshal(raw, &cases); err != nil {
		fmt.Fprintln(os.Stderr, "parse:", err)
		os.Exit(1)
	}

	out := make([]result, 0, len(cases))
	for _, c := range cases {
		vars := c.Variables
		getVar := func(key string) (string, bool) {
			v, ok := vars[key]
			return v, ok
		}
		out = append(out, result{Name: c.Name, Outcome: runner.RunScript(c.Code, c.Response, getVar, c.Mode)})
	}

	enc := json.NewEncoder(os.Stdout)
	enc.SetIndent("", "  ")
	if err := enc.Encode(out); err != nil {
		fmt.Fprintln(os.Stderr, "encode:", err)
		os.Exit(1)
	}
}
