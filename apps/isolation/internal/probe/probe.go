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
	"slices"
	"sync"
	"time"

	"io"
	"syscall"

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
	Dir       string
	Handoff   string
	ClusterID string
	PodUID    string
	// TrustSet is read again every round: an admission whose kid leaves the set stops counting at the next one.
	TrustSet  func() (TrustSet, error)
	Config    Config
	Network   Network
	Canary    func(ctx context.Context) CanaryResult
	BootID    func() string
	Boottime  func() (uint64, error)
	WallClock func() time.Time
	Logf      func(format string, args ...any)

	key ed25519.PrivateKey
	// mu guards State: the canary runs every second beside a round, which holds it only outside its network phase.
	mu sync.Mutex
	// gen changes with every lease written or withdrawn: a canary answer about an older lease is discarded.
	gen   uint64
	trust TrustSet
	// trustErr is logged once per change, not every round.
	trustErr string
	// releases are the valid confirmed-violation releases the agent handed over this round.
	releases []ReleaseClaims
	// unsaved: the last save failed, so the state on disk is behind; nothing is exposed or acked until one succeeds.
	unsaved bool
	// inconclusive are the capabilities the last round could not prove.
	inconclusive []string
	queue        []queued
	queueBytes   int64
	nextOrder    uint64
	// exposed maps each outbox name to the queued report written there (names are seqs, reused across admissions).
	exposed map[string]uint64
	// terminated: the final report is out; no round may report or serve after it.
	terminated bool
	State      Persisted
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
	// LeaseExpiresNs is when the last lease that readers accept expires (0: none out).
	LeaseExpiresNs uint64 `json:"leaseExpiresNs"`
	Chain          Chain  `json:"chain"`
	// ClosedAdmissions ended with a final report: never adopted or served again.
	ClosedAdmissions []string `json:"closedAdmissions,omitempty"`
	// StaleReleases were already handed over before the current violation (or are another pod's); UsedReleases ended
	// one. Neither ends a violation: a release counts only once, and only if it arrived after the violation.
	StaleReleases []string `json:"staleReleases,omitempty"`
	UsedReleases  []string `json:"usedReleases,omitempty"`
	// Detection counts the rounds' detections (a forbidden target answered), written in the latch with each one;
	// ReportedDetection is the last one a saved violation report carried. While one is pending, the next violation
	// report moves Chain.ViolationSeq and no release ends the violation.
	Detection         uint64 `json:"detection,omitempty"`
	ReportedDetection uint64 `json:"reportedDetection,omitempty"`
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
	if err := p.loadQueue(); err != nil {
		return err
	}
	if c := p.State.Chain; c.Closed && c.AdmissionID != "" && !slices.Contains(p.State.ClosedAdmissions, c.AdmissionID) {
		// The final report was saved but not yet the admission's end (a crash in between): it ends here.
		p.State.ClosedAdmissions = keepLast(append(p.State.ClosedAdmissions, c.AdmissionID), 64)
	}
	// The latch is the first thing a violation writes: a crash after it cannot lose the violation, nor a detection
	// (the same capability again included) whose report the state never saved.
	if data, err := os.ReadFile(p.violationFile()); err == nil {
		var l latch
		if json.Unmarshal(data, &l) != nil || len(l.Violated) == 0 || l.Detection == 0 {
			l = latch{Violated: []string{"unknown"}, Detection: p.State.ReportedDetection + 1}
		}
		p.State.Violated = mergeUnique(p.State.Violated, l.Violated)
		p.State.Detection = max(p.State.Detection, l.Detection)
		p.State.State = "violation"
	} else if !errors.Is(err, os.ErrNotExist) {
		return err
	}
	if p.State.State == "" {
		p.State.State = "awaiting-admission"
	}
	// What was recovered from the queue and the latch is saved before any ack is relayed or report exposed: an ack
	// could otherwise remove the only copy of it. Until a save succeeds, neither happens (see saved).
	_ = p.save()
	return writeSynced(filepath.Join(p.Handoff, "probe.pub"), []byte(p.PublicKey()), 0o644)
}

