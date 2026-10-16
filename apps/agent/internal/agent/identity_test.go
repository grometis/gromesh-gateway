package agent

import (
	"bytes"
	"context"
	"encoding/json"
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

func TestNodeTokenSurvivesRestartWithStableIdentity(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	first := newTestAgent(t, cp, k, path)
	stop := start(t, first)
	registered := receive(t, cp.Registrations, nil)
	waitState(t, cp, "idle", 0)
	stop()
	tokenPath := filepath.Join(first.config.StateDir, "node-token")
	token, err := os.ReadFile(tokenPath)
	if err != nil {
		t.Fatalf("node token was not persisted in the new directory: %v", err)
	}
	if string(token) != cpmock.NodeToken {
		t.Fatal("persisted node token differs from registration")
	}
	info, err := os.Stat(tokenPath)
	if err != nil || info.Mode().Perm() != 0600 {
		t.Fatalf("node token must have mode 0600: %v", err)
	}
	for len(cp.Statuses) > 0 {
		<-cp.Statuses
	}
	restarted := newTestAgent(t, cp, k, path)
	// The hostname can change while the configured node identity remains stable.
	restarted.config.Hostname, restarted.client.config.Hostname = "new-host", "new-host"
	stopRestart := start(t, restarted)
	status := waitState(t, cp, "idle", 0)
	receive(t, cp.SnapshotRequests, nil)
	stopRestart()
	if status.NodeID != registered.NodeID {
		t.Fatalf("restart changed node ID: %q", status.NodeID)
	}
	select {
	case <-cp.Registrations:
		t.Fatal("restart made a second registration")
	default:
	}
}

func TestRevokedNodeTokenIsDeletedBeforeReregister(t *testing.T) {
	for _, endpoint := range []string{"/agent/v1/status", "/agent/v1/snapshots/current", "/agent/v1/events"} {
		t.Run(endpoint, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			k := newKong(t)
			path := filepath.Join(t.TempDir(), "kong.json")
			first := newTestAgent(t, cp, k, path)
			stop := start(t, first)
			registered := receive(t, cp.Registrations, nil)
			waitState(t, cp, "idle", 0)
			stop()
			for len(cp.Statuses) > 0 {
				<-cp.Statuses
			}
			for len(cp.SnapshotRequests) > 0 {
				<-cp.SnapshotRequests
			}
			for len(cp.EventConnections) > 0 {
				<-cp.EventConnections
			}
			tokenPath := filepath.Join(first.config.StateDir, "node-token")
			_, err := os.ReadFile(tokenPath)
			if err != nil {
				t.Fatalf("missing saved token before revocation: %v", err)
			}
			// Revoke just one endpoint, so recovery cannot rely on a different request's 401.
			upstream := cp.HTTP.Config.Handler
			var revoked atomic.Bool
			proxy := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
				if r.URL.Path == endpoint && revoked.CompareAndSwap(false, true) {
					w.WriteHeader(http.StatusUnauthorized)
					return
				}
				if r.URL.Path == "/agent/v1/register" {
					if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
						t.Error("revoked token was not deleted before registration")
					}
					cp.SetNodeToken("refreshed-node-token")
				}
				upstream.ServeHTTP(w, r)
			}))
			t.Cleanup(proxy.Close)
			// Keep the persisted control-plane URL unchanged; only route its transport through the interceptor.
			restarted := newTestAgent(t, cp, k, path)
			transport := restarted.client.http.Transport
			restarted.client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Host == cp.HTTP.Listener.Addr().String() {
					clone := r.Clone(r.Context())
					u := *r.URL
					u.Host = proxy.Listener.Addr().String()
					clone.URL = &u
					return transport.RoundTrip(clone)
				}
				return transport.RoundTrip(r)
			})
			stopRestart := start(t, restarted)
			registration := receive(t, cp.Registrations, nil)
			if registration.NodeID != registered.NodeID {
				t.Fatal("re-registration changed node identity")
			}
			waitState(t, cp, "idle", 0)
			receive(t, cp.EventConnections, nil)
			receive(t, cp.SnapshotRequests, nil)
			stopRestart()
			restored, err := os.ReadFile(tokenPath)
			if err != nil || string(restored) != "refreshed-node-token" {
				t.Fatal("re-registration did not persist its token")
			}
			// The refreshed credentials must also survive a subsequent restart.
			final := newTestAgent(t, cp, k, path)
			ctx, cancel := context.WithTimeout(t.Context(), 80*time.Millisecond)
			defer cancel()
			if err := final.Run(ctx); err != nil {
				t.Fatal(err)
			}
			select {
			case <-cp.Registrations:
				t.Fatal("recovery caused extra registrations")
			default:
			}
		})
	}
}

func TestRunningAgentRecoversRevokedToken(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	stop := start(t, a)
	first := receive(t, cp.Registrations, nil)
	waitState(t, cp, "idle", 0)
	receive(t, cp.EventConnections, nil)
	cp.SetNodeToken("rotated-while-running")
	recovered := receive(t, cp.Registrations, nil)
	if recovered.NodeID != first.NodeID {
		t.Fatal("running recovery created a different node")
	}
	// Observe authenticated requests after the rotated credential was issued.
	receive(t, cp.EventConnections, nil)
	waitState(t, cp, "idle", 0)
	receive(t, cp.SnapshotRequests, nil)
	stop()
	token, err := os.ReadFile(filepath.Join(a.config.StateDir, "node-token"))
	if err != nil || string(token) != "rotated-while-running" {
		t.Fatal("running recovery did not save the replacement token")
	}
	select {
	case <-cp.Registrations:
		t.Fatal("concurrent 401s caused extra registration")
	default:
	}
}

