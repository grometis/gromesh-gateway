package probe

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/json"
	"errors"
	"net"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
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
	mu         sync.Mutex
	open       map[string]bool
	slow       map[string]bool
	unresolved map[string]bool
	// connectedNoAnswer: the TCP connection is accepted and the request then fails (TLS, protocol, no response).
	connectedNoAnswer map[string]bool
	// answer: the status an open URL answers (200 when absent).
	answer map[string]int
	// local: the attempt fails on this side (no route chosen, no socket), not at the destination.
	local map[string]bool
	dns   bool
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
	if n.local[address] {
		return &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("socket", syscall.EMFILE)}
	}
	if n.unresolved[address] {
		return &net.OpError{Op: "dial", Err: &net.DNSError{Err: "no such host", Name: address, IsNotFound: true}}
	}
	return &net.OpError{Op: "dial", Net: "tcp", Err: os.NewSyscallError("connect", syscall.ECONNREFUSED)}
}
func (n *fakeNet) Get(ctx context.Context, url string) (int, bool, error) {
	n.mu.Lock()
	hung := n.connectedNoAnswer[url]
	n.mu.Unlock()
	if hung {
		return 0, true, errors.New("tls: handshake failure")
	}
	if err := n.Dial(ctx, url); err != nil {
		return 0, false, err
	}
	n.mu.Lock()
	defer n.mu.Unlock()
	if status, ok := n.answer[url]; ok {
		return status, true, nil
	}
	return 200, true, nil
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
	checks = append(checks, Check{Capability: "CAP-1", Kind: "tcp-open", Name: "allowed backend", Address: "backend:80"})
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
	kid     string
	trust   TrustSet
	logs    []string
}

func newWorld(t *testing.T, dir string) *world {
	w := &world{t: t, net: &fakeNet{open: map[string]bool{"backend:80": true}, slow: map[string]bool{}, unresolved: map[string]bool{}, connectedNoAnswer: map[string]bool{}, answer: map[string]int{}, local: map[string]bool{}, dns: true}, now: 1_000 * uint64(time.Second), boot: boot1}
	w.instKey, w.kid = instanceKey()
	w.trust = TrustSet{w.kid: w.instKey.Public().(ed25519.PublicKey)}
	w.p = w.probe(dir)
	return w
}

// instanceKey is a fresh instance key and its kid (the RFC 7638 thumbprint).
func instanceKey() (ed25519.PrivateKey, string) {
	pub, priv, _ := ed25519.GenerateKey(rand.Reader)
	return priv, Thumbprint(b64.EncodeToString(pub))
}

// signInstance is what the control plane signs: {alg, kid, typ} in that order.
func signInstance(key ed25519.PrivateKey, kid, typ string, claims any) []byte {
	payload, _ := json.Marshal(claims)
	return sign(key, []byte(`{"alg":"EdDSA","kid":"`+kid+`","typ":"`+typ+`"}`), payload)
}

