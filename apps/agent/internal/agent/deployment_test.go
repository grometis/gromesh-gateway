package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

// deploymentEnvelope is the contract example at (epoch, revision); content names its config, and so its hash.
func deploymentEnvelope(t *testing.T, epoch, revision int64, content string) []byte {
	t.Helper()
	b, err := os.ReadFile("../../../../contracts/examples/snapshot-v2.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var envelope map[string]json.RawMessage
	if err := json.Unmarshal(b, &envelope); err != nil {
		t.Fatal(err)
	}
	config := bytes.ReplaceAll(envelope["config"], []byte("recarga.tvro.example"), []byte(content+".tvro.example"))
	envelope["config"] = config
	envelope["epoch"], envelope["revision"] = fmt.Appendf(nil, "%d", epoch), fmt.Appendf(nil, "%d", revision)
	envelope["hash"] = fmt.Appendf(nil, `"sha256:%x"`, sha256.Sum256(config))
	out, err := json.Marshal(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return out
}

func hashOf(t *testing.T, envelope []byte) string {
	t.Helper()
	d, err := DecodeDeployment(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return d.Hash
}

func newWorkspacesAgent(t *testing.T, cp *cpmock.Server, k *kongMock, path string) *Agent {
	t.Helper()
	a := newTestAgent(t, cp, k, path)
	// Workspaces mode is chosen by the handoff directory alone; the isolation relay has tests of its own.
	a.config.HandoffDir = t.TempDir()
	// Run keeps a deployments it is given, so a test reads it without racing.
	a.deploy = &deployments{store: store{path: path, meta: deploymentMeta}}
	return a
}

func waitDeployment(t *testing.T, cp *cpmock.Server, match func(cpmock.DeploymentStatus) bool) cpmock.DeploymentStatus {
	t.Helper()
	return receive(t, cp.DeploymentStatuses, match)
}

func applied(epoch, revision int64, hash string) func(cpmock.DeploymentStatus) bool {
	return func(s cpmock.DeploymentStatus) bool {
		return s.Epoch == epoch && s.AppliedRevision != nil && *s.AppliedRevision == revision && s.AppliedHash != nil && *s.AppliedHash == hash
	}
}

// settle waits for n more polls answered with the applied hash, so a change that should not happen had its chance.
func settle(t *testing.T, cp *cpmock.Server, n int) {
	t.Helper()
	for len(cp.DeploymentRequests) > 0 {
		<-cp.DeploymentRequests
	}
	for range n {
		receive(t, cp.DeploymentRequests, nil)
	}
}

// drain keeps Kong answering however many times the agent calls it, so a regression fails instead of blocking.
func drain(t *testing.T, k *kongMock) {
	done := make(chan struct{})
	t.Cleanup(func() { close(done) })
	go func() {
		for {
			select {
			case <-done:
				return
			case <-k.bodies:
			}
		}
	}()
}

func lastStatus(t *testing.T, cp *cpmock.Server) cpmock.DeploymentStatus {
	t.Helper()
	for len(cp.DeploymentStatuses) > 0 {
		<-cp.DeploymentStatuses
	}
	return receive(t, cp.DeploymentStatuses, nil)
}

func TestDeploymentEnvelopeValidation(t *testing.T) {
	b, err := os.ReadFile("../../../../contracts/examples/snapshot-v2.example.json")
	if err != nil {
		t.Fatal(err)
	}
	d, err := DecodeDeployment(b)
	if err != nil {
		t.Fatalf("the contract example was refused: %v", err)
	}
	if d.Epoch != 2 || d.Revision != 7 || !bytes.Equal(d.raw, b) {
		t.Fatal("the envelope was not kept as received")
	}
	edit := func(f func(map[string]any)) []byte {
		var m map[string]any
		if err := json.Unmarshal(b, &m); err != nil {
			t.Fatal(err)
		}
		f(m)
		out, _ := json.Marshal(m)
		return out
	}
	member := func(m map[string]any) map[string]any { return m["members"].([]any)[0].(map[string]any) }
	for name, f := range map[string]func(map[string]any){
		"unknown field":               func(m map[string]any) { m["environmentId"] = "00000000-0000-4000-8000-0000000000e1" },
		"unknown member field":        func(m map[string]any) { member(m)["extra"] = true },
		"schema version 1":            func(m map[string]any) { m["schemaVersion"] = 1 },
		"no schema version":           func(m map[string]any) { delete(m, "schemaVersion") },
		"instance not a UUID":         func(m map[string]any) { m["instanceId"] = "instance" },
		"epoch 0":                     func(m map[string]any) { m["epoch"] = 0 },
		"no epoch":                    func(m map[string]any) { delete(m, "epoch") },
		"revision 0":                  func(m map[string]any) { m["revision"] = 0 },
		"fractional revision":         func(m map[string]any) { m["revision"] = 1.5 },
		"bad hash":                    func(m map[string]any) { m["hash"] = "sha256:abc" },
		"no creation time":            func(m map[string]any) { delete(m, "createdAt") },
		"null reason":                 func(m map[string]any) { m["reason"] = nil },
		"unknown reason":              func(m map[string]any) { m["reason"] = "manual" },
		"no members":                  func(m map[string]any) { delete(m, "members") },
		"null members":                func(m map[string]any) { m["members"] = nil },
		"bad slug":                    func(m map[string]any) { member(m)["slug"] = "TVRO" },
		"long slug":                   func(m map[string]any) { member(m)["slug"] = strings.Repeat("a", 41) },
		"release version 0":           func(m map[string]any) { member(m)["releaseVersion"] = 0 },
		"bad content digest":          func(m map[string]any) { member(m)["contentDigest"] = "md5:0" },
		"mandatory plugins version 0": func(m map[string]any) { m["mandatoryPluginsVersion"] = 0 },
		"bad values digest":           func(m map[string]any) { m["valuesDigest"] = "x" },
		"config not an object":        func(m map[string]any) { m["config"] = []any{} },
		"no config":                   func(m map[string]any) { delete(m, "config") },
		"epoch in another case":       func(m map[string]any) { m["Epoch"] = m["epoch"]; delete(m, "epoch") },
		"both cases of revision":      func(m map[string]any) { m["Revision"] = 99 },
		"member key in another case": func(m map[string]any) {
			member(m)["WorkspaceId"] = member(m)["workspaceId"]
			delete(member(m), "workspaceId")
		},
	} {
		if _, err := DecodeDeployment(edit(f)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	for name, f := range map[string]func(map[string]any){
		"no reason":                      func(m map[string]any) { delete(m, "reason") },
		"null mandatory plugins version": func(m map[string]any) { m["mandatoryPluginsVersion"] = nil },
		"null values digest":             func(m map[string]any) { m["valuesDigest"] = nil },
		"no members yet":                 func(m map[string]any) { m["members"] = []any{} },
	} {
		if _, err := DecodeDeployment(edit(f)); err != nil {
			t.Errorf("%s: refused: %v", name, err)
		}
	}
	if _, err := DecodeDeployment(append(append([]byte(nil), b...), []byte(" {}")...)); err == nil {
		t.Error("trailing data accepted")
	}
}

func TestDeploymentResponseHeaders(t *testing.T) {
	body := deploymentEnvelope(t, 1, 2, "a")
	hash := hashOf(t, body)
	var answer func(http.ResponseWriter)
	server := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { answer(w) }))
	defer server.Close()
	c := &client{config: Config{ControlPlaneURL: server.URL}, http: server.Client(), unauthorized: make(chan struct{}, 1)}
	notModified := func(epoch, revision string) func(http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			if epoch != "" {
				w.Header().Set("X-Gromesh-Epoch", epoch)
			}
			if revision != "" {
				w.Header().Set("X-Gromesh-Revision", revision)
			}
			w.WriteHeader(http.StatusNotModified)
		}
	}
	ok := func(etag, epoch, revision string) func(http.ResponseWriter) {
		return func(w http.ResponseWriter) {
			for k, v := range map[string]string{"ETag": etag, "X-Gromesh-Epoch": epoch, "X-Gromesh-Revision": revision} {
				if v != "" {
					w.Header().Set(k, v)
				}
			}
			w.Write(body)
		}
	}
	for name, a := range map[string]func(http.ResponseWriter){
		"304 without epoch":       notModified("", "2"),
		"304 without revision":    notModified("1", ""),
		"304 with a leading zero": notModified("1", "02"),
		"304 with a sign":         notModified("+1", "2"),
		"304 with revision 0":     notModified("1", "0"),
		"200 with another ETag":   ok("sha256:"+strings.Repeat("0", 64), "", ""),
		"200 with another epoch":  ok(hash, "2", "2"),
		"200 with another rev":    ok(hash, "1", "3"),
		"500":                     func(w http.ResponseWriter) { w.WriteHeader(http.StatusInternalServerError) },
	} {
		answer = a
		if got, err := c.deployment(context.Background(), hash); err == nil {
			t.Errorf("%s: accepted %+v", name, got)
		}
	}
	answer = notModified("1", "2")
	if _, err := c.deployment(context.Background(), ""); err == nil {
		t.Error("a 304 to a request without If-None-Match was accepted")
	}
	got, err := c.deployment(context.Background(), hash)
	if err != nil || got.deployment != nil || got.at != (position{1, 2, hash}) {
		t.Fatalf("304 confirmation: %+v, %v", got, err)
	}
	answer = ok(hash, "1", "2")
	if got, err := c.deployment(context.Background(), ""); err != nil || got.at != (position{1, 2, hash}) || got.deployment == nil {
		t.Fatalf("200: %+v, %v", got, err)
	}
	answer = ok("", "", "")
	if _, err := c.deployment(context.Background(), ""); err != nil {
		t.Fatalf("200 without the optional headers: %v", err)
	}
	answer = func(w http.ResponseWriter) { w.WriteHeader(http.StatusNotFound) }
	if got, err := c.deployment(context.Background(), ""); got != nil || err != nil {
		t.Fatalf("404: %+v, %v", got, err)
	}
}

// A 304 still names the current (epoch, revision): a newer revision of the running hash is confirmed without Kong.
func TestWorkspacesConfirmsANewRevisionOn304(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	start(t, a)
	// No deployment yet (404): without an epoch the agent has no status it may send.
	settle(t, cp, 3)
	if len(cp.DeploymentStatuses) != 0 || len(cp.Statuses) != 0 {
		t.Fatal("a status was sent before any epoch was known, or on v1")
	}
	one := deploymentEnvelope(t, 1, 1, "a")
	hash := hashOf(t, one)
	cp.SetDeployment(one)
	if s := waitDeployment(t, cp, applied(1, 1, hash)); !s.KongHealthy || s.FailedRevision != nil {
		t.Fatalf("unexpected status %+v", s)
	}
	if body := receive(t, k.bodies, nil); !bytes.Equal(body, mustDecode(t, one).Config) {
		t.Fatal("Kong did not receive the opaque config bytes unchanged")
	}
	cp.SetDeployment(deploymentEnvelope(t, 1, 2, "a"))
	waitDeployment(t, cp, applied(1, 2, hash))
	receive(t, cp.DeploymentRequests, func(h string) bool { return h == hash })
	// Negative control: a 304 naming a lower revision does not move the confirmed one back.
	cp.SetDeployment(one)
	settle(t, cp, 3)
	if s := lastStatus(t, cp); !applied(1, 2, hash)(s) {
		t.Fatalf("a lower revision was confirmed: %+v", s)
	}
	if k.calls.Load() != 1 || len(cp.SnapshotRequests) != 0 || len(cp.Statuses) != 0 {
		t.Fatalf("Kong calls %d, v1 snapshot requests %d, v1 statuses %d", k.calls.Load(), len(cp.SnapshotRequests), len(cp.Statuses))
	}
}

func mustDecode(t *testing.T, envelope []byte) *Deployment {
	t.Helper()
	d, err := DecodeDeployment(envelope)
	if err != nil {
		t.Fatal(err)
	}
	return d
}

func TestWorkspacesNeverAppliesALowerRevisionOrAnOlderEpoch(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	a := newWorkspacesAgent(t, cp, k, path)
	start(t, a)
	first := deploymentEnvelope(t, 2, 5, "a")
	cp.SetDeployment(first)
	waitDeployment(t, cp, applied(2, 5, hashOf(t, first)))
	for name, refused := range map[string][]byte{
		"lower revision":              deploymentEnvelope(t, 2, 4, "b"),
		"same revision, another hash": deploymentEnvelope(t, 2, 5, "b"),
		"older epoch":                 deploymentEnvelope(t, 1, 9, "b"),
	} {
		cp.SetDeployment(refused)
		settle(t, cp, 3)
		if k.calls.Load() != 1 {
			t.Fatalf("%s: applied (%d Kong calls)", name, k.calls.Load())
		}
		if s := lastStatus(t, cp); !applied(2, 5, hashOf(t, first))(s) {
			t.Fatalf("%s: status moved to %+v", name, s)
		}
	}
	saved, _, err := a.deploy.store.loadRaw()
	if err != nil || !bytes.Equal(saved, first) {
		t.Fatal("a refused deployment replaced the volume")
	}
	// Controls: a higher revision is applied, and so is the first revision of a newer epoch.
	higher := deploymentEnvelope(t, 2, 6, "b")
	cp.SetDeployment(higher)
	waitDeployment(t, cp, applied(2, 6, hashOf(t, higher)))
	newer := deploymentEnvelope(t, 3, 1, "c")
	cp.SetDeployment(newer)
	waitDeployment(t, cp, applied(3, 1, hashOf(t, newer)))
	if k.calls.Load() != 3 {
		t.Fatalf("%d Kong calls, want 3", k.calls.Load())
	}
	if saved, _, err := a.deploy.store.loadRaw(); err != nil || !bytes.Equal(saved, newer) {
		t.Fatal("the volume does not hold the applied deployment as received")
	}
	if disk, err := os.ReadFile(path); err != nil || !bytes.Equal(disk, mustDecode(t, newer).Config) {
		t.Fatal("Kong's boot config is not the applied deployment's config")
	}
}

func TestWorkspacesMarksAPermanentFailurePerRevision(t *testing.T) {
	for _, code := range []int{http.StatusBadRequest, http.StatusRequestEntityTooLarge} {
		t.Run(fmt.Sprint(code), func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			cp.SetSSEDown(true)
			k := newKong(t)
			k.failureStatus.Store(int64(code))
			a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
			a.applyRetry = func(int) time.Duration { return 0 }
			drain(t, k)
			stop := start(t, a)
			good := deploymentEnvelope(t, 1, 1, "a")
			goodHash := hashOf(t, good)
			cp.SetDeployment(good)
			waitDeployment(t, cp, applied(1, 1, goodHash))
			k.failed.Store(true)
			bad := deploymentEnvelope(t, 1, 2, "b")
			badHash := hashOf(t, bad)
			cp.SetDeployment(bad)
			s := waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil })
			if *s.FailedRevision != 2 || s.FailedHash == nil || *s.FailedHash != badHash || s.FailureStatus == nil || *s.FailureStatus != code || !applied(1, 1, goodHash)(s) {
				t.Fatalf("unexpected failure status %+v", s)
			}
			// The mark holds for (epoch, revision, hash) even once Kong would accept it.
			k.failed.Store(false)
			settle(t, cp, 4)
			if k.calls.Load() != 2 {
				t.Fatalf("the marked revision was retried: %d Kong calls", k.calls.Load())
			}
			// The mark survives a restart: the rejected deployment is not sent to Kong again.
			stop()
			restarted := newWorkspacesAgent(t, cp, k, a.config.SnapshotPath)
			start(t, restarted)
			waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool {
				return s.FailedRevision != nil && *s.FailedRevision == 2 && applied(1, 1, goodHash)(s)
			})
			settle(t, cp, 3)
			if k.calls.Load() != 2 {
				t.Fatalf("the marked revision was retried after a restart: %d Kong calls", k.calls.Load())
			}
			// A new revision of the same content clears the mark.
			cp.SetDeployment(deploymentEnvelope(t, 1, 3, "b"))
			s = waitDeployment(t, cp, applied(1, 3, badHash))
			if s.FailedRevision != nil || s.FailedHash != nil || s.FailureStatus != nil {
				t.Fatalf("the mark survived a new revision: %+v", s)
			}
			if k.calls.Load() != 3 {
				t.Fatalf("%d Kong calls, want 3", k.calls.Load())
			}
			if _, err := os.Stat(restarted.deploy.failureFile()); !os.IsNotExist(err) {
				t.Fatalf("the cleared mark is still on the volume: %v", err)
			}
		})
	}
}

