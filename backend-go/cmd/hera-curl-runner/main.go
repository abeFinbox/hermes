// hera-curl-runner reads the shared Hera cURL cases file and emits the cURL
// built for each step. It is the Go half of the cURL-parity harness — the Node
// half (backend/tools/hera-curl-runner.ts) reads the same input and must produce
// BYTE-IDENTICAL output.
//
// A divergence here is not cosmetic: this command carries real credentials and is
// what someone pastes into a terminal to reproduce a failing step. If the two
// engines quote, order or percent-encode differently, one of them is handing out
// a command that does not reproduce the run.
//
//	go run ./cmd/hera-curl-runner ./testdata/hera-curl-cases.json
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/hera"
	"github.com/finbox/hermes/backend-go/internal/model"
)

type fixtureCase struct {
	Name       string                   `json:"name"`
	SeedVars   map[string]string        `json:"seedVars"`
	FileMeta   map[string]hera.FileMeta `json:"fileMeta"`
	HostHeader string                   `json:"hostHeader"`
	Step       json.RawMessage          `json:"step"`
}

// hydrateStep fills a fixture step out to a full model.Step. Mirrors hydrateStep
// in the Node half.
func hydrateStep(raw json.RawMessage) model.Step {
	var probe struct {
		ID      string `json:"id"`
		Name    string `json:"name"`
		Enabled *bool  `json:"enabled"`
		Request *struct {
			Method  string      `json:"method"`
			URL     string      `json:"url"`
			Headers []model.KV  `json:"headers"`
			Params  []model.KV  `json:"params"`
			Body    *model.Body `json:"body"`
			Auth    *model.Auth `json:"auth"`
		} `json:"request"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		panic(err)
	}
	step := model.Step{ID: probe.ID, Name: probe.Name, Enabled: probe.Enabled == nil || *probe.Enabled}
	if step.ID == "" {
		step.ID = "step-1"
	}
	if step.Name == "" {
		step.Name = "Step"
	}
	if probe.Request != nil {
		step.Request.Method = probe.Request.Method
		step.Request.URL = probe.Request.URL
		step.Request.Headers = probe.Request.Headers
		step.Request.Params = probe.Request.Params
		if probe.Request.Body != nil {
			step.Request.Body = *probe.Request.Body
		}
		if probe.Request.Auth != nil {
			step.Request.Auth = *probe.Request.Auth
		}
	}
	if step.Request.Method == "" {
		step.Request.Method = "GET"
	}
	if step.Request.Body.Mode == "" {
		step.Request.Body.Mode = "none"
	}
	if step.Request.Auth.Type == "" {
		step.Request.Auth.Type = "none"
	}
	return step
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: hera-curl-runner <cases.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(data, &cases); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(2)
	}

	lines := []string{}
	for _, c := range cases {
		lines = append(lines, "--- "+c.Name)
		seed := c.SeedVars
		if seed == nil {
			seed = map[string]string{}
		}
		metas := c.FileMeta
		if metas == nil {
			metas = map[string]hera.FileMeta{}
		}
		curl := hera.BuildStepCurl(hera.StepCurlInput{
			Step:       hydrateStep(c.Step),
			SeedVars:   seed,
			FileMetas:  metas,
			HostHeader: c.HostHeader,
		})
		// Indent so a multi-line command cannot be confused with the next case
		// label.
		for _, l := range strings.Split(curl, "\n") {
			lines = append(lines, "  "+l)
		}
	}
	fmt.Print(strings.Join(lines, "\n") + "\n")
}
