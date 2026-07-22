package server

import (
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"runtime"
	"strconv"
	"strings"
	"sync"
	"syscall"
	"time"

	"github.com/finbox/hermes/backend-go/internal/model"
	"github.com/finbox/hermes/backend-go/internal/runner"
	"github.com/finbox/hermes/backend-go/internal/store"
	"github.com/finbox/hermes/backend-go/internal/web"
	"github.com/go-chi/chi/v5"
)

// ---------------- docs ----------------

var docs = map[string]struct{ file, title string }{
	"readme": {"README.md", "README"},
	"manual": {"USER_MANUAL.md", "User Manual"},
	"deploy": {"HOW-TO-DEPLOY.md", "How to Deploy"},
}

func docsRoot() string {
	if d := os.Getenv("DOCS_DIR"); d != "" {
		return d
	}
	return ".." // repo root, relative to backend-go
}

func docsRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		out := []map[string]string{}
		// stable order matching the TS object literal
		for _, key := range []string{"readme", "manual", "deploy"} {
			out = append(out, map[string]string{"key": key, "title": docs[key].title})
		}
		web.JSON(w, 200, out)
	})
	r.Get("/{key}", func(w http.ResponseWriter, r *http.Request) {
		key := chi.URLParam(r, "key")
		doc, ok := docs[key]
		if !ok {
			web.Err(w, 404, "Unknown document")
			return
		}
		path := filepath.Join(docsRoot(), doc.file)
		data, err := os.ReadFile(path)
		if err != nil {
			web.Err(w, 404, doc.file+" is not available in this build")
			return
		}
		web.JSON(w, 200, map[string]string{"key": key, "title": doc.title, "markdown": string(data)})
	})
	return r
}

// ---------------- files ----------------

const maxFileBytes = 25 * 1024 * 1024

func filesRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		rows, err := store.DB.Query("SELECT id, original_name, stored_name, size, mime, created_at FROM files ORDER BY created_at DESC")
		if err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		defer rows.Close()
		out := []map[string]interface{}{}
		for rows.Next() {
			var r store.FileRow
			rows.Scan(&r.ID, &r.OriginalName, &r.StoredName, &r.Size, &r.Mime, &r.CreatedAt)
			out = append(out, fileMeta(r))
		}
		web.JSON(w, 200, out)
	})
	r.Post("/", uploadFiles)
	r.Get("/{id}/download", downloadFile)
	r.Delete("/{id}", deleteFile)
	return r
}

func fileMeta(r store.FileRow) map[string]interface{} {
	return map[string]interface{}{"id": r.ID, "originalName": r.OriginalName, "size": r.Size, "mime": r.Mime, "createdAt": r.CreatedAt}
}

func uploadFiles(w http.ResponseWriter, r *http.Request) {
	if err := r.ParseMultipartForm(maxFileBytes); err != nil {
		web.Err(w, 400, "Could not parse upload: "+err.Error())
		return
	}
	files := r.MultipartForm.File["files"]
	if len(files) == 0 {
		web.Err(w, 400, `No files uploaded (field name must be "files")`)
		return
	}
	now := nowISO()
	created := []map[string]interface{}{}
	for _, fh := range files {
		src, err := fh.Open()
		if err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		id := model.NewID()
		storedName := id + extOf(fh.Filename)
		dstPath := filepath.Join(store.FilesDir, storedName)
		dst, err := os.Create(dstPath)
		if err != nil {
			src.Close()
			web.Err(w, 500, err.Error())
			return
		}
		size, _ := io.Copy(dst, src)
		dst.Close()
		src.Close()
		mime := fh.Header.Get("Content-Type")
		store.DB.Exec("INSERT INTO files (id, original_name, stored_name, size, mime, created_at) VALUES (?, ?, ?, ?, ?, ?)",
			id, fh.Filename, storedName, size, mime, now)
		created = append(created, map[string]interface{}{"id": id, "originalName": fh.Filename, "size": size, "mime": mime, "createdAt": now})
	}
	web.JSON(w, 201, created)
}

