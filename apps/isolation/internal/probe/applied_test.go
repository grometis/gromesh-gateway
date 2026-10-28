package probe

import (
	"bytes"
	"context"
	"fmt"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

const (
	instance  = "6a1f3c2e-0b7d-4c1a-9f10-0000000000e1"
	hashA     = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
	hashB     = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
	deployTag = "sha256:1111111111111111111111111111111111111111111111111111111111111111"
)

func (w *world) applied(kongHash string, revision int64, mutate func(string) string) {
	w.t.Helper()
	doc := fmt.Sprintf(`{"instanceId":%q,"clusterId":%q,"nodeId":"node-1","podUid":%q,"epoch":1,"revision":%d,"hash":%q,"kongConfigHash":%q,"result":"applied","appliedAt":"2026-10-27T12:00:00.5Z"}`,
		instance, cluster, pod, revision, deployTag, kongHash)
	if mutate != nil {
		doc = mutate(doc)
	}
	w.handoff("applied.json", doc)
}

func (w *world) nonce() string {
	w.t.Helper()
	l, err := lease.Read(filepath.Join(w.p.Dir, "lease.json"))
	if err != nil {
		w.t.Fatal(err)
	}
	return l.Nonce
}

func (w *world) serve(hash string) {
	w.canary = CanaryResult{Status: 204, Nonce: w.nonce(), ConfigHash: hash}
	w.p.CanaryStep(context.Background())
}

// lastReport is the report of one more round.
func (w *world) lastReport() Report {
	w.t.Helper()
	w.round()
	reports := w.outbox()
	return reports[len(reports)-1].report
}

func ready(t *testing.T) *world {
	w := newWorld(t, t.TempDir())
	w.p.InstanceID = instance
	w.admit(nil)
	w.round()
	return w
}

// The probe copies applied.json into its signed report only in a round in which the canary served that file's Kong
// hash; the file alone proves nothing.
func TestTheAppliedRevisionIsReportedOnlyWhenTheCanaryServesIt(t *testing.T) {
	w := ready(t)
	// No canary answer yet: nothing about the configuration, and the payload is as before the evidence existed.
	w.now += uint64(Period)
	w.round()
	first := w.outbox()
	if r := first[len(first)-1]; r.report.ServedKongConfigHash != nil || bytes.Contains(r.payload, []byte("applied")) || bytes.Contains(r.payload, []byte("served")) {
		t.Fatalf("evidence without a canary answer: %s", r.payload)
	}
	w.applied(hashA, 7, nil)
	w.serve(hashA)
	w.expect("ok", true)
	w.now += uint64(Period)
	r := w.lastReport()
	if r.ServedKongConfigHash == nil || *r.ServedKongConfigHash != hashA || r.AppliedEpoch == nil || *r.AppliedEpoch != 1 ||
		*r.AppliedRevision != 7 || *r.AppliedHash != deployTag || *r.AppliedKongConfigHash != hashA {
		t.Fatalf("report %+v", r)
	}
	// The evidence is of the round: a round without a canary answer reports none.
	w.now += uint64(Period)
	if r := w.lastReport(); r.ServedKongConfigHash != nil || r.AppliedEpoch != nil {
		t.Fatalf("stale evidence: %+v", r)
	}
	// Negative control: an applied.json that names another Kong hash is never copied, and the pod is not ok.
	w.applied(hashB, 8, nil)
	w.serve(hashA)
	if w.p.State.State == "ok" {
		t.Fatal("ok while Kong serves another config than applied.json's")
	}
	w.now += uint64(Period)
	if r := w.lastReport(); r.ServedKongConfigHash == nil || *r.ServedKongConfigHash != hashA || r.AppliedEpoch != nil {
		t.Fatalf("report %+v", r)
	}
}

// An applied.json of another pod, cluster or instance, an invalid one, or any one without a configured instance counts
// as absent: readiness needs only the canary, and the report carries no applied revision.
func TestAnAppliedFileNotOfThisPodCountsAsAbsent(t *testing.T) {
	for name, mutate := range map[string]func(string) string{
		"another pod":      func(s string) string { return strings.Replace(s, pod, "6a1f3c2e-0b7d-4c1a-9f10-0000000000ff", 1) },
		"another cluster":  func(s string) string { return strings.Replace(s, cluster, "6a1f3c2e-0b7d-4c1a-9f10-0000000000c2", 1) },
		"another instance": func(s string) string { return strings.Replace(s, instance, "6a1f3c2e-0b7d-4c1a-9f10-0000000000e2", 1) },
		"unknown member":   func(s string) string { return strings.Replace(s, `"result"`, `"extra":1,"result"`, 1) },
		"not applied":      func(s string) string { return strings.Replace(s, `"result":"applied"`, `"result":"failed"`, 1) },
		"revision 0":       func(s string) string { return strings.Replace(s, `"revision":7`, `"revision":0`, 1) },
		"short Kong hash":  func(s string) string { return strings.Replace(s, hashB, "bbbb", 1) },
		"not JSON":         func(string) string { return "applied" },
		"no instance set":  func(s string) string { return s },
	} {
		w := ready(t)
		if name == "no instance set" {
			w.p.InstanceID = ""
		}
		w.applied(hashB, 7, mutate)
		w.serve(hashA)
		w.expect("ok", true)
		w.now += uint64(Period)
		if r := w.lastReport(); r.AppliedEpoch != nil || r.ServedKongConfigHash == nil {
			t.Fatalf("%s: report %+v", name, r)
		}
	}
}

// ok -> verifying when the canary serves a new config hash, and back to ok on the next answer.
func TestANewConfigTakesTheOkPodBackToVerifying(t *testing.T) {
	w := ready(t)
	w.serve(hashA)
	w.expect("ok", true)
	w.serve(hashB)
	w.expect("verifying", true)
	w.serve(hashB)
	w.expect("ok", true)
}

// Kong serving a config other than applied.json's: verifying at once, guard-missing (lease withdrawn) after 60 s;
// serving the applied one again before that makes the pod ok.
func TestAConfigDivergingFromTheAppliedOneIsGuardMissingAfter60s(t *testing.T) {
	w := ready(t)
	w.applied(hashA, 1, nil)
	w.serve(hashA)
	w.expect("ok", true)
	w.serve(hashB)
	w.expect("verifying", true)
	w.now += uint64(CanaryNotFound) / 2
	w.serve(hashB)
	w.expect("verifying", true)
	w.serve(hashA)
	w.expect("ok", true)
	// Negative control: the divergence lasts.
	w.serve(hashB)
	w.serve(hashB)
	w.now += uint64(CanaryNotFound) + 1
	w.serve(hashB)
	w.expect("guard-missing", false)
}

// A divergence while inconclusive is not made ok by the next conclusive round.
func TestADivergenceWhileInconclusiveIsNotOk(t *testing.T) {
	w := ready(t)
	w.applied(hashA, 1, nil)
	w.serve(hashA)
	w.expect("ok", true)
	w.net.dns = false
	w.now += uint64(Period)
	w.round()
	w.expect("inconclusive", true)
	w.serve(hashB)
	w.net.dns = true
	w.now += uint64(Period)
	w.round()
	if w.p.State.State == "ok" {
		t.Fatal("a conclusive round made ok a pod whose Kong serves another config than applied.json's")
	}
}

// The control plane's reading of the evidence, mirrored: all four applied members or none, and only with the served
// hash they name.
func TestReportAppliedEvidenceIsStrict(t *testing.T) {
	base := `{"clusterId":"` + cluster + `","podUid":"` + pod + `","bootId":"` + boot1 + `","admissionId":"` + admissionID +
		`","seq":1,"prevDigest":null,"state":"ok","failedCapabilities":[],"challenge":null,"final":false`
	applied := `,"appliedEpoch":1,"appliedRevision":7,"appliedHash":"` + deployTag + `","appliedKongConfigHash":"` + hashA + `"`
	for name, tc := range map[string]struct {
		extra string
		ok    bool
	}{
		"nothing":                 {``, true},
		"served only":             {`,"servedKongConfigHash":"` + hashA + `"`, true},
		"all null":                {`,"servedKongConfigHash":null,"appliedEpoch":null,"appliedRevision":null,"appliedHash":null,"appliedKongConfigHash":null`, true},
		"applied with its served": {`,"servedKongConfigHash":"` + hashA + `"` + applied, true},
		"applied without served":  {applied, false},
		"applied, other served":   {`,"servedKongConfigHash":"` + hashB + `"` + applied, false},
		"partial applied":         {`,"servedKongConfigHash":"` + hashA + `","appliedEpoch":1`, false},
		"applied epoch 0":         {`,"servedKongConfigHash":"` + hashA + `"` + strings.Replace(applied, `"appliedEpoch":1`, `"appliedEpoch":0`, 1), false},
		"malformed served":        {`,"servedKongConfigHash":"AAAA"`, false},
		"epoch null alone":        {`,"appliedEpoch":null`, false},
		"epoch null, no served":   {`,"appliedEpoch":null,"appliedRevision":null,"appliedHash":null,"appliedKongConfigHash":null`, false},
		"revision null alone":     {`,"appliedRevision":null`, false},
		"malformed applied hash":  {`,"servedKongConfigHash":"` + hashA + `"` + strings.Replace(applied, deployTag, "sha256:1", 1), false},
	} {
		_, err := ParseReport([]byte(base + tc.extra + `}`))
		if (err == nil) != tc.ok {
			t.Errorf("%s: err %v", name, err)
		}
	}
}
