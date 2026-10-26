package supervisor

import (
	"encoding/json"
	"errors"
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
	body := `echo $$ > "` + dir + `/master"; sleep 300 & echo $! > "` + dir + `/worker"; `
	switch mode {
	case "drain":
		body += `trap 'sleep 0.3; exit 0' QUIT; trap '' TERM; `
	case "stuck":
		body += `trap '' TERM QUIT; `
	case "orphan":
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

func start(t *testing.T, mode string, valid bool) *harness { return startWith(t, mode, valid, 100*time.Millisecond) }

func startWith(t *testing.T, mode string, valid bool, period time.Duration) *harness {
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
		Logf: func(format string, args ...any) {
			h.mu.Lock()
			h.logs = append(h.logs, format)
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
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) })
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
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
	first := h.pid("master")
	_ = syscall.Kill(-first, syscall.SIGKILL)
	eventually(t, 2*time.Second, "nginx restarted", func() bool { p := h.pid("master"); return p != first && alive(p) })
}

func TestStopDrainsThenExits(t *testing.T) {
	h := start(t, "drain", true)
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
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
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
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
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
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
	eventually(t, time.Second, "nginx running", func() bool { return alive(h.pid("worker")) })
	first, worker := h.pid("master"), h.pid("worker")
	eventually(t, 3*time.Second, "restarted after the exit", func() bool { p := h.pid("master"); return p != first && alive(p) })
	if alive(worker) {
		t.Fatal("a new nginx started while the previous worker was still alive")
	}
}

func TestDrainDeadlineDoesNotWaitForThePeriod(t *testing.T) {
	h := startWith(t, "stuck", true, 2*time.Second)
	eventually(t, 3*time.Second, "nginx running", func() bool { return alive(h.pid("master")) })
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
