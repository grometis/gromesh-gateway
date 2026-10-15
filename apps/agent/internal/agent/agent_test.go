package agent

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/json"
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

func example(t *testing.T, version int64) *Snapshot {
	t.Helper()
	b, err := os.ReadFile("../../../../contracts/examples/snapshot.example.json")
	if err != nil {
		t.Fatal(err)
	}
	s, err := DecodeSnapshot(b)
	if err != nil {
		t.Fatal(err)
	}
	s.Version = version
	if version != 1 {
		s.Config = bytes.ReplaceAll(s.Config, []byte("team:platform"), fmt.Appendf(nil, "team:version-%d", version))
		var config any
		if err := json.Unmarshal(s.Config, &config); err != nil {
			t.Fatal(err)
		}
		canonical, err := json.Marshal(config)
		if err != nil {
			t.Fatal(err)
		}
		s.Hash = fmt.Sprintf("sha256:%x", sha256.Sum256(canonical))
	}
	return s
}

func encoded(t *testing.T, s *Snapshot) []byte {
	t.Helper()
	b, err := s.MarshalJSON()
	if err != nil {
		t.Fatal(err)
	}
	return b
}

func receive[T any](t *testing.T, ch <-chan T, match func(T) bool) T {
	t.Helper()
	timer := time.NewTimer(4 * time.Second)
	defer timer.Stop()
	for {
		select {
		case value := <-ch:
			if match == nil || match(value) {
				return value
			}
		case <-timer.C:
			t.Fatal("timed out waiting for protocol activity")
			var zero T
			return zero
		}
	}
}

type kongMock struct {
	server  *httptest.Server
	calls   atomic.Int64
	failed  atomic.Bool
	healthy atomic.Bool
	bodies  chan []byte
	onApply func(http.ResponseWriter, *http.Request, []byte)
}

func newKong(t *testing.T) *kongMock {
	t.Helper()
	k := &kongMock{bodies: make(chan []byte, 64)}
	k.healthy.Store(true)
	k.server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("control plane credentials leaked to Kong")
		}
		switch r.Method + " " + r.URL.Path {
		case "GET /":
			fmt.Fprint(w, `{"version":"3.9.4"}`)
		case "GET /status":
			if !k.healthy.Load() {
				w.WriteHeader(http.StatusServiceUnavailable)
			}
		case "POST /config":
			if r.Header.Get("Content-Type") != "application/json" {
				t.Error("config must be sent as application/json")
			}
			b, _ := io.ReadAll(r.Body)
			k.calls.Add(1)
			k.bodies <- b
			if k.onApply != nil {
				k.onApply(w, r, b)
				return
			}
			if k.failed.Load() {
				w.WriteHeader(http.StatusBadRequest)
				fmt.Fprint(w, "Kong validation failed: "+strings.Repeat("x", 9<<10))
				return
			}
			w.WriteHeader(http.StatusCreated)
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(k.server.Close)
	return k
}

