// Package lease reads and checks the isolation lease (agent-protocol-v2, IsolationLease) the isolation-probe writes
// and the kong container's supervisor and liveness read. Validity is measured only in the node's CLOCK_BOOTTIME and
// bound to the node boot id; the wall clock never decides it, and any doubt makes the lease invalid.
package lease

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"regexp"
	"time"
)

// Validity is V = 2P + T (probe period 15 s, round 3 s); a lease of any other length is refused.
const Validity = 33 * time.Second

// Lease is the file /gromesh/isolation/lease.json.
type Lease struct {
	State             string   `json:"state"`
	PodUID            string   `json:"podUid"`
	BootID            string   `json:"bootId"`
	AdmissionID       string   `json:"admissionId"`
	IssuedBoottimeNs  uint64   `json:"issuedBoottimeNs"`
	ExpiresBoottimeNs uint64   `json:"expiresBoottimeNs"`
	Nonce             string   `json:"nonce"`
	Capabilities      []string `json:"capabilities"`
	IssuedAt          string   `json:"issuedAt"`
}

// Node is what the reader observes about itself when it checks a lease.
type Node struct {
	PodUID string
	BootID string
	// Now is CLOCK_BOOTTIME in nanoseconds; ClockErr is set when it could not be read.
	Now      uint64
	ClockErr error
	// TimeNamespaceZero is false when /proc/self/timens_offsets has a non-zero offset or could not be read.
	TimeNamespaceZero bool
}

var (
	uuidRE  = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	nonceRE = regexp.MustCompile(`^[A-Za-z0-9_-]{22,64}$`)
)

// Read parses the lease file; any error (missing, unreadable, malformed, unknown field) is an invalid lease.
func Read(path string) (Lease, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Lease{}, fmt.Errorf("lease unreadable: %w", err)
	}
	return Parse(data)
}

// Parse decodes a lease strictly: unknown fields and trailing data are refused.
func Parse(data []byte) (Lease, error) {
	var l Lease
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&l); err != nil {
		return Lease{}, fmt.Errorf("lease malformed: %w", err)
	}
	if dec.More() {
		return Lease{}, errors.New("lease malformed: trailing data")
	}
	return l, nil
}

// Check returns nil only for a lease that is valid for this reader right now.
func Check(l Lease, n Node) error {
	switch {
	case n.ClockErr != nil:
		return fmt.Errorf("CLOCK_BOOTTIME unreadable: %w", n.ClockErr)
	case !n.TimeNamespaceZero:
		return errors.New("time namespace offset is not zero")
	case !uuidRE.MatchString(n.PodUID) || l.PodUID != n.PodUID:
		return errors.New("lease of another pod")
	case !uuidRE.MatchString(n.BootID) || l.BootID != n.BootID:
		return errors.New("lease of another boot")
	case l.State != "ok" && l.State != "inconclusive":
		return fmt.Errorf("lease state %q", l.State)
	case !uuidRE.MatchString(l.AdmissionID) || !nonceRE.MatchString(l.Nonce):
		return errors.New("lease fields inconsistent")
	case l.ExpiresBoottimeNs < l.IssuedBoottimeNs || l.ExpiresBoottimeNs-l.IssuedBoottimeNs != uint64(Validity):
		return errors.New("lease validity is not 33 s")
	case n.Now < l.IssuedBoottimeNs:
		return errors.New("lease issued in the future")
	case n.Now >= l.ExpiresBoottimeNs:
		return errors.New("lease expired")
	}
	return nil
}