// The epoch of a marked first deployment already counts: an older epoch is refused even with nothing applied.
func TestWorkspacesRefusesAnOlderEpochThanAMarkedFailure(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	k.failed.Store(true)
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	drain(t, k)
	stop := start(t, a)
	bad := deploymentEnvelope(t, 2, 1, "a")
	cp.SetDeployment(bad)
	s := waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil })
	if s.Epoch != 2 || *s.FailedRevision != 1 || *s.FailedHash != hashOf(t, bad) || *s.FailureStatus != http.StatusBadRequest || s.AppliedRevision != nil || s.AppliedHash != nil {
		t.Fatalf("unexpected first failure status %+v", s)
	}
	k.failed.Store(false)
	// After a restart the marked epoch still counts.
	stop()
	start(t, newWorkspacesAgent(t, cp, k, a.config.SnapshotPath))
	waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.Epoch == 2 && s.FailedRevision != nil })
	cp.SetDeployment(deploymentEnvelope(t, 1, 5, "b"))
	settle(t, cp, 3)
	if k.calls.Load() != 1 {
		t.Fatalf("an older epoch was applied: %d Kong calls", k.calls.Load())
	}
	// Control: the next revision of the marked epoch is applied.
	next := deploymentEnvelope(t, 2, 2, "b")
	cp.SetDeployment(next)
	waitDeployment(t, cp, applied(2, 2, hashOf(t, next)))
}