// latch is the content of violation.json.
type latch struct {
	Violated  []string `json:"violated"`
	Detection uint64   `json:"detection"`
}

// detectionPending: a detection whose violation report is not saved yet.
func (p *Probe) detectionPending() bool { return p.State.Detection > p.State.ReportedDetection }

func (p *Probe) PublicKey() string { return b64.EncodeToString(p.publicKey()) }

func (p *Probe) publicKey() ed25519.PublicKey { return p.key.Public().(ed25519.PublicKey) }

// Round is one period: identity, admission, capabilities, then the lease and the round's report.
func (p *Probe) Round(ctx context.Context) {
	if !p.prepare() {
		return
	}
	verdict := Round(ctx, p.Config, p.Network, RoundBudget, func(capability string) {
		// Written as soon as a forbidden target answers, before the round ends.
		p.mu.Lock()
		defer p.mu.Unlock()
		if !p.terminated {
			p.violate([]string{capability})
		}
	})
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return
	}
	renew, now, ok := p.conclude(verdict)
	if !ok {
		return
	}
	// The round's report is durable before the lease it reports is published: no lease is out that no report counts.
	r := p.roundReport(now)
	if renew != "" {
		ms := uint64(lease.Validity / time.Millisecond)
		r.LeaseRemainingMs = &ms
	}
	err := errors.New("no report chain of the current admission")
	if p.State.AdmissionID != "" && p.State.Chain.AdmissionID == p.State.AdmissionID {
		err = p.emit(r)
	}
	if err != nil {
		p.Logf("round report: %v", err)
		p.unproven()
		return
	}
	if renew != "" {
		p.issue(renew, now)
	}
}

// unproven is what a failure to persist leads to: nothing is proven to the control plane, so nothing is served.
func (p *Probe) unproven() {
	if p.State.State != "violation" {
		p.State.State = "no-proof"
	}
	p.State.Passes, p.State.FreshAdmission = 0, false
	p.withdraw(p.State.State)
}

// prepare relays acks, closes a previous boot's chain, checks identity, admission and the current lease; false when
// no round is due (no admission).
func (p *Probe) prepare() bool {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return false
	}
	p.drainAcks()
	boot := p.BootID()
	p.closePreviousBoot(boot)
	p.syncOutbox()
	now, err := p.Boottime()
	if err != nil {
		p.Logf("CLOCK_BOOTTIME unreadable: %v", err)
		p.withdraw("no-proof")
		return false
	}
	trust, err := p.TrustSet()
	if err != nil {
		// No admission counts without a valid set: nothing is proven to the guard, whatever the state was.
		if err.Error() != p.trustErr {
			p.Logf("%v: no lease will be issued", err)
		}
		p.trustErr = err.Error()
		if serving(p.State.State) {
			p.State.State, p.State.Passes, p.State.FreshAdmission = "no-proof", 0, false
		}
		p.withdraw(p.State.State)
		return false
	}
	p.trust, p.trustErr = trust, ""
	if p.State.BootID != boot {
		// A new boot: every lease and admission of the previous one is void; a violation or a corrupt state is not, nor
		// the report chain and what ended or released before.
		p.Logf("boot %s (was %q): a new admission is needed", boot, p.State.BootID)
		state := "awaiting-admission"
		if p.State.Corrupt {
			state = "no-proof"
		}
		if len(p.State.Violated) > 0 {
			state = "violation"
		}
		old := p.State
		p.State = Persisted{State: state, BootID: boot, Violated: old.Violated, Corrupt: old.Corrupt, Chain: old.Chain,
			ClosedAdmissions: old.ClosedAdmissions, StaleReleases: old.StaleReleases, UsedReleases: old.UsedReleases,
			Detection: old.Detection, ReportedDetection: old.ReportedDetection}
	}
	p.loadReleases()
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

