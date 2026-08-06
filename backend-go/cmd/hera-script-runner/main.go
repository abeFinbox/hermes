// hera-script-runner reads the shared Hera cases file and emits the generated
// k6 script for each case. It is the Go half of the script-parity harness — the
// Node half (backend/tools/hera-script-runner.ts) reads the same input and must
// produce BYTE-IDENTICAL output.
//
//	go run ./cmd/hera-script-runner ./testdata/hera-cases.json
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
	Load       hera.LoadConfig          `json:"load"`
	FilePaths  map[string]string        `json:"filePaths"`
	FileMeta   map[string]hera.FileMeta `json:"fileMeta"`
	HostHeader string                   `json:"hostHeader"`
	Suite      struct {
		Name      string                `json:"name"`
		Settings  *model.SuiteSettings  `json:"settings"`
		Variables []model.SuiteVariable `json:"variables"`
		Steps     []json.RawMessage     `json:"steps"`
	} `json:"suite"`
}

// hydrateStep fills a fixture step out to a full model.Step so fixtures stay
// readable. Mirrors hydrateStep in the Node runner.
func hydrateStep(raw json.RawMessage) model.Step {
	var probe struct {
		ID         string `json:"id"`
		Name       string `json:"name"`
		Enabled    *bool  `json:"enabled"`
		FolderPath string `json:"folderPath"`
		Request    *struct {
			Method  string      `json:"method"`
			URL     string      `json:"url"`
			Headers []model.KV  `json:"headers"`
			Params  []model.KV  `json:"params"`
			Body    *model.Body `json:"body"`
			Auth    *model.Auth `json:"auth"`
		} `json:"request"`
		Validations *model.Validations `json:"validations"`
		Captures    *model.Captures    `json:"captures"`
		Polling     *model.StepPolling `json:"polling"`
	}
	if err := json.Unmarshal(raw, &probe); err != nil {
		panic(err)
	}

	step := model.Step{
		ID:         probe.ID,
		Name:       probe.Name,
		Enabled:    probe.Enabled == nil || *probe.Enabled,
		FolderPath: probe.FolderPath,
		Polling:    probe.Polling,
	}
	if probe.Request != nil {
		step.Request.Method = probe.Request.Method
		if step.Request.Method == "" {
			step.Request.Method = "GET"
		}
		step.Request.URL = probe.Request.URL
		step.Request.Headers = probe.Request.Headers
		step.Request.Params = probe.Request.Params
		if probe.Request.Body != nil {
			step.Request.Body = *probe.Request.Body
		}
		if step.Request.Body.Mode == "" {
			step.Request.Body.Mode = "none"
		}
		if probe.Request.Auth != nil {
			step.Request.Auth = *probe.Request.Auth
		}
	} else {
		step.Request.Method = "GET"
		step.Request.Body.Mode = "none"
	}
	if step.Request.Auth.Type == "" {
		step.Request.Auth.Type = "none"
	}
	if probe.Validations != nil {
		step.Validations = *probe.Validations
	}
	if probe.Captures != nil {
		step.Captures = *probe.Captures
	}
	return step
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: hera-script-runner <cases.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var cases []fixtureCase
	if err := json.Unmarshal(data, &cases); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	chunks := []string{}
	for _, c := range cases {
		settings := model.DefaultSettings()
		if c.Suite.Settings != nil {
			settings = *c.Suite.Settings
		}
		steps := make([]model.Step, 0, len(c.Suite.Steps))
		for _, raw := range c.Suite.Steps {
			steps = append(steps, hydrateStep(raw))
		}
		suite := model.Suite{
			ID:        "fixture",
			Name:      c.Suite.Name,
			Steps:     steps,
			Variables: c.Suite.Variables,
			Settings:  settings,
		}
		seed := c.SeedVars
		if seed == nil {
			seed = map[string]string{}
		}
		filePaths := c.FilePaths
		if filePaths == nil {
			filePaths = map[string]string{}
		}
		fileMetas := c.FileMeta
		if fileMetas == nil {
			fileMetas = map[string]hera.FileMeta{}
		}
		script, _ := hera.GenerateScript(hera.GenerateInput{
			Suite:      suite,
			SeedVars:   seed,
			Load:       c.Load,
			FilePaths:  filePaths,
			FileMetas:  fileMetas,
			HostHeader: c.HostHeader,
		})
		chunks = append(chunks, "===== CASE "+c.Name+" =====\n"+script)
	}
	fmt.Print(strings.Join(chunks, "\n") + "\n")
}