// The mark keeps its epoch known until a newer revision is applied: a next revision that only fails transiently does
// not let an older epoch in, before or after a restart.
func TestWorkspacesTheMarkKeepsItsEpochUntilANewerRevisionApplies(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	var older atomic.Bool
	k.onApply = func(w http.ResponseWriter, r *http.Request, body []byte) {
		if bytes.Contains(body, []byte("older.tvro.example")) {
			older.Store(true)
		}
		if k.failed.Load() {
			w.WriteHeader(int(k.failureStatus.Load()))
			return
		}
		w.WriteHeader(http.StatusCreated)
	}
	k.failed.Store(true)
	path := filepath.Join(t.TempDir(), "kong.json")
	a := newWorkspacesAgent(t, cp, k, path)
	drain(t, k)
	stop := start(t, a)
	cp.SetDeployment(deploymentEnvelope(t, 2, 1, "a"))
	waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil })
	k.failureStatus.Store(http.StatusServiceUnavailable)
	cp.SetDeployment(deploymentEnvelope(t, 2, 2, "b"))
	before := k.calls.Load()
	for k.calls.Load() < before+2 {
		receive(t, cp.DeploymentRequests, nil)
	}
	for _, restart := range []bool{false, true} {
		if restart {
			stop()
			stop = start(t, newWorkspacesAgent(t, cp, k, path))
		}
		cp.SetDeployment(deploymentEnvelope(t, 1, 5, "older"))
		settle(t, cp, 3)
		if older.Load() {
			t.Fatalf("an older epoch reached Kong (restart: %v)", restart)
		}
		if s := lastStatus(t, cp); s.Epoch != 2 || s.FailedRevision == nil || *s.FailedRevision != 1 {
			t.Fatalf("the mark of epoch 2 was lost (restart: %v): %+v", restart, s)
		}
	}
	// Control: once the next revision applies, the mark is gone from the status and the volume.
	k.failed.Store(false)
	next := deploymentEnvelope(t, 2, 2, "b")
	cp.SetDeployment(next)
	if s := waitDeployment(t, cp, applied(2, 2, hashOf(t, next))); s.FailedRevision != nil {
		t.Fatalf("the mark survived the applied revision: %+v", s)
	}
	if _, err := os.Stat(a.deploy.failureFile()); !os.IsNotExist(err) {
		t.Fatalf("the mark is still on the volume: %v", err)
	}
}

