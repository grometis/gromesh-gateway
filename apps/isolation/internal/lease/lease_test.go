package lease

import (
	"strings"
	"testing"
)

const (
	pod  = "6a1f3c2e-0b7d-4c1a-9f10-000000000001"
	boot = "0b5d6a4e-1f2c-4d3b-8a9e-7c6b5a4d3e2f"
)

func valid() Lease {
	return Lease{State: "ok", PodUID: pod, BootID: boot, AdmissionID: "6a1f3c2e-0b7d-4c1a-9f10-000000000002",
		IssuedBoottimeNs: 1_000_000_000_000, ExpiresBoottimeNs: 1_000_000_000_000 + uint64(Validity),
		Nonce: "AAAAAAAAAAAAAAAAAAAAAA", Capabilities: []string{"CAP-1"}, IssuedAt: "2026-10-26T00:00:00Z"}
}

func here(now uint64) Node { return Node{PodUID: pod, BootID: boot, Now: now, TimeNamespaceZero: true} }

func TestCheck(t *testing.T) {
	issued := valid().IssuedBoottimeNs
	cases := []struct {
		name   string
		lease  func(*Lease)
		node   func(*Node)
		reason string
	}{
		{name: "valid at issue", reason: ""},
		{name: "valid just before expiry", node: func(n *Node) { n.Now = issued + uint64(Validity) - 1 }},
		{name: "inconclusive still valid", lease: func(l *Lease) { l.State = "inconclusive" }},
		{name: "expired", node: func(n *Node) { n.Now = issued + uint64(Validity) }, reason: "expired"},
		{name: "issued in the future (clock went back)", node: func(n *Node) { n.Now = issued - 1 }, reason: "future"},
		{name: "violation", lease: func(l *Lease) { l.State = "violation" }, reason: "state"},
		{name: "no-proof", lease: func(l *Lease) { l.State = "no-proof" }, reason: "state"},
		{name: "guard-missing", lease: func(l *Lease) { l.State = "guard-missing" }, reason: "state"},
		{name: "other pod", lease: func(l *Lease) { l.PodUID = "6a1f3c2e-0b7d-4c1a-9f10-000000000009" }, reason: "another pod"},
		{name: "reader without pod uid", node: func(n *Node) { n.PodUID = "" }, reason: "another pod"},
		{name: "other boot", lease: func(l *Lease) { l.BootID = "0b5d6a4e-1f2c-4d3b-8a9e-000000000000" }, reason: "another boot"},
		{name: "reader without boot id", node: func(n *Node) { n.BootID = "" }, reason: "another boot"},
		{name: "longer validity", lease: func(l *Lease) { l.ExpiresBoottimeNs++ }, reason: "33 s"},
		{name: "expires before issue", lease: func(l *Lease) { l.ExpiresBoottimeNs = l.IssuedBoottimeNs - 1 }, reason: "33 s"},
		{name: "time namespace offset", node: func(n *Node) { n.TimeNamespaceZero = false }, reason: "time namespace"},
		{name: "clock unreadable", node: func(n *Node) { n.ClockErr = errClock }, reason: "CLOCK_BOOTTIME"},
		{name: "bad nonce", lease: func(l *Lease) { l.Nonce = "short" }, reason: "inconsistent"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			l, n := valid(), here(issued)
			if c.lease != nil {
				c.lease(&l)
			}
			if c.node != nil {
				c.node(&n)
			}
			err := Check(l, n)
			if c.reason == "" && err != nil {
				t.Fatalf("expected valid, got %v", err)
			}
			if c.reason != "" && (err == nil || !strings.Contains(err.Error(), c.reason)) {
				t.Fatalf("expected %q, got %v", c.reason, err)
			}
		})
	}
}

func TestParseIsStrict(t *testing.T) {
	for _, text := range []string{"", "{", `{"state":"ok","extra":1}`, `{"state":"ok"} {}`, `{"issuedBoottimeNs":-1}`} {
		if _, err := Parse([]byte(text)); err == nil {
			t.Errorf("%q must be refused", text)
		}
	}
	if _, err := Parse([]byte(`{"state":"ok","issuedBoottimeNs":18446744073709551615}`)); err != nil {
		t.Errorf("a full uint64 boottime must parse exactly: %v", err)
	}
}

type clockError struct{}

func (clockError) Error() string { return "boom" }

var errClock = clockError{}
