// Package supervisor is PID 1 of the kong container in Workspaces mode (agent-protocol-v2, fail-closed isolation).
// It starts nginx only with a valid lease, rereads the lease every period S and, as soon as it is invalid, sends
// SIGTERM to nginx's process group and SIGKILL F/2 later (F = 1 s to the confirmed exit). It never restarts nginx
// without a valid lease and never uses nginx's graceful stop for containment. On the pod's stop signal it drains
// with SIGQUIT for at most Dk, still killing at once if the lease becomes invalid meanwhile.
//
// Kx milestones (B §3.5.3: SIGKILL → exit confirmed by waitpid, measured in N2). Every SIGKILL to nginx's group
// logs "kill-event phase=attempt" before kill(2) and "phase=sent" or "phase=failed error=<errno>" after it returns,
// with its path: containment, drain, or group (the remnants after the master exited, repeats counted in
// "group-event"); the master reaped by Wait4 logs "exit-event". Each line carries the supervisor run (sup, random per process), the
// start of nginx (run, counted from 1), pid and pgid, and boottimeNs: CLOCK_BOOTTIME (the liveness's clock) read at
// that point, in nanoseconds. A value only lies before (attempt) or after (sent, exit) its event, so exit − attempt
// bounds Kx from above; "unknown" when the clock could not be read. No lease, config or request content is logged.
package supervisor

import (
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sort"
	"strings"
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
	// Kill sends a signal (kill(2)); nil is syscall.Kill. Injectable only so tests can refuse a signal.
	Kill func(pid int, sig syscall.Signal) error
	Logf func(format string, args ...any)
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
	cfg Config
	// pid is nginx's master; pgid its process group, kept until no process of the group is left.
	pid      int
	pgid     int
	exited   chan string
	state    State
	stopping bool
	drain    <-chan time.Time
	// sup identifies this supervisor process and run each start of nginx, so events of two runs never pair.
	sup      string
	run      int
	reapedAt string
}