// A mark that could not be written is written on a later poll, without Kong, even when the control plane has moved to
// a revision that only fails transiently.
func TestWorkspacesRetriesPersistingTheMark(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	k.failed.Store(true)
	path := filepath.Join(t.TempDir(), "kong.json")
	a := newWorkspacesAgent(t, cp, k, path)
	blocked := a.deploy.failureFile()
	if err := os.Mkdir(blocked, 0o755); err != nil {
		t.Fatal(err)
	}
	drain(t, k)
	stop := start(t, a)
	bad := deploymentEnvelope(t, 1, 1, "a")
	cp.SetDeployment(bad)
	waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil })
	k.failureStatus.Store(http.StatusServiceUnavailable)
	cp.SetDeployment(deploymentEnvelope(t, 1, 2, "b"))
	settle(t, cp, 2)
	if err := os.Remove(blocked); err != nil {
		t.Fatal(err)
	}
	settle(t, cp, 3)
	if info, err := os.Stat(blocked); err != nil || !info.Mode().IsRegular() {
		t.Fatalf("the mark was not written once the volume recovered: %v", err)
	}
	stop()
	k.failed.Store(false)
	cp.SetDeployment(bad)
	calls := k.calls.Load()
	start(t, newWorkspacesAgent(t, cp, k, path))
	waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.FailedRevision != nil && *s.FailedRevision == 1 })
	settle(t, cp, 3)
	if k.calls.Load() != calls {
		t.Fatalf("the rejected deployment was sent again: %d Kong calls, want %d", k.calls.Load(), calls)
	}
}

