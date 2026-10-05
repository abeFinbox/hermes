package hera

import (
	"bufio"
	"fmt"
	"io"
	"os"
	"os/exec"
	"runtime"
	"strings"
	"sync"
	"syscall"
	"time"
)

// k6 child-process lifecycle.
//
// The single worst incident this feature can cause is an orphaned k6 still
// hammering someone's API after Hermes has gone away, so the containment here is
// deliberately belt-and-braces:
//
//   - the script arrives on STDIN, so it never touches disk (no secrets on the
//     volume, no generated files to clean up)
//   - the child gets its OWN PROCESS GROUP, and stop kills the group, not just
//     the leader — k6 spawns worker threads and we want all of them gone
//   - k6 is always given --duration so it self-terminates, AND a parent
//     wall-clock watchdog SIGKILLs at duration + 30s in case it does not
//   - the child is de-prioritised and capped to cores-1, so the API stays
//     responsive enough to serve the UI that is polling this run
//
// Mirrors backend/src/hera/process.ts.

// k6 exit codes we care about. Verified against k6 v2.0.0.
const (
	K6ExitThresholdFailed = 99
	K6ExitScriptError     = 107
)

const (
	MaxStdoutBytes = 1024 * 1024
	MaxStderrBytes = 64 * 1024
	// KillGrace is the gap between SIGTERM and SIGKILL when stopping.
	KillGrace = 5 * time.Second
	// WatchdogSlack is wall-clock slack on top of the configured duration.
	WatchdogSlack = 30 * time.Second
)

type RunResult struct {
	ExitCode        int
	Signal          string
	Summary         *SummaryDoc
	ParseError      string
	StderrTail      string
	TruncatedStdout bool
	// Killed is "", "stop", "watchdog" or "stdout-overflow".
	Killed string
}

type RunHandle struct {
	Pid  int
	stop func()
	done chan RunResult
	once sync.Once
	res  RunResult
}

// Stop asks k6 to stop; it drains in-flight VUs, then we escalate.
func (h *RunHandle) Stop() { h.stop() }

// Wait blocks until the run finishes and returns its result.
func (h *RunHandle) Wait() RunResult {
	h.once.Do(func() { h.res = <-h.done })
	return h.res
}

type SpawnOptions struct {
	Script      string
	DurationSec int
	Rps         int
	// RunID is exposed to the script as __ENV.HERA_RUN_ID; never baked into the source.
	RunID string
	// RestPort is the loopback port for k6's REST API, used to sample live
	// progress. Zero leaves the API off entirely (k6's default).
	RestPort int
	// ScheduleInScript means the script's own options carry the schedule (stages
	// or scenarios), so no --duration flag may be passed: on the CLI it wins and
	// flattens the shape.
	ScheduleInScript bool
	// OnStderrLine receives every complete k6 output line as it arrives, for the
	// live log ring. It runs on the stderr reader goroutine, so it must not
	// block. The stderr tail is accumulated independently: this callback is
	// additive and can be nil.
	OnStderrLine func(string)
}

// StatusForExit derives the run status from how k6 exited.
func StatusForExit(exitCode int, killed string) string {
	if killed == "stop" {
		return "stopped"
	}
	if exitCode == 0 {
		return "passed"
	}
	// 99 means a threshold was breached — that is a legitimate test failure, not
	// a malfunction. Everything else (including 107, a script that would not
	// compile) is an error.
	if exitCode == K6ExitThresholdFailed {
		return "failed"
	}
	return "error"
}

func childEnv(runID string) []string {
	cores := runtime.NumCPU() - 1
	if cores < 1 {
		cores = 1
	}
	home := os.Getenv("HOME")
	if home == "" {
		// distroless has no HOME, and k6 resolves its config dir from it
		home = "/tmp"
	}
	env := os.Environ()
	env = append(env,
		"HOME="+home,
		"XDG_CONFIG_HOME=/tmp",
		// Without these, every run phones home — which would make the project's
		// "no external services" claim false.
		"K6_NO_USAGE_REPORT=true",
		"K6_NO_UPDATE_CHECK=true",
		// Leave a core for the API that is serving the UI polling this run.
		fmt.Sprintf("GOMAXPROCS=%d", cores),
		"HERA_RUN_ID="+runID,
	)
	return env
}

