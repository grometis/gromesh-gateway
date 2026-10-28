package agent

import (
	"bytes"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

func readApplied(t *testing.T, a *Agent) (AppliedRevision, bool) {
	t.Helper()
	data, err := os.ReadFile(filepath.Join(a.config.HandoffDir, appliedFile))
	if os.IsNotExist(err) {
		return AppliedRevision{}, false
	}
	if err != nil {
		t.Fatal(err)
	}
	var doc AppliedRevision
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&doc); err != nil {
		t.Fatalf("applied.json is not an AppliedRevision: %v", err)
	}
	return doc, true
}

func waitApplied(t *testing.T, a *Agent, revision int64) AppliedRevision {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		if doc, ok := readApplied(t, a); ok && doc.Revision == revision {
			return doc
		}
		if time.Now().After(deadline) {
			t.Fatalf("applied.json never named revision %d", revision)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func declared(s cpmock.DeploymentStatus) bool { return s.AppliedRevision != nil }

// A revision is declared applied (applied.json, then the status) only once Kong reports the md5 of the bytes posted
// as {"config": ...}; the declaration carries the pod, the cluster and the instance.
func TestWorkspacesDeclaresOnlyWhatKongConfirms(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	// Negative control: Kong accepts the config but reports another hash.
	k.reported.Store(strings.Repeat("f", 32))
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.config.PodUID = testPod
	a.kongConfirmWait, a.kongConfirmStep = 50*time.Millisecond, 10*time.Millisecond
	drain(t, k)
	start(t, a)
	one := deploymentEnvelope(t, 1, 1, "a")
	cp.SetDeployment(one)
	for i := 0; k.calls.Load() < 3; i++ {
		if i > 200 {
			t.Fatal("Kong was not called again: the unconfirmed revision is not retried")
		}
		receive(t, cp.DeploymentRequests, nil)
	}
	if _, ok := readApplied(t, a); ok {
		t.Fatal("applied.json was written for a config Kong did not report")
	}
	settle(t, cp, 2)
	for len(cp.DeploymentStatuses) > 0 {
		if s := <-cp.DeploymentStatuses; declared(s) {
			t.Fatalf("a revision Kong did not confirm was reported applied: %+v", s)
		}
	}
	k.reported.Store("")
	s := waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
	want := kongConfigHash(mustDecode(t, one).Config)
	if s.KongConfigHash == nil || *s.KongConfigHash != want {
		t.Fatalf("the status does not carry Kong's hash %s: %+v", want, s)
	}
	doc := waitApplied(t, a, 1)
	if doc != (AppliedRevision{InstanceID: exampleInstance, ClusterID: cpmock.ClusterID, NodeID: "node-1", PodUID: testPod, Epoch: 1,
		Revision: 1, Hash: hashOf(t, one), KongConfigHash: want, Result: "applied", AppliedAt: doc.AppliedAt}) {
		t.Fatalf("applied.json %+v", doc)
	}
	if _, err := time.Parse(time.RFC3339Nano, doc.AppliedAt); err != nil {
		t.Fatalf("appliedAt %q", doc.AppliedAt)
	}
	// A 304 into a newer revision of the same config is declared too, after Kong reports the same hash.
	cp.SetDeployment(deploymentEnvelope(t, 1, 2, "a"))
	waitDeployment(t, cp, applied(1, 2, hashOf(t, one)))
	if doc := waitApplied(t, a, 2); doc.KongConfigHash != want {
		t.Fatalf("applied.json %+v", doc)
	}
}

// The posted body is exactly {"config": "<the envelope's config bytes>"}: Kong's hash is the md5 of those bytes,
// characters JSON could escape included.
func TestWorkspacesPostsTheConfigBytesAsAString(t *testing.T) {
	config := []byte(`{"_format_version":"3.0","services":[{"name":"a<b>&c","url":"http://x"}],"tags":["é"]}`)
	body := kongConfigBody(config)
	if !bytes.HasPrefix(body, []byte(`{"config":"`)) || !bytes.HasSuffix(body, []byte(`"}`)) {
		t.Fatalf("body %s", body)
	}
	var fields map[string]string
	if json.Unmarshal(body, &fields) != nil || len(fields) != 1 || fields["config"] != string(config) {
		t.Fatalf("the config did not survive the string: %s", body)
	}
	if !bytes.Contains(body, []byte("a<b>&c")) {
		t.Fatal("the body escapes HTML characters")
	}
	if kongHash(body) != kongConfigHash(config) {
		t.Fatal("the md5 the agent expects is not Kong's")
	}
	if _, err := DecodeDeployment(bytes.Replace(deploymentEnvelope(t, 1, 1, "a"), []byte("a.tvro.example"), []byte("a\xff.tvro.example"), 1)); err == nil {
		t.Fatal("a config that is not UTF-8 was accepted: it would not reach Kong unchanged")
	}
}

// A cold start declares nothing until Kong, which boots from the volume after the admission, reports its hash.
func TestWorkspacesColdStartDeclaresAfterKongStarts(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	first := newWorkspacesAgent(t, cp, k, path)
	stop := start(t, first)
	three := deploymentEnvelope(t, 1, 3, "a")
	cp.SetDeployment(three)
	waitDeployment(t, cp, applied(1, 3, hashOf(t, three)))
	stop()
	// Kong is not up yet: the restarted agent knows the volume but must not declare it.
	k.healthy.Store(false)
	restarted := newWorkspacesAgent(t, cp, k, path)
	start(t, restarted)
	settle(t, cp, 3)
	for len(cp.DeploymentStatuses) > 0 {
		if s := <-cp.DeploymentStatuses; declared(s) {
			t.Fatalf("declared before Kong answered: %+v", s)
		}
	}
	if _, ok := readApplied(t, restarted); ok {
		t.Fatal("applied.json written before Kong answered")
	}
	k.healthy.Store(true)
	waitDeployment(t, cp, applied(1, 3, hashOf(t, three)))
	waitApplied(t, restarted, 3)
	if k.calls.Load() != 1 {
		t.Fatalf("the cold start posted the volume again: %d Kong calls", k.calls.Load())
	}
}

// Kong serving another config withdraws the declaration and gets the applied config again.
func TestWorkspacesKongServingAnotherConfigIsRepaired(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.kongConfirmWait, a.kongConfirmStep = 50*time.Millisecond, 10*time.Millisecond
	drain(t, k)
	start(t, a)
	one := deploymentEnvelope(t, 1, 1, "a")
	cp.SetDeployment(one)
	waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
	// Kong reports another hash and keeps reporting it whatever it is sent: the declaration goes.
	k.reported.Store(strings.Repeat("e", 32))
	waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return !declared(s) && s.KongConfigHash == nil })
	calls := k.calls.Load()
	receive(t, cp.DeploymentRequests, nil)
	for i := 0; k.calls.Load() == calls; i++ {
		if i > 200 {
			t.Fatal("the applied config was not posted again")
		}
		receive(t, cp.DeploymentRequests, nil)
	}
	k.reported.Store("")
	waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
}

