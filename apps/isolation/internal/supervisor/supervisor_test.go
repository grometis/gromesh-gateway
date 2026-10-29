package supervisor

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"os/signal"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// A fake nginx: a shell that writes its pid, starts a child (a "worker" in the same process group) and either exits
// on SIGQUIT after a delay (graceful drain) or ignores SIGTERM and SIGQUIT (a stuck master).
func fake(t *testing.T, dir, mode string) []string {
	script := filepath.Join(dir, "nginx.sh")
	// The traps come first: the master's pid file is the signal that it is ready for the test's signals.
	body := ""
	switch mode {
	case "drain":
		body += `trap 'sleep 0.3; exit 0' QUIT; trap '' TERM; `
	case "stuck":
		body += `trap '' TERM QUIT; `
	}
	body += `sleep 300 & echo $! > "` + dir + `/worker"; echo $$ > "` + dir + `/master"; `
	if mode == "orphan" {
		// The master leaves on its own and its worker stays behind (until killed).
		body += `sleep 0.3; exit 3; `
	}
	body += `while :; do sleep 0.05; done`
	if err := os.WriteFile(script, []byte(body), 0o755); err != nil {
		t.Fatal(err)
	}
	return []string{"/bin/sh", script}
}

type harness struct {
	t        *testing.T
	dir      string
	valid    atomic.Bool
	stop     chan os.Signal
	children chan os.Signal
	done     chan int
	finished chan struct{}
	mu       sync.Mutex
	logs     []string
	clock    atomic.Uint64
}

func start(t *testing.T, mode string, valid bool) *harness {
	return startWith(t, mode, valid, 100*time.Millisecond)
}

func startWith(t *testing.T, mode string, valid bool, period time.Duration) *harness {
	return startFull(t, mode, valid, period, nil)
}

func startWithKill(t *testing.T, mode string, kill func(int, syscall.Signal) error) *harness {
	return startFull(t, mode, true, 100*time.Millisecond, kill)
}

func startFull(t *testing.T, mode string, valid bool, period time.Duration, kill func(int, syscall.Signal) error) *harness {
	h := &harness{t: t, dir: t.TempDir(), stop: make(chan os.Signal, 1), children: make(chan os.Signal, 16), done: make(chan int, 1), finished: make(chan struct{})}
	h.valid.Store(valid)
	signal.Notify(h.children, syscall.SIGCHLD)
	t.Cleanup(func() { signal.Stop(h.children) })
	cfg := Config{
		Command: fake(t, h.dir, mode),
		Check: func() error {
			if h.valid.Load() {
				return nil
			}
			return errors.New("lease expired")
		},
		Boottime:  func() (uint64, error) { return h.clock.Add(1), nil },
		StateFile: filepath.Join(h.dir, "kong-state.json"),
		Period:    period,
		KillAfter: 200 * time.Millisecond,
		Drain:     time.Second,
		Kill:      kill,
		Logf: func(format string, args ...any) {
			h.mu.Lock()
			h.logs = append(h.logs, fmt.Sprintf(format, args...))
			h.mu.Unlock()
		},
	}
	go func() { h.done <- Run(cfg, h.stop, h.children); close(h.finished) }()
	t.Cleanup(func() {
		select {
		case h.stop <- syscall.SIGQUIT:
		default:
		}
		h.valid.Store(false)
		select {
		case <-h.finished:
		case <-time.After(5 * time.Second):
		}
	})
	return h
}

func (h *harness) pid(name string) int {
	data, err := os.ReadFile(filepath.Join(h.dir, name))
	if err != nil {
		return 0
	}
	var pid int
	_ = json.Unmarshal([]byte(strings.TrimSpace(string(data))), &pid)
	return pid
}

// A zombie runs nothing; outside PID 1 its reaping belongs to another process.
func alive(pid int) bool {
	if pid <= 0 || syscall.Kill(pid, 0) != nil {
		return false
	}
	stat, err := os.ReadFile("/proc/" + strconv.Itoa(pid) + "/stat")
	if err != nil {
		return true
	}
	fields := strings.Fields(string(stat[strings.LastIndexByte(string(stat), ')')+1:]))
	return len(fields) == 0 || fields[0] != "Z"
}

