package probe

import (
	"crypto/ed25519"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
)

// Report is the payload of a probe report (agent-protocol-v2, ProbeReport), its members in the schema's order.
type Report struct {
	ClusterID          string   `json:"clusterId"`
	PodUID             string   `json:"podUid"`
	BootID             string   `json:"bootId"`
	AdmissionID        string   `json:"admissionId"`
	Seq                uint64   `json:"seq"`
	PrevDigest         *string  `json:"prevDigest"`
	State              string   `json:"state"`
	FailedCapabilities []string `json:"failedCapabilities"`
	Challenge          *string  `json:"challenge"`
	LeaseRemainingMs   *uint64  `json:"leaseRemainingMs,omitempty"`
	Final              bool     `json:"final"`
	FinalReason        string   `json:"finalReason,omitempty"`
	KongStopConfirmed  *bool    `json:"kongStopConfirmed,omitempty"`
}

var reportHeader = []byte(`{"alg":"EdDSA","typ":"` + TypReport + `"}`)

// SignReport returns the report's JWS and its payload bytes as signed (what the next report's prevDigest hashes).
func SignReport(key ed25519.PrivateKey, r Report) (jws, payload []byte, err error) {
	if r.FailedCapabilities == nil {
		r.FailedCapabilities = []string{}
	}
	payload, err = json.Marshal(r)
	if err != nil {
		return nil, nil, err
	}
	return sign(key, reportHeader, payload), payload, nil
}

var (
	digestRE    = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)
	challengeRE = regexp.MustCompile(`^[A-Za-z0-9_-]{22,64}$`)
	reportCaps  = map[string]bool{"CAP-1": true, "CAP-2": true, "CAP-3": true, "CAP-4": true, "CAP-5": true, "CAP-6": true, "CAP-7": true, "guard-canary": true}
	podStates   = map[string]bool{"awaiting-admission": true, "verifying": true, "ok": true, "inconclusive": true, "kong-unavailable": true, "guard-missing": true, "no-proof": true, "violation": true}
)

// ParseReport decodes a report payload strictly, as the control plane does: the schema's members and types only.
func ParseReport(payload []byte) (Report, error) {
	raw, err := strictRaw(payload,
		[]string{"clusterId", "podUid", "bootId", "admissionId", "seq", "prevDigest", "state", "failedCapabilities", "challenge", "final"},
		[]string{"leaseRemainingMs", "finalReason", "kongStopConfirmed"})
	if err != nil {
		return Report{}, fmt.Errorf("report: %w", err)
	}
	var r Report
	str := func(name string, into *string) bool {
		v, ok := raw[name]
		return ok && len(v) > 0 && v[0] == '"' && json.Unmarshal(v, into) == nil
	}
	nullable := func(name string, into **string) bool {
		if string(raw[name]) == "null" {
			return true
		}
		var s string
		if !str(name, &s) {
			return false
		}
		*into = &s
		return true
	}
	if !str("clusterId", &r.ClusterID) || !str("podUid", &r.PodUID) || !str("bootId", &r.BootID) || !str("admissionId", &r.AdmissionID) ||
		!uuid(r.ClusterID) || !uuid(r.PodUID) || !uuid(r.BootID) || !uuid(r.AdmissionID) {
		return r, errors.New("report identifiers malformed")
	}
	if !digits.Match(raw["seq"]) || json.Unmarshal(raw["seq"], &r.Seq) != nil || r.Seq < 1 {
		return r, errors.New("report seq malformed")
	}
	if !nullable("prevDigest", &r.PrevDigest) || (r.PrevDigest == nil) != (r.Seq == 1) || (r.PrevDigest != nil && !digestRE.MatchString(*r.PrevDigest)) {
		return r, errors.New("report prevDigest malformed: null exactly for seq 1")
	}
	if !str("state", &r.State) || !podStates[r.State] {
		return r, errors.New("report state malformed")
	}
	var caps []json.RawMessage
	if v := raw["failedCapabilities"]; len(v) == 0 || v[0] != '[' || json.Unmarshal(v, &caps) != nil {
		return r, errors.New("report failedCapabilities malformed")
	}
	r.FailedCapabilities = []string{}
	seen := map[string]bool{}
	for _, item := range caps {
		var c string
		if len(item) == 0 || item[0] != '"' || json.Unmarshal(item, &c) != nil || !reportCaps[c] || seen[c] {
			return r, errors.New("report failedCapabilities malformed")
		}
		seen[c] = true
		r.FailedCapabilities = append(r.FailedCapabilities, c)
	}
	if r.State == "violation" && len(r.FailedCapabilities) == 0 {
		return r, errors.New("a violation report names its failed capabilities")
	}
	if !nullable("challenge", &r.Challenge) || (r.Challenge != nil && !challengeRE.MatchString(*r.Challenge)) {
		return r, errors.New("report challenge malformed")
	}
	if v, ok := raw["leaseRemainingMs"]; ok && string(v) != "null" {
		var ms uint64
		if !digits.Match(v) || json.Unmarshal(v, &ms) != nil {
			return r, errors.New("report leaseRemainingMs malformed")
		}
		r.LeaseRemainingMs = &ms
	}
	switch string(raw["final"]) {
	case "true":
		r.Final = true
	case "false":
	default:
		return r, errors.New("report final malformed")
	}
	_, hasReason := raw["finalReason"]
	_, hasStop := raw["kongStopConfirmed"]
	if r.Final != hasReason || r.Final != hasStop {
		return r, errors.New("finalReason and kongStopConfirmed go exactly with a final report")
	}
	if r.Final {
		if !str("finalReason", &r.FinalReason) || (r.FinalReason != "pod-terminated" && r.FinalReason != "node-reboot") {
			return r, errors.New("report finalReason malformed")
		}
		stop := string(raw["kongStopConfirmed"]) == "true"
		if !stop && string(raw["kongStopConfirmed"]) != "false" {
			return r, errors.New("report kongStopConfirmed malformed")
		}
		r.KongStopConfirmed = &stop
	}
	return r, nil
}

var digits = regexp.MustCompile(`^(0|[1-9][0-9]{0,17})$`)
