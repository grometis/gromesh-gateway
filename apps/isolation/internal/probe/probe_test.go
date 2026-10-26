package probe

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"errors"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

const (
	cluster = "6a1f3c2e-0b7d-4c1a-9f10-0000000000c1"
	pod     = "6a1f3c2e-0b7d-4c1a-9f10-0000000000a1"
	boot1   = "0b5d6a4e-1f2c-4d3b-8a9e-000000000001"
	boot2   = "0b5d6a4e-1f2c-4d3b-8a9e-000000000002"
)

// fakeNet: addresses in `open` accept connections; `slow` ones hang until the round budget ends.
type fakeNet struct {
	mu   sync.Mutex
	open map[string]bool
	slow map[string]bool
	dns  bool
}

func (n *fakeNet) Dial(ctx context.Context, address string) error {
	n.mu.Lock()
	open, slow := n.open[address], n.slow[address]
	n.mu.Unlock()
	if slow {
		<-ctx.Done()
		return ctx.Err()
	}
	if open {
		return nil
	}
	return errors.New("connection refused")
}
func (n *fakeNet) Get(ctx context.Context, url string) (int, error) {
	if n.Dial(ctx, url) == nil {
		return 200, nil
	}
	return 0, errors.New("connection refused")
}
func (n *fakeNet) Resolve(context.Context, string) error {
	if n.dns {
		return nil
	}
	return errors.New("no such host")
}
func (n *fakeNet) set(address string, open bool) {
	n.mu.Lock()
	n.open[address] = open
	n.mu.Unlock()
}

func config() Config {
	var checks []Check
	for _, c := range Capabilities {
		checks = append(checks, Check{Capability: c, Kind: "tcp", Name: c, Address: "forbidden-" + c + ":80"})
	}
	checks = append(checks, Check{Capability: "CAP-4", Kind: "dns", Name: "cluster dns", Host: "kubernetes.default.svc"})
	return Config{Checks: checks}
}

type world struct {
	t       *testing.T
	p       *Probe
	net     *fakeNet
	now     uint64
	boot    string
	canary  CanaryResult
	instKey ed25519.PrivateKey
	logs    []string
}

func newWorld(t *testing.T, dir string) *world {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	w := &world{t: t, net: &fakeNet{open: map[string]bool{}, slow: map[string]bool{}, dns: true}, now: 1_000 * uint64(time.Second), boot: boot1, instKey: priv}
	w.p = w.probe(dir, pub)
	return w
}

func (w *world) probe(dir string, pub ed25519.PublicKey) *Probe {
	p := &Probe{
		Dir: filepath.Join(dir, "probe"), Handoff: filepath.Join(dir, "handoff"), ClusterID: cluster, PodUID: pod, InstanceKey: pub,
		Config: config(), Network: w.net,
		Canary:   func(context.Context) CanaryResult { return w.canary },
		BootID:   func() string { return w.boot },
		Boottime: func() (uint64, error) { return w.now, nil },
		WallClock: time.Now,
		Logf:      func(f string, a ...any) { w.logs = append(w.logs, f) },
	}
	_ = os.MkdirAll(p.Handoff, 0o755)
	if err := p.Open(); err != nil {
		w.t.Fatal(err)
	}
	return p
}

func (w *world) admit(mutate func(*AdmissionClaims)) {
	c := AdmissionClaims{ClusterID: cluster, PodUID: pod, NodeName: "n1", BootID: w.boot, AdmissionID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad",
		ProbePublicKey: w.p.PublicKey(), StartDeadline: "2026-10-26T12:00:00Z"}
	if mutate != nil {
		mutate(&c)
	}
	raw, err := Sign(w.instKey, c)
	if err != nil {
		w.t.Fatal(err)
	}
	if err := os.WriteFile(filepath.Join(w.p.Handoff, "admission.jws"), raw, 0o644); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) round() { w.p.Round(context.Background()) }

// leaseValid is what the guard, the supervisor and the liveness decide, right now.
func (w *world) leaseValid() error {
	l, err := lease.Read(filepath.Join(w.p.Dir, "lease.json"))
	if err != nil {
		return err
	}
	return lease.Check(l, lease.Node{PodUID: pod, BootID: w.boot, Now: w.now, TimeNamespaceZero: true})
}

func (w *world) expect(state string, valid bool) {
	w.t.Helper()
	if w.p.State.State != state {
		w.t.Fatalf("state %q, want %q (failures %v)", w.p.State.State, state, w.p.State.Failures)
	}
	if err := w.leaseValid(); (err == nil) != valid {
		w.t.Fatalf("lease valid=%v (%v), want %v", err == nil, err, valid)
	}
}

