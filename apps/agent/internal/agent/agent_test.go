package agent

import (
	"bytes"
	"context"
	"crypto/md5"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
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
	server        *httptest.Server
	calls         atomic.Int64
	failed        atomic.Bool
	failureStatus atomic.Int64
	healthy       atomic.Bool
	bodies        chan []byte
	onApply       func(http.ResponseWriter, *http.Request, []byte)
	// served is Kong's configuration_hash, computed as Kong 3.9 does; reported, when set, replaces it in /status.
	served   atomic.Value
	reported atomic.Value
}

// kongHash is Kong 3.9's configuration_hash of a POST /config body: the md5 of the "config" string when there is
// one, otherwise of the body (a config object, as v1 sends it).
func kongHash(body []byte) string {
	var wrapped struct {
		Config *string `json:"config"`
	}
	if json.Unmarshal(body, &wrapped) == nil && wrapped.Config != nil {
		body = []byte(*wrapped.Config)
	}
	sum := md5.Sum(body)
	return hex.EncodeToString(sum[:])
}

func newKong(t *testing.T) *kongMock {
	t.Helper()
	k := &kongMock{bodies: make(chan []byte, 64)}
	k.failureStatus.Store(http.StatusBadRequest)
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
				return
			}
			hash, _ := k.served.Load().(string)
			if reported, _ := k.reported.Load().(string); reported != "" {
				hash = reported
			}
			if hash == "" {
				hash = strings.Repeat("0", 32)
			}
			fmt.Fprintf(w, `{"configuration_hash":%q,"server":{"connections_active":1}}`, hash)
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
				w.WriteHeader(int(k.failureStatus.Load()))
				fmt.Fprint(w, "Kong validation failed: "+strings.Repeat("x", 9<<10))
				return
			}
			k.served.Store(kongHash(b))
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
		KongStatusURL: k.server.URL, SnapshotPath: path, StateDir: filepath.Join(filepath.Dir(path), "state"),
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	a.retry = func(int) time.Duration { return 5 * time.Millisecond }
	a.applyRetry = func(int) time.Duration { return 80 * time.Millisecond }
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

func TestHTTP400KeepsGoodSnapshotAndSuppressesSameHash(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	cp.SetSSEDown(true)
	k := newKong(t)
	k.failureStatus.Store(http.StatusBadRequest)
	path := filepath.Join(t.TempDir(), "kong.json")
	s1 := example(t, 1)
	cp.SetSnapshot(encoded(t, s1))
	a := newTestAgent(t, cp, k, path)
	a.applyRetry = func(int) time.Duration { return 0 }
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

func TestTransientApplyFailureRecoversWithoutNewSnapshot(t *testing.T) {
	for _, code := range []int{http.StatusTooManyRequests, http.StatusInternalServerError, http.StatusServiceUnavailable, http.StatusGatewayTimeout, 0} {
		t.Run(fmt.Sprintf("status-%d", code), func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			k := newKong(t)
			var failing atomic.Bool
			failing.Store(true)
			attempts := make(chan time.Time, 16)
			k.onApply = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
				attempts <- time.Now()
				if !failing.Load() {
					w.WriteHeader(http.StatusCreated)
					return
				}
				if code == 0 {
					conn, _, err := w.(http.Hijacker).Hijack()
					if err != nil {
						t.Error(err)
						return
					}
					conn.Close()
					return
				}
				w.WriteHeader(code)
				fmt.Fprint(w, cpmock.RegistrationToken+" "+cpmock.NodeToken+" "+strings.Repeat("x", 9<<10))
			}
			current := example(t, 1)
			cp.SetSnapshot(encoded(t, current))
			a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
			a.poll = 10 * time.Millisecond
			stop := start(t, a)
			receive(t, cp.EventConnections, nil)
			failed := waitState(t, cp, "failed", 1)
			if failed.Error == nil || *failed.Error == "" || len(*failed.Error) > 8<<10 || strings.Contains(*failed.Error, cpmock.RegistrationToken) || strings.Contains(*failed.Error, cpmock.NodeToken) {
				t.Fatal("transient failure was not reported with a bounded, redacted error")
			}
			failing.Store(false)
			for range 5 {
				cp.Emit(fmt.Sprintf("event: snapshot.published\ndata: {\"version\":1,\"hash\":%q}\n\n", current.Hash))
			}
			waitState(t, cp, "applied", 1)
			stop()
			first, second := receive(t, attempts, nil), receive(t, attempts, nil)
			if second.Sub(first) < 80*time.Millisecond {
				t.Fatal("polls or SSE events reapplied the snapshot inside the backoff window")
			}
			if k.calls.Load() != 2 {
				t.Fatalf("expected one failed and one successful apply, got %d", k.calls.Load())
			}
		})
	}
}

func TestHTTP413SuppressesSameHashUntilAnotherArrives(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	k.failureStatus.Store(http.StatusRequestEntityTooLarge)
	k.failed.Store(true)
	cp.SetSnapshot(encoded(t, example(t, 1)))
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.applyRetry = func(int) time.Duration { return 0 }
	stop := start(t, a)
	waitState(t, cp, "failed", 1)
	k.failed.Store(false)
	for range 5 {
		receive(t, cp.SnapshotRequests, nil)
	}
	if k.calls.Load() != 1 {
		t.Fatal("HTTP 413 did not park the rejected hash")
	}
	cp.SetSnapshot(encoded(t, example(t, 2)))
	waitState(t, cp, "applied", 2)
	stop()
	if k.calls.Load() != 2 {
		t.Fatal("a new hash did not clear the HTTP 413 rejection")
	}
}