func newTestAgent(t *testing.T, cp *cpmock.Server, k *kongMock, path string) *Agent {
	t.Helper()
	a, err := New(Config{
		ControlPlaneURL: cp.HTTP.URL, RegistrationToken: cpmock.RegistrationToken,
		NodeID: "node-1", Hostname: "host-1", KongAdminURL: k.server.URL,
		KongStatusURL: k.server.URL, SnapshotPath: path,
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	a.retry = func(int) time.Duration { return 5 * time.Millisecond }
	a.poll = 20 * time.Millisecond
	a.heartbeat = 25 * time.Millisecond
	return a
}

func start(t *testing.T, a *Agent) func() {
	t.Helper()
	ctx, cancel := context.WithCancel(context.Background())
	done := make(chan error, 1)
	go func() { done <- a.Run(ctx) }()
	var stopped atomic.Bool
	stop := func() {
		if stopped.Swap(true) {
			return
		}
		cancel()
		select {
		case err := <-done:
			if err != nil {
				t.Errorf("agent stopped with error: %v", err)
			}
		case <-time.After(4 * time.Second):
			t.Error("agent did not stop promptly")
		}
	}
	t.Cleanup(stop)
	return stop
}

func waitState(t *testing.T, cp *cpmock.Server, state string, version int64) cpmock.Status {
	t.Helper()
	return receive(t, cp.Statuses, func(s cpmock.Status) bool {
		if s.State != state {
			return false
		}
		if state == "failed" {
			return s.FailedVersion != nil && *s.FailedVersion == version
		}
		return version == 0 || s.AppliedVersion != nil && *s.AppliedVersion == version
	})
}

func TestRegistrationSSEAndRestart(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	a := newTestAgent(t, cp, k, path)
	a.poll = time.Hour // An event, rather than a poll, must trigger this application.
	stop := start(t, a)
	r := receive(t, cp.Registrations, nil)
	if r.NodeID != "node-1" || r.Hostname != "host-1" || r.KongVersion != "3.9.4" || r.AgentVersion != Version {
		t.Fatalf("unexpected registration: %+v", r)
	}
	idle := waitState(t, cp, "idle", 0)
	if !idle.KongHealthy || idle.AppliedVersion != nil || idle.AppliedHash != nil {
		t.Fatalf("unexpected initial heartbeat: %+v", idle)
	}
	receive(t, cp.EventConnections, nil)
	receive(t, cp.SnapshotRequests, nil) // Complete the initial 204 before publishing.
	s := example(t, 1)
	cp.SetSnapshot(encoded(t, s))
	cp.Emit(fmt.Sprintf("id: 42\r\nevent: snapshot.published\r\ndata: {\"version\":1,\r\ndata: \"hash\":%q}\r\n\r\n", s.Hash))
	waitState(t, cp, "applying", 0)
	applied := waitState(t, cp, "applied", 1)
	if applied.AppliedHash == nil || *applied.AppliedHash != s.Hash {
		t.Fatalf("wrong applied hash: %+v", applied)
	}
	if body := receive(t, k.bodies, nil); !bytes.Equal(body, s.Config) {
		t.Fatal("Kong did not receive the opaque config bytes unchanged")
	}
	disk, err := os.ReadFile(path)
	if err != nil || !bytes.Equal(disk, s.Config) {
		t.Fatalf("boot config differs from snapshot: %v", err)
	}
	cp.SetSSEDown(true)
	cp.SetSSEDown(false)
	if last := receive(t, cp.EventConnections, nil); last != "42" {
		t.Fatalf("Last-Event-ID = %q, want 42", last)
	}
	stop()
	// Drop old heartbeats so this assertion observes the restarted process.
	for len(cp.Statuses) > 0 {
		<-cp.Statuses
	}
	restarted := newTestAgent(t, cp, k, path)
	start(t, restarted)
	waitState(t, cp, "applied", 1)
	receive(t, cp.SnapshotRequests, func(hash string) bool { return hash == s.Hash })
	if k.calls.Load() != 1 {
		t.Fatalf("restart reapplied existing config: %d calls", k.calls.Load())
	}
}

func TestPollingFallback304AndHeartbeat(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	start(t, a)
	waitState(t, cp, "idle", 0)
	receive(t, cp.SnapshotRequests, nil)
	s := example(t, 1)
	cp.SetSnapshot(encoded(t, s))
	waitState(t, cp, "applied", 1)
	for range 3 {
		receive(t, cp.SnapshotRequests, func(hash string) bool { return hash == s.Hash })
	}
	if k.calls.Load() != 1 {
		t.Fatalf("304 triggered application: %d calls", k.calls.Load())
	}
	k.healthy.Store(false)
	heartbeat := receive(t, cp.Statuses, func(s cpmock.Status) bool { return s.State == "applied" && !s.KongHealthy })
	if heartbeat.NodeID != "node-1" || heartbeat.ReportedAt == "" {
		t.Fatalf("invalid heartbeat: %+v", heartbeat)
	}
}

func TestRunRecoversFromUnusablePersistedSnapshot(t *testing.T) {
	for _, persisted := range []string{"unrelated config", "other environment", "broken link"} {
		t.Run(persisted, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			k := newKong(t)
			path := filepath.Join(t.TempDir(), "kong.json")
			switch persisted {
			case "unrelated config":
				if err := os.WriteFile(path, []byte("{}"), 0644); err != nil {
					t.Fatal(err)
				}
			case "other environment":
				snapshot := example(t, 2)
				snapshot.EnvironmentID = "00000000-0000-4000-8000-0000000000e2"
				commitFixture(t, &store{path: path}, snapshot)
			case "broken link":
				if err := os.Symlink("missing-config.json", path); err != nil {
					t.Fatal(err)
				}
			}
			current := example(t, 1)
			cp.SetSnapshot(encoded(t, current))
			a := newTestAgent(t, cp, k, path)
			stop := start(t, a)
			receive(t, cp.Registrations, nil)
			idle := waitState(t, cp, "idle", 0)
			if idle.AppliedVersion != nil || idle.AppliedHash != nil {
				t.Fatal("unusable persisted snapshot was reported as applied")
			}
			if hash := receive(t, cp.SnapshotRequests, nil); hash != "" {
				t.Fatalf("initial refresh used an untrusted hash: %q", hash)
			}
			applied := waitState(t, cp, "applied", current.Version)
			if applied.AppliedHash == nil || *applied.AppliedHash != current.Hash {
				t.Fatal("current snapshot was not reported as applied")
			}
			stop()
			saved, err := a.store.load()
			if err != nil || saved.EnvironmentID != current.EnvironmentID || saved.Version != current.Version || !bytes.Equal(saved.Config, current.Config) {
				t.Fatalf("unusable file was not replaced with the current snapshot: %v", err)
			}
			if k.calls.Load() != 1 {
				t.Fatalf("current snapshot was not applied exactly once: %d calls", k.calls.Load())
			}
		})
	}
}

func TestFailedKongKeepsGoodSnapshotAndSuppressesSameHash(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	s1 := example(t, 1)
	cp.SetSnapshot(encoded(t, s1))
	a := newTestAgent(t, cp, k, path)
	start(t, a)
	waitState(t, cp, "applied", 1)
	k.failed.Store(true)
	s2 := example(t, 2)
	cp.SetSnapshot(encoded(t, s2))
	failed := waitState(t, cp, "failed", 2)
	if failed.Error == nil || len(*failed.Error) != 8<<10 || !strings.HasPrefix(*failed.Error, "Kong validation failed:") {
		t.Fatal("Kong error was not reported with the 8 KiB limit")
	}
	if failed.AppliedVersion == nil || *failed.AppliedVersion != 1 || failed.AppliedHash == nil || *failed.AppliedHash != s1.Hash {
		t.Fatal("failure lost the last applied version")
	}
	saved, err := a.store.load()
	if err != nil || saved.Version != 1 || !bytes.Equal(saved.Config, s1.Config) {
		t.Fatalf("failure replaced good snapshot: %v", err)
	}
	for range 3 {
		receive(t, cp.SnapshotRequests, func(hash string) bool { return hash == s1.Hash })
	}
	if k.calls.Load() != 2 {
		t.Fatalf("retried rejected hash: %d calls", k.calls.Load())
	}
	k.failed.Store(false)
	s3 := example(t, 3)
	cp.SetSnapshot(encoded(t, s3))
	waitState(t, cp, "applied", 3)
	if k.calls.Load() != 3 {
		t.Fatal("new hash did not recover from failure")
	}
	w := httptest.NewRecorder()
	a.MetricsHandler().ServeHTTP(w, httptest.NewRequest("GET", "/metrics", nil))
	for _, metric := range []string{"gromesh_agent_applied_version 3", "gromesh_agent_apply_failures_total 1"} {
		if !strings.Contains(w.Body.String(), metric) {
			t.Fatalf("missing metric %q in %s", metric, w.Body.String())
		}
	}
	if a.lastSuccess.Load() == 0 {
		t.Fatal("last success timestamp was not recorded")
	}
}

func TestHeartbeatContinuesWhileKongApplies(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	entered, release := make(chan struct{}), make(chan struct{})
	k.onApply = func(w http.ResponseWriter, r *http.Request, _ []byte) {
		close(entered)
		select {
		case <-release:
			w.WriteHeader(http.StatusCreated)
		case <-r.Context().Done():
		}
	}
	cp.SetSnapshot(encoded(t, example(t, 1)))
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	start(t, a)
	receive(t, entered, nil)
	waitState(t, cp, "applying", 0)
	waitState(t, cp, "applying", 0)
	close(release)
	waitState(t, cp, "applied", 1)
}

func TestSSEIdleReconnectAndEmptyLastID(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.streamIdle = 80 * time.Millisecond
	start(t, a)
	receive(t, cp.EventConnections, nil)
	cp.Emit("id: old\nevent: ping\n\nid:\nevent: ping\n\n")
	if last := receive(t, cp.EventConnections, nil); last != "" {
		t.Fatalf("empty event ID did not reset Last-Event-ID: %q", last)
	}
}