// An envelope of another instance, or one that is not valid, is never posted to Kong: the revision is reported as not
// applied with its reason, Kong keeps what it serves, and the next valid revision clears the mark.
func TestWorkspacesRefusesAnotherInstanceAndAnInvalidEnvelope(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	drain(t, k)
	start(t, a)
	one := deploymentEnvelope(t, 1, 1, "a")
	cp.SetDeployment(one)
	waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
	calls := k.calls.Load()
	other := bytes.Replace(deploymentEnvelope(t, 1, 2, "b"), []byte(exampleInstance), []byte("00000000-0000-4000-8000-0000000000a2"), 1)
	cp.SetDeployment(other)
	s := waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil && *s.FailedRevision == 2 })
	if s.FailureReason == nil || *s.FailureReason != "instance-mismatch" || s.FailureStatus != nil || !applied(1, 1, hashOf(t, one))(s) {
		t.Fatalf("status %+v", s)
	}
	broken := bytes.Replace(deploymentEnvelope(t, 1, 3, "c"), []byte(`"schemaVersion":2`), []byte(`"schemaVersion":9`), 1)
	cp.SetDeployment(broken)
	s = waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil && *s.FailedRevision == 3 })
	if s.FailureReason == nil || *s.FailureReason != "invalid-envelope" || s.FailureStatus != nil {
		t.Fatalf("status %+v", s)
	}
	if k.calls.Load() != calls {
		t.Fatal("a refused envelope reached Kong")
	}
	if doc := waitApplied(t, a, 1); doc.Revision != 1 {
		t.Fatalf("applied.json moved: %+v", doc)
	}
	four := deploymentEnvelope(t, 1, 4, "d")
	cp.SetDeployment(four)
	if s := waitDeployment(t, cp, applied(1, 4, hashOf(t, four))); s.FailedRevision != nil || s.FailureReason != nil {
		t.Fatalf("the mark survived the next revision: %+v", s)
	}
}

