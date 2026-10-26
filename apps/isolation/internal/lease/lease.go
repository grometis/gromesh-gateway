// Package lease reads and checks the isolation lease (agent-protocol-v2, IsolationLease) the isolation-probe writes
// and the kong container's supervisor and liveness read. Validity is measured only in the node's CLOCK_BOOTTIME and
// bound to the node boot id; the wall clock never decides it, and any doubt makes the lease invalid.
package lease

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"strconv"
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

// Parse decodes a lease strictly, as the guard does: one top-level object, every field exactly once, no other field,
// the declared types, unsigned integers written only with digits, and nothing after the object.
func Parse(data []byte) (Lease, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.UseNumber()
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return Lease{}, errors.New("lease malformed: not an object")
	}
	fields := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		key, ok := tok.(string)
		if err != nil || !ok {
			return Lease{}, errors.New("lease malformed: key")
		}
		if _, dup := fields[key]; dup {
			return Lease{}, fmt.Errorf("lease malformed: duplicate %q", key)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return Lease{}, fmt.Errorf("lease malformed: %w", err)
		}
		fields[key] = raw
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return Lease{}, errors.New("lease malformed: unterminated object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return Lease{}, errors.New("lease malformed: trailing data")
	}
	var l Lease
	// The probe writes no escapes; both readers refuse them, so they never disagree on a document.
	str := func(name string, into *string) error {
		raw, ok := fields[name]
		if !ok || len(raw) == 0 || raw[0] != '"' || bytes.IndexByte(raw, '\\') >= 0 || json.Unmarshal(raw, into) != nil {
			return fmt.Errorf("lease malformed: %s", name)
		}
		return nil
	}
	num := func(name string, into *uint64) error {
		raw, ok := fields[name]
		if !ok || !digits.Match(raw) {
			return fmt.Errorf("lease malformed: %s", name)
		}
		v, err := strconv.ParseUint(string(raw), 10, 64)
		*into = v
		return err
	}
	for _, err := range []error{
		str("state", &l.State), str("podUid", &l.PodUID), str("bootId", &l.BootID), str("admissionId", &l.AdmissionID),
		num("issuedBoottimeNs", &l.IssuedBoottimeNs), num("expiresBoottimeNs", &l.ExpiresBoottimeNs),
		str("nonce", &l.Nonce), str("issuedAt", &l.IssuedAt),
	} {
		if err != nil {
			return Lease{}, err
		}
	}
	raw, ok := fields["capabilities"]
	var items []json.RawMessage
	if !ok || len(raw) == 0 || raw[0] != '[' || json.Unmarshal(raw, &items) != nil {
		return Lease{}, errors.New("lease malformed: capabilities")
	}
	seen := map[string]bool{}
	for _, item := range items {
		var c string
		if len(item) == 0 || item[0] != '"' || bytes.IndexByte(item, '\\') >= 0 || json.Unmarshal(item, &c) != nil || !capabilityRE.MatchString(c) || seen[c] {
			return Lease{}, errors.New("lease malformed: capabilities")
		}
		seen[c] = true
		l.Capabilities = append(l.Capabilities, c)
	}
	if len(fields) != 9 {
		return Lease{}, errors.New("lease malformed: unknown field")
	}
	return l, nil
}

var (
	digits       = regexp.MustCompile(`^(0|[1-9][0-9]{0,19})$`)
	capabilityRE = regexp.MustCompile(`^CAP-[1-7]$`)
)

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