// SpawnK6 starts k6 with the script on stdin and returns a handle to it.
func SpawnK6(opts SpawnOptions) (*RunHandle, error) {
	bin := GetLimits().K6Bin
	if bin == "" {
		bin = "k6"
	}
	args := []string{
		"run",
		"-", // read the script from stdin
		"--quiet",
		"--no-usage-report",
		// One JSON object per line. The default logfmt escapes the message, so a
		// diagnostic containing a response body arrives double-quoted and is
		// painful to read in the UI; this makes level/time/msg addressable.
		"--log-format", "json",
		"--rps", fmt.Sprintf("%d", opts.Rps),
	}
	// --duration on the CLI OVERRIDES options.stages and options.scenarios, so a
	// shaped run would silently flatten back to a plain one. The script carries
	// the schedule in those modes; the watchdog below still uses DurationSec,
	// which the profile guarantees is the total.
	if !opts.ScheduleInScript {
		args = append(args, "--duration", fmt.Sprintf("%ds", opts.DurationSec))
	}
	if opts.RestPort > 0 {
		// 127.0.0.1 ONLY. k6's REST API is unauthenticated and can change VU
		// counts, so it must never be reachable off-box. --profiling-enabled
		// stays off.
		args = append(args, "--address", fmt.Sprintf("127.0.0.1:%d", opts.RestPort))
	}

	cmd := exec.Command(bin, args...)
	cmd.Env = childEnv(opts.RunID)
	// Own process group, so we can kill the whole tree.
	cmd.SysProcAttr = &syscall.SysProcAttr{Setpgid: true}

	stdin, err := cmd.StdinPipe()
	if err != nil {
		return nil, err
	}
	stdoutPipe, err := cmd.StdoutPipe()
	if err != nil {
		return nil, err
	}
	stderrPipe, err := cmd.StderrPipe()
	if err != nil {
		return nil, err
	}
	if err := cmd.Start(); err != nil {
		return nil, err
	}

	// Best-effort: a load generator must not outrank the API it is measuring.
	_ = syscall.Setpriority(syscall.PRIO_PROCESS, cmd.Process.Pid, 10)

	var mu sync.Mutex
	killed := ""
	truncated := false
	settled := false

	killGroup := func(sig syscall.Signal) {
		if cmd.Process == nil {
			return
		}
		// negative pid = the whole process group
		if err := syscall.Kill(-cmd.Process.Pid, sig); err != nil {
			_ = cmd.Process.Signal(sig)
		}
	}
	setKilled := func(reason string) {
		mu.Lock()
		if killed == "" {
			killed = reason
		}
		mu.Unlock()
	}

	go func() {
		<-time.After(time.Duration(opts.DurationSec)*time.Second + WatchdogSlack)
		mu.Lock()
		done := settled
		mu.Unlock()
		if done {
			return
		}
		setKilled("watchdog")
		killGroup(syscall.SIGKILL)
	}()

	stdoutCh := make(chan string, 1)
	go func() {
		var b strings.Builder
		buf := make([]byte, 32*1024)
		total := 0
		for {
			n, rerr := stdoutPipe.Read(buf)
			if n > 0 {
				total += n
				if total > MaxStdoutBytes {
					// Runaway output would take the whole process down with it.
					mu.Lock()
					truncated = true
					mu.Unlock()
					setKilled("stdout-overflow")
					killGroup(syscall.SIGKILL)
					break
				}
				b.Write(buf[:n])
			}
			if rerr != nil {
				break
			}
		}
		stdoutCh <- b.String()
	}()

	stderrCh := make(chan string, 1)
	go func() {
		// Read line by line so the log ring can see output as it happens, while
		// still accumulating the exact byte stream for the tail.
		//
		// bufio.Reader.ReadString, NOT bufio.Scanner: Scanner errors out on a
		// token longer than its 64KB buffer and would then silently stop reading
		// stderr for the rest of the run, losing the tail — the one place the
		// error actually lives.
		r := bufio.NewReader(stderrPipe)
		var buf []byte
		emit := func(chunk string) {
			if opts.OnStderrLine == nil {
				return
			}
			opts.OnStderrLine(strings.TrimSuffix(chunk, "\n"))
		}
		for {
			chunk, rerr := r.ReadString('\n')
			if chunk != "" {
				buf = append(buf, chunk...)
				if len(buf) > MaxStderrBytes {
					// keep the TAIL: that is where the error is
					buf = buf[len(buf)-MaxStderrBytes:]
				}
				emit(chunk)
			}
			if rerr != nil {
				break
			}
		}
		stderrCh <- string(buf)
	}()

	// Feed the script in and close stdin so k6 starts.
	go func() {
		_, _ = io.WriteString(stdin, opts.Script)
		_ = stdin.Close()
	}()

	done := make(chan RunResult, 1)
	go func() {
		waitErr := cmd.Wait()
		stdout := <-stdoutCh
		stderrTail := <-stderrCh
		mu.Lock()
		settled = true
		k := killed
		trunc := truncated
		mu.Unlock()

		exitCode := 0
		signal := ""
		if waitErr != nil {
			if ee, ok := waitErr.(*exec.ExitError); ok {
				exitCode = ee.ExitCode()
				if st, ok := ee.Sys().(syscall.WaitStatus); ok && st.Signaled() {
					signal = st.Signal().String()
					exitCode = -1
				}
			} else {
				exitCode = -1
				stderrTail = strings.TrimSpace(stderrTail + "\n" + waitErr.Error())
				if len(stderrTail) > MaxStderrBytes {
					stderrTail = stderrTail[len(stderrTail)-MaxStderrBytes:]
				}
			}
		}
		doc, parseErr := ParseSummary(stdout)
		done <- RunResult{
			ExitCode:        exitCode,
			Signal:          signal,
			Summary:         doc,
			ParseError:      parseErr,
			StderrTail:      stderrTail,
			TruncatedStdout: trunc,
			Killed:          k,
		}
	}()

	h := &RunHandle{Pid: cmd.Process.Pid, done: done}
	h.stop = func() {
		mu.Lock()
		if settled {
			mu.Unlock()
			return
		}
		mu.Unlock()
		setKilled("stop")
		killGroup(syscall.SIGTERM)
		go func() {
			time.Sleep(KillGrace)
			killGroup(syscall.SIGKILL)
		}()
	}
	return h, nil
}