func TestPersistedIdentityRecovery(t *testing.T) {
	for _, tc := range []struct {
		name   string
		reason string
		change func(*nodeState, *[]byte, *string)
	}{
		{name: "valid state"},
		{name: "control plane URL mismatch", reason: "control-plane URL mismatch", change: func(s *nodeState, _ *[]byte, _ *string) { s.ControlPlaneURL = "https://previous.example" }},
		{name: "node ID mismatch", reason: "node ID mismatch", change: func(s *nodeState, _ *[]byte, _ *string) { s.NodeID = "previous-node" }},
		{name: "corrupt JSON", reason: "invalid node state JSON", change: func(_ *nodeState, data *[]byte, _ *string) { *data = []byte(`{"secret":"sensitive-state-token"`) }},
		{name: "invalid registration", reason: "invalid persisted registration", change: func(s *nodeState, _ *[]byte, _ *string) { s.Registration.EnvironmentID = "invalid-environment" }},
		{name: "invalid node token", reason: "invalid persisted registration", change: func(_ *nodeState, _ *[]byte, token *string) { *token = "sensitive-state-token\n" }},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			k := newKong(t)
			a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
			var logs bytes.Buffer
			a.log = slog.New(slog.NewJSONHandler(&logs, nil))
			state := nodeState{
				ControlPlaneURL: cp.HTTP.URL, NodeID: "node-1",
				Registration: Registration{ClusterID: cpmock.ClusterID, EnvironmentID: cpmock.EnvironmentID, PollIntervalSeconds: 5, HeartbeatIntervalSeconds: 5},
			}
			var data []byte
			token := cpmock.NodeToken
			if tc.change != nil {
				tc.change(&state, &data, &token)
			}
			if data == nil {
				var err error
				data, err = json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
			}
			if err := os.MkdirAll(a.config.StateDir, 0700); err != nil {
				t.Fatal(err)
			}
			statePath := filepath.Join(a.config.StateDir, "node-state.json")
			tokenPath := filepath.Join(a.config.StateDir, "node-token")
			if err := os.WriteFile(statePath, data, 0600); err != nil {
				t.Fatal(err)
			}
			if err := os.WriteFile(tokenPath, []byte(token), 0600); err != nil {
				t.Fatal(err)
			}
			transport := a.client.http.Transport
			a.client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/agent/v1/register" {
					if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
						t.Error("unusable token was not deleted before registration")
					}
					freshData, err := os.ReadFile(statePath)
					var fresh nodeState
					if err != nil || json.Unmarshal(freshData, &fresh) != nil {
						t.Error("fresh node state was not saved before registration")
					} else if fresh.NodeID != "node-1" || fresh.ControlPlaneURL != cp.HTTP.URL || fresh.Registration != (Registration{}) {
						t.Error("registration did not start from fresh configured state")
					}
				}
				return transport.RoundTrip(r)
			})
			stop := start(t, a)
			if tc.reason != "" {
				registration := receive(t, cp.Registrations, nil)
				if registration.NodeID != "node-1" {
					t.Error("re-registration did not use configured node ID")
				}
			}
			status := waitState(t, cp, "idle", 0)
			receive(t, cp.EventConnections, nil)
			stop()
			if status.NodeID != "node-1" || a.config.NodeID != "node-1" || a.client.config.NodeID != "node-1" {
				t.Error("persisted state replaced the configured node ID")
			}
			select {
			case <-cp.Registrations:
				t.Error("unexpected extra registration")
			default:
			}
			savedData, err := os.ReadFile(statePath)
			var saved nodeState
			if err != nil || json.Unmarshal(savedData, &saved) != nil {
				t.Fatalf("state file is not usable JSON: %v", err)
			}
			expected := nodeState{ControlPlaneURL: cp.HTTP.URL, NodeID: "node-1", Registration: Registration{ClusterID: cpmock.ClusterID, EnvironmentID: cpmock.EnvironmentID, PollIntervalSeconds: 5, HeartbeatIntervalSeconds: 5}}
			if saved != expected {
				t.Error("persisted metadata is inconsistent with registration")
			}
			savedToken, err := os.ReadFile(tokenPath)
			if err != nil || string(savedToken) != cpmock.NodeToken {
				t.Error("persisted token is inconsistent with registration")
			}
			for _, path := range []string{statePath, tokenPath} {
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Errorf("state file must have mode 0600: %v", err)
				}
			}
			if tc.reason != "" && (!strings.Contains(logs.String(), `"level":"WARN"`) || !strings.Contains(logs.String(), tc.reason)) {
				t.Error("missing warning explaining why persisted state was discarded")
			}
			if tc.reason == "" && strings.Contains(logs.String(), `"level":"WARN"`) {
				t.Error("valid persisted state was reported as unusable")
			}
			for _, secret := range []string{cpmock.NodeToken, cpmock.RegistrationToken, "sensitive-state-token"} {
				if strings.Contains(logs.String(), secret) {
					t.Error("credential leaked to logs")
				}
			}
		})
	}
}