// Negative control: any other Kong failure is retried and never marked.
func TestWorkspacesTransientFailureIsRetriedNotMarked(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	k.failureStatus.Store(http.StatusInternalServerError)
	k.failed.Store(true)
	a := newWorkspacesAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.applyRetry = func(int) time.Duration { return 0 }
	start(t, a)
	one := deploymentEnvelope(t, 1, 1, "a")
	cp.SetDeployment(one)
	for range 3 {
		receive(t, k.bodies, nil)
	}
	drain(t, k)
	if len(cp.DeploymentStatuses) != 0 {
		t.Fatalf("a transient failure produced a status: %+v", <-cp.DeploymentStatuses)
	}
	k.failed.Store(false)
	if s := waitDeployment(t, cp, applied(1, 1, hashOf(t, one))); s.FailedRevision != nil {
		t.Fatalf("a transient failure was marked: %+v", s)
	}
}

// Cold start with the control plane unreachable: the agent adopts the deployment and the confirmed revision on the
// volume (Kong boots from it) without calling Kong, reports it once the control plane answers, and still accepts the
// first revision of a newer epoch.
func TestWorkspacesColdStartWithTheControlPlaneDownAdoptsTheVolume(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	first := newWorkspacesAgent(t, cp, k, path)
	stop := start(t, first)
	three := deploymentEnvelope(t, 1, 3, "a")
	hash := hashOf(t, three)
	cp.SetDeployment(three)
	waitDeployment(t, cp, applied(1, 3, hash))
	cp.SetDeployment(deploymentEnvelope(t, 1, 4, "a"))
	waitDeployment(t, cp, applied(1, 4, hash))
	stop()
	cp.SetDown(true)
	for len(cp.DeploymentStatuses) > 0 || len(cp.DeploymentRequests) > 0 {
		select {
		case <-cp.DeploymentStatuses:
		case <-cp.DeploymentRequests:
		}
	}
	restarted := newWorkspacesAgent(t, cp, k, path)
	start(t, restarted)
	waitAdopted(t, restarted, position{1, 4, hash})
	if len(cp.DeploymentRequests) != 0 || len(cp.Registrations) != 1 {
		t.Fatal("the control plane answered while down")
	}
	cp.SetDown(false)
	waitDeployment(t, cp, applied(1, 4, hash))
	receive(t, cp.DeploymentRequests, func(h string) bool { return h == hash })
	if k.calls.Load() != 1 {
		t.Fatalf("the cold start reapplied the volume: %d Kong calls", k.calls.Load())
	}
	newer := deploymentEnvelope(t, 2, 1, "b")
	cp.SetDeployment(newer)
	waitDeployment(t, cp, applied(2, 1, hashOf(t, newer)))
}

