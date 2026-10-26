package probe

import (
	"context"
	"crypto/ed25519"
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"sync"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
	"io"
	"syscall"
)

// Timing of agent-protocol-v2 (B §3.5.3): period P, round T, inconclusive tolerance I, guard-missing backoff.
const (
	Period            = 15 * time.Second
	RoundBudget       = 3 * time.Second
	InconclusiveLimit = 5 * time.Minute
	CanaryNotFound    = 60 * time.Second
	BackoffFirst      = 30 * time.Second
	BackoffMax        = 5 * time.Minute
	// The guard caches the lease for 1 s: right after a renewal the canary may still show the previous nonce.
	PreviousNonceGrace = 3 * time.Second
)

// Canary results of GET /.gromesh/guard/current.
type CanaryResult struct {
	// Unreachable: no connection (Kong not running yet, or stopped).
	Unreachable bool
	Status      int
	Nonce       string
	// Kong's declarative config hash: which configuration's guard answered.
	ConfigHash string
}

// Probe keeps its state, key and lease in Dir (its own volume: read-only for kong, not mounted by the agent) and
// exchanges the admission and its public key with the agent through Handoff.
type Probe struct {
	Dir         string
	Handoff     string
	ClusterID   string
	PodUID      string
	InstanceKey ed25519.PublicKey
	Config      Config
	Network     Network
	Canary      func(ctx context.Context) CanaryResult
	BootID      func() string
	Boottime    func() (uint64, error)
	WallClock   func() time.Time
	Logf        func(format string, args ...any)

	key ed25519.PrivateKey
	// mu guards State: the canary runs every second beside a round, which holds it only outside its network phase.
	mu    sync.Mutex
	State Persisted
}

// Persisted survives container and node restarts (the volume is on disk), violation included.
type Persisted struct {
	State       string `json:"state"`
	BootID      string `json:"bootId"`
	AdmissionID string `json:"admissionId,omitempty"`
	// The signed admission itself, revalidated against the current cluster, pod, boot and key on every round.
	AdmissionJWS string `json:"admissionJws,omitempty"`
	// Corrupt: the state could not be read; recovery needs two conclusive passes, never a fresh admission's one.
	Corrupt bool `json:"corrupt,omitempty"`
	// GuardVerified: the canary answered with the current nonce since the last start of verification.
	GuardVerified bool `json:"guardVerified"`
	// LastRoundConclusive: a passing canary makes the pod ok (Ready) only after a conclusive round.
	LastRoundConclusive bool   `json:"lastRoundConclusive"`
	PreviousSinceNs     uint64 `json:"previousSinceNs"`
	ConfigHash          string `json:"configHash,omitempty"`
	// FreshAdmission: the first conclusive pass of a newly admitted pod is enough.
	FreshAdmission bool     `json:"freshAdmission"`
	Violated       []string `json:"violated,omitempty"`
	Passes         int      `json:"passes"`
	// Boottime nanoseconds of this boot only; meaningless after a reboot (reset with the boot id).
	LastConclusiveNs uint64   `json:"lastConclusiveNs"`
	Nonce            string   `json:"nonce,omitempty"`
	PreviousNonce    string   `json:"previousNonce,omitempty"`
	BackoffNs        uint64   `json:"backoffNs"`
	RetryAtNs        uint64   `json:"retryAtNs"`
	NotFoundSinceNs  uint64   `json:"notFoundSinceNs"`
	Proven           []string `json:"proven,omitempty"`
	Failures         []string `json:"failures,omitempty"`
}

func (p *Probe) leaseFile() string     { return filepath.Join(p.Dir, "lease.json") }
func (p *Probe) stateFile() string     { return filepath.Join(p.Dir, "probe-state.json") }
func (p *Probe) violationFile() string { return filepath.Join(p.Dir, "violation.json") }

