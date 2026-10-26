// Package supervisor is PID 1 of the kong container in Workspaces mode (agent-protocol-v2, fail-closed isolation).
// It starts nginx only with a valid lease, rereads the lease every period S and, as soon as it is invalid, sends
// SIGTERM to nginx's process group and SIGKILL F/2 later (F = 1 s to the confirmed exit). It never restarts nginx
// without a valid lease and never uses nginx's graceful stop for containment. On the pod's stop signal it drains
// with SIGQUIT for at most Dk, still killing at once if the lease becomes invalid meanwhile.
package supervisor

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"syscall"
	"time"
)

type Config struct {
	Command []string
	// Check returns nil while the lease is valid for this pod and boot.
	Check func() error
	// Boottime is CLOCK_BOOTTIME in nanoseconds, for the heartbeat the liveness reads.
	Boottime func() (uint64, error)
	// StateFile is kong-state.json, in a directory only the supervisor writes.
	StateFile string
	Period    time.Duration // S
	KillAfter time.Duration // SIGTERM → SIGKILL
	Drain     time.Duration // Dk
	Logf      func(format string, args ...any)
}

// State is kong-state.json: read by the liveness and by the probe for its final report (kongStopConfirmed).
type State struct {
	HeartbeatBoottimeNs uint64 `json:"heartbeatBoottimeNs"`
	Nginx               string `json:"nginx"` // running | stopped
	Pid                 int    `json:"pid,omitempty"`
	Stopping            bool   `json:"stopping"`
	LastExit            string `json:"lastExit,omitempty"`
	LeaseError          string `json:"leaseError,omitempty"`
}

type supervisor struct {
	cfg      Config
	pid      int
	exited   chan string
	state    State
	stopping bool
	deadline time.Time
}

// Run blocks until the pod is stopped (signal on stop) and nginx has exited. children delivers SIGCHLD.
func Run(cfg Config, stop <-chan os.Signal, children <-chan os.Signal) int {
	s := &supervisor{cfg: cfg, exited: make(chan string, 1)}
	tick := time.NewTicker(cfg.Period)
	defer tick.Stop()
	s.evaluate()
	for {
		select {
		case <-stop:
			if s.pid == 0 {
				s.write()
				return 0
			}
			if !s.stopping {
				s.stopping = true
				s.deadline = time.Now().Add(cfg.Drain)
				s.cfg.Logf("stop signal: draining nginx for at most %s", cfg.Drain)
				s.signal(syscall.SIGQUIT)
			}
		case <-children:
			s.reap()
		case status := <-s.exited:
			s.onExit(status)
			if s.stopping {
				s.write()
				return 0
			}
		case <-tick.C:
		}
		s.evaluate()
		// The exit may have been collected while killing (lost lease or Dk exceeded during the drain).
		if s.stopping && s.pid == 0 {
			s.write()
			return 0
		}
	}
}

func (s *supervisor) evaluate() {
	err := s.cfg.Check()
	s.state.LeaseError = ""
	if err != nil {
		s.state.LeaseError = err.Error()
	}
	switch {
	case s.pid != 0 && err != nil:
		s.cfg.Logf("lease invalid (%v): stopping nginx", err)
		s.kill()
	case s.pid != 0 && s.stopping && time.Now().After(s.deadline):
		s.cfg.Logf("drain exceeded %s: killing nginx", s.cfg.Drain)
		s.signal(syscall.SIGKILL)
		s.awaitExit(s.cfg.KillAfter)
	case s.pid == 0 && err == nil && !s.stopping:
		s.start()
	}
	s.write()
}

func (s *supervisor) start() {
	proc, err := os.StartProcess(s.cfg.Command[0], s.cfg.Command, &os.ProcAttr{
		Files: []*os.File{os.Stdin, os.Stdout, os.Stderr},
		Sys:   &syscall.SysProcAttr{Setpgid: true},
	})
	if err != nil {
		s.cfg.Logf("cannot start nginx: %v", err)
		return
	}
	s.pid = proc.Pid
	s.state.Nginx, s.state.Pid = "running", s.pid
	s.cfg.Logf("lease valid: nginx started (pid %d)", s.pid)
}

// kill is SIGTERM to the whole process group, then SIGKILL after KillAfter, then the confirmed exit.
func (s *supervisor) kill() {
	s.signal(syscall.SIGTERM)
	if s.awaitExit(s.cfg.KillAfter) {
		return
	}
	s.signal(syscall.SIGKILL)
	if !s.awaitExit(s.cfg.KillAfter) {
		s.cfg.Logf("nginx (pid %d) did not exit after SIGKILL", s.pid)
	}
}

func (s *supervisor) signal(sig syscall.Signal) {
	if s.pid != 0 {
		_ = syscall.Kill(-s.pid, sig)
	}
}

// awaitExit reaps until nginx's master has exited or the timeout passes.
func (s *supervisor) awaitExit(timeout time.Duration) bool {
	end := time.Now().Add(timeout)
	for s.pid != 0 {
		s.reap()
		select {
		case status := <-s.exited:
			s.onExit(status)
			return true
		default:
		}
		if time.Now().After(end) {
			return false
		}
		time.Sleep(10 * time.Millisecond)
	}
	return true
}

// reap collects every exited child: as PID 1 the supervisor also inherits nginx's orphaned workers.
func (s *supervisor) reap() {
	for {
		var status syscall.WaitStatus
		pid, err := syscall.Wait4(-1, &status, syscall.WNOHANG, nil)
		if pid <= 0 || err != nil {
			return
		}
		if pid == s.pid {
			select {
			case s.exited <- describe(status):
			default:
			}
		}
	}
}

func (s *supervisor) onExit(status string) {
	s.cfg.Logf("nginx (pid %d) exited: %s", s.pid, status)
	// No worker may outlive its master: whatever is left of the group goes with it.
	_ = syscall.Kill(-s.pid, syscall.SIGKILL)
	s.pid = 0
	s.state.Nginx, s.state.Pid, s.state.LastExit = "stopped", 0, status
}

func (s *supervisor) write() {
	now, err := s.cfg.Boottime()
	if err != nil {
		// Without the clock there is no heartbeat: the liveness fails, which is the safe side.
		return
	}
	if s.pid == 0 {
		s.state.Nginx = "stopped"
	}
	s.state.HeartbeatBoottimeNs, s.state.Stopping = now, s.stopping
	data, _ := json.Marshal(s.state)
	tmp := filepath.Join(filepath.Dir(s.cfg.StateFile), ".kong-state.tmp")
	if err := os.WriteFile(tmp, data, 0o644); err == nil {
		_ = os.Rename(tmp, s.cfg.StateFile)
	}
}

func describe(status syscall.WaitStatus) string {
	if status.Signaled() {
		return fmt.Sprintf("signal %s", status.Signal())
	}
	return fmt.Sprintf("exit %d", status.ExitStatus())
}