// Run blocks until the pod is stopped (signal on stop) and nginx's whole process group has exited. children delivers
// SIGCHLD.
func Run(cfg Config, stop <-chan os.Signal, children <-chan os.Signal) int {
	becomeSubreaper()
	if cfg.Kill == nil {
		cfg.Kill = syscall.Kill
	}
	s := &supervisor{cfg: cfg, exited: make(chan string, 1), sup: supervisorID()}
	tick := time.NewTicker(cfg.Period)
	defer tick.Stop()
	s.evaluate()
	for {
		select {
		case <-stop:
			if !s.stopping {
				s.stopping = true
				if s.pgid != 0 {
					s.cfg.Logf("stop signal: draining nginx for at most %s", cfg.Drain)
					s.signal(syscall.SIGQUIT)
					// A timer of its own: the drain never outlasts Dk by a period of the ticker.
					s.drain = time.After(cfg.Drain)
				}
			}
		case <-s.drain:
			s.cfg.Logf("drain exceeded %s: killing nginx", s.cfg.Drain)
			s.sigkill("drain")
			s.awaitExit(s.cfg.KillAfter)
		case <-children:
			s.reap()
		case status := <-s.exited:
			s.onExit(status)
		case <-tick.C:
		}
		s.evaluate()
		if s.stopping && s.pgid == 0 {
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
	case s.pid == 0 && s.pgid != 0:
		// The master is gone but part of its group is not yet: never a new nginx beside it.
		s.confirmGroupGone()
	case s.pgid == 0 && err == nil && !s.stopping:
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
	s.pid, s.pgid = proc.Pid, proc.Pid
	s.run++
	s.state.Nginx, s.state.Pid = "running", s.pid
	s.cfg.Logf("lease valid: nginx started (pid %d)", s.pid)
	s.event("start-event", "")
}

// kill is SIGTERM to the whole process group, then SIGKILL after KillAfter, then the confirmed exit.
func (s *supervisor) kill() {
	s.signal(syscall.SIGTERM)
	if s.awaitExit(s.cfg.KillAfter) {
		return
	}
	s.sigkill("containment")
	if !s.awaitExit(s.cfg.KillAfter) {
		s.cfg.Logf("nginx (pid %d) did not exit after SIGKILL", s.pid)
	}
}

// sigkill is SIGKILL to nginx's group with its Kx milestones: the attempt before kill(2), its result after it.
func (s *supervisor) sigkill(path string) {
	if s.pgid == 0 {
		return
	}
	s.event("kill-event", "phase=attempt path="+path+" signal=SIGKILL")
	if err := s.cfg.Kill(-s.pgid, syscall.SIGKILL); err != nil {
		s.event("kill-event", "phase=failed path="+path+" signal=SIGKILL error="+errnoName(err))
		return
	}
	s.event("kill-event", "phase=sent path="+path+" signal=SIGKILL")
}

// event logs one milestone line: kind, the identity of this run of nginx, CLOCK_BOOTTIME now, then fields.
func (s *supervisor) event(kind, fields string) {
	s.cfg.Logf("%s v=1 sup=%s run=%d pid=%d pgid=%d boottimeNs=%s %s", kind, s.sup, s.run, s.pid, s.pgid, s.boottime(), fields)
}

func (s *supervisor) boottime() string {
	now, err := s.cfg.Boottime()
	if err != nil {
		return "unknown"
	}
	return fmt.Sprint(now)
}

func supervisorID() string {
	b := make([]byte, 4)
	if _, err := rand.Read(b); err != nil {
		return fmt.Sprintf("p%d", os.Getpid())
	}
	return hex.EncodeToString(b)
}

// summary renders outcome counts as "sent:3,EPERM:1" (sorted; "none" when empty).
func summary(counts map[string]int) string {
	if len(counts) == 0 {
		return "none"
	}
	keys := make([]string, 0, len(counts))
	for k := range counts {
		keys = append(keys, k)
	}
	sort.Strings(keys)
	parts := make([]string, len(keys))
	for i, k := range keys {
		parts[i] = fmt.Sprintf("%s:%d", k, counts[k])
	}
	return strings.Join(parts, ",")
}

func errnoName(err error) string {
	var errno syscall.Errno
	if !errors.As(err, &errno) {
		return "unknown"
	}
	switch errno {
	case syscall.EPERM:
		return "EPERM"
	case syscall.ESRCH:
		return "ESRCH"
	case syscall.EINVAL:
		return "EINVAL"
	}
	return fmt.Sprintf("errno%d", int(errno))
}

func (s *supervisor) signal(sig syscall.Signal) {
	if s.pgid != 0 {
		_ = s.cfg.Kill(-s.pgid, sig)
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
			// Read right after Wait4 returned the master: the confirmation milestone of Kx.
			s.reapedAt = s.boottime()
			select {
			case s.exited <- describe(status):
			default:
			}
		}
	}
}

func (s *supervisor) onExit(status string) {
	s.cfg.Logf("nginx (pid %d) exited: %s", s.pid, status)
	s.cfg.Logf("exit-event v=1 sup=%s run=%d pid=%d pgid=%d boottimeNs=%s status=%s", s.sup, s.run, s.pid, s.pgid, s.reapedAt, strings.ReplaceAll(status, " ", "-"))
	s.pid = 0
	s.state.Pid, s.state.LastExit = 0, status
	s.confirmGroupGone()
}

// confirmGroupGone kills what is left of the group and reaps until none of its processes exists, for at most
// KillAfter. Until then the state stays running and no new nginx starts. Its SIGKILLs are to the group's remnants
// after the master exited (path=group, never a Kx milestone): the first is logged like any SIGKILL, the repeats of the
// loop are counted, and "group-event" says how it ended (gone, or remaining after KillAfter).
func (s *supervisor) confirmGroupGone() {
	end := time.Now().Add(s.cfg.KillAfter)
	kills := 0
	// The repeats' results, by outcome: "sent" or the errno name; never dropped.
	results := map[string]int{}
	for {
		if kills == 0 {
			s.sigkill("group")
		} else if err := s.cfg.Kill(-s.pgid, syscall.SIGKILL); err != nil {
			results[errnoName(err)]++
		} else {
			results["sent"]++
		}
		kills++
		s.reap()
		if err := syscall.Kill(-s.pgid, 0); errors.Is(err, syscall.ESRCH) {
			s.event("group-event", fmt.Sprintf("phase=gone kills=%d repeats=%s", kills, summary(results)))
			s.pgid = 0
			s.state.Nginx = "stopped"
			return
		}
		if time.Now().After(end) {
			s.event("group-event", fmt.Sprintf("phase=remaining kills=%d repeats=%s", kills, summary(results)))
			s.cfg.Logf("process group %d still has processes after SIGKILL", s.pgid)
			return
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func (s *supervisor) write() {
	now, err := s.cfg.Boottime()
	if err != nil {
		// Without the clock there is no heartbeat: the liveness fails, which is the safe side.
		return
	}
	s.state.Nginx = "running"
	if s.pgid == 0 {
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