// Open loads the persisted state, the violation latch and the probe key (created once, never leaving Dir) and
// publishes the public key.
func (p *Probe) Open() error {
	if err := os.MkdirAll(p.Dir, 0o755); err != nil {
		return err
	}
	stateData, stateErr := os.ReadFile(p.stateFile())
	if stateErr != nil && !errors.Is(stateErr, os.ErrNotExist) {
		return stateErr
	}
	if stateErr == nil {
		if err := json.Unmarshal(stateData, &p.State); err != nil {
			// A corrupt state is never read as clean.
			p.State = Persisted{State: "no-proof", Corrupt: true}
		}
	}
	keyFile := filepath.Join(p.Dir, "probe.key")
	seed, err := os.ReadFile(keyFile)
	if errors.Is(err, os.ErrNotExist) {
		seed = make([]byte, ed25519.SeedSize)
		if _, err := rand.Read(seed); err != nil {
			return err
		}
		if err := writeSynced(keyFile, seed, 0o600); err != nil {
			return err
		}
		if p.State.AdmissionID != "" {
			// An admission names the key it was granted to; a new key needs a new admission.
			p.Logf("probe key regenerated: admission %s dropped", p.State.AdmissionID)
			p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission = "", "", false
			if p.State.State != "violation" {
				p.State.State = "no-proof"
			}
		}
	} else if err != nil {
		return err
	}
	if len(seed) != ed25519.SeedSize {
		return errors.New("probe key corrupt")
	}
	p.key = ed25519.NewKeyFromSeed(seed)
	// The latch is the first thing a violation writes: a crash after it cannot lose the violation.
	if data, err := os.ReadFile(p.violationFile()); err == nil {
		var latched []string
		if json.Unmarshal(data, &latched) != nil || len(latched) == 0 {
			latched = []string{"unknown"}
		}
		p.State.Violated = mergeUnique(p.State.Violated, latched)
		p.State.State = "violation"
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if p.State.State == "" {
		p.State.State = "awaiting-admission"
	}
	return writeSynced(filepath.Join(p.Handoff, "probe.pub"), []byte(p.PublicKey()), 0o644)
}

func (p *Probe) PublicKey() string {
	return base64.RawURLEncoding.EncodeToString(p.key.Public().(ed25519.PublicKey))
}

// Round is one period: identity, admission, capabilities, then the lease.
func (p *Probe) Round(ctx context.Context) {
	if !p.prepare() {
		return
	}
	verdict := Round(ctx, p.Config, p.Network, RoundBudget, func(capability string) {
		// Written as soon as a forbidden target answers, before the round ends.
		p.mu.Lock()
		defer p.mu.Unlock()
		p.violate([]string{capability})
	})
	p.mu.Lock()
	defer p.mu.Unlock()
	p.conclude(verdict)
}

// prepare checks identity, admission and the current lease; false when no round is due (no admission).
func (p *Probe) prepare() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	now, err := p.Boottime()
	if err != nil {
		p.Logf("CLOCK_BOOTTIME unreadable: %v", err)
		p.withdraw("no-proof")
		return false
	}
	boot := p.BootID()
	if p.State.BootID != boot {
		// A new boot: every lease and admission of the previous one is void; a violation or a corrupt state is not.
		p.Logf("boot %s (was %q): a new admission is needed", boot, p.State.BootID)
		state := "awaiting-admission"
		if p.State.Corrupt {
			state = "no-proof"
		}
		if len(p.State.Violated) > 0 {
			state = "violation"
		}
		p.State = Persisted{State: state, BootID: boot, Violated: p.State.Violated, Corrupt: p.State.Corrupt}
	}
	p.refreshAdmission(boot)
	if p.State.AdmissionID == "" {
		if p.State.State != "violation" && !p.State.Corrupt {
			p.State.State = "awaiting-admission"
		}
		p.removeLease()
		p.save()
		return false
	}
	// A state that serves continues only while its own lease is still valid (after a stop longer than V it is not).
	if serving(p.State.State) && !p.leaseValid(now) {
		p.Logf("lease expired while in %s: no-proof", p.State.State)
		p.State.State, p.State.Passes, p.State.FreshAdmission = "no-proof", 0, false
	}
	return true
}

// conclude turns a round's verdict into the state and the lease.
func (p *Probe) conclude(verdict Verdict) {
	now, err := p.Boottime()
	if err != nil {
		p.withdraw("no-proof")
		return
	}
	p.State.Proven, p.State.Failures = verdict.Proven, verdict.Failures
	p.State.LastRoundConclusive = len(verdict.Violated) == 0 && len(verdict.Inconclusive) == 0
	if len(verdict.Violated) > 0 {
		p.violate(verdict.Violated)
		return
	}
	if len(p.State.Violated) > 0 {
		// Only a signed release (task N2-D3) ends a violation; a pass changes nothing.
		p.violate(nil)
		return
	}
	if len(verdict.Inconclusive) > 0 {
		p.State.Passes = 0
		if p.State.State == "guard-missing" {
			p.withdraw("guard-missing")
			return
		}
		if serving(p.State.State) && p.State.LastConclusiveNs != 0 && now-p.State.LastConclusiveNs < uint64(InconclusiveLimit) {
			if p.State.State == "ok" {
				p.State.State = "inconclusive"
			}
			p.issue("inconclusive", now)
			return
		}
		if p.State.State != "awaiting-admission" {
			p.State.State = "no-proof"
		}
		p.withdraw(p.State.State)
		return
	}

	p.State.Passes++
	p.State.LastConclusiveNs = now
	if now < p.State.RetryAtNs {
		// The guard-missing backoff holds whatever the rounds say.
		p.withdraw(p.State.State)
		return
	}
	switch p.State.State {
	case "awaiting-admission", "guard-missing":
		p.verify()
	case "no-proof":
		if p.State.Passes < 2 && !(p.State.FreshAdmission && !p.State.Corrupt) {
			p.withdraw("no-proof")
			return
		}
		p.State.Corrupt = false
		p.verify()
	case "inconclusive":
		if p.State.GuardVerified {
			p.State.State = "ok"
		} else {
			p.verify()
		}
	}
	p.State.FreshAdmission = false
	p.issue("ok", now)
}

