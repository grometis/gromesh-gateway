package agent

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"regexp"
	"time"
)

var (
	hashPattern = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	uuidPattern = regexp.MustCompile(`^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$`)
	kongVersionPattern = regexp.MustCompile(`^[0-9]+\.[0-9]+\.[0-9]+$`)
)

type RegisterRequest struct {
	NodeID       string            `json:"nodeId"`
	Hostname     string            `json:"hostname"`
	KongVersion  string            `json:"kongVersion"`
	AgentVersion string            `json:"agentVersion"`
	Labels       map[string]string `json:"labels,omitempty"`
}

type Registration struct {
	NodeToken                string `json:"nodeToken"`
	ClusterID                string `json:"clusterId"`
	EnvironmentID            string `json:"environmentId"`
	PollIntervalSeconds      int    `json:"pollIntervalSeconds"`
	HeartbeatIntervalSeconds int    `json:"heartbeatIntervalSeconds"`
}

type Snapshot struct {
	Version       int64           `json:"version"`
	Hash          string          `json:"hash"`
	EnvironmentID string          `json:"environmentId"`
	CreatedAt     string          `json:"createdAt"`
	Config        json.RawMessage `json:"config"`
}

func DecodeSnapshot(data []byte) (*Snapshot, error) {
	var s Snapshot
	d := json.NewDecoder(bytes.NewReader(data))
	d.DisallowUnknownFields()
	if err := d.Decode(&s); err != nil {
		return nil, fmt.Errorf("invalid snapshot envelope")
	}
	if err := d.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, fmt.Errorf("invalid trailing snapshot data")
	}
	if s.Version < 1 || !hashPattern.MatchString(s.Hash) || !uuidPattern.MatchString(s.EnvironmentID) {
		return nil, fmt.Errorf("invalid snapshot version, hash or environment ID")
	}
	if _, err := time.Parse(time.RFC3339Nano, s.CreatedAt); err != nil {
		return nil, fmt.Errorf("invalid snapshot creation time")
	}
	config := bytes.TrimSpace(s.Config)
	if len(config) == 0 || config[0] != '{' || !json.Valid(config) {
		return nil, fmt.Errorf("snapshot config must be a JSON object")
	}
	return &s, nil
}

// MarshalJSON preserves config bytes; only the compiler interprets their contents.
func (s Snapshot) MarshalJSON() ([]byte, error) {
	metadata := struct {
		Version       int64  `json:"version"`
		Hash          string `json:"hash"`
		EnvironmentID string `json:"environmentId"`
		CreatedAt     string `json:"createdAt"`
	}{s.Version, s.Hash, s.EnvironmentID, s.CreatedAt}
	b, err := json.Marshal(metadata)
	if err != nil {
		return nil, err
	}
	b = append(b[:len(b)-1], []byte(`,"config":`)...)
	b = append(b, s.Config...)
	return append(b, '}'), nil
}

type StatusReport struct {
	NodeID         string  `json:"nodeId"`
	State          string  `json:"state"`
	AppliedVersion *int64  `json:"appliedVersion"`
	AppliedHash    *string `json:"appliedHash"`
	FailedVersion  *int64  `json:"failedVersion"`
	Error          *string `json:"error"`
	KongHealthy    bool    `json:"kongHealthy"`
	ReportedAt     string  `json:"reportedAt"`
}
