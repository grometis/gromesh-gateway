package probe

import (
	"context"
	"encoding/json"
	"fmt"
	"net"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"testing"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

type outboxed struct {
	name    string
	report  Report
	payload []byte
}

// outbox is what the agent finds in handoff/outbox, in name order, each report verified with the probe key.
func (w *world) outbox() []outboxed {
	w.t.Helper()
	dir := filepath.Join(w.p.Handoff, "outbox")
	entries, _ := os.ReadDir(dir)
	var out []outboxed
	for _, e := range entries {
		raw, err := os.ReadFile(filepath.Join(dir, e.Name()))
		if err != nil {
			w.t.Fatal(err)
		}
		payload, err := VerifyReport(raw, w.p.publicKey())
		if err != nil {
			w.t.Fatalf("%s: %v", e.Name(), err)
		}
		r, err := ParseReport(payload)
		if err != nil {
			w.t.Fatalf("%s: %v", e.Name(), err)
		}
		if e.Name() != fmt.Sprintf("%020d.jws", r.Seq) {
			w.t.Fatalf("%s holds seq %d", e.Name(), r.Seq)
		}
		out = append(out, outboxed{e.Name(), r, payload})
	}
	return out
}

// chained checks seq without gaps and each prevDigest as the sha256 of the previous payload bytes.
func chained(t *testing.T, reports []outboxed, first uint64, prev []byte) {
	t.Helper()
	for i, o := range reports {
		if o.report.Seq != first+uint64(i) {
			t.Fatalf("report %d has seq %d, want %d", i, o.report.Seq, first+uint64(i))
		}
		switch {
		case o.report.Seq == 1 && o.report.PrevDigest != nil:
			t.Fatal("seq 1 with a prevDigest")
		case o.report.Seq > 1 && (o.report.PrevDigest == nil || prev == nil || *o.report.PrevDigest != digest(prev)):
			t.Fatalf("seq %d: prevDigest does not hash the previous payload", o.report.Seq)
		}
		prev = o.payload
	}
}

func (w *world) handoff(name, content string) {
	w.t.Helper()
	if err := os.WriteFile(filepath.Join(w.p.Handoff, name), []byte(content), 0o644); err != nil {
		w.t.Fatal(err)
	}
}

func (w *world) ack(admission string, seq uint64) {
	w.handoff("acks.json", fmt.Sprintf(`{"admissionId":%q,"ackedSeq":%d}`, admission, seq))
}

const admissionID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad"

func TestOneSignedReportPerRoundChainedWithTheLatestChallenge(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.round()
	if len(w.outbox()) != 0 {
		t.Fatal("a report without an admission")
	}
	w.admit(nil)
	w.round()
	w.handoff("challenge", "Q2hhbGxlbmdlLXRlc3Qtb25seS0x")
	w.net.dns = false
	w.now += uint64(Period)
	w.round()
	w.handoff("challenge", "not a challenge")
	w.now += uint64(Period)
	w.round()
	reports := w.outbox()
	if len(reports) != 3 {
		t.Fatalf("%d reports for 3 rounds", len(reports))
	}
	chained(t, reports, 1, nil)
	first, second, third := reports[0].report, reports[1].report, reports[2].report
	if first.State != "verifying" || first.Challenge != nil || first.LeaseRemainingMs == nil || *first.LeaseRemainingMs != 33_000 || len(first.FailedCapabilities) != 0 {
		t.Fatalf("first report %+v", first)
	}
	if first.ClusterID != cluster || first.PodUID != pod || first.BootID != boot1 || first.AdmissionID != admissionID || first.Final {
		t.Fatalf("first report identity %+v", first)
	}
	if second.Challenge == nil || *second.Challenge != "Q2hhbGxlbmdlLXRlc3Qtb25seS0x" || !slices.Equal(second.FailedCapabilities, []string{"CAP-4"}) || second.State != "verifying" {
		t.Fatalf("second report %+v", second)
	}
	if third.Challenge != nil {
		t.Fatalf("a malformed challenge was relayed: %+v", third)
	}
}

func TestAcksDropOnlyThatAdmissionsReportsUpToAckedSeq(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	for range 3 {
		w.round()
	}
	w.ack("6a1f3c2e-0b7d-4c1a-9f10-0000000000ff", 3)
	w.round()
	if n := len(w.outbox()); n != 4 {
		t.Fatalf("another admission's ack removed reports: %d left", n)
	}
	for _, bad := range []string{`{"admissionId":"` + admissionID + `","ackedSeq":"2"}`, `{"admissionId":"` + admissionID + `","ackedSeq":2,"x":1}`, `{"admissionId":"` + admissionID + `","ackedSeq":2}{}`} {
		w.handoff("acks.json", bad)
		w.round()
	}
	if n := len(w.outbox()); n != 7 {
		t.Fatalf("a malformed ack removed reports: %d left", n)
	}
	w.ack(admissionID, 5)
	w.round()
	reports := w.outbox()
	if len(reports) != 3 || reports[0].report.Seq != 6 {
		t.Fatalf("after ack 5: %d reports from seq %d", len(reports), reports[0].report.Seq)
	}
	queued, _ := os.ReadDir(w.p.queueDir())
	if len(queued) != 3 {
		t.Fatalf("the queue keeps %d reports, the outbox 3", len(queued))
	}
}

func TestReportsSurviveARestartAndNeverRepeatASeq(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.round()
	w.p = w.probe(dir)
	w.round()
	// A crash after the report was queued but before the state counted it: the queue is the chain's head.
	var s Persisted
	data, _ := os.ReadFile(filepath.Join(w.p.Dir, "probe-state.json"))
	_ = json.Unmarshal(data, &s)
	s.Chain.Seq, s.Chain.LastDigest = 2, "sha256:"+strings.Repeat("0", 64)
	data, _ = json.Marshal(s)
	_ = os.WriteFile(filepath.Join(w.p.Dir, "probe-state.json"), data, 0o644)
	w.p = w.probe(dir)
	w.round()
	// And a state lost altogether.
	_ = os.WriteFile(filepath.Join(w.p.Dir, "probe-state.json"), []byte("{corrupt"), 0o644)
	w.p = w.probe(dir)
	w.round()
	w.round()
	reports := w.outbox()
	if len(reports) != 6 {
		t.Fatalf("%d reports", len(reports))
	}
	chained(t, reports, 1, nil)
}

func TestAFullQueueStopsRenewalUntilItDrains(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	w.p.queueBytes += QueueLimit
	w.now += uint64(Period)
	w.round()
	w.expect("no-proof", false)
	if n := len(w.outbox()); n != 1 {
		t.Fatalf("a full queue took %d reports", n)
	}
	w.p.queueBytes -= QueueLimit
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
	reports := w.outbox()
	chained(t, reports, 1, nil)
	if reports[1].report.State != "no-proof" || reports[2].report.State != "verifying" {
		t.Fatalf("states %s %s", reports[1].report.State, reports[2].report.State)
	}
}

func TestTheFinalReportEndsTheAdmission(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.p.Terminate(true)
	if w.leaseValid() == nil {
		t.Fatal("a lease outlived the final report")
	}
	w.round()
	reports := w.outbox()
	if len(reports) != 2 {
		t.Fatalf("%d reports", len(reports))
	}
	final := reports[1].report
	if !final.Final || final.FinalReason != "pod-terminated" || final.KongStopConfirmed == nil || !*final.KongStopConfirmed {
		t.Fatalf("final %+v", final)
	}
	// The probe container restarted (not the pod): the ended admission is never served again.
	w.p = w.probe(dir)
	w.round()
	w.round()
	w.expect("awaiting-admission", false)
	if n := len(w.outbox()); n != 2 {
		t.Fatalf("reports after the final: %d", n)
	}
	// An unconfirmed stop says so.
	w2 := newWorld(t, t.TempDir())
	w2.admit(nil)
	w2.round()
	w2.p.Terminate(false)
	if r := w2.outbox()[1].report; *r.KongStopConfirmed {
		t.Fatal("an unconfirmed stop reported as confirmed")
	}
}

func TestANodeRebootClosesThePreviousBootsChainBeforeTheNextOne(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.round()
	w.boot = boot2
	w.p = w.probe(dir)
	w.admit(func(c *AdmissionClaims) { c.AdmissionID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ae" })
	w.round()
	w.expect("verifying", true)
	reports := w.outbox()
	if len(reports) != 3 {
		t.Fatalf("%d reports in the outbox", len(reports))
	}
	chained(t, reports, 1, nil)
	final := reports[2].report
	if !final.Final || final.FinalReason != "node-reboot" || final.BootID != boot1 || final.AdmissionID != admissionID || !*final.KongStopConfirmed || final.LeaseRemainingMs != nil {
		t.Fatalf("node-reboot report %+v", final)
	}
	// The new admission's chain waits in the queue until the previous one is acknowledged.
	w.ack(admissionID, 3)
	w.round()
	reports = w.outbox()
	if len(reports) != 2 || reports[0].report.AdmissionID != "6a1f3c2e-0b7d-4c1a-9f10-0000000000ae" || reports[0].report.BootID != boot2 {
		t.Fatalf("new chain %+v", reports)
	}
	chained(t, reports, 1, nil)
}

func (w *world) releases(claims ...any) {
	w.t.Helper()
	var items []json.RawMessage
	for _, c := range claims {
		switch c := c.(type) {
		case []byte:
			items = append(items, c)
		default:
			items = append(items, signInstance(w.instKey, w.kid, TypRelease, c))
		}
	}
	data, _ := json.Marshal(map[string]any{"items": items})
	w.handoff("releases.json", string(data))
}

// covering is a confirmed-violation release of this cluster naming one admission through seq.
func covering(pendency, admission string, through uint64) ReleaseClaims {
	return ReleaseClaims{ClusterID: cluster, PendencyID: pendency, Kind: "confirmed-violation", ExpiresAt: "2026-10-26T12:15:00Z",
		Admissions: []ReleasedAdmission{{admission, through}}}
}

// The agent keeps valid releases of the same cluster it never handed over (another pod's pendency, or an earlier one
// of this pod) and shows them after a violation: only a release naming this admission through the violation's
// report ends it.
func TestOnlyAReleaseCoveringTheViolationsReportEndsIt(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	w.net.set("forbidden-CAP-2:80", true)
	w.round()
	w.net.set("forbidden-CAP-2:80", false)
	if w.p.State.Chain.ViolationSeq != 2 {
		t.Fatalf("violation seq %d after the violation's report", w.p.State.Chain.ViolationSeq)
	}
	for name, r := range map[string]ReleaseClaims{
		"another pod's admission": covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000e8", "6a1f3c2e-0b7d-4c1a-9f10-0000000000af", 40),
		"before this violation":   covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000e9", admissionID, 1),
		"covering no admission":   {ClusterID: cluster, PendencyID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ea", Kind: "confirmed-violation", ExpiresAt: "2026-10-26T12:15:00Z", Admissions: []ReleasedAdmission{}},
	} {
		w.releases(r)
		w.round()
		if w.p.State.State != "violation" || w.leaseValid() == nil {
			t.Fatalf("%s: the violation ended", name)
		}
	}
	// Reports that only carry the latch do not move the seq a release must cover; a restart does not either.
	w.p = w.probe(dir)
	w.round()
	if w.p.State.Chain.ViolationSeq != 2 || w.p.State.Chain.Seq != 6 {
		t.Fatalf("violation seq %d at seq %d", w.p.State.Chain.ViolationSeq, w.p.State.Chain.Seq)
	}
	w.releases(covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000eb", admissionID, 2))
	w.round()
	w.expect("verifying", true)
	// A new violation is new evidence: the release that covered seq 2 never covers it, used or not.
	w.net.set("forbidden-CAP-2:80", true)
	w.round()
	w.net.set("forbidden-CAP-2:80", false)
	if w.p.State.Chain.ViolationSeq != 8 {
		t.Fatalf("violation seq %d after the second violation's report", w.p.State.Chain.ViolationSeq)
	}
	w.releases(covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000ec", admissionID, 7))
	w.round()
	w.expect("violation", false)
	w.releases(covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000ed", admissionID, 8))
	w.round()
	w.expect("verifying", true)
}

func TestAReleaseEndsAViolationOnlyIfItArrivedAfterItAndOnlyOnce(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	release := func(id string) ReleaseClaims { return covering(id, admissionID, 5) }
	early := release("6a1f3c2e-0b7d-4c1a-9f10-0000000000e1")
	w.releases(early)
	w.admit(nil)
	w.round()
	w.net.set("forbidden-CAP-3:80", true)
	w.round()
	w.net.set("forbidden-CAP-3:80", false)
	w.round()
	w.expect("violation", false)
	// Not of this cluster, not typed as a release, another kind, signed outside the trust set: none counts.
	other, otherKid := instanceKey()
	w.releases(early,
		ReleaseClaims{ClusterID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000c2", PendencyID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000e2", Kind: "confirmed-violation", ExpiresAt: "2026-10-26T12:15:00Z", Admissions: []ReleasedAdmission{{admissionID, 5}}},
		signInstance(w.instKey, w.kid, TypAdmission, release("6a1f3c2e-0b7d-4c1a-9f10-0000000000e3")),
		ReleaseClaims{ClusterID: cluster, PendencyID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000e4", Kind: "unconfirmed-isolation", ExpiresAt: "2026-10-26T12:15:00Z", Admissions: []ReleasedAdmission{{admissionID, 5}}},
		signInstance(other, otherKid, TypRelease, release("6a1f3c2e-0b7d-4c1a-9f10-0000000000e5")))
	w.round()
	w.expect("violation", false)
	// A new valid release, but an inconclusive round: still contained.
	fresh := release("6a1f3c2e-0b7d-4c1a-9f10-0000000000e6")
	w.releases(early, fresh)
	w.net.dns = false
	w.round()
	w.expect("violation", false)
	w.net.dns = true
	w.p = w.probe(dir)
	w.round()
	w.expect("verifying", true)
	if _, err := os.Stat(w.p.violationFile()); err == nil {
		t.Fatal("the latch outlived the release")
	}
	// The next violation is not ended by the same release, even across a restart.
	w.net.set("forbidden-CAP-1:80", true)
	w.round()
	w.net.set("forbidden-CAP-1:80", false)
	w.p = w.probe(dir)
	w.round()
	w.round()
	w.expect("violation", false)
	states := []string{}
	for _, o := range w.outbox() {
		states = append(states, o.report.State)
		if o.report.State == "violation" && len(o.report.FailedCapabilities) == 0 {
			t.Fatal("a violation report without its capability")
		}
	}
	want := []string{"verifying", "violation", "violation", "violation", "violation", "verifying", "violation", "violation", "violation"}
	if !slices.Equal(states, want) {
		t.Fatalf("states %v, want %v", states, want)
	}
}

// The agent withholds the used release while the pod serves and hands it over again after the next violation.
func TestAUsedReleaseNeverEndsAnotherViolation(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.net.set("forbidden-CAP-3:80", true)
	w.round()
	w.net.set("forbidden-CAP-3:80", false)
	w.releases(covering("6a1f3c2e-0b7d-4c1a-9f10-0000000000e7", admissionID, 2))
	data, _ := os.ReadFile(filepath.Join(w.p.Handoff, "releases.json"))
	w.round()
	w.expect("verifying", true)
	_ = os.Remove(filepath.Join(w.p.Handoff, "releases.json"))
	w.net.set("forbidden-CAP-3:80", true)
	w.round()
	w.net.set("forbidden-CAP-3:80", false)
	w.handoff("releases.json", string(data))
	w.round()
	w.round()
	w.expect("violation", false)
}

func TestAHostileOutboxNeverReachesTheProbesOwnFiles(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	_ = os.Symlink(w.p.Dir, filepath.Join(w.p.Handoff, "outbox"))
	w.round()
	w.round()
	for _, name := range []string{"probe.key", "probe-state.json", "lease.json"} {
		if _, err := os.Stat(filepath.Join(w.p.Dir, name)); err != nil {
			t.Fatalf("%s: %v", name, err)
		}
	}
	if entries, _ := os.ReadDir(w.p.Dir); slices.ContainsFunc(entries, func(e os.DirEntry) bool { return queueName.MatchString(e.Name()) }) {
		t.Fatal("a report was written through the symlink")
	}
	// A symlink that stays inside the handoff is not followed either.
	_ = os.Remove(filepath.Join(w.p.Handoff, "outbox"))
	_ = os.Mkdir(filepath.Join(w.p.Handoff, "elsewhere"), 0o755)
	_ = os.Symlink("elsewhere", filepath.Join(w.p.Handoff, "outbox"))
	w.round()
	if entries, _ := os.ReadDir(filepath.Join(w.p.Handoff, "elsewhere")); len(entries) != 0 {
		t.Fatal("reports were written through a symlink inside the handoff")
	}
	// The agent leaves it alone again: every queued report is exposed, none lost.
	_ = os.Remove(filepath.Join(w.p.Handoff, "outbox"))
	_ = os.WriteFile(filepath.Join(w.p.Handoff, "planted"), nil, 0o644)
	w.round()
	chained(t, w.outbox(), 1, nil)
	if n := len(w.outbox()); n != 4 {
		t.Fatalf("%d reports", n)
	}
}

func TestKongStopIsConfirmedOnlyWhenRecordedAndNothingListens(t *testing.T) {
	dir := t.TempDir()
	state := filepath.Join(dir, "kong-state.json")
	listener, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		t.Fatal(err)
	}
	address := listener.Addr().String()
	write := func(s string) { _ = os.WriteFile(state, []byte(s), 0o644) }
	write(`{"heartbeatBoottimeNs":1,"nginx":"stopped","stopping":true}`)
	if KongStopConfirmed(state, address) {
		t.Fatal("confirmed while the proxy port still listens")
	}
	listener.Close()
	if !KongStopConfirmed(state, address) {
		t.Fatal("not confirmed after a recorded stop with the port closed")
	}
	for _, s := range []string{`{"nginx":"running","stopping":true}`, `{"nginx":"stopped","stopping":false}`, `{"nginx":"stopped","stopping":true,"pid":7}`, `garbage`} {
		write(s)
		if KongStopConfirmed(state, address) {
			t.Fatalf("confirmed from %s", s)
		}
	}
	write(`{"nginx":"stopped","stopping":true}`)
	link := filepath.Join(dir, "link.json")
	_ = os.Symlink(state, link)
	if KongStopConfirmed(link, address) || KongStopConfirmed(filepath.Join(dir, "missing"), address) {
		t.Fatal("confirmed through a symlink or without the state")
	}
}

// readOnly makes dir unwritable (a full or failing volume) until the returned function, or the test's end, restores it.
func readOnly(t *testing.T, dir string) func() {
	t.Helper()
	if err := os.Chmod(dir, 0o555); err != nil {
		t.Fatal(err)
	}
	restore := func() { _ = os.Chmod(dir, 0o755) }
	t.Cleanup(restore)
	return restore
}

// A report that cannot be queued is a round that proves nothing: the lease is not renewed without it.
func TestNoLeaseIsRenewedWithoutItsRoundsDurableReport(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	restore := readOnly(t, w.p.queueDir())
	for range 3 {
		w.now += uint64(Period)
		w.round()
		w.expect("no-proof", false)
	}
	if n := len(w.outbox()); n != 1 {
		t.Fatalf("%d reports", n)
	}
	restore()
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
	chained(t, w.outbox(), 1, nil)
	// Every lease out was counted by a report queued before it, which said the lease it reports.
	for _, o := range w.outbox()[1:] {
		if o.report.State == "verifying" && (o.report.LeaseRemainingMs == nil || *o.report.LeaseRemainingMs != 33_000) {
			t.Fatalf("report %d: lease remaining %v", o.report.Seq, o.report.LeaseRemainingMs)
		}
	}
}

// The probe crashes after the final report was saved and before the admission was recorded as ended, and restarts on
// the same boot with the admission still in the handoff: it never serves on it again.
func TestACrashAfterTheFinalReportNeverServesTheAdmissionAgain(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	// Terminate's first half: the final report, queued and saved with the chain closed.
	r := w.p.roundReport(w.now)
	confirmed := true
	r.Final, r.FinalReason, r.KongStopConfirmed = true, "pod-terminated", &confirmed
	if err := w.p.emit(r); err != nil {
		t.Fatal(err)
	}
	w.p = w.probe(dir)
	for range 2 {
		w.round()
		w.expect("awaiting-admission", false)
	}
	if !slices.Contains(w.p.State.ClosedAdmissions, admissionID) {
		t.Fatal("the closed chain was not recorded as an ended admission")
	}
	// The state lost too: the queued final report still ends it.
	_ = os.WriteFile(filepath.Join(w.p.Dir, "probe-state.json"), []byte("{corrupt"), 0o644)
	w.p = w.probe(dir)
	for range 3 {
		w.round()
		if w.leaseValid() == nil {
			t.Fatal("served on an ended admission after the state was lost")
		}
	}
	if n := len(w.outbox()); n != 2 {
		t.Fatalf("%d reports after the final", n)
	}
}

// The state cannot be saved after a report was queued: the report is not exposed, an ack cannot remove the queue's
// copy of the advance, and after a crash the seq is never reused with other content.
func TestAReportIsExposedOnlyOnceItsSeqIsSaved(t *testing.T) {
	dir := t.TempDir()
	w := newWorld(t, dir)
	w.admit(nil)
	w.round()
	seen := map[uint64][]byte{}
	look := func() {
		for _, o := range w.outbox() {
			if prev, ok := seen[o.report.Seq]; ok && string(prev) != string(o.payload) {
				t.Fatalf("seq %d exposed twice with different content", o.report.Seq)
			}
			seen[o.report.Seq] = o.payload
		}
	}
	look()
	before, _ := lease.Read(filepath.Join(w.p.Dir, "lease.json"))
	restore := readOnly(t, w.p.Dir)
	w.now += uint64(Period)
	w.round()
	look()
	if _, ok := seen[2]; ok {
		t.Fatal("a report was exposed while its seq was not saved")
	}
	// The volume refuses every write: the lease out is not renewed and expires by itself.
	if l, _ := lease.Read(filepath.Join(w.p.Dir, "lease.json")); serving(w.p.State.State) || l.Nonce != before.Nonce {
		t.Fatalf("state %s, lease renewed with an unsaved report", w.p.State.State)
	}
	// The agent acks seq 2 anyway, and the probe crashes right after relaying acks.
	w.ack(admissionID, 2)
	w.p.mu.Lock()
	w.p.drainAcks()
	w.p.mu.Unlock()
	restore()
	w.p = w.probe(dir)
	w.round()
	w.round()
	look()
	if w.p.State.Chain.Seq != 4 {
		t.Fatalf("chain at seq %d", w.p.State.Chain.Seq)
	}
}