func extOf(name string) string {
	dot := strings.LastIndex(name, ".")
	if dot > 0 && dot < len(name)-1 {
		ext := strings.ToLower(name[dot:])
		var b strings.Builder
		for _, c := range ext {
			if c == '.' || (c >= 'a' && c <= 'z') || (c >= '0' && c <= '9') {
				b.WriteRune(c)
			}
		}
		return b.String()
	}
	return ""
}

func downloadFile(w http.ResponseWriter, r *http.Request) {
	row, _ := store.GetFileRow(chi.URLParam(r, "id"))
	if row == nil {
		web.Err(w, 404, "File not found")
		return
	}
	mime := row.Mime
	if mime == "" {
		mime = "application/octet-stream"
	}
	w.Header().Set("Content-Type", mime)
	w.Header().Set("Content-Disposition", `attachment; filename="`+strings.ReplaceAll(row.OriginalName, `"`, "")+`"`)
	http.ServeFile(w, r, filepath.Join(store.FilesDir, row.StoredName))
}

func deleteFile(w http.ResponseWriter, r *http.Request) {
	row, _ := store.GetFileRow(chi.URLParam(r, "id"))
	if row == nil {
		web.Err(w, 404, "File not found")
		return
	}
	store.DB.Exec("DELETE FROM files WHERE id = ?", row.ID)
	os.Remove(filepath.Join(store.FilesDir, row.StoredName))
	web.JSON(w, 200, map[string]bool{"ok": true})
}

// ---------------- metrics ----------------

type metricSample struct {
	T        int64   `json:"t"`
	CPU      float64 `json:"cpu"`
	RSS      uint64  `json:"rss"`
	HeapUsed uint64  `json:"heapUsed"`
}

const sampleMs = 2000
const maxSamples = 60

var (
	metricsMu sync.Mutex
	samples   []metricSample
	lastCPU   float64
	lastAt    time.Time
)

// StartMetrics launches the background resource sampler.
func StartMetrics() {
	lastAt = time.Now()
	lastCPU = processCPUSeconds()
	takeSample()
	go func() {
		t := time.NewTicker(sampleMs * time.Millisecond)
		for range t.C {
			takeSample()
		}
	}()
}

func takeSample() {
	now := time.Now()
	nowCPU := processCPUSeconds()
	elapsed := now.Sub(lastAt).Seconds()
	used := nowCPU - lastCPU
	lastCPU = nowCPU
	lastAt = now
	cpu := 0.0
	if elapsed > 0 {
		cpu = (used / elapsed) * 100
		if cpu < 0 {
			cpu = 0
		}
		if cpu > 100 {
			cpu = 100
		}
	}
	var m runtime.MemStats
	runtime.ReadMemStats(&m)
	metricsMu.Lock()
	samples = append(samples, metricSample{
		T: now.UnixMilli(), CPU: float64(int(cpu*10)) / 10, RSS: m.Sys, HeapUsed: m.HeapAlloc,
	})
	if len(samples) > maxSamples {
		samples = samples[len(samples)-maxSamples:]
	}
	metricsMu.Unlock()
}

// totalMem returns total physical memory in bytes (best effort), used only to
// scale the memory graph. sysTotalMem is platform-specific (see metrics_*.go).
func totalMem() uint64 {
	if v := sysTotalMem(); v > 0 {
		return v
	}
	return 17179869184 // 16 GiB fallback
}

// processCPUSeconds returns cumulative user+system CPU seconds for this process.
func processCPUSeconds() float64 {
	var ru syscall.Rusage
	if err := syscall.Getrusage(syscall.RUSAGE_SELF, &ru); err != nil {
		return 0
	}
	u := float64(ru.Utime.Sec) + float64(ru.Utime.Usec)/1e6
	s := float64(ru.Stime.Sec) + float64(ru.Stime.Usec)/1e6
	return u + s
}