// The control plane's typed refusals: "nothing to apply now" keeps Kong as it is; a status it did not record makes
// the agent fetch the current deployment at once, not at the next poll.
func TestWorkspacesTypedRefusals(t *testing.T) {
	for _, code := range []string{"workspaces-mode-disabled", "delivery-protocol-v1", "delivery-protocol-switching"} {
		t.Run(code, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			cp.SetSSEDown(true)
			k := newKong(t)
			a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
			start(t, a)
			one := deploymentEnvelope(t, 1, 1, "a")
			cp.SetDeployment(one)
			waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
			receive(t, k.bodies, nil)
			cp.SetDeploymentRefusal(code)
			cp.SetDeployment(deploymentEnvelope(t, 1, 2, "b"))
			settle(t, cp, 3)
			if k.calls.Load() != 1 {
				t.Fatal("Kong was called while the control plane delivered nothing")
			}
			if s := lastStatus(t, cp); !applied(1, 1, hashOf(t, one))(s) {
				t.Fatalf("the applied revision was not kept: %+v", s)
			}
		})
	}
	for code, refetch := range map[string]bool{"revision-regression": true, "unknown-deployment": true, "epoch-outdated": true, "workspaces-mode-disabled": false} {
		t.Run("status "+code, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			cp.SetSSEDown(true)
			k := newKong(t)
			a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
			a.poll = time.Hour
			one := deploymentEnvelope(t, 1, 1, "a")
			cp.SetDeployment(one)
			start(t, a)
			waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
			for len(cp.DeploymentRequests) > 0 {
				<-cp.DeploymentRequests
			}
			cp.SetStatusRefusal(code)
			select {
			case <-cp.DeploymentRequests:
				if !refetch {
					t.Fatal("a refusal that asks for nothing made the agent fetch again")
				}
			case <-time.After(500 * time.Millisecond):
				if refetch {
					t.Fatal("a status the control plane did not record was not followed by a fetch")
				}
			}
		})
	}
}

// v1 mode is untouched: the snapshot's config object is posted as it was, not as a string.
func TestV1ModePostsTheConfigObject(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	snapshot := example(t, 1)
	cp.SetSnapshot(encoded(t, snapshot))
	start(t, a)
	waitState(t, cp, "applied", 1)
	if body := receive(t, k.bodies, nil); !bytes.Equal(body, snapshot.Config) {
		t.Fatalf("v1 changed what it posts: %.80s", body)
	}
	if _, err := os.Stat(filepath.Join(filepath.Dir(a.config.SnapshotPath), appliedFile)); !os.IsNotExist(err) {
		t.Fatal("v1 wrote applied.json")
	}
}
