// Load profiles: the SHAPE of a run, derived from the two numbers the user
// already gives (virtual users and duration).
//
// A mode never invents its own numbers. Vus stays the peak and DurationSec stays
// the total, so every existing cap — HERA_MAX_VUS, HERA_MAX_DURATION_SEC, the
// rps x duration request ceiling — keeps applying unchanged, and switching mode
// can never smuggle more load past them than the flat run would.
//
// Stage seconds are integers and always sum to EXACTLY DurationSec: the
// remainder after the percentage split is given to the hold stage, never
// distributed. Two implementations that round differently would emit different
// scripts, which is what the script-parity fixture is there to catch.
//
// Mirrors backend/src/hera/profile.ts.
package hera

import "fmt"

// Modes are declared in one place, in display order; the UI dropdown follows it.
var Modes = []string{"constant", "smoke", "load", "stress", "spike", "soak", "rate"}

func IsMode(v string) bool {
	for _, m := range Modes {
		if m == v {
			return true
		}
	}
	return false
}

type Stage struct {
	// DurationSec is whole seconds.
	DurationSec int `json:"durationSec"`
	// Target is the virtual users to reach by the end of this stage.
	Target int `json:"target"`
}

type Profile struct {
	Mode string `json:"mode"`
	// Vus is the peak virtual users. For smoke this is 1, whatever was requested.
	Vus int `json:"vus"`
	// DurationSec is the total run length; the stages always sum to this.
	DurationSec int `json:"durationSec"`
	// Stages is empty for the flat modes, which use plain vus + duration.
	Stages []Stage `json:"stages"`
	// RatePerSec is the arrival rate; set only for "rate", which pins throughput.
	RatePerSec *int `json:"ratePerSec"`
	// Summary is the human explanation of the shape.
	Summary string `json:"summary"`
	// Notes say why the requested shape was not used verbatim, if it was not.
	Notes []string `json:"notes"`
}

// minSec is the shortest run each shape needs to be meaningful. Below it the
// shape would collapse into stages of zero or one second, which is noise rather
// than a ramp, so the mode falls back to a flat run and says so.
var minSec = map[string]int{
	"constant": 1,
	"smoke":    1,
	"load":     5,
	"stress":   8,
	"spike":    10,
	"soak":     1,
	"rate":     1,
}

var ModeLabels = map[string]string{
	"constant": "Constant — flat load, the whole run at once",
	"smoke":    "Smoke — one virtual user, does it work at all",
	"load":     "Load — ramp up, hold, ramp down",
	"stress":   "Stress — step up in four stages to find the knee",
	"spike":    "Spike — a sudden surge on top of a low baseline",
	"soak":     "Soak — hold steady for a long time, watch for drift",
	"rate":     "Rate — pin iterations per second, whatever it costs in VUs",
}

// vuWord keeps "1 virtual user" from reading as "1 virtual users". Mirrors the
// ternary in profile.ts.
func vuWord(n int) string {
	if n == 1 {
		return "virtual user"
	}
	return "virtual users"
}

// pctOf is integer seconds for a percentage of the total.
func pctOf(total, p int) int { return total * p / 100 }

// shareOf is at least one VU, for the low shoulders of a spike.
func shareOf(vus, p int) int {
	v := vus * p / 100
	if v < 1 {
		return 1
	}
	return v
}

// DeriveProfile builds the shape of a run.
//
// rps is the ceiling the server allows. targetRps is what the operator asked for
// in rate mode; nil means the ceiling, which is what every pre-existing config
// does.
func DeriveProfile(mode string, vus, durationSec, rps int, targetRps *int) Profile {
	notes := []string{}
	m := mode
	if durationSec < minSec[m] {
		notes = append(notes, fmt.Sprintf(
			"%s needs at least %ds to have a shape, so this run is flat instead. Raise the duration to use it.",
			m, minSec[m]))
		m = "constant"
	}

	flat := func(summary string, atVus int) Profile {
		return Profile{Mode: m, Vus: atVus, DurationSec: durationSec, Stages: []Stage{},
			RatePerSec: nil, Summary: summary, Notes: notes}
	}

	switch m {
	case "smoke":
		if vus > 1 {
			notes = append(notes, "Smoke runs a single virtual user; the requested count is ignored.")
		}
		return flat(fmt.Sprintf("1 virtual user for %ds.", durationSec), 1)

	case "soak":
		return flat(fmt.Sprintf(
			"%d %s held for %ds. A real soak wants tens of minutes — raise HERA_MAX_DURATION_SEC if this is capped short.",
			vus, vuWord(vus), durationSec), vus)

	case "rate":
		rate := rps
		if targetRps != nil {
			rate = *targetRps
			if rate > rps {
				notes = append(notes, fmt.Sprintf("Rate reduced from %d to %d iterations/s (HERA_MAX_RPS).", rate, rps))
				rate = rps
			}
			if rate < 1 {
				rate = 1
			}
		}
		return Profile{Mode: m, Vus: vus, DurationSec: durationSec, Stages: []Stage{}, RatePerSec: &rate,
			Summary: fmt.Sprintf(
				"%d iterations/s — one full pass through the suite each — for %ds, using up to %d virtual users. Dropped iterations mean the rate could not be met.",
				rate, durationSec, vus),
			Notes: notes}

	case "load":
		up := pctOf(durationSec, 20)
		down := pctOf(durationSec, 20)
		hold := durationSec - up - down
		return Profile{Mode: m, Vus: vus, DurationSec: durationSec, RatePerSec: nil,
			Stages:  []Stage{{up, vus}, {hold, vus}, {down, 0}},
			Summary: fmt.Sprintf("0→%d over %ds, hold %ds, %d→0 over %ds.", vus, up, hold, vus, down),
			Notes:   notes}

	case "stress":
		step := pctOf(durationSec, 25)
		last := durationSec - step*3
		t1 := shareOf(vus, 25)
		t2 := shareOf(vus, 50)
		t3 := shareOf(vus, 75)
		return Profile{Mode: m, Vus: vus, DurationSec: durationSec, RatePerSec: nil,
			Stages: []Stage{{step, t1}, {step, t2}, {step, t3}, {last, vus}},
			Summary: fmt.Sprintf("Steps of ~%ds to %d, %d, %d, then %d virtual users. Watch which step the latency turns at.",
				step, t1, t2, t3, vus),
			Notes: notes}

	case "spike":
		base := pctOf(durationSec, 25)
		rise := pctOf(durationSec, 5)
		recover := pctOf(durationSec, 25)
		hold := durationSec - base - rise - recover
		low := shareOf(vus, 10)
		return Profile{Mode: m, Vus: vus, DurationSec: durationSec, RatePerSec: nil,
			Stages: []Stage{{base, low}, {rise, vus}, {hold, vus}, {recover, low}},
			Summary: fmt.Sprintf("%d %s for %ds, surge to %d in %ds, hold %ds, back to %d over %ds.",
				low, vuWord(low), base, vus, rise, hold, low, recover),
			Notes: notes}

	default:
		return flat(fmt.Sprintf("%d %s for %ds.", vus, vuWord(vus), durationSec), vus)
	}
}

// SchedulesInScript is true when the schedule lives in the script's own options
// rather than in plain vus + duration. Those runs must NOT be given a --duration
// flag: on the CLI it wins and silently flattens the shape. One rule, read by
// both the generator and the spawner.
func SchedulesInScript(p Profile) bool {
	return p.RatePerSec != nil || len(p.Stages) > 0
}