func TestNoLeaseWithoutAnAdmissionOfThisPodBootAndKey(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.round()
	w.expect("awaiting-admission", false)
	_, other, _ := ed25519.GenerateKey(rand.Reader)
	for name, mutate := range map[string]func(*AdmissionClaims){
		"another pod":     func(c *AdmissionClaims) { c.PodUID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ff" },
		"another boot":    func(c *AdmissionClaims) { c.BootID = boot2 },
		"another cluster": func(c *AdmissionClaims) { c.ClusterID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000c2" },
		"another key":     func(c *AdmissionClaims) { c.ProbePublicKey = "AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA" },
	} {
		w.admit(mutate)
		w.round()
		if w.p.State.State != "awaiting-admission" || w.leaseValid() == nil {
			t.Fatalf("%s: admitted", name)
		}
	}
	// Forged: signed by a key that is not the instance's.
	good := w.instKey
	w.instKey = other
	w.admit(nil)
	w.instKey = good
	w.round()
	w.expect("awaiting-admission", false)
}

func TestAdmittedPassIssuesTheLeaseThenTheCanaryMakesItReady(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.expect("verifying", true)
	l, _ := lease.Read(filepath.Join(w.p.Dir, "lease.json"))
	if len(l.Capabilities) != 7 || l.ExpiresBoottimeNs-l.IssuedBoottimeNs != uint64(lease.Validity) {
		t.Fatalf("lease %+v", l)
	}
	w.canary = CanaryResult{Unreachable: true}
	w.p.CanaryStep(context.Background())
	w.expect("kong-unavailable", true)
	w.canary = CanaryResult{Status: 204, Nonce: l.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	// The lease expires by itself V after the last round: a dead probe contains the gateway.
	w.now += uint64(lease.Validity)
	if w.leaseValid() == nil {
		t.Fatal("lease outlived V without a round")
	}
}

func TestViolationIsWrittenAtOnceAndOnlyAReleaseEndsIt(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.net.set("forbidden-CAP-2:80", true)
	w.round()
	w.expect("violation", false)
	if strings.Join(w.p.State.Violated, ",") != "CAP-2" {
		t.Fatalf("violated %v", w.p.State.Violated)
	}
	w.net.set("forbidden-CAP-2:80", false)
	w.round()
	w.round()
	w.expect("violation", false)
	// It survives a restart of the probe, and of the node.
	pub := w.p.InstanceKey
	w.p = w.probe(dir, pub)
	w.round()
	w.expect("violation", false)
	w.boot = boot2
	w.admit(nil)
	w.round()
	w.expect("violation", false)
}

func TestInconclusiveIsToleratedFiveMinutesThenNoProofNeedsTwoPasses(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.net.dns = false
	w.now += uint64(time.Minute)
	w.round()
	w.expect("inconclusive", true)
	w.now += uint64(InconclusiveLimit)
	w.round()
	w.expect("no-proof", false)
	w.net.dns = true
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
}

func TestARoundCutByItsBudgetProvesNothing(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.net.slow["forbidden-CAP-5:80"] = true
	began := time.Now()
	w.round()
	if took := time.Since(began); took > RoundBudget+500*time.Millisecond {
		t.Fatalf("round took %s", took)
	}
	w.expect("awaiting-admission", false)
}

func TestGuardMissingWithdrawsTheLeaseWithBackoff(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 200}
	w.p.CanaryStep(context.Background())
	w.expect("guard-missing", false)
	if w.p.State.BackoffNs != uint64(BackoffFirst) {
		t.Fatalf("backoff %d", w.p.State.BackoffNs)
	}
	w.round()
	w.expect("guard-missing", false)
	w.now += uint64(BackoffFirst)
	w.round()
	w.expect("verifying", true)
	w.canary = CanaryResult{Status: 204, Nonce: "not-the-lease-nonce-xxxxxx"}
	w.p.CanaryStep(context.Background())
	w.expect("guard-missing", false)
	if w.p.State.BackoffNs != 2*uint64(BackoffFirst) {
		t.Fatalf("backoff did not double: %d", w.p.State.BackoffNs)
	}
	// A route without the canary for more than 60 s while Kong answers.
	w.now += 2 * uint64(BackoffFirst)
	w.round()
	w.canary = CanaryResult{Status: 404}
	w.p.CanaryStep(context.Background())
	w.expect("verifying", true)
	w.now += uint64(CanaryNotFound) + 1
	w.p.CanaryStep(context.Background())
	w.expect("guard-missing", false)
}

func TestConfigMustCoverEveryCapability(t *testing.T) {
	cfg := config()
	if err := cfg.Validate(); err != nil {
		t.Fatal(err)
	}
	cfg.Checks = cfg.Checks[1:]
	if err := cfg.Validate(); err == nil || !strings.Contains(err.Error(), "CAP-1") {
		t.Fatalf("a configuration without CAP-1 accepted: %v", err)
	}
}
