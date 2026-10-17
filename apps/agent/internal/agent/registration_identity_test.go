package agent

import (
	"bytes"
	"encoding/json"
	"log/slog"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

const testRegistrationTokenHash = "c968fde29ef07289e9d15df007102af524add4996f8c85b671511fd70a6b6293"

func TestRegistrationTokenBindsPersistedIdentity(t *testing.T) {
	for _, tc := range []struct {
		name   string
		token  string
		hash   string
		reason string
		legacy bool
	}{
		{name: "same registration token", token: cpmock.RegistrationToken, hash: testRegistrationTokenHash},
		{name: "different registration token", token: "replacement-registration-token", hash: "7ebeb8ff3949cdace9ee851c66837f5ca5f8403a83c8c3d41d4c6569c25d76b9", reason: "registration token hash mismatch"},
		{name: "legacy state without hash", token: cpmock.RegistrationToken, hash: testRegistrationTokenHash, reason: "registration token hash is missing", legacy: true},
	} {
		t.Run(tc.name, func(t *testing.T) {
			cp := cpmock.New()
			t.Cleanup(cp.Close)
			k := newKong(t)
			path := filepath.Join(t.TempDir(), "kong.json")
			first := newTestAgent(t, cp, k, path)
			stopFirst := start(t, first)
			receive(t, cp.Registrations, nil)
			waitState(t, cp, "idle", 0)
			stopFirst()
			for len(cp.Statuses) > 0 {
				<-cp.Statuses
			}
			for len(cp.EventConnections) > 0 {
				<-cp.EventConnections
			}
			statePath := filepath.Join(first.config.StateDir, "node-state.json")
			tokenPath := filepath.Join(first.config.StateDir, "node-token")
			if tc.legacy {
				data, err := os.ReadFile(statePath)
				if err != nil {
					t.Fatal(err)
				}
				var state map[string]json.RawMessage
				if err := json.Unmarshal(data, &state); err != nil {
					t.Fatal(err)
				}
				delete(state, "registrationTokenHash")
				data, err = json.Marshal(state)
				if err != nil {
					t.Fatal(err)
				}
				if err := os.WriteFile(statePath, data, 0600); err != nil {
					t.Fatal(err)
				}
			}
			// Changing the registration credential leaves the old node token accepted.
			// Recovery must be triggered by disk/config comparison, without a 401.
			cp.SetRegistrationToken(tc.token)
			restarted := newTestAgent(t, cp, k, path)
			restarted.config.RegistrationToken, restarted.client.config.RegistrationToken = tc.token, tc.token
			var logs bytes.Buffer
			restarted.log = slog.New(slog.NewJSONHandler(&logs, nil))
			transport := restarted.client.http.Transport
			restarted.client.http.Transport = roundTripFunc(func(r *http.Request) (*http.Response, error) {
				if r.URL.Path == "/agent/v1/register" {
					if r.Header.Get("Authorization") != "Bearer "+tc.token {
						t.Error("registration did not use the configured credential")
					}
					if _, err := os.Stat(tokenPath); !os.IsNotExist(err) {
						t.Error("old node token was not deleted before registration")
					}
					freshData, err := os.ReadFile(statePath)
					var fresh map[string]json.RawMessage
					if err != nil || json.Unmarshal(freshData, &fresh) != nil {
						t.Error("fresh state was not written before registration")
					} else if string(fresh["registrationTokenHash"]) != `"`+tc.hash+`"` {
						t.Error("fresh state is not bound to the configured registration token")
					}
					cp.SetNodeToken("new-node-token")
				}
				return transport.RoundTrip(r)
			})
			stopRestart := start(t, restarted)
			if tc.reason != "" {
				receive(t, cp.Registrations, nil)
			}
			status := waitState(t, cp, "idle", 0)
			receive(t, cp.EventConnections, nil)
			stopRestart()
			if status.NodeID != "node-1" {
				t.Error("configured node identity changed")
			}
			select {
			case <-cp.Registrations:
				t.Error("unexpected extra registration")
			default:
			}
			savedData, err := os.ReadFile(statePath)
			if err != nil {
				t.Fatal(err)
			}
			var saved map[string]json.RawMessage
			if err := json.Unmarshal(savedData, &saved); err != nil {
				t.Fatal(err)
			}
			if string(saved["registrationTokenHash"]) != `"`+tc.hash+`"` {
				t.Error("saved registration hash does not match the configured token")
			}
			var state nodeState
			if err := json.Unmarshal(savedData, &state); err != nil {
				t.Fatal(err)
			}
			if state.ControlPlaneURL != cp.HTTP.URL || state.NodeID != "node-1" || state.Registration.ClusterID != cpmock.ClusterID || state.Registration.EnvironmentID != cpmock.EnvironmentID {
				t.Error("saved registration metadata is inconsistent")
			}
			wantToken := cpmock.NodeToken
			if tc.reason != "" {
				wantToken = "new-node-token"
			}
			savedToken, err := os.ReadFile(tokenPath)
			if err != nil || string(savedToken) != wantToken {
				t.Error("saved node token does not match the current registration")
			}
			for _, path := range []string{statePath, tokenPath} {
				info, err := os.Stat(path)
				if err != nil || info.Mode().Perm() != 0600 {
					t.Errorf("state file must have mode 0600: %v", err)
				}
			}
			if tc.reason != "" && (!strings.Contains(logs.String(), `"level":"WARN"`) || !strings.Contains(logs.String(), tc.reason)) {
				t.Error("missing warning explaining registration token change/upgrade")
			}
			if tc.reason == "" && strings.Contains(logs.String(), `"level":"WARN"`) {
				t.Error("same registration token was not reused silently")
			}
			for _, secret := range []string{cpmock.RegistrationToken, tc.token, cpmock.NodeToken, "new-node-token"} {
				if strings.Contains(string(savedData), secret) || strings.Contains(logs.String(), secret) {
					t.Error("token leaked to metadata or logs")
				}
			}
		})
	}
}