func metricsRouter() chi.Router {
	r := chi.NewRouter()
	r.Get("/", func(w http.ResponseWriter, _ *http.Request) {
		metricsMu.Lock()
		snap := make([]metricSample, len(samples))
		copy(snap, samples)
		metricsMu.Unlock()
		if snap == nil {
			snap = []metricSample{}
		}
		web.JSON(w, 200, map[string]interface{}{"samples": snap, "totalMem": totalMem(), "sampleMs": sampleMs})
	})
	return r
}

// ---------------- runs ----------------

func runsRouter() chi.Router {
	r := chi.NewRouter()
	r.Post("/", triggerRun)
	r.Post("/step", runStep)
	r.Post("/{id}/stop", stopRunHandler)
	r.Get("/", listRuns)
	r.Get("/{id}", getRun)
	r.Delete("/{id}", deleteRun)
	r.Post("/{id}/report", runReport)
	return r
}

func rowToRun(scan func(...interface{}) error, includeResults bool) (*model.Run, error) {
	var (
		id, suiteID, suiteName, status, startedAt string
		cycles                                    int
		stopOnFailure                             int
		finishedAt                                *string
		cycleJSON                                 string
		summaryJSON                               *string
	)
	if err := scan(&id, &suiteID, &suiteName, &status, &cycles, &stopOnFailure, &startedAt, &finishedAt, &cycleJSON, &summaryJSON); err != nil {
		return nil, err
	}
	run := &model.Run{
		ID: id, SuiteID: suiteID, SuiteName: suiteName, Status: status, Cycles: cycles,
		StopOnFailure: stopOnFailure != 0, StartedAt: startedAt, FinishedAt: finishedAt,
		CycleResults: []model.CycleResult{},
	}
	if includeResults {
		json.Unmarshal([]byte(cycleJSON), &run.CycleResults)
		if run.CycleResults == nil {
			run.CycleResults = []model.CycleResult{}
		}
	}
	if summaryJSON != nil {
		var s model.RunSummary
		if json.Unmarshal([]byte(*summaryJSON), &s) == nil {
			run.Summary = &s
		}
	}
	return run, nil
}

const runCols = "id, suite_id, suite_name, status, cycles, stop_on_failure, started_at, finished_at, cycle_results_json, summary_json"

func triggerRun(w http.ResponseWriter, r *http.Request) {
	var body struct {
		SuiteID       string `json:"suiteId"`
		Cycles        *int   `json:"cycles"`
		StopOnFailure *bool  `json:"stopOnFailure"`
	}
	_ = web.Decode(r, &body)
	suite, _ := getSuite(body.SuiteID)
	if suite == nil {
		web.Err(w, 404, "Suite not found")
		return
	}
	anyEnabled := false
	for _, s := range suite.Steps {
		if s.Enabled {
			anyEnabled = true
			break
		}
	}
	if !anyEnabled {
		web.Err(w, 400, "Suite has no enabled steps")
		return
	}
	n := suite.Settings.DefaultCycles
	if body.Cycles != nil && *body.Cycles != 0 {
		n = *body.Cycles
	}
	if n < 1 {
		n = 1
	}
	if n > 100 {
		n = 100
	}
	stop := suite.Settings.StopOnFailure
	if body.StopOnFailure != nil {
		stop = *body.StopOnFailure
	}
	run := runner.StartRun(*suite, n, stop)
	web.JSON(w, 202, map[string]string{"id": run.ID, "status": run.Status})
}

func runStep(w http.ResponseWriter, r *http.Request) {
	var body struct {
		Step           *model.Step            `json:"step"`
		SuiteVariables []model.SuiteVariable  `json:"suiteVariables"`
		Settings       map[string]interface{} `json:"settings"`
	}
	if err := web.Decode(r, &body); err != nil || body.Step == nil {
		web.Err(w, 400, "A step object with a request is required")
		return
	}
	settings := model.DefaultSettings()
	if body.Settings != nil {
		reb, _ := json.Marshal(body.Settings)
		json.Unmarshal(reb, &settings)
	}
	vars := body.SuiteVariables
	if vars == nil {
		vars = []model.SuiteVariable{}
	}
	suite := model.Suite{ID: "ad-hoc", Name: "ad-hoc", Steps: []model.Step{*body.Step}, Variables: vars, Settings: settings}
	scope := runner.NewVarScope(suite)
	result := runner.ExecuteStep(*body.Step, scope, suite, runner.ExecuteOpts{WithCurl: true})
	web.JSON(w, 200, result)
}

