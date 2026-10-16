package agent

import (
	"encoding/json"
	"fmt"
	"log/slog"
	"os"
	"path/filepath"
	"strings"
)

const defaultStateDir = "/var/lib/gromesh"

type identityStore struct {
	dir string
}

type nodeState struct {
	ControlPlaneURL string       `json:"controlPlaneUrl"`
	NodeID          string       `json:"nodeId"`
	Registration    Registration `json:"registration"`
}

func validRegistration(r Registration) bool {
	return r.NodeToken != "" && !strings.ContainsAny(r.NodeToken, "\r\n") && uuidPattern.MatchString(r.ClusterID) && uuidPattern.MatchString(r.EnvironmentID) && r.PollIntervalSeconds >= 5 && r.HeartbeatIntervalSeconds >= 5
}

func (s identityStore) load(config Config, logger *slog.Logger) (*Registration, error) {
	if err := os.MkdirAll(s.dir, 0700); err != nil {
		return nil, fmt.Errorf("create agent state directory: %w", err)
	}
	fresh := nodeState{ControlPlaneURL: config.ControlPlaneURL, NodeID: config.NodeID}
	reset := func(reason string) (*Registration, error) {
		// Reasons are fixed strings: corrupt state and credentials must never reach logs.
		logger.Warn("ignoring unusable persisted node state", "reason", reason)
		if err := s.revoke(); err != nil {
			return nil, err
		}
		// Clear the credential before publishing the configured identity, so a crash
		// between the two writes cannot pair an old token with the new identity.
		return nil, s.saveState(fresh)
	}
	data, err := os.ReadFile(filepath.Join(s.dir, "node-state.json"))
	if os.IsNotExist(err) {
		return reset("node state is missing")
	}
	if err != nil {
		return reset("cannot read node state")
	}
	var state nodeState
	if json.Unmarshal(data, &state) != nil {
		return reset("invalid node state JSON")
	}
	if state.ControlPlaneURL != config.ControlPlaneURL {
		return reset("control-plane URL mismatch")
	}
	if state.NodeID != config.NodeID {
		return reset("node ID mismatch")
	}
	token, err := os.ReadFile(filepath.Join(s.dir, "node-token"))
	if os.IsNotExist(err) {
		return reset("node token is missing")
	}
	if err != nil {
		return reset("cannot read node token")
	}
	state.Registration.NodeToken = string(token)
	if !validRegistration(state.Registration) {
		return reset("invalid persisted registration")
	}
	return &state.Registration, nil
}

func (s identityStore) saveState(state nodeState) error {
	state.Registration.NodeToken = ""
	data, err := json.Marshal(state)
	if err != nil {
		return fmt.Errorf("encode node state")
	}
	return s.write("node-state.json", data)
}

func (s identityStore) save(config Config, registration Registration) error {
	if err := s.saveState(nodeState{ControlPlaneURL: config.ControlPlaneURL, NodeID: config.NodeID, Registration: registration}); err != nil {
		return err
	}
	return s.write("node-token", []byte(registration.NodeToken))
}

func (s identityStore) write(name string, data []byte) error {
	// CreateTemp uses 0600; no partially written credential becomes visible at the final path.
	f, err := os.CreateTemp(s.dir, "."+name+"-*")
	if err != nil {
		return fmt.Errorf("create node state temporary file: %w", err)
	}
	defer os.Remove(f.Name())
	_, writeErr := f.Write(data)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return fmt.Errorf("write node state: %w", writeErr)
	}
	if closeErr != nil {
		return fmt.Errorf("close node state: %w", closeErr)
	}
	if err := os.Rename(f.Name(), filepath.Join(s.dir, name)); err != nil {
		return fmt.Errorf("publish node state: %w", err)
	}
	return syncDir(s.dir)
}

func (s identityStore) revoke() error {
	if err := os.Remove(filepath.Join(s.dir, "node-token")); err != nil && !os.IsNotExist(err) {
		return fmt.Errorf("delete revoked node token: %w", err)
	}
	return syncDir(s.dir)
}