// closePreviousBoot sends the node-reboot report of an admission of an earlier boot whose chain is still open. A new
// boot id proves that every process of that boot, Kong included, has ended.
func (p *Probe) closePreviousBoot(boot string) {
	c := p.State.Chain
	if !uuid(boot) || c.AdmissionID == "" || c.Closed || c.BootID == boot {
		return
	}
	confirmed := true
	r := Report{State: p.State.State, FailedCapabilities: p.failedCapabilities(), Challenge: p.challenge(), Final: true, FinalReason: "node-reboot", KongStopConfirmed: &confirmed}
	if p.State.BootID != c.BootID {
		// The state already moved on to another boot: what the admission ended in is not known.
		r.State, r.FailedCapabilities = "no-proof", nil
		if len(p.State.Violated) > 0 {
			r.State, r.FailedCapabilities = "violation", p.failedCapabilities()
		}
	}
	if err := p.emit(r); err != nil && !p.State.Chain.Closed {
		// Retried every round: until it is out, no admission of the new boot is adopted.
		p.Logf("node-reboot report of %s: %v", c.AdmissionID, err)
		return
	}
	p.State.ClosedAdmissions = keepLast(append(p.State.ClosedAdmissions, c.AdmissionID), 64)
	p.Logf("node-reboot report of admission %s (boot %s) queued", c.AdmissionID, c.BootID)
	p.save()
}

// Terminate is the pod's stop signal: the final pod-terminated report of the current admission, which then never
// serves again, or of the admission the handoff holds that was not adopted yet (closeUnadopted). kongStopped is what
// the probe could confirm about Kong (see KongStopConfirmed). probe.pub goes last: the agent then asks for nothing.
// Without a confirmed Kong stop only this container is known to stop (a restart of the probe alone; native sidecars
// are signalled after Kong exits): nothing is closed, the chain resumes after the restart from the persisted state,
// and nothing is served until a new proof. A pod that really ends this way leaves its admission open (residual).
func (p *Probe) Terminate(kongStopped bool) {
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.terminated {
		return
	}
	p.terminated = true
	defer func() {
		if err := os.Remove(filepath.Join(p.Handoff, "probe.pub")); err != nil && !errors.Is(err, os.ErrNotExist) {
			p.Logf("probe.pub not removed: %v", err)
		}
	}()
	if !kongStopped {
		p.Logf("stop without a confirmed Kong stop: the admission stays open and nothing is served until a new proof")
		if p.State.State != "violation" {
			p.State.State = "no-proof"
		}
		p.State.Passes, p.State.FreshAdmission = 0, false
		p.removeLease()
		p.save()
		return
	}
	p.closeUnadopted()
	c := p.State.Chain
	if c.AdmissionID != "" && !c.Closed && c.BootID == p.State.BootID {
		now, err := p.Boottime()
		r := p.roundReport(now)
		if err != nil {
			r.LeaseRemainingMs = nil
		}
		r.Final, r.FinalReason, r.KongStopConfirmed = true, "pod-terminated", &kongStopped
		if err := p.emit(r); err != nil {
			p.Logf("final report: %v", err)
		}
		// Queued even if its seq was not saved (the queue is then the chain's head): the admission ends either way.
		if p.State.Chain.Closed {
			p.State.ClosedAdmissions = keepLast(append(p.State.ClosedAdmissions, c.AdmissionID), 64)
			p.Logf("final report of admission %s queued (kongStopConfirmed %v)", c.AdmissionID, kongStopped)
		}
	}
	p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission = "", "", false
	p.removeLease()
	p.save()
}