// verify starts a verification: NotReady until the canary answers with the lease about to be issued.
func (p *Probe) verify() {
	p.State.State, p.State.GuardVerified, p.State.PreviousSinceNs = "verifying", false, 0
}

func serving(state string) bool {
	return state == "ok" || state == "verifying" || state == "kong-unavailable" || state == "inconclusive"
}

func (p *Probe) leaseValid(now uint64) bool {
	l, err := lease.Read(p.leaseFile())
	return err == nil && lease.Check(l, lease.Node{PodUID: p.PodUID, BootID: p.State.BootID, Now: now, TimeNamespaceZero: true}) == nil && l.Nonce == p.State.Nonce
}

// CanaryStep checks the guard every second while a lease is out: a configuration without it is caught within 1 s.
func (p *Probe) CanaryStep(ctx context.Context) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if !serving(p.State.State) {
		return
	}
	now, err := p.Boottime()
	if err != nil {
		return
	}
	r := p.Canary(ctx)
	switch {
	case r.Unreachable:
		p.State.NotFoundSinceNs = 0
		if p.State.State == "ok" || p.State.State == "verifying" {
			p.State.State = "kong-unavailable"
		}
	case r.Status == 204 && r.Nonce != "" && r.Nonce == p.State.Nonce:
		if r.ConfigHash != p.State.ConfigHash {
			p.Logf("guard verified on configuration %s", r.ConfigHash)
		}
		p.State.GuardVerified, p.State.ConfigHash, p.State.NotFoundSinceNs, p.State.PreviousSinceNs, p.State.BackoffNs = true, r.ConfigHash, 0, 0, 0
		if p.State.State == "verifying" || p.State.State == "kong-unavailable" {
			// The guard is there; the pod is ok only if the last round proved the capabilities too.
			if p.State.LastRoundConclusive {
				p.State.State = "ok"
			} else {
				p.State.State = "inconclusive"
			}
		}
	case r.Status == 204 && r.Nonce != "" && r.Nonce == p.State.PreviousNonce:
		// Not a proof of the current lease; tolerated only while the guard's cache can explain it.
		if p.State.PreviousSinceNs == 0 {
			p.State.PreviousSinceNs = now
		}
		if now-p.State.PreviousSinceNs > uint64(PreviousNonceGrace) {
			p.guardMissing(now, "canary kept the previous lease's nonce")
			return
		}
	case r.Status == 404:
		if p.State.NotFoundSinceNs == 0 {
			p.State.NotFoundSinceNs = now
		}
		if now-p.State.NotFoundSinceNs > uint64(CanaryNotFound) {
			p.guardMissing(now, "canary route absent for more than 60 s")
			return
		}
		if p.State.State == "kong-unavailable" {
			p.verify()
		}
	default:
		// Kong answers, but not the guard holding the current lease.
		p.guardMissing(now, fmt.Sprintf("canary answered %d", r.Status))
		return
	}
	p.save()
}

func (p *Probe) guardMissing(now uint64, why string) {
	backoff := p.State.BackoffNs * 2
	if backoff == 0 {
		backoff = uint64(BackoffFirst)
	}
	if backoff > uint64(BackoffMax) {
		backoff = uint64(BackoffMax)
	}
	p.Logf("guard-missing (%s): lease withdrawn, new attempt in %s", why, time.Duration(backoff))
	p.State.State, p.State.BackoffNs, p.State.RetryAtNs, p.State.NotFoundSinceNs, p.State.GuardVerified = "guard-missing", backoff, now+backoff, 0, false
	p.withdraw("guard-missing")
}

func (p *Probe) violate(capabilities []string) {
	p.State.Violated = mergeUnique(p.State.Violated, capabilities)
	if len(p.State.Violated) == 0 {
		p.State.Violated = []string{"unknown"}
	}
	// The latch first: a crash between the writes below can never lose the violation.
	data, _ := json.Marshal(p.State.Violated)
	if err := writeSynced(p.violationFile(), data, 0o644); err != nil {
		p.Logf("violation latch not written: %v", err)
	}
	if p.State.State != "violation" {
		p.Logf("violation of %v: containment", p.State.Violated)
	}
	p.State.State, p.State.Passes, p.State.GuardVerified = "violation", 0, false
	p.withdraw("violation")
}