func (h *harness) state() State {
	var s State
	data, _ := os.ReadFile(filepath.Join(h.dir, "kong-state.json"))
	_ = json.Unmarshal(data, &s)
	return s
}

func eventually(t *testing.T, within time.Duration, what string, ok func() bool) time.Duration {
	t.Helper()
	began := time.Now()
	for time.Since(began) < within {
		if ok() {
			return time.Since(began)
		}
		time.Sleep(10 * time.Millisecond)
	}
	t.Fatalf("%s: not within %s", what, within)
	return 0
}

func TestNoNginxWithoutALease(t *testing.T) {
	h := start(t, "plain", false)
	time.Sleep(500 * time.Millisecond)
	if h.pid("master") != 0 {
		t.Fatal("nginx started without a valid lease")
	}
	if s := h.state(); s.Nginx != "stopped" || s.LeaseError == "" || s.HeartbeatBoottimeNs == 0 {
		t.Fatalf("state %+v", s)
	}
	h.valid.Store(true)
	eventually(t, time.Second, "nginx starts once the lease is valid", func() bool { return alive(h.pid("master")) })
}

func TestInvalidLeaseKillsTheWholeGroupWithinF(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	master, worker := h.pid("master"), h.pid("worker")
	h.valid.Store(false)
	// S (100 ms here) to notice, KillAfter for SIGTERM, then SIGKILL: the stuck master ignores TERM.
	took := eventually(t, time.Second, "master and worker gone", func() bool { return !alive(master) && !alive(worker) })
	if took > 100*time.Millisecond+2*200*time.Millisecond+100*time.Millisecond {
		t.Fatalf("containment took %s", took)
	}
	time.Sleep(300 * time.Millisecond)
	if h.pid("master") != master {
		t.Fatal("nginx restarted without a valid lease")
	}
	if s := h.state(); s.Nginx != "stopped" || !strings.Contains(s.LastExit, "killed") {
		t.Fatalf("state %+v", s)
	}
}

