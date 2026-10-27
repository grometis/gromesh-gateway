package probe

import (
	"context"
	"errors"
	"net"
	"net/http"
	"net/http/httptest"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"testing"
	"time"
)

// scripted answers every call the same way: one check per case.
type scripted struct {
	dialErr   error
	status    int
	connected bool
	getErr    error
}

func (s scripted) Dial(context.Context, string) error { return s.dialErr }
func (s scripted) Get(context.Context, string) (int, bool, error) {
	return s.status, s.connected, s.getErr
}
func (s scripted) Resolve(context.Context, string) error { return s.dialErr }

func TestEvaluateTellsAViolationFromAMissingProof(t *testing.T) {
	refused := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
	dialTimeout := &net.OpError{Op: "dial", Net: "tcp", Err: os.ErrDeadlineExceeded}
	local := &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("socket", syscall.EMFILE)}
	unresolved := &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: "x", IsNotFound: true}}
	// What net/http returns when the server accepted the connection and never answered.
	noAnswer := &url.Error{Op: "Get", URL: "http://127.0.0.1:9100/metrics", Err: os.ErrDeadlineExceeded}
	reset := &url.Error{Op: "Get", URL: "http://127.0.0.1:9100/metrics", Err: os.NewSyscallError("read", syscall.ECONNRESET)}
	tcp := Check{Capability: "CAP-2", Kind: "tcp", Name: "node", Address: "10.0.0.1:10250"}
	agent := Check{Capability: "CAP-6", Kind: "http", Name: "agent metrics", URL: "http://127.0.0.1:9100/metrics", ExpectStatus: 403}
	validator := Check{Capability: "CAP-5", Kind: "http", Name: "validator", URL: "http://validator:8001/", ExpectStatus: 401}
	cases := []struct {
		name  string
		check Check
		net   scripted
		want  string
	}{
		{"tcp forbidden port accepts", tcp, scripted{}, "violation"},
		{"tcp refused", tcp, scripted{dialErr: refused}, "pass"},
		{"tcp dial timeout", tcp, scripted{dialErr: dialTimeout}, "pass"},
		{"tcp local failure", tcp, scripted{dialErr: local}, "inconclusive"},
		{"tcp name unresolved", tcp, scripted{dialErr: unresolved}, "inconclusive"},
		{"http answers 403 as expected", agent, scripted{status: 403, connected: true}, "pass"},
		{"http answers 401 as expected", validator, scripted{status: 401, connected: true}, "pass"},
		{"http answers 200", agent, scripted{status: 200, connected: true}, "violation"},
		{"http answers 401 where 403 is expected", agent, scripted{status: 401, connected: true}, "violation"},
		{"http frozen agent: connected, no answer", agent, scripted{connected: true, getErr: noAnswer}, "inconclusive"},
		{"http connected then reset", agent, scripted{connected: true, getErr: reset}, "inconclusive"},
		{"http connected then TLS failure", validator, scripted{connected: true, getErr: errors.New("tls: handshake failure")}, "inconclusive"},
		{"http refused", agent, scripted{getErr: refused}, "pass"},
		{"http dial timeout", agent, scripted{getErr: dialTimeout}, "pass"},
		{"http local failure", agent, scripted{getErr: local}, "inconclusive"},
		{"http name unresolved", validator, scripted{getErr: unresolved}, "inconclusive"},
	}
	for _, c := range cases {
		if got, detail := evaluate(context.Background(), c.net, c.check); got != c.want {
			t.Errorf("%s: %s (%s), want %s", c.name, got, detail, c.want)
		}
	}
}

// The real client against loopback servers: a listener that never accepts is what a SIGSTOPped agent looks like (the
// kernel completes the handshake into the backlog, nobody reads).
func TestRealNetworkAFrozenServerIsInconclusiveAndAnAnswerDecides(t *testing.T) {
	network := realNetwork{timeout: 300 * time.Millisecond}
	frozen, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	defer frozen.Close()
	closed, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	closedAddr := closed.Addr().String()
	_ = closed.Close()
	var status atomic.Int32
	status.Store(http.StatusForbidden)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.WriteHeader(int(status.Load())) }))
	defer server.Close()

	check := func(kind, target string) string {
		ch := Check{Capability: "CAP-6", Kind: kind, Name: "agent", Address: target, URL: "http://" + target + "/metrics", ExpectStatus: 403}
		got, _ := evaluate(context.Background(), network, ch)
		return got
	}
	serverAddr := strings.TrimPrefix(server.URL, "http://")
	for _, c := range []struct{ kind, target, want string }{
		{"http", frozen.Addr().String(), "inconclusive"},
		{"tcp", frozen.Addr().String(), "violation"},
		{"http", closedAddr, "pass"},
		{"tcp", closedAddr, "pass"},
		{"http", serverAddr, "pass"},
	} {
		if got := check(c.kind, c.target); got != c.want {
			t.Errorf("%s %s: %s, want %s", c.kind, c.target, got, c.want)
		}
	}
	status.Store(http.StatusOK)
	if got := check("http", serverAddr); got != "violation" {
		t.Errorf("http answering 200: %s, want violation", got)
	}
}

