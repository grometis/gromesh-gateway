// Run: cd tests/load/agents && go test ./...
package main

import (
	"strings"
	"testing"
)

func TestSSEFrames(t *testing.T) {
	var versions []int
	err := readEvents(strings.NewReader(": heartbeat\r\nevent: ping\r\n\r\nid: 7\nevent: snapshot.published\ndata: {\"version\":7,\ndata: \"hash\":\"sha256:test\"}\n\n"), func(e publication) error { versions = append(versions, e.Version); return nil })
	if err != nil || len(versions) != 1 || versions[0] != 7 {
		t.Fatalf("versions=%v error=%v", versions, err)
	}
}
func TestRejectMalformedPublication(t *testing.T) {
	for _, input := range []string{"event: snapshot.published\ndata: bad\n\n", "event: snapshot.published\ndata: {}\n\n"} {
		if readEvents(strings.NewReader(input), func(publication) error { return nil }) == nil {
			t.Fatal("accepted malformed publication")
		}
	}
}
func TestConvergedRequiresEveryNodeAndVersion(t *testing.T) {
	p := publication{Version: 2, Hash: "sha256:test"}
	c := cluster{Status: "converged", Nodes: []nodeStatus{{State: "applied", AppliedVersion: 2, KongHealthy: true}}}
	if !c.converged(1, p) || c.converged(200, p) {
		t.Fatal("incorrect node count acceptance")
	}
	c.Nodes[0].AppliedVersion = 1
	if c.converged(1, p) {
		t.Fatal("accepted wrong version")
	}
}