func stopRunHandler(w http.ResponseWriter, r *http.Request) {
	if !runner.StopRun(chi.URLParam(r, "id")) {
		web.Err(w, 409, "Run is not active (already finished, or not running on this server)")
		return
	}
	web.JSON(w, 200, map[string]bool{"ok": true})
}

func listRuns(w http.ResponseWriter, r *http.Request) {
	suiteID := r.URL.Query().Get("suiteId")
	var rows interface {
		Next() bool
		Scan(...interface{}) error
		Close() error
		Err() error
	}
	var err error
	if suiteID != "" {
		rows, err = store.DB.Query("SELECT "+runCols+" FROM runs WHERE suite_id = ? ORDER BY started_at DESC LIMIT 100", suiteID)
	} else {
		rows, err = store.DB.Query("SELECT " + runCols + " FROM runs ORDER BY started_at DESC LIMIT 100")
	}
	if err != nil {
		web.Err(w, 500, err.Error())
		return
	}
	defer rows.Close()
	out := []*model.Run{}
	for rows.Next() {
		run, err := rowToRun(rows.Scan, false)
		if err != nil {
			web.Err(w, 500, err.Error())
			return
		}
		out = append(out, run)
	}
	web.JSON(w, 200, out)
}

func getRun(w http.ResponseWriter, r *http.Request) {
	row := store.DB.QueryRow("SELECT "+runCols+" FROM runs WHERE id = ?", chi.URLParam(r, "id"))
	run, err := rowToRun(row.Scan, true)
	if err != nil {
		web.Err(w, 404, "Run not found")
		return
	}
	web.JSON(w, 200, run)
}

func deleteRun(w http.ResponseWriter, r *http.Request) {
	store.DB.Exec("DELETE FROM runs WHERE id = ?", chi.URLParam(r, "id"))
	web.JSON(w, 200, map[string]bool{"ok": true})
}

func runReport(w http.ResponseWriter, r *http.Request) {
	row := store.DB.QueryRow("SELECT "+runCols+" FROM runs WHERE id = ?", chi.URLParam(r, "id"))
	run, err := rowToRun(row.Scan, true)
	if err != nil {
		web.Err(w, 404, "Run not found")
		return
	}
	if run.Status == "running" {
		web.Err(w, 409, "Run is still in progress")
		return
	}
	cycles := []map[string]interface{}{}
	for _, c := range run.CycleResults {
		steps := []map[string]interface{}{}
		for _, s := range c.Steps {
			var httpStatus, timeMs interface{}
			if s.Response != nil {
				httpStatus = s.Response.Status
				timeMs = s.Response.TimeMs
			}
			captured := []map[string]interface{}{}
			for _, cv := range s.Captured {
				captured = append(captured, map[string]interface{}{"key": cv.Key, "scope": cv.Scope})
			}
			var errVal interface{}
			if s.Error != "" {
				errVal = s.Error
			}
			steps = append(steps, map[string]interface{}{
				"name": s.Name, "status": s.Status, "httpStatus": httpStatus, "timeMs": timeMs,
				"assertions": s.Assertions, "captured": captured, "error": errVal,
			})
		}
		cycles = append(cycles, map[string]interface{}{"cycle": c.Cycle, "passed": c.Passed, "steps": steps})
	}
	report := map[string]interface{}{
		"stub": true, "format": "json", "generatedAt": nowISO(),
		"title": "Test report — " + run.SuiteName,
		"run": map[string]interface{}{
			"id": run.ID, "suite": run.SuiteName, "status": run.Status, "cycles": run.Cycles,
			"startedAt": run.StartedAt, "finishedAt": run.FinishedAt,
		},
		"summary": run.Summary,
		"cycles":  cycles,
		"todo":    "Replace this stub with HTML/PDF rendering (e.g. server-side template + puppeteer or a React print view).",
	}
	web.JSON(w, 200, report)
}