func TestRestartsAKilledNginxOnlyWithALease(t *testing.T) {
	h := start(t, "plain", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	first := h.pid("master")
	_ = syscall.Kill(-first, syscall.SIGKILL)
	eventually(t, 2*time.Second, "nginx restarted", func() bool { p := h.pid("master"); return p != first && alive(p) })
}

func TestStopDrainsThenExits(t *testing.T) {
	h := start(t, "drain", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	worker := h.pid("worker")
	h.stop <- syscall.SIGQUIT
	select {
	case code := <-h.done:
		if code != 0 {
			t.Fatalf("exit %d", code)
		}
	case <-time.After(2 * time.Second):
		t.Fatal("did not exit after the drain")
	}
	// Outside PID 1 the killed worker is reaped by another process: allow for that.
	eventually(t, time.Second, "no worker outlives the drained master", func() bool { return !alive(worker) })
	if s := h.state(); s.Nginx != "stopped" || !s.Stopping || s.LastExit != "exit 0" {
		t.Fatalf("state %+v", s)
	}
}

func TestDrainIsBoundedByDk(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	began := time.Now()
	h.stop <- syscall.SIGQUIT
	select {
	case <-h.done:
	case <-time.After(3 * time.Second):
		t.Fatal("a master ignoring SIGQUIT kept the container past Dk")
	}
	if took := time.Since(began); took < time.Second || took > time.Second+500*time.Millisecond {
		t.Fatalf("drain took %s, Dk is 1 s here", took)
	}
}

func TestInvalidLeaseDuringDrainKillsAtOnce(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	h.stop <- syscall.SIGQUIT
	time.Sleep(150 * time.Millisecond)
	began := time.Now()
	h.valid.Store(false)
	select {
	case <-h.done:
	case <-time.After(2 * time.Second):
		t.Fatal("did not stop")
	}
	if took := time.Since(began); took > 600*time.Millisecond {
		t.Fatalf("lost lease during the drain took %s to stop nginx", took)
	}
}

func TestAMasterLeavingItsWorkerBehindIsNotRestartedBesideIt(t *testing.T) {
	h := start(t, "orphan", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	first, worker := h.pid("master"), h.pid("worker")
	eventually(t, 3*time.Second, "restarted after the exit", func() bool { p := h.pid("master"); return p != first && alive(p) })
	if alive(worker) {
		t.Fatal("a new nginx started while the previous worker was still alive")
	}
}

func TestDrainDeadlineDoesNotWaitForThePeriod(t *testing.T) {
	h := startWith(t, "stuck", true, 2*time.Second)
	eventually(t, 3*time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	began := time.Now()
	h.stop <- syscall.SIGQUIT
	select {
	case <-h.done:
	case <-time.After(3 * time.Second):
		t.Fatal("did not stop")
	}
	if took := time.Since(began); took > time.Second+300*time.Millisecond {
		t.Fatalf("drain took %s with Dk = 1 s and a 2 s period", took)
	}
}

// events returns the kill and exit events logged so far, each as its key=value fields.
func (h *harness) events(kind string) []map[string]string {
	h.mu.Lock()
	defer h.mu.Unlock()
	var out []map[string]string
	for _, line := range h.logs {
		if !strings.HasPrefix(line, kind+" ") {
			continue
		}
		fields := map[string]string{}
		for _, kv := range strings.Fields(line)[1:] {
			if k, v, ok := strings.Cut(kv, "="); ok {
				fields[k] = v
			}
		}
		out = append(out, fields)
	}
	return out
}

func boottime(t *testing.T, e map[string]string) uint64 {
	t.Helper()
	n, err := strconv.ParseUint(e["boottimeNs"], 10, 64)
	if err != nil {
		t.Fatalf("event without a boottime: %v", e)
	}
	return n
}

// Kx (SIGKILL → confirmed exit) needs both milestones, of the same run of nginx, on one clock.
func TestContainmentLogsTheSigkillAttemptItsResultAndTheConfirmedExit(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	master := h.pid("master")
	h.valid.Store(false)
	eventually(t, 2*time.Second, "a confirmed exit", func() bool { return len(h.events("exit-event")) > 0 })
	kills := onPath(h.events("kill-event"), "containment")
	if len(kills) != 2 || kills[0]["phase"] != "attempt" || kills[1]["phase"] != "sent" {
		t.Fatalf("kill events %v", kills)
	}
	exit := h.events("exit-event")[0]
	for _, k := range kills {
		if k["signal"] != "SIGKILL" || k["path"] != "containment" || k["pid"] != strconv.Itoa(master) || k["run"] != exit["run"] || k["sup"] != exit["sup"] {
			t.Fatalf("kill event %v does not identify the run of exit %v", k, exit)
		}
	}
	if exit["pid"] != strconv.Itoa(master) || !strings.Contains(exit["status"], "killed") {
		t.Fatalf("exit event %v", exit)
	}
	if a, sent, e := boottime(t, kills[0]), boottime(t, kills[1]), boottime(t, exit); !(a <= sent && sent <= e) {
		t.Fatalf("milestones out of order: attempt %d, sent %d, exit %d", a, sent, e)
	}
}

func TestADrainOverDkLogsItsSigkillOnTheDrainPath(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) && alive(h.pid("master")) })
	h.stop <- syscall.SIGQUIT
	select {
	case <-h.done:
	case <-time.After(3 * time.Second):
		t.Fatal("did not stop")
	}
	kills := onPath(h.events("kill-event"), "drain")
	if len(kills) != 2 || kills[0]["path"] != "drain" || kills[1]["phase"] != "sent" || len(h.events("exit-event")) != 1 {
		t.Fatalf("kill %v exit %v", kills, h.events("exit-event"))
	}
}

// kill events of one path (containment or drain: the Kx paths; group: the remnants after the master exited).
func onPath(events []map[string]string, path string) []map[string]string {
	var out []map[string]string
	for _, e := range events {
		if e["path"] == path {
			out = append(out, e)
		}
	}
	return out
}

// No SIGKILL to the master happened: no Kx path claims one (Kx not exercised). The remnants' SIGKILL is still logged.
func TestAGracefulDrainAndATermThatSufficesLogNoSigkill(t *testing.T) {
	drained := start(t, "drain", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(drained.pid("master")) })
	drained.stop <- syscall.SIGQUIT
	<-drained.done
	kills := drained.events("kill-event")
	if len(onPath(kills, "drain"))+len(onPath(kills, "containment")) != 0 || len(drained.events("exit-event")) != 1 {
		t.Fatalf("graceful drain: kill %v exit %v", kills, drained.events("exit-event"))
	}
	// The worker left behind by the drained master is killed by the group cleanup, which logs it.
	group := onPath(kills, "group")
	if len(group) != 2 || group[0]["phase"] != "attempt" || group[1]["phase"] != "sent" || len(drained.events("group-event")) != 1 || drained.events("group-event")[0]["phase"] != "gone" {
		t.Fatalf("group cleanup: kill %v group %v", group, drained.events("group-event"))
	}
	// "plain": the shell dies of SIGTERM before SIGKILL would be due.
	termed := start(t, "plain", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(termed.pid("master")) })
	termed.valid.Store(false)
	eventually(t, 2*time.Second, "exit", func() bool { return len(termed.events("exit-event")) > 0 })
	time.Sleep(300 * time.Millisecond)
	if k := termed.events("kill-event"); len(onPath(k, "containment")) != 0 {
		t.Fatalf("SIGTERM sufficed but containment kill events %v", k)
	}
}