func waitAdopted(t *testing.T, a *Agent, want position) {
	t.Helper()
	deadline := time.Now().Add(4 * time.Second)
	for {
		a.statusMu.RLock()
		s := a.deployStatus
		a.statusMu.RUnlock()
		if s != nil && s.Epoch == want.Epoch && s.AppliedRevision != nil && *s.AppliedRevision == want.Revision && *s.AppliedHash == want.Hash {
			return
		}
		if time.Now().After(deadline) {
			t.Fatalf("the volume was not adopted at %+v: %+v", want, s)
		}
		time.Sleep(10 * time.Millisecond)
	}
}

// A 304 into a newer epoch is confirmed and survives a restart: an older epoch stays refused.
func TestWorkspacesConfirmsANewEpochOn304AcrossARestart(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	stop := start(t, newWorkspacesAgent(t, cp, k, path))
	three := deploymentEnvelope(t, 1, 3, "a")
	hash := hashOf(t, three)
	cp.SetDeployment(three)
	waitDeployment(t, cp, applied(1, 3, hash))
	cp.SetDeployment(deploymentEnvelope(t, 2, 1, "a"))
	waitDeployment(t, cp, applied(2, 1, hash))
	stop()
	cp.SetDown(true)
	restarted := newWorkspacesAgent(t, cp, k, path)
	start(t, restarted)
	waitAdopted(t, restarted, position{2, 1, hash})
	cp.SetDown(false)
	cp.SetDeployment(deploymentEnvelope(t, 1, 9, "b"))
	settle(t, cp, 3)
	if s := lastStatus(t, cp); !applied(2, 1, hash)(s) || k.calls.Load() != 1 {
		t.Fatalf("an older epoch moved the agent: %+v, %d Kong calls", s, k.calls.Load())
	}
}