// closeUnadopted starts the chain of the admission the handoff holds for this cluster, pod, boot and key when no chain
// of this boot is open: Terminate then makes its seq 1 the final report. A lease is issued only after the report of
// its round is durable, so a chain that starts with its final report proves the admission never authorized traffic.
func (p *Probe) closeUnadopted() {
	boot := p.BootID()
	// Only on the boot the state was last prepared for, or before the first preparation of a fresh state: a chain of an
	// earlier boot still open is never overwritten, nor a state of an earlier boot reported as this one's.
	if c := p.State.Chain; !uuid(boot) || (p.State.BootID != "" && boot != p.State.BootID) || (c.AdmissionID != "" && !c.Closed) {
		return
	}
	trust, err := p.TrustSet()
	if err != nil {
		return
	}
	raw, err := readHandoff(filepath.Join(p.Handoff, "admission.jws"), 64<<10)
	if err != nil {
		return
	}
	self := Identity{ClusterID: p.ClusterID, PodUID: p.PodUID, BootID: boot, PublicKey: p.publicKey()}
	claims, _, err := CheckAdmission(raw, trust, self)
	if err != nil || p.ended(claims.AdmissionID) {
		return
	}
	p.Logf("admission %s closed before adoption: it never authorized traffic", claims.AdmissionID)
	p.State.BootID = boot
	p.State.Chain = Chain{AdmissionID: claims.AdmissionID, BootID: boot, ProbeKey: p.PublicKey()}
}

// loadReleases reads the releases the agent handed over: only valid confirmed-violation releases of this cluster count.
// Every release seen while there is no violation is stale for the next one.
func (p *Probe) loadReleases() {
	p.releases = nil
	raw, err := readHandoff(filepath.Join(p.Handoff, "releases.json"), 1<<20)
	if err == nil {
		var doc struct {
			Items []json.RawMessage `json:"items"`
		}
		fields, ferr := strictRaw(raw, []string{"items"}, nil)
		if ferr == nil && json.Unmarshal(fields["items"], &doc.Items) == nil {
			for _, item := range doc.Items {
				if c, err := CheckRelease(item, p.trust, p.ClusterID); err == nil && c.Kind == "confirmed-violation" {
					p.releases = append(p.releases, c)
				}
			}
		}
	}
	if len(p.State.Violated) == 0 {
		for _, r := range p.releases {
			p.State.StaleReleases = keepLast(mergeUnique(p.State.StaleReleases, []string{r.PendencyID}), 256)
		}
	}
}

// release returns a release that may end the current violation: valid, confirmed-violation (loadReleases keeps no
// other kind), arrived after it, never used before, and covering it: it names the current admission through a seq at
// least the report of the chain's last detecting round. A release kept by the agent from another pendency, or from
// before a later detection, does not.
func (p *Probe) release() string {
	c := p.State.Chain
	if c.AdmissionID == "" || c.AdmissionID != p.State.AdmissionID || c.ViolationSeq == 0 || p.detectionPending() {
		// The chain has not reported this violation (a detection, or a violation carried from an earlier admission) yet:
		// no release can cover it.
		return ""
	}
	for _, r := range p.releases {
		if slices.Contains(p.State.StaleReleases, r.PendencyID) || slices.Contains(p.State.UsedReleases, r.PendencyID) {
			continue
		}
		if slices.ContainsFunc(r.Admissions, func(a ReleasedAdmission) bool {
			return a.AdmissionID == c.AdmissionID && a.ThroughSeq >= c.ViolationSeq
		}) {
			return r.PendencyID
		}
	}
	return ""
}

func keepLast(s []string, n int) []string {
	if len(s) > n {
		return append([]string{}, s[len(s)-n:]...)
	}
	return s
}