func mergeUnique(a, b []string) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range append(append([]string{}, a...), b...) {
		if !seen[c] {
			seen[c] = true
			out = append(out, c)
		}
	}
	return out
}

// refreshAdmission adopts a valid new admission from the handoff and revalidates the stored one: an admission is
// used only while it is this cluster's, pod's, boot's and key's, whatever the state file says.
func (p *Probe) refreshAdmission(boot string) {
	self := Identity{ClusterID: p.ClusterID, PodUID: p.PodUID, BootID: boot, PublicKey: p.key.Public().(ed25519.PublicKey)}
	if p.State.AdmissionJWS != "" {
		if claims, err := CheckAdmission([]byte(p.State.AdmissionJWS), p.InstanceKey, self); err != nil || claims.AdmissionID != p.State.AdmissionID {
			p.Logf("stored admission no longer valid: dropped")
			p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission = "", "", false
		}
	} else if p.State.AdmissionID != "" {
		p.State.AdmissionID, p.State.FreshAdmission = "", false
	}
	raw, err := readHandoff(filepath.Join(p.Handoff, "admission.jws"))
	if err != nil {
		return
	}
	claims, err := CheckAdmission(raw, p.InstanceKey, self)
	if err != nil {
		// Another pod's, another boot's, another key's or a forged admission is ignored.
		if p.State.AdmissionID == "" {
			p.Logf("admission ignored: %v", err)
		}
		return
	}
	if claims.AdmissionID != p.State.AdmissionID {
		p.Logf("admitted: %s", claims.AdmissionID)
		p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission, p.State.Passes = claims.AdmissionID, string(raw), true, 0
	}
}

// issue writes a lease that is valid for V from now; ok or inconclusive.
func (p *Probe) issue(state string, now uint64) {
	nonce := make([]byte, 24)
	_, _ = rand.Read(nonce)
	// A new nonce: the tolerance of the guard's cache starts again for this renewal.
	p.State.PreviousNonce, p.State.Nonce, p.State.PreviousSinceNs = p.State.Nonce, base64.RawURLEncoding.EncodeToString(nonce), 0
	p.writeLease(lease.Lease{
		State: state, PodUID: p.PodUID, BootID: p.State.BootID, AdmissionID: p.State.AdmissionID,
		IssuedBoottimeNs: now, ExpiresBoottimeNs: now + uint64(lease.Validity), Nonce: p.State.Nonce,
		Capabilities: p.State.Proven, IssuedAt: p.WallClock().UTC().Format(time.RFC3339),
	})
	p.save()
}

// withdraw replaces the lease by one that no reader accepts (its state), keeping the evidence visible.
func (p *Probe) withdraw(state string) {
	if p.State.AdmissionID == "" {
		p.removeLease()
	} else {
		now, _ := p.Boottime()
		p.writeLease(lease.Lease{
			State: state, PodUID: p.PodUID, BootID: p.State.BootID, AdmissionID: p.State.AdmissionID,
			IssuedBoottimeNs: now, ExpiresBoottimeNs: now + uint64(lease.Validity), Nonce: base64.RawURLEncoding.EncodeToString(make([]byte, 24)),
			Capabilities: p.State.Proven, IssuedAt: p.WallClock().UTC().Format(time.RFC3339),
		})
	}
	p.save()
}

func (p *Probe) writeLease(l lease.Lease) {
	data, _ := json.Marshal(l)
	if err := writeSynced(p.leaseFile(), data, 0o644); err != nil {
		// The previous lease then expires by itself within V.
		p.Logf("lease not written: %v", err)
	}
}

func (p *Probe) removeLease() {
	if err := os.Remove(p.leaseFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
		p.Logf("lease not removed: %v", err)
	}
}

func (p *Probe) save() {
	data, _ := json.Marshal(p.State)
	if err := writeSynced(p.stateFile(), data, 0o644); err != nil {
		p.Logf("state not saved: %v", err)
	}
}

// writeSynced replaces path atomically and durably: a fresh exclusive temporary (never an existing name, which could
// be a planted symlink in a shared directory), fsync, rename over the target (which replaces a symlink rather than
// following it), fsync the directory.
func writeSynced(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	if _, err := f.Write(data); err != nil {
		f.Close()
		return err
	}
	if err := f.Chmod(mode); err != nil {
		f.Close()
		return err
	}
	if err := f.Sync(); err != nil {
		f.Close()
		return err
	}
	if err := f.Close(); err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	if dir, err := os.Open(filepath.Dir(path)); err == nil {
		_ = dir.Sync()
		dir.Close()
	}
	return nil
}

// readHandoff reads a file the agent wrote: only a regular file, never through a symlink, never blocking on a FIFO.
func readHandoff(path string) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > 64<<10 {
		return nil, errors.New("not a regular file of at most 64 KiB")
	}
	return io.ReadAll(io.LimitReader(f, 64<<10))
}