// A 200 for a newer revision of the running hash is confirmed without Kong, and its envelope replaces the volume's.
func TestWorkspacesConfirmsANewRevisionSentWithItsBody(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	cp.SetAlwaysSendBody(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	a := newWorkspacesAgent(t, cp, k, path)
	start(t, a)
	one := deploymentEnvelope(t, 1, 1, "a")
	hash := hashOf(t, one)
	cp.SetDeployment(one)
	waitDeployment(t, cp, applied(1, 1, hash))
	two := deploymentEnvelope(t, 1, 2, "a")
	cp.SetDeployment(two)
	waitDeployment(t, cp, applied(1, 2, hash))
	settle(t, cp, 3)
	if saved, _, err := a.deploy.store.loadRaw(); err != nil || !bytes.Equal(saved, two) || k.calls.Load() != 1 {
		t.Fatalf("the confirmed envelope is not on the volume, or Kong was called (%d)", k.calls.Load())
	}
}

// Persistence failures: nothing is confirmed or kept that is not on the volume, and Kong goes back to the running
// config when a new one cannot be committed.
func TestWorkspacesPersistenceFailures(t *testing.T) {
	t.Run("commit", func(t *testing.T) {
		cp := cpmock.New()
		t.Cleanup(cp.Close)
		cp.SetSSEDown(true)
		k := newKong(t)
		path := filepath.Join(t.TempDir(), "kong.json")
		a := newWorkspacesAgent(t, cp, k, path)
		var failRename atomic.Bool
		a.deploy = &deployments{store: store{path: path, meta: deploymentMeta, rename: func(from, to string) error {
			if failRename.Load() {
				return errors.New("injected rename failure")
			}
			return os.Rename(from, to)
		}}}
		start(t, a)
		one, two := deploymentEnvelope(t, 1, 1, "a"), deploymentEnvelope(t, 1, 2, "b")
		cp.SetDeployment(one)
		waitDeployment(t, cp, applied(1, 1, hashOf(t, one)))
		receive(t, k.bodies, nil)
		failRename.Store(true)
		cp.SetDeployment(two)
		if body := receive(t, k.bodies, nil); !bytes.Equal(body, mustDecode(t, two).Config) {
			t.Fatal("the new config was not sent first")
		}
		if body := receive(t, k.bodies, nil); !bytes.Equal(body, mustDecode(t, one).Config) {
			t.Fatal("Kong did not get the running config back")
		}
		drain(t, k)
		if s := lastStatus(t, cp); !applied(1, 1, hashOf(t, one))(s) || s.FailedRevision != nil {
			t.Fatalf("an uncommitted deployment was reported: %+v", s)
		}
		failRename.Store(false)
		waitDeployment(t, cp, applied(1, 2, hashOf(t, two)))
	})
	t.Run("confirmation", func(t *testing.T) {
		cp := cpmock.New()
		t.Cleanup(cp.Close)
		cp.SetSSEDown(true)
		k := newKong(t)
		dir := t.TempDir()
		a := newWorkspacesAgent(t, cp, k, filepath.Join(dir, "kong.json"))
		start(t, a)
		one := deploymentEnvelope(t, 1, 1, "a")
		hash := hashOf(t, one)
		cp.SetDeployment(one)
		waitDeployment(t, cp, applied(1, 1, hash))
		// A directory where the position goes: the confirmation cannot be written.
		blocked := filepath.Join(dir, ".kong.json.position")
		if err := os.Mkdir(blocked, 0o755); err != nil {
			t.Fatal(err)
		}
		cp.SetDeployment(deploymentEnvelope(t, 1, 2, "a"))
		settle(t, cp, 3)
		if s := lastStatus(t, cp); !applied(1, 1, hash)(s) {
			t.Fatalf("a revision was confirmed without being persisted: %+v", s)
		}
		if err := os.Remove(blocked); err != nil {
			t.Fatal(err)
		}
		waitDeployment(t, cp, applied(1, 2, hash))
	})
}

// Negative controls for the volume: a v1 snapshot, a deployment whose boot config differs, and a confirmed position
// of another hash are never adopted.
func TestWorkspacesColdStartIgnoresAnUnusableVolume(t *testing.T) {
	t.Run("v1 snapshot", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "kong.json")
		commitFixture(t, &store{path: path}, example(t, 5))
		a := restoring(&deployments{store: store{path: path, meta: deploymentMeta}})
		if a.deploy.at != nil || a.deployStatus != nil {
			t.Fatal("a v1 snapshot was adopted in Workspaces mode")
		}
	})
	t.Run("mismatched boot config", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "kong.json")
		d := &deployments{store: store{path: path, meta: deploymentMeta}}
		one := mustDecode(t, deploymentEnvelope(t, 1, 1, "a"))
		pending, err := d.store.stageRaw(one.raw, []byte(`{"_format_version":"3.0"}`))
		if err != nil || pending.commit() != nil {
			t.Fatal("cannot write the fixture")
		}
		restoring(d)
		if d.at != nil {
			t.Fatal("a deployment whose boot config differs was adopted")
		}
	})
	t.Run("confirmed position", func(t *testing.T) {
		path := filepath.Join(t.TempDir(), "kong.json")
		one := mustDecode(t, deploymentEnvelope(t, 1, 3, "a"))
		for name, tc := range map[string]struct {
			position string
			want     position
		}{
			"another hash":        {fmt.Sprintf(`{"epoch":1,"revision":9,"hash":"sha256:%064d"}`, 0), position{1, 3, one.Hash}},
			"lower revision":      {fmt.Sprintf(`{"epoch":1,"revision":2,"hash":%q}`, one.Hash), position{1, 3, one.Hash}},
			"unknown field":       {fmt.Sprintf(`{"epoch":1,"revision":9,"hash":%q,"x":1}`, one.Hash), position{1, 3, one.Hash}},
			"newer epoch":         {fmt.Sprintf(`{"epoch":2,"revision":1,"hash":%q}`, one.Hash), position{2, 1, one.Hash}},
			"confirmed revision":  {fmt.Sprintf(`{"epoch":1,"revision":9,"hash":%q}`, one.Hash), position{1, 9, one.Hash}},
			"key in another case": {fmt.Sprintf(`{"epoch":1,"Revision":9,"hash":%q}`, one.Hash), position{1, 3, one.Hash}},
		} {
			d := &deployments{store: store{path: path, meta: deploymentMeta}}
			pending, err := d.store.stageRaw(one.raw, one.Config)
			if err != nil || pending.commit() != nil {
				t.Fatal("cannot write the fixture")
			}
			if err := os.WriteFile(d.positionFile(), []byte(tc.position), 0o644); err != nil {
				t.Fatal(err)
			}
			restoring(d)
			if d.at == nil || *d.at != tc.want {
				t.Errorf("%s: adopted %+v, want %+v", name, d.at, tc.want)
			}
		}
	})
}

