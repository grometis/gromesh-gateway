package probe

import (
	"encoding/json"
	"path/filepath"
	"regexp"
	"time"
)

// AppliedRevision is the agent's applied.json (agent-protocol-v2): the last revision Kong confirmed in this pod. It
// proves nothing alone; the probe copies it into a signed report only when the canary served its kongConfigHash.
type AppliedRevision struct {
	InstanceID     string
	Epoch          int64
	Revision       int64
	Hash           string
	KongConfigHash string
}

var kongHashRE = regexp.MustCompile(`^[0-9a-f]{32}$`)

// readApplied returns the pod's applied.json, or nil when it is missing, unreadable, invalid, or names another
// instance, cluster or pod: all of which count as absent. Without a configured instance nothing is ever present.
func (p *Probe) readApplied() *AppliedRevision {
	if p.InstanceID == "" {
		return nil
	}
	raw, err := readHandoff(filepath.Join(p.Handoff, "applied.json"), 4<<10)
	if err != nil {
		return nil
	}
	f, err := strictRaw(raw, []string{"instanceId", "clusterId", "nodeId", "podUid", "epoch", "revision", "hash", "kongConfigHash", "result", "appliedAt"}, nil)
	if err != nil {
		return nil
	}
	var a AppliedRevision
	var cluster, node, pod, result, at string
	for name, into := range map[string]*string{"instanceId": &a.InstanceID, "clusterId": &cluster, "nodeId": &node, "podUid": &pod,
		"hash": &a.Hash, "kongConfigHash": &a.KongConfigHash, "result": &result, "appliedAt": &at} {
		if v := f[name]; len(v) == 0 || v[0] != '"' || json.Unmarshal(v, into) != nil {
			return nil
		}
	}
	for name, into := range map[string]*int64{"epoch": &a.Epoch, "revision": &a.Revision} {
		if !digits.Match(f[name]) || json.Unmarshal(f[name], into) != nil || *into < 1 {
			return nil
		}
	}
	if _, err := time.Parse(time.RFC3339Nano, at); err != nil || result != "applied" || node == "" || len(node) > 253 {
		return nil
	}
	if a.InstanceID != p.InstanceID || cluster != p.ClusterID || pod != p.PodUID || !digestRE.MatchString(a.Hash) || !kongHashRE.MatchString(a.KongConfigHash) {
		return nil
	}
	return &a
}