// conclude turns a round's verdict into the state; a lease it withdraws is withdrawn at once, one it renews is returned
// (ok or inconclusive) for Round to issue once the round's report is durable. ok is false when no report is due.
func (p *Probe) conclude(verdict Verdict) (renew string, now uint64, ok bool) {
	now, err := p.Boottime()
	if err != nil {
		p.withdraw("no-proof")
		return "", 0, false
	}
	p.State.Proven, p.State.Failures, p.inconclusive = verdict.Proven, verdict.Failures, verdict.Inconclusive
	p.State.LastRoundConclusive = len(verdict.Violated) == 0 && len(verdict.Inconclusive) == 0
	if len(verdict.Violated) > 0 {
		p.violate(verdict.Violated)
		return "", now, true
	}
	if len(p.State.Violated) > 0 {
		// Only a valid signed release that arrived after the violation, with a conclusive pass, ends it.
		id := p.release()
		if id == "" || !p.State.LastRoundConclusive || p.queueFull() {
			p.violate(nil)
			return "", now, true
		}
		// The latch goes first: a crash before the state is saved finds the violation still in the state, and the
		// release still unused.
		if err := os.Remove(p.violationFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
			p.Logf("violation latch not removed (%v): still contained", err)
			p.violate(nil)
			return "", now, true
		}
		p.Logf("violation of %v released by pendency %s: verifying", p.State.Violated, id)
		p.State.UsedReleases = keepLast(append(p.State.UsedReleases, id), 256)
		p.State.Violated, p.State.Passes, p.State.LastConclusiveNs, p.State.FreshAdmission = nil, 1, now, false
		p.verify()
		return "ok", now, true
	}
	if p.queueFull() {
		// The reports cannot be kept any more: nothing is proven to the control plane, so nothing is served.
		p.Logf("report queue full: no-proof")
		if p.State.State != "awaiting-admission" {
			p.State.State = "no-proof"
		}
		p.State.Passes = 0
		p.withdraw(p.State.State)
		return "", now, true
	}
	if len(verdict.Inconclusive) > 0 {
		p.State.Passes = 0
		if p.State.State == "guard-missing" {
			p.withdraw("guard-missing")
			return "", now, true
		}
		if serving(p.State.State) && p.State.LastConclusiveNs != 0 && now-p.State.LastConclusiveNs < uint64(InconclusiveLimit) {
			if p.State.State == "ok" {
				p.State.State = "inconclusive"
			}
			return "inconclusive", now, true
		}
		if p.State.State != "awaiting-admission" {
			p.State.State = "no-proof"
		}
		p.withdraw(p.State.State)
		return "", now, true
	}

	p.State.Passes++
	p.State.LastConclusiveNs = now
	if now < p.State.RetryAtNs {
		// The guard-missing backoff holds whatever the rounds say.
		p.withdraw(p.State.State)
		return "", now, true
	}
	switch p.State.State {
	case "awaiting-admission", "guard-missing":
		p.verify()
	case "no-proof":
		if p.State.Passes < 2 && !(p.State.FreshAdmission && !p.State.Corrupt) {
			p.withdraw("no-proof")
			return "", now, true
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
	return "ok", now, true
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
	// The HTTP call runs without the lock: a slow canary never delays a violation or a round.
	p.mu.Lock()
	gen, active := p.gen, serving(p.State.State)
	p.mu.Unlock()
	if !active {
		return
	}
	r := p.Canary(ctx)
	p.mu.Lock()
	defer p.mu.Unlock()
	if p.gen != gen || !serving(p.State.State) {
		return
	}
	now, err := p.Boottime()
	if err != nil {
		return
	}
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
	if len(capabilities) > 0 {
		// A round that detected a failure: its report moves Chain.ViolationSeq, the latched rounds after it do not.
		p.State.Detection++
	}
	// The latch first, with the detection: a crash between the writes below can never lose the violation, nor make a
	// repeated detection of a latched capability look already reported.
	data, _ := json.Marshal(latch{Violated: p.State.Violated, Detection: max(p.State.Detection, 1)})
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
		if claims, _, err := CheckAdmission([]byte(p.State.AdmissionJWS), p.trust, self); err != nil || claims.AdmissionID != p.State.AdmissionID {
			p.Logf("stored admission no longer valid (%v): dropped", err)
			p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission = "", "", false
		}
	} else if p.State.AdmissionID != "" {
		p.State.AdmissionID, p.State.FreshAdmission = "", false
	}
	if p.ended(p.State.AdmissionID) {
		p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission = "", "", false
	}
	raw, err := readHandoff(filepath.Join(p.Handoff, "admission.jws"), 64<<10)
	if err != nil {
		return
	}
	claims, kid, err := CheckAdmission(raw, p.trust, self)
	if err == nil && p.ended(claims.AdmissionID) {
		err = errors.New("admission already ended by a final report")
	}
	if c := p.State.Chain; err == nil && c.AdmissionID != claims.AdmissionID && c.AdmissionID != "" && !c.Closed && c.BootID != boot {
		err = errors.New("the previous boot's admission is not closed yet")
	}
	if err != nil {
		// Another pod's, another boot's, another key's, a forged or an ended admission is ignored.
		if p.State.AdmissionID == "" {
			p.Logf("admission ignored: %v", err)
		}
		return
	}
	if claims.AdmissionID != p.State.AdmissionID {
		p.Logf("admitted: %s (instance key %s)", claims.AdmissionID, kid)
		p.State.AdmissionID, p.State.AdmissionJWS, p.State.FreshAdmission, p.State.Passes = claims.AdmissionID, string(raw), true, 0
	}
	if p.State.Chain.AdmissionID != claims.AdmissionID {
		// The admission's own chain, from seq 1; an admission adopted again (its kid back in the set) continues its own.
		p.State.Chain = Chain{AdmissionID: claims.AdmissionID, BootID: boot, ProbeKey: p.PublicKey()}
	}
}

// ended: the admission's final report is out (or queued): it is never adopted or served again.
func (p *Probe) ended(admission string) bool {
	c := p.State.Chain
	return admission != "" && (slices.Contains(p.State.ClosedAdmissions, admission) || (c.Closed && c.AdmissionID == admission))
}

// issue writes a lease that is valid for V from now; ok or inconclusive. The state that knows its nonce is saved
// first: a lease the state on disk does not name is never accepted after a restart.
func (p *Probe) issue(state string, now uint64) {
	nonce := make([]byte, 24)
	_, _ = rand.Read(nonce)
	// A new nonce: the tolerance of the guard's cache starts again for this renewal.
	p.State.PreviousNonce, p.State.Nonce, p.State.PreviousSinceNs = p.State.Nonce, base64.RawURLEncoding.EncodeToString(nonce), 0
	p.State.LeaseExpiresNs = now + uint64(lease.Validity)
	if err := p.save(); err != nil {
		p.unproven()
		return
	}
	p.writeLease(lease.Lease{
		State: state, PodUID: p.PodUID, BootID: p.State.BootID, AdmissionID: p.State.AdmissionID,
		IssuedBoottimeNs: now, ExpiresBoottimeNs: now + uint64(lease.Validity), Nonce: p.State.Nonce,
		Capabilities: p.State.Proven, IssuedAt: p.WallClock().UTC().Format(time.RFC3339),
	})
}

// withdraw replaces the lease by one that no reader accepts (its state), keeping the evidence visible.
func (p *Probe) withdraw(state string) {
	p.State.LeaseExpiresNs = 0
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
	p.gen++
	data, _ := json.Marshal(l)
	if err := writeSynced(p.leaseFile(), data, 0o644); err != nil {
		// The previous lease then expires by itself within V.
		p.Logf("lease not written: %v", err)
	}
}

func (p *Probe) removeLease() {
	p.gen++
	p.State.LeaseExpiresNs = 0
	if err := os.Remove(p.leaseFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
		p.Logf("lease not removed: %v", err)
	}
}

// save writes the state durably. On failure the state on disk is behind the one in memory (a report's seq
// included) until a later save succeeds: meanwhile no report is exposed and no acked report removed (see saved).
func (p *Probe) save() error {
	data, _ := json.Marshal(p.State)
	if err := writeSynced(p.stateFile(), data, 0o644); err != nil {
		p.Logf("state not saved: %v", err)
		p.unsaved = true
		return err
	}
	p.unsaved = false
	return nil
}

// saved is true once the state on disk is the one in memory, trying again a save that failed.
func (p *Probe) saved() bool {
	return !p.unsaved || p.save() == nil
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
func readHandoff(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, fmt.Errorf("not a regular file of at most %d bytes", limit)
	}
	return io.ReadAll(io.LimitReader(f, limit))
}