func (w *world) probe(dir string) *Probe {
	p := &Probe{
		Dir: filepath.Join(dir, "probe"), Handoff: filepath.Join(dir, "handoff"), ClusterID: cluster, PodUID: pod,
		TrustSet: func() (TrustSet, error) {
			if w.trust == nil {
				return nil, errors.New("instance trust set invalid: test")
			}
			return w.trust, nil
		},
		Config: config(), Network: w.net,
		Canary:    func(context.Context) CanaryResult { return w.canary },
		BootID:    func() string { return w.boot },
		Boottime:  func() (uint64, error) { return w.now, nil },
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
	raw := signInstance(w.instKey, w.kid, TypAdmission, c)
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
	// The next round renews the lease: the guard's cache may show the previous nonce for a moment, never for long.
	w.now += uint64(Period)
	w.round()
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	w.now += uint64(PreviousNonceGrace) + 1
	w.p.CanaryStep(context.Background())
	w.expect("guard-missing", false)
}

func TestALeaseExpiresByItselfAndARestartAfterThatNeedsTwoPasses(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	// The probe is stopped longer than V: the gateway is contained without it.
	w.now += uint64(lease.Validity)
	if w.leaseValid() == nil {
		t.Fatal("lease outlived V without a round")
	}
	w.p = w.probe(dir)
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
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
	w.p = w.probe(dir)
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
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	w.net.dns = false
	began := w.now
	for w.now-began < uint64(InconclusiveLimit)-uint64(Period) {
		w.now += uint64(Period)
		w.round()
		w.expect("inconclusive", true)
	}
	w.now += 2 * uint64(Period)
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

func TestAForbiddenNameThatDoesNotResolveProvesNothing(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.net.unresolved["forbidden-CAP-3:80"] = true
	w.round()
	w.expect("awaiting-admission", false)
	if !strings.Contains(strings.Join(w.p.State.Failures, ";"), "no such host") {
		t.Fatalf("failures %v", w.p.State.Failures)
	}
}

func TestTheViolationLatchSurvivesACrashBeforeTheState(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.net.set("forbidden-CAP-1:80", true)
	w.round()
	// A crash right after the latch: the state still says ok, or is unreadable.
	_ = os.WriteFile(filepath.Join(w.p.Dir, "probe-state.json"), []byte("{corrupt"), 0o644)
	w.net.set("forbidden-CAP-1:80", false)
	w.p = w.probe(dir)
	w.round()
	w.expect("violation", false)
}

func TestACorruptStateNeedsTwoPassesEvenWithAFreshAdmission(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	_ = os.WriteFile(filepath.Join(w.p.Dir, "probe-state.json"), []byte("{corrupt"), 0o644)
	w.p = w.probe(dir)
	w.round()
	if w.leaseValid() == nil {
		t.Fatal("one pass after a corrupt state issued a lease")
	}
	w.round()
	w.expect("verifying", true)
}

func TestALostKeyDropsTheAdmission(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	_ = os.Remove(filepath.Join(w.p.Dir, "probe.key"))
	w.p = w.probe(dir)
	w.round()
	w.expect("awaiting-admission", false)
	// The same admission signed again for the new key: its chain is the old key's and cannot be continued, so no
	// report would count the lease.
	w.admit(nil)
	w.round()
	w.expect("no-proof", false)
	w.admit(func(c *AdmissionClaims) { c.AdmissionID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ae" }) // a new one, for the new key
	w.round()
	w.expect("verifying", true)
}

func TestTheCanaryIsCheckedWhileInconclusiveAndTheBackoffHolds(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.net.dns = false
	w.now += uint64(Period)
	w.round()
	w.expect("verifying", true)
	w.canary = CanaryResult{Status: 503}
	w.p.CanaryStep(context.Background())
	w.expect("guard-missing", false)
	retry := w.p.State.RetryAtNs
	// Inconclusive rounds keep guard-missing; passes before the backoff ends issue nothing.
	w.round()
	w.expect("guard-missing", false)
	w.net.dns = true
	w.round()
	w.round()
	w.expect("guard-missing", false)
	w.now = retry
	w.round()
	w.expect("verifying", true)
}

func TestAdmissionPayloadIsStrict(t *testing.T) {
	w := newWorld(t, t.TempDir())
	sign := func(payload string) []byte {
		return sign(w.instKey, []byte(`{"alg":"EdDSA","kid":"`+w.kid+`","typ":"`+TypAdmission+`"}`), []byte(payload))
	}
	self := Identity{ClusterID: cluster, PodUID: pod, BootID: boot1, PublicKey: w.p.key.Public().(ed25519.PublicKey)}
	good := `{"clusterId":"` + cluster + `","podUid":"` + pod + `","nodeName":"n1","bootId":"` + boot1 + `","admissionId":"6a1f3c2e-0b7d-4c1a-9f10-0000000000ad","probePublicKey":"` + w.p.PublicKey() + `","startDeadline":"2026-10-26T12:00:00Z"}`
	if _, _, err := CheckAdmission(sign(good), w.trust, self); err != nil {
		t.Fatal(err)
	}
	for _, bad := range []string{
		strings.Replace(good, `"nodeName":"n1",`, ``, 1),
		strings.Replace(good, `"nodeName":"n1"`, `"nodeName":"n1","nodeName":"n2"`, 1),
		strings.Replace(good, `"startDeadline":"2026-10-26T12:00:00Z"`, `"startDeadline":"tomorrow"`, 1),
		good + "{}",
		strings.Replace(good, `"nodeName":"n1"`, `"nodeName":"n1","extra":"x"`, 1),
	} {
		if _, _, err := CheckAdmission(sign(bad), w.trust, self); err == nil {
			t.Errorf("accepted %s", bad)
		}
	}
	raw := sign(good)
	if _, _, err := CheckAdmission(append(raw, []byte(" {}")...), w.trust, self); err == nil {
		t.Error("accepted a JWS with trailing data")
	}
}

func TestConnectedWithoutAnAnswerAndALocalFailureProveNothing(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.p.Config.Checks = append(w.p.Config.Checks, Check{Capability: "CAP-5", Kind: "http", Name: "validator", URL: "http://validator:8001/", ExpectStatus: 401})
	w.admit(nil)
	w.net.local["forbidden-CAP-6:80"] = true
	w.round()
	w.expect("awaiting-admission", false)
	w.net.local["forbidden-CAP-6:80"] = false
	w.net.connectedNoAnswer["http://validator:8001/"] = true
	w.round()
	w.expect("awaiting-admission", false)
	if len(w.p.State.Violated) != 0 {
		t.Fatalf("violated %v", w.p.State.Violated)
	}
}

func TestACanaryAfterAnInconclusiveRoundIsNotReady(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.net.dns = false
	w.now += uint64(Period)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("inconclusive", true)
}

func TestThePreviousNonceToleranceStartsAgainAtEachRenewal(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.now += uint64(Period)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.PreviousNonce}
	w.p.CanaryStep(context.Background())
	w.canary = CanaryResult{Unreachable: true}
	w.now += uint64(time.Second)
	w.p.CanaryStep(context.Background())
	// A renewal later the cached nonce is the one just replaced: tolerated again, not guard-missing at once.
	w.now += uint64(Period)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.PreviousNonce}
	w.p.CanaryStep(context.Background())
	if w.p.State.State == "guard-missing" {
		t.Fatal("the tolerance of a previous renewal carried over")
	}
}

func TestPortsAndJWSAlphabetAreStrict(t *testing.T) {
	cfg := config()
	cfg.Checks[0].Address = "host:99999"
	if cfg.Validate() == nil {
		t.Fatal("port 99999 accepted")
	}
	w := newWorld(t, t.TempDir())
	c := AdmissionClaims{ClusterID: cluster, PodUID: pod, NodeName: "n1", BootID: boot1, AdmissionID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad", ProbePublicKey: w.p.PublicKey(), StartDeadline: "2026-10-26T12:00:00Z"}
	raw := signInstance(w.instKey, w.kid, TypAdmission, c)
	broken := strings.Replace(string(raw), `"signature":"`, `"signature":"\n`, 1)
	if _, _, err := CheckAdmission([]byte(broken), w.trust, Identity{ClusterID: cluster, PodUID: pod, BootID: boot1, PublicKey: w.p.key.Public().(ed25519.PublicKey)}); err == nil {
		t.Fatal("a signature with a JSON newline was accepted")
	}
}

func TestAHostileHandoffCannotReachThePrivateKey(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	key := filepath.Join(w.p.Dir, "probe.key")
	before, _ := os.ReadFile(key)
	// The agent plants symlinks named like a temporary the probe could use, and a FIFO as the admission.
	for _, name := range []string{"probe.pub.tmp", ".probe.pub.tmp"} {
		_ = os.Symlink(key, filepath.Join(w.p.Handoff, name))
	}
	_ = os.Remove(filepath.Join(w.p.Handoff, "admission.jws"))
	if err := syscall.Mkfifo(filepath.Join(w.p.Handoff, "admission.jws"), 0o644); err != nil {
		t.Fatal(err)
	}
	w.p = w.probe(dir)
	done := make(chan struct{})
	go func() { w.round(); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a FIFO as the admission blocked the round")
	}
	after, _ := os.ReadFile(key)
	if string(before) != string(after) {
		t.Fatal("the private key was overwritten through the handoff")
	}
	_ = os.Remove(filepath.Join(w.p.Handoff, "admission.jws"))
	_ = os.Symlink(key, filepath.Join(w.p.Handoff, "admission.jws"))
	w.round()
	w.expect("awaiting-admission", false)
}

func TestASlowCanaryNeverDelaysAViolation(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	release := make(chan struct{})
	entered := make(chan struct{})
	w.p.Canary = func(context.Context) CanaryResult {
		close(entered)
		<-release
		// An answer about the lease that existed when the call started: discarded after the violation.
		return CanaryResult{Status: 204, Nonce: w.p.State.PreviousNonce}
	}
	finished := make(chan struct{})
	go func() { w.p.CanaryStep(context.Background()); close(finished) }()
	<-entered
	w.net.set("forbidden-CAP-3:80", true)
	done := make(chan struct{})
	go func() { w.round(); close(done) }()
	select {
	case <-done:
	case <-time.After(RoundBudget + time.Second):
		t.Fatal("the round waited for the canary")
	}
	w.expect("violation", false)
	close(release)
	<-finished
	w.p.mu.Lock()
	state := w.p.State.State
	w.p.mu.Unlock()
	if state != "violation" {
		t.Fatalf("a stale canary answer changed the state to %s", state)
	}
}

// Passes only with the generation check: the stale answer arrives while the state still serves.
func TestAStaleCanaryAnswerNeverWithdrawsARenewedLease(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	release, entered, finished := make(chan struct{}), make(chan struct{}), make(chan struct{})
	w.p.Canary = func(context.Context) CanaryResult {
		close(entered)
		<-release
		return CanaryResult{Status: 503}
	}
	go func() { w.p.CanaryStep(context.Background()); close(finished) }()
	<-entered
	w.now += uint64(Period)
	w.round()
	renewed := w.p.State.Nonce
	close(release)
	<-finished
	w.expect("verifying", true)
	if w.p.State.Nonce != renewed {
		t.Fatal("the renewed lease was replaced")
	}
}