// A refused SIGKILL is logged as failed with its errno, never as sent; the supervisor's behaviour is unchanged.
func TestARefusedSigkillIsLoggedAsFailed(t *testing.T) {
	h := startWithKill(t, "stuck", func(pid int, sig syscall.Signal) error {
		if sig == syscall.SIGKILL && pid < 0 {
			return syscall.EPERM
		}
		return syscall.Kill(pid, sig)
	})
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
	h.valid.Store(false)
	eventually(t, 2*time.Second, "the failed SIGKILL", func() bool {
		for _, k := range h.events("kill-event") {
			if k["phase"] == "failed" {
				return true
			}
		}
		return false
	})
	for _, k := range h.events("kill-event") {
		if k["phase"] == "sent" {
			t.Fatalf("a refused SIGKILL logged as sent: %v", k)
		}
		if k["phase"] == "failed" && k["error"] != "EPERM" {
			t.Fatalf("failed without its errno: %v", k)
		}
	}
	// The refused SIGKILL left the stuck master running: the test ends it itself (the supervisor's behaviour after a
	// failed kill(2) is unchanged by the events).
	_ = syscall.Kill(-h.pid("master"), syscall.SIGKILL)
}

// Each start of nginx is its own run: events of two runs never share (sup, run).
func TestEachStartOfNginxIsADistinctRun(t *testing.T) {
	h := start(t, "stuck", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
	h.valid.Store(false)
	eventually(t, 2*time.Second, "first exit", func() bool { return len(h.events("exit-event")) == 1 })
	h.valid.Store(true)
	eventually(t, 2*time.Second, "second nginx", func() bool { return len(h.events("start-event")) == 2 })
	h.valid.Store(false)
	eventually(t, 2*time.Second, "second exit", func() bool { return len(h.events("exit-event")) == 2 })
	exits := h.events("exit-event")
	if exits[0]["sup"] != exits[1]["sup"] || exits[0]["run"] == exits[1]["run"] {
		t.Fatalf("runs not distinct: %v", exits)
	}
}

// The group cleanup's repeated SIGKILLs keep their results: a refusal after a first success is not lost.
func TestTheGroupCleanupKeepsTheResultOfEveryRepeatedSigkill(t *testing.T) {
	var groupKills atomic.Int32
	h := startWithKill(t, "orphan", func(pid int, sig syscall.Signal) error {
		// The master exits on its own; its worker stays. The first group SIGKILL passes, the repeats are refused, so
		// the worker survives until KillAfter and the cleanup must report the refusals.
		if sig == syscall.SIGKILL && pid < 0 && groupKills.Add(1) > 1 {
			return syscall.EPERM
		}
		if sig == syscall.SIGKILL && pid < 0 {
			return nil // the first one "succeeds" without killing, so the loop repeats
		}
		return syscall.Kill(pid, sig)
	})
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) })
	worker := h.pid("worker")
	eventually(t, 3*time.Second, "the cleanup's end", func() bool { return len(h.events("group-event")) > 0 })
	g := h.events("group-event")[0]
	if g["phase"] != "remaining" || !strings.Contains(g["repeats"], "EPERM:") || strings.Contains(g["repeats"], "sent:") {
		t.Fatalf("group event %v", g)
	}
	_ = syscall.Kill(worker, syscall.SIGKILL)
	_ = syscall.Kill(-h.pid("master"), syscall.SIGKILL)
}