func TestApplyBackoffResetsForNewHashAndSuccess(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	k.failureStatus.Store(http.StatusServiceUnavailable)
	k.failed.Store(true)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	if _, err := a.client.register(t.Context()); err != nil {
		t.Fatal(err)
	}
	var attempts []int
	a.applyRetry = func(attempt int) time.Duration {
		attempts = append(attempts, attempt)
		if len(attempts) == 1 {
			return time.Hour
		}
		return 0
	}
	cp.SetSnapshot(encoded(t, example(t, 1)))
	a.refresh(t.Context(), cpmock.EnvironmentID)
	a.refresh(t.Context(), cpmock.EnvironmentID)
	if k.calls.Load() != 1 {
		t.Fatal("same hash was retried before its backoff expired")
	}
	cp.SetSnapshot(encoded(t, example(t, 2)))
	a.refresh(t.Context(), cpmock.EnvironmentID)
	a.refresh(t.Context(), cpmock.EnvironmentID)
	if k.calls.Load() != 3 {
		t.Fatal("new hash did not bypass the old backoff or retry after expiry")
	}
	k.failed.Store(false)
	a.refresh(t.Context(), cpmock.EnvironmentID)
	waitState(t, cp, "applied", 2)
	if a.applyAttempt != 0 || !a.nextApply.IsZero() {
		t.Fatal("successful apply did not reset the retry backoff")
	}
	k.failed.Store(true)
	cp.SetSnapshot(encoded(t, example(t, 3)))
	a.refresh(t.Context(), cpmock.EnvironmentID)
	if !slices.Equal(attempts, []int{0, 0, 1, 0}) {
		t.Fatalf("unexpected backoff attempts across hashes and success: %v", attempts)
	}
}

func TestApplyBackoffIsExponentialWithJitterCappedAt60Seconds(t *testing.T) {
	for attempt := range 20 {
		seen := make(map[time.Duration]bool)
		ceiling := min(time.Second*time.Duration(1<<min(attempt, 6)), 60*time.Second)
		for range 20 {
			delay := applyRetryDelay(attempt)
			if delay < ceiling/2 || delay > ceiling {
				t.Fatalf("apply backoff outside exponential bounds: attempt %d, delay %v", attempt, delay)
			}
			seen[delay] = true
		}
		if len(seen) < 2 {
			t.Fatal("apply backoff has no jitter")
		}
	}
}

type roundTripFunc func(*http.Request) (*http.Response, error)

func (f roundTripFunc) RoundTrip(r *http.Request) (*http.Response, error) { return f(r) }

func TestApplyAllows60SecondsForKongResponse(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	transport := a.client.applyHTTP.Transport.(*http.Transport)
	defer transport.CloseIdleConnections()
	if transport.ResponseHeaderTimeout != 60*time.Second {
		t.Fatal("Kong response headers are still limited by a shorter timeout")
	}
	a.client.applyHTTP.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
		deadline, ok := r.Context().Deadline()
		if !ok || time.Until(deadline) < 59*time.Second || time.Until(deadline) > 60*time.Second {
			t.Error("Kong apply request does not have a 60 second deadline")
		}
		return transport.RoundTrip(r)
	})
	if err := a.client.apply(t.Context(), example(t, 1).Config); err != nil {
		t.Fatal(err)
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

func TestKongAdminAndStatusOverUnixSockets(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	// t.TempDir() can exceed the 104-byte socket path limit on macOS.
	dir, err := os.MkdirTemp("", "agent-sock")
	if err != nil {
		t.Fatal(err)
	}
	t.Cleanup(func() { os.RemoveAll(dir) })
	serve := func(name string) string {
		path := filepath.Join(dir, name)
		l, err := net.Listen("unix", path)
		if err != nil {
			t.Fatal(err)
		}
		server := &http.Server{Handler: k.server.Config.Handler}
		go server.Serve(l)
		t.Cleanup(func() { server.Close() })
		return "unix://" + path
	}
	path := filepath.Join(t.TempDir(), "kong.json")
	a, err := New(Config{
		ControlPlaneURL: cp.HTTP.URL, RegistrationToken: cpmock.RegistrationToken, NodeID: "node-1", Hostname: "host-1",
		KongAdminURL: serve("admin.sock"), KongStatusURL: serve("status.sock"), SnapshotPath: path, StateDir: filepath.Join(filepath.Dir(path), "state"),
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	a.poll, a.heartbeat = 20*time.Millisecond, 25*time.Millisecond
	k.server.Close() // Nothing may reach Kong over TCP.
	start(t, a)
	if r := receive(t, cp.Registrations, nil); r.KongVersion != "3.9.4" {
		t.Fatalf("Kong version not read through the admin socket: %+v", r)
	}
	if idle := waitState(t, cp, "idle", 0); !idle.KongHealthy {
		t.Fatal("Kong health not read through the status socket")
	}
	s := example(t, 1)
	cp.SetSnapshot(encoded(t, s))
	waitState(t, cp, "applied", 1)
	if body := receive(t, k.bodies, nil); !bytes.Equal(body, s.Config) {
		t.Fatal("config not applied through the admin socket")
	}
}
