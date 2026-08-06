// hera-target-runner is the Go half of the Hera target-validation parity
// harness. DNS is stubbed from the fixture, so it needs no network and is
// deterministic. The Node half is backend/tools/hera-target-runner.ts and must
// produce BYTE-IDENTICAL output.
//
// Rejection-string parity matters more than script parity: a divergence between
// the two backends means one is a bypass for the other.
//
//	go run ./cmd/hera-target-runner ./testdata/hera-target-cases.json
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strings"

	"github.com/finbox/hermes/backend-go/internal/hera"
)

type fixture struct {
	SelfPort string              `json:"selfPort"`
	DNS      map[string][]string `json:"dns"`
	Cases    []struct {
		Name  string            `json:"name"`
		URL   string            `json:"url"`
		Allow []string          `json:"allow"`
		Vars  map[string]string `json:"vars"`
	} `json:"cases"`
}

func main() {
	if len(os.Args) < 2 {
		fmt.Fprintln(os.Stderr, "usage: hera-target-runner <target-cases.json>")
		os.Exit(2)
	}
	data, err := os.ReadFile(os.Args[1])
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	var fx fixture
	if err := json.Unmarshal(data, &fx); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}

	resolve := func(host string) ([]string, error) {
		ips, ok := fx.DNS[host]
		if !ok {
			return nil, errors.New("stub NXDOMAIN")
		}
		return ips, nil
	}

	lines := []string{}
	for _, c := range fx.Cases {
		limits := hera.GetLimits()
		limits.TargetAllow = c.Allow
		vars := c.Vars
		if vars == nil {
			vars = map[string]string{}
		}
		res := hera.ValidateTarget(c.URL, vars, hera.TargetOptions{
			Limits:   limits,
			SelfPort: fx.SelfPort,
			Resolve:  resolve,
		})
		allowJSON, _ := json.Marshal(c.Allow)
		allIPs := res.AllIPs
		if allIPs == nil {
			allIPs = []string{}
		}
		ipsJSON, _ := json.Marshal(allIPs)
		lines = append(lines, "--- "+c.Name)
		lines = append(lines, "  url    : "+c.URL)
		lines = append(lines, "  allow  : "+string(allowJSON))
		lines = append(lines, "  ok     : "+boolStr(res.OK))
		lines = append(lines, "  reason : "+res.Reason)
		lines = append(lines, "  host   : "+res.Host)
		lines = append(lines, "  port   : "+res.Port)
		lines = append(lines, "  pinned : "+res.ResolvedIP)
		lines = append(lines, "  allIps : "+string(ipsJSON))
		lines = append(lines, "  selfMock: "+boolStr(res.SelfMock))
	}
	fmt.Print(strings.Join(lines, "\n") + "\n")
}

func boolStr(b bool) string {
	if b {
		return "true"
	}
	return "false"
}
