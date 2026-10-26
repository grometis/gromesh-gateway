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
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

// Timing of agent-protocol-v2 (B §3.5.3): period P, round T, inconclusive tolerance I, guard-missing backoff.
const (
	Period            = 15 * time.Second
	RoundBudget       = 3 * time.Second
	InconclusiveLimit = 5 * time.Minute
	CanaryNotFound    = 60 * time.Second
	BackoffFirst      = 30 * time.Second
	BackoffMax        = 5 * time.Minute
)

// Canary results of GET /.gromesh/guard/current.
type CanaryResult struct {
	// Unreachable: no connection (Kong not running yet, or stopped).
	Unreachable bool
	Status      int
	Nonce       string
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

	key   ed25519.PrivateKey
	State Persisted
}

// Persisted survives container and node restarts (the volume is on disk), violation included.
type Persisted struct {
	State       string `json:"state"`
	BootID      string `json:"bootId"`
	AdmissionID string `json:"admissionId,omitempty"`
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

func (p *Probe) leaseFile() string { return filepath.Join(p.Dir, "lease.json") }
func (p *Probe) stateFile() string { return filepath.Join(p.Dir, "probe-state.json") }

// Open loads the persisted state and the probe key (created once, never leaving Dir) and publishes the public key.
func (p *Probe) Open() error {
	if err := os.MkdirAll(p.Dir, 0o755); err != nil {
		return err
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
	} else if err != nil {
		return err
	}
	if len(seed) != ed25519.SeedSize {
		return errors.New("probe key corrupt")
	}
	p.key = ed25519.NewKeyFromSeed(seed)
	if data, err := os.ReadFile(p.stateFile()); err == nil {
		if err := json.Unmarshal(data, &p.State); err != nil {
			// A corrupt state is never read as clean: no lease until a new conclusive start.
			p.State = Persisted{State: "no-proof"}
		}
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if p.State.State == "" {
		p.State.State = "awaiting-admission"
	}
	return writeSynced(filepath.Join(p.Handoff, "probe.pub"), []byte(p.PublicKey()), 0o644)
}

func (p *Probe) PublicKey() string { return base64.RawURLEncoding.EncodeToString(p.key.Public().(ed25519.PublicKey)) }

// Round is one period: identity, admission, capabilities, then the lease.
func (p *Probe) Round(ctx context.Context) {
	now, err := p.Boottime()
	if err != nil {
		p.Logf("CLOCK_BOOTTIME unreadable: %v", err)
		p.withdraw("no-proof")
		return
	}
	boot := p.BootID()
	if p.State.BootID != boot {
		// A new boot: every lease and admission of the previous one is void; a violation is not.
		p.Logf("boot %s (was %q): a new admission is needed", boot, p.State.BootID)
		p.State = Persisted{State: "awaiting-admission", BootID: boot, Violated: p.State.Violated}
	}
	p.readAdmission(boot)
	if p.State.AdmissionID == "" {
		p.State.State = "awaiting-admission"
		p.removeLease()
		p.save()
		return
	}

	verdict := Round(ctx, p.Config, p.Network, RoundBudget, func(capability string) {
		// Written as soon as a forbidden target answers, before the round ends.
		p.violate([]string{capability}, now)
	})
	p.State.Proven, p.State.Failures = verdict.Proven, verdict.Failures
	if len(verdict.Violated) > 0 {
		p.violate(verdict.Violated, now)
		return
	}
	if len(p.State.Violated) > 0 {
		// Only a signed release (task N2-D3) ends a violation; a pass changes nothing.
		p.violate(nil, now)
		return
	}
	if len(verdict.Inconclusive) > 0 {
		p.State.Passes = 0
		switch p.State.State {
		case "ok", "verifying", "kong-unavailable", "inconclusive":
			if p.State.LastConclusiveNs != 0 && now-p.State.LastConclusiveNs < uint64(InconclusiveLimit) {
				p.State.State = "inconclusive"
				p.issue("inconclusive", now)
				return
			}
		}
		if p.State.State != "awaiting-admission" {
			p.State.State = "no-proof"
		}
		p.withdraw(p.State.State)
		return
	}

	p.State.Passes++
	p.State.LastConclusiveNs = now
	switch p.State.State {
	case "awaiting-admission":
		p.State.State = "verifying"
	case "no-proof":
		if p.State.Passes < 2 && !p.State.FreshAdmission {
			p.withdraw("no-proof")
			return
		}
		p.State.State = "verifying"
	case "guard-missing":
		if now < p.State.RetryAtNs {
			p.withdraw("guard-missing")
			return
		}
		p.State.State = "verifying"
	case "inconclusive":
		p.State.State = "ok"
	}
	p.State.FreshAdmission = false
	p.issue("ok", now)
}

// CanaryStep checks the guard: every second while verifying, and once per round otherwise.
func (p *Probe) CanaryStep(ctx context.Context) {
	switch p.State.State {
	case "verifying", "ok", "kong-unavailable":
	default:
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
	case r.Status == 204 && r.Nonce != "" && (r.Nonce == p.State.Nonce || r.Nonce == p.State.PreviousNonce):
		p.State.State, p.State.NotFoundSinceNs, p.State.BackoffNs = "ok", 0, 0
	case r.Status == 404:
		if p.State.NotFoundSinceNs == 0 {
			p.State.NotFoundSinceNs = now
		}
		if now-p.State.NotFoundSinceNs > uint64(CanaryNotFound) {
			p.guardMissing(now, "canary route absent for more than 60 s")
			return
		}
		if p.State.State == "kong-unavailable" {
			p.State.State = "verifying"
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
	p.State.State, p.State.BackoffNs, p.State.RetryAtNs, p.State.NotFoundSinceNs = "guard-missing", backoff, now+backoff, 0
	p.withdraw("guard-missing")
}

func (p *Probe) violate(capabilities []string, now uint64) {
	seen := map[string]bool{}
	for _, c := range p.State.Violated {
		seen[c] = true
	}
	for _, c := range capabilities {
		if !seen[c] {
			p.State.Violated = append(p.State.Violated, c)
			seen[c] = true
		}
	}
	if p.State.State != "violation" {
		p.Logf("violation of %v: containment", p.State.Violated)
	}
	p.State.State, p.State.Passes = "violation", 0
	p.withdraw("violation")
}

func (p *Probe) readAdmission(boot string) {
	raw, err := os.ReadFile(filepath.Join(p.Handoff, "admission.jws"))
	if err != nil {
		return
	}
	claims, err := CheckAdmission(raw, p.InstanceKey, Identity{ClusterID: p.ClusterID, PodUID: p.PodUID, BootID: boot, PublicKey: p.key.Public().(ed25519.PublicKey)})
	if err != nil {
		// Another pod's, another boot's, another key's or a forged admission is ignored.
		if p.State.AdmissionID == "" {
			p.Logf("admission ignored: %v", err)
		}
		return
	}
	if claims.AdmissionID != p.State.AdmissionID {
		p.Logf("admitted: %s", claims.AdmissionID)
		p.State.AdmissionID, p.State.FreshAdmission, p.State.Passes = claims.AdmissionID, true, 0
	}
}

// issue writes a lease that is valid for V from now; ok or inconclusive.
func (p *Probe) issue(state string, now uint64) {
	nonce := make([]byte, 24)
	_, _ = rand.Read(nonce)
	p.State.PreviousNonce, p.State.Nonce = p.State.Nonce, base64.RawURLEncoding.EncodeToString(nonce)
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

// writeSynced replaces path atomically and durably: write, fsync, rename, fsync the directory.
func writeSynced(path string, data []byte, mode os.FileMode) error {
	tmp := path + ".tmp"
	f, err := os.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_TRUNC, mode)
	if err != nil {
		return err
	}
	if _, err := f.Write(data); err != nil {
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