func restoring(d *deployments) *Agent {
	a := &Agent{config: Config{NodeID: "node-1"}, log: slog.New(slog.NewJSONHandler(io.Discard, nil)), deploy: d}
	a.restoreDeployment()
	return a
}

// The persisted mark counts only above the applied position and only for 400/413.
func TestWorkspacesRestoresOnlyALivePermanentFailure(t *testing.T) {
	one := mustDecode(t, deploymentEnvelope(t, 1, 3, "a"))
	other := fmt.Sprintf("sha256:%064d", 1)
	for name, tc := range map[string]struct {
		failure string
		kept    bool
	}{
		"above the applied revision": {fmt.Sprintf(`{"epoch":1,"revision":4,"hash":%q,"status":400}`, other), true},
		"newer epoch":                {fmt.Sprintf(`{"epoch":2,"revision":1,"hash":%q,"status":413}`, other), true},
		"below the applied revision": {fmt.Sprintf(`{"epoch":1,"revision":2,"hash":%q,"status":400}`, other), false},
		"the applied revision":       {fmt.Sprintf(`{"epoch":1,"revision":3,"hash":%q,"status":400}`, one.Hash), false},
		"transient status":           {fmt.Sprintf(`{"epoch":1,"revision":4,"hash":%q,"status":500}`, other), false},
		"key in another case":        {fmt.Sprintf(`{"epoch":1,"revision":4,"hash":%q,"Status":400}`, other), false},
	} {
		path := filepath.Join(t.TempDir(), "kong.json")
		d := &deployments{store: store{path: path, meta: deploymentMeta}}
		pending, err := d.store.stageRaw(one.raw, one.Config)
		if err != nil || pending.commit() != nil {
			t.Fatal("cannot write the fixture")
		}
		if err := os.WriteFile(d.failureFile(), []byte(tc.failure), 0o644); err != nil {
			t.Fatal(err)
		}
		a := restoring(d)
		if (d.failed != nil) != tc.kept || d.at == nil || *d.at != one.position() {
			t.Errorf("%s: failed %+v, applied %+v", name, d.failed, d.at)
		}
		if tc.kept && (a.deployStatus == nil || a.deployStatus.FailedRevision == nil) {
			t.Errorf("%s: the restored mark is not reported", name)
		}
	}
}

// With GROMESH_HANDOFF_DIR unset nothing of protocol v2 is spoken, even when the control plane serves both.
func TestV1ModeNeverSpeaksV2(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	cp.SetDeployment(deploymentEnvelope(t, 1, 1, "a"))
	cp.SetSnapshot(encoded(t, example(t, 1)))
	start(t, a)
	waitState(t, cp, "applied", 1)
	for range 3 {
		receive(t, cp.SnapshotRequests, nil)
	}
	if len(cp.DeploymentRequests) != 0 || len(cp.DeploymentStatuses) != 0 || a.deploy != nil {
		t.Fatal("v1 mode spoke protocol v2")
	}
}
