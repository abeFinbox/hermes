package hera

import (
	"encoding/json"
	"fmt"
	"math"
	"net"
	"net/http"
	"sync"
	"time"
)

// Live progress, sampled from k6's own REST API on loopback.
//
// Why not --out json: it emits one line per metric per request — roughly 1.2M
// lines for a 500rps/5min run — which would have to be streamed and parsed by
// the API process serving the UI. The REST endpoint gives pre-aggregated numbers
// for a single GET instead, with no disk and no volume problem.
//
// Security posture: bound to 127.0.0.1 on an ephemeral port, and
// --profiling-enabled is never passed. k6's REST API is unauthenticated and can
// change VU counts, so it must never listen on a routable address.
//
// WHAT IS AND IS NOT INSTANTANEOUS (verified against k6 v2.0.0):
//   - http_reqs is a counter, so rps is derived from the DELTA between polls
//   - http_req_failed exposes only a cumulative rate, but its denominator is the
//     request count, so failed = rate * count and the delta gives an
//     instantaneous error rate
//   - vus is a gauge, already instantaneous
//   - http_req_duration is a trend accumulated over the WHOLE RUN. Its
//     percentiles cannot be de-cumulated, so p50/p90/p95 here are cumulative
//     and the UI must say so. p(99) is absent entirely and comes from the
//     end-of-run summary.
//
// Mirrors backend/src/hera/progress.ts.

type Sample struct {
	// T is seconds since the run started.
	T   int `json:"t"`
	Vus int `json:"vus"`
	// Rps is instantaneous, from the request-count delta.
	Rps float64 `json:"rps"`
	// ErrorRatePct is instantaneous, from the failed-count delta.
	ErrorRatePct float64 `json:"errorRatePct"`
	// P50/P90/P95 are cumulative over the run so far — see the note above.
	P50 float64 `json:"p50"`
	P90 float64 `json:"p90"`
	P95 float64 `json:"p95"`
}

const (
	MaxSamples   = 120
	PollInterval = time.Second
	fetchTimeout = 2 * time.Second
)

// PickLoopbackPort grabs a free loopback port for k6's REST listener.
func PickLoopbackPort() (int, error) {
	l, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return 0, err
	}
	port := l.Addr().(*net.TCPAddr).Port
	if cerr := l.Close(); cerr != nil {
		return 0, cerr
	}
	if port == 0 {
		return 0, fmt.Errorf("could not find a free port")
	}
	return port, nil
}

type restPayload struct {
	Data []struct {
		ID         string `json:"id"`
		Attributes struct {
			Sample map[string]float64 `json:"sample"`
		} `json:"attributes"`
	} `json:"data"`
}

func (p *restPayload) sample(id string) map[string]float64 {
	for _, m := range p.Data {
		if m.ID == id {
			return m.Attributes.Sample
		}
	}
	return nil
}

type ProgressCollector struct {
	port    int
	client  *http.Client
	mu      sync.Mutex
	acc     []Sample
	started time.Time
	prevAt  time.Time

	prevReqs   float64
	prevFailed float64

	stopCh chan struct{}
	once   sync.Once
}

func NewProgressCollector(port int) *ProgressCollector {
	return &ProgressCollector{
		port:   port,
		client: &http.Client{Timeout: fetchTimeout},
		acc:    []Sample{},
		stopCh: make(chan struct{}),
	}
}

func (c *ProgressCollector) Start() {
	c.started = time.Now()
	c.prevAt = c.started
	go func() {
		t := time.NewTicker(PollInterval)
		defer t.Stop()
		for {
			select {
			case <-c.stopCh:
				return
			case <-t.C:
				c.poll()
			}
		}
	}()
}

func (c *ProgressCollector) Stop() {
	c.once.Do(func() { close(c.stopCh) })
}

// PollOnce samples one more time (used right before the run is finalised).
func (c *ProgressCollector) PollOnce() { c.poll() }

func (c *ProgressCollector) Samples() []Sample {
	c.mu.Lock()
	defer c.mu.Unlock()
	out := make([]Sample, len(c.acc))
	copy(out, c.acc)
	return out
}

func (c *ProgressCollector) poll() {
	res, err := c.client.Get(fmt.Sprintf("http://127.0.0.1:%d/v1/metrics", c.port))
	if err != nil {
		// k6 has not opened the port yet, or has already exited. Both normal.
		return
	}
	defer res.Body.Close()
	if res.StatusCode != 200 {
		return
	}
	var payload restPayload
	if err := json.NewDecoder(res.Body).Decode(&payload); err != nil {
		return
	}

	now := time.Now()
	c.mu.Lock()
	dtSec := math.Max(0.001, now.Sub(c.prevAt).Seconds())

	reqs := payload.sample("http_reqs")
	dur := payload.sample("http_req_duration")
	failed := payload.sample("http_req_failed")
	vus := payload.sample("vus")

	reqCount := reqs["count"]
	failCount := failed["rate"] * reqCount
	dReqs := math.Max(0, reqCount-c.prevReqs)
	dFailed := math.Max(0, failCount-c.prevFailed)

	errPct := 0.0
	if dReqs > 0 {
		errPct = round2((dFailed / dReqs) * 100)
	}
	s := Sample{
		T:            int(math.Round(now.Sub(c.started).Seconds())),
		Vus:          int(math.Round(vus["value"])),
		Rps:          round2(dReqs / dtSec),
		ErrorRatePct: errPct,
		P50:          round2(dur["med"]),
		P90:          round2(dur["p(90)"]),
		P95:          round2(dur["p(95)"]),
	}

	c.prevAt = now
	c.prevReqs = reqCount
	c.prevFailed = failCount
	c.pushLocked(s)
	c.mu.Unlock()
}

// pushLocked appends and compacts. Caller holds the mutex.
func (c *ProgressCollector) pushLocked(s Sample) {
	c.acc = append(c.acc, s)
	if len(c.acc) <= MaxSamples {
		return
	}
	// Merge adjacent pairs so the bucket width doubles instead of dropping the
	// tail. MAX is taken for latency and error rate: smoothing away a spike
	// would hide exactly the thing a load test is looking for.
	merged := make([]Sample, 0, len(c.acc)/2+1)
	for i := 0; i < len(c.acc); i += 2 {
		a := c.acc[i]
		if i+1 >= len(c.acc) {
			merged = append(merged, a)
			continue
		}
		b := c.acc[i+1]
		merged = append(merged, Sample{
			T:            b.T,
			Vus:          b.Vus,
			Rps:          math.Max(a.Rps, b.Rps),
			ErrorRatePct: math.Max(a.ErrorRatePct, b.ErrorRatePct),
			P50:          math.Max(a.P50, b.P50),
			P90:          math.Max(a.P90, b.P90),
			P95:          math.Max(a.P95, b.P95),
		})
	}
	c.acc = merged
}

func round2(n float64) float64 {
	return math.Round(n*100) / 100
}