const agentMetrics = "http://127.0.0.1:9100/metrics"

// agentWorld probes the agent's :9100 over http (CAP-6), which answers 403 to its own pod while it runs.
func agentWorld(t *testing.T) *world {
	w := newWorld(t, t.TempDir())
	w.p.Config.Checks = append(w.p.Config.Checks, Check{Capability: "CAP-6", Kind: "http", Name: "agent metrics", URL: agentMetrics, ExpectStatus: 403})
	w.net.open[agentMetrics] = true
	w.net.answer[agentMetrics] = 403
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	return w
}

func (w *world) freezeAgent(frozen bool) {
	w.net.mu.Lock()
	w.net.connectedNoAnswer[agentMetrics] = frozen
	w.net.mu.Unlock()
}

func (w *world) noViolation() {
	w.t.Helper()
	if len(w.p.State.Violated) != 0 {
		w.t.Fatalf("violated %v", w.p.State.Violated)
	}
	if _, err := os.Stat(filepath.Join(w.p.Dir, "violation.json")); !errors.Is(err, os.ErrNotExist) {
		w.t.Fatalf("violation latch written (%v)", err)
	}
}

// F2: a frozen agent proves no bypass. It is inconclusive, and a conclusive pass after it recovers without any release.
func TestAFrozenAgentIsInconclusiveAndRecoversWithoutARelease(t *testing.T) {
	w := agentWorld(t)
	w.freezeAgent(true)
	w.now += uint64(Period)
	w.round()
	w.expect("inconclusive", true)
	w.noViolation()
	if !strings.Contains(strings.Join(w.p.State.Failures, ";"), "CAP-6 agent metrics") || w.p.State.LastRoundConclusive {
		t.Fatalf("failures %v conclusive %v", w.p.State.Failures, w.p.State.LastRoundConclusive)
	}
	w.freezeAgent(false)
	w.now += uint64(Period)
	w.round()
	w.expect("ok", true)
	w.noViolation()
}

// Inconclusive is never access: past the tolerance the lease is withdrawn, and two conclusive passes bring it back.
func TestAFrozenAgentPastTheToleranceIsNoProof(t *testing.T) {
	w := agentWorld(t)
	w.freezeAgent(true)
	began := w.now
	for w.now-began < uint64(InconclusiveLimit)-uint64(Period) {
		w.now += uint64(Period)
		w.round()
		w.expect("inconclusive", true)
	}
	w.now += 2 * uint64(Period)
	w.round()
	w.expect("no-proof", false)
	w.now += uint64(Period)
	w.round()
	w.expect("no-proof", false)
	w.noViolation()
	w.freezeAgent(false)
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
}

// An agent that answers what it must refuse is a confirmed violation; freezing or refusing again never ends it.
func TestAWrongAnswerIsLatchedAndAFrozenAgentDoesNotEndIt(t *testing.T) {
	w := agentWorld(t)
	w.net.mu.Lock()
	w.net.answer[agentMetrics] = 200
	w.net.mu.Unlock()
	w.now += uint64(Period)
	w.round()
	w.expect("violation", false)
	if strings.Join(w.p.State.Violated, ",") != "CAP-6" {
		t.Fatalf("violated %v", w.p.State.Violated)
	}
	w.freezeAgent(true)
	w.now += uint64(Period)
	w.round()
	w.expect("violation", false)
	w.freezeAgent(false)
	w.net.mu.Lock()
	w.net.answer[agentMetrics] = 403
	w.net.mu.Unlock()
	w.round()
	w.round()
	w.expect("violation", false)
	if _, err := os.Stat(filepath.Join(w.p.Dir, "violation.json")); err != nil {
		t.Fatalf("violation latch gone: %v", err)
	}
}

// A port that must refuse every connection is violated by the connection alone, without any HTTP.
func TestAForbiddenTCPPortThatAcceptsIsAViolation(t *testing.T) {
	w := agentWorld(t)
	w.net.set("forbidden-CAP-6:80", true)
	w.now += uint64(Period)
	w.round()
	w.expect("violation", false)
	if strings.Join(w.p.State.Violated, ",") != "CAP-6" {
		t.Fatalf("violated %v", w.p.State.Violated)
	}
}