// ---------------- mock demo API ----------------

const mockTokenPrefix = "mock-token-"

var itemSeq = 3

func checkBearer(r *http.Request) bool {
	return strings.HasPrefix(r.Header.Get("Authorization"), "Bearer "+mockTokenPrefix)
}

func mockRouter() chi.Router {
	r := chi.NewRouter()
	r.Post("/login", func(w http.ResponseWriter, r *http.Request) {
		var body struct{ Username, Password string }
		_ = web.Decode(r, &body)
		if body.Username == "" || body.Password == "" {
			web.Err(w, 400, "username and password required")
			return
		}
		if body.Password == "wrong" {
			web.Err(w, 401, "invalid credentials")
			return
		}
		web.JSON(w, 200, map[string]interface{}{
			"token": mockTokenPrefix + hexEncode(body.Username),
			"user":  map[string]string{"id": "u-1001", "name": body.Username},
		})
	})
	r.Get("/profile", func(w http.ResponseWriter, r *http.Request) {
		if !checkBearer(r) {
			web.Err(w, 401, "missing or invalid bearer token")
			return
		}
		web.JSON(w, 200, map[string]string{"id": "u-1001", "name": "demo user", "email": "demo@example.com", "plan": "pro"})
	})
	r.Get("/items", func(w http.ResponseWriter, r *http.Request) {
		if !checkBearer(r) {
			web.Err(w, 401, "missing or invalid bearer token")
			return
		}
		web.JSON(w, 200, map[string]interface{}{
			"items": []map[string]interface{}{{"id": 1, "name": "alpha"}, {"id": 2, "name": "beta"}, {"id": 3, "name": "gamma"}},
			"count": 3,
		})
	})
	r.Post("/items", func(w http.ResponseWriter, r *http.Request) {
		if !checkBearer(r) {
			web.Err(w, 401, "missing or invalid bearer token")
			return
		}
		var body struct{ Name string }
		_ = web.Decode(r, &body)
		if body.Name == "" {
			web.Err(w, 400, "name required")
			return
		}
		itemSeq++
		web.JSON(w, 201, map[string]interface{}{"id": itemSeq, "name": body.Name, "createdAt": nowISO()})
	})
	r.Get("/slow", func(w http.ResponseWriter, r *http.Request) {
		ms := 1500
		if v, err := strconv.Atoi(r.URL.Query().Get("ms")); err == nil && v != 0 {
			ms = v
		}
		if ms > 10000 {
			ms = 10000
		}
		time.Sleep(time.Duration(ms) * time.Millisecond)
		web.JSON(w, 200, map[string]int{"delayedMs": ms})
	})
	r.Post("/upload", func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseMultipartForm(25 * 1024 * 1024)
		fields := map[string]string{}
		files := []map[string]interface{}{}
		if r.MultipartForm != nil {
			for k, v := range r.MultipartForm.Value {
				if len(v) > 0 {
					fields[k] = v[0]
				}
			}
			for field, fhs := range r.MultipartForm.File {
				for _, fh := range fhs {
					files = append(files, map[string]interface{}{
						"field": field, "filename": fh.Filename,
						"mime": fh.Header.Get("Content-Type"), "size": fh.Size,
					})
				}
			}
		}
		web.JSON(w, 200, map[string]interface{}{
			"receivedAt": nowISO(), "fields": fields, "files": files, "fileCount": len(files),
		})
	})
	return r
}

func hexEncode(s string) string {
	const hexits = "0123456789abcdef"
	var b strings.Builder
	for _, c := range []byte(s) {
		b.WriteByte(hexits[c>>4])
		b.WriteByte(hexits[c&0x0f])
	}
	return b.String()
}
