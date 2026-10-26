package probe

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"time"
)

// JWS is the flattened JSON serialization with an attached payload (agent-protocol-v2, Jws), alg EdDSA.
type JWS struct {
	Protected string `json:"protected"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// AdmissionClaims is the payload of an admission, signed with the instance key and recorded before signing.
type AdmissionClaims struct {
	ClusterID      string `json:"clusterId"`
	PodUID         string `json:"podUid"`
	NodeName       string `json:"nodeName"`
	BootID         string `json:"bootId"`
	AdmissionID    string `json:"admissionId"`
	ProbePublicKey string `json:"probePublicKey"`
	// Checked by the control plane's clock only.
	StartDeadline string `json:"startDeadline"`
}

// Identity is what the probe knows about itself; an admission for anything else is ignored.
type Identity struct {
	ClusterID string
	PodUID    string
	BootID    string
	PublicKey ed25519.PublicKey
}

var b64 = base64.RawURLEncoding

// strictObject decodes one JSON object until EOF with unique keys, exactly the names given, each a string.
func strictObject(data []byte, names ...string) (map[string]string, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("not an object")
	}
	allowed := map[string]bool{}
	for _, n := range names {
		allowed[n] = true
	}
	out := map[string]string{}
	for dec.More() {
		tok, err := dec.Token()
		key, ok := tok.(string)
		if err != nil || !ok || !allowed[key] {
			return nil, fmt.Errorf("unexpected field %v", tok)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("duplicate field %q", key)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		var value string
		if len(raw) == 0 || raw[0] != '"' || json.Unmarshal(raw, &value) != nil {
			return nil, fmt.Errorf("field %q must be a string", key)
		}
		out[key] = value
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, errors.New("unterminated object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data")
	}
	if len(out) != len(names) {
		return nil, errors.New("missing field")
	}
	return out, nil
}

// Verify checks the signature over the received bytes and returns the payload's fields (all strings here).
func Verify(raw []byte, key ed25519.PublicKey, names ...string) (map[string]string, error) {
	jws, err := strictObject(raw, "protected", "payload", "signature")
	if err != nil {
		return nil, fmt.Errorf("jws malformed: %w", err)
	}
	header, err := b64.DecodeString(jws["protected"])
	if err != nil {
		return nil, errors.New("jws protected header malformed")
	}
	if h, err := strictObject(header, "alg"); err != nil || h["alg"] != "EdDSA" {
		return nil, errors.New(`jws protected header must be exactly {"alg":"EdDSA"}`)
	}
	signature, err := b64.DecodeString(jws["signature"])
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, []byte(jws["protected"]+"."+jws["payload"]), signature) {
		return nil, errors.New("jws signature invalid")
	}
	payload, err := b64.DecodeString(jws["payload"])
	if err != nil {
		return nil, errors.New("jws payload malformed")
	}
	fields, err := strictObject(payload, names...)
	if err != nil {
		return nil, fmt.Errorf("jws payload: %w", err)
	}
	return fields, nil
}

// Sign is the counterpart, used by the control plane's tests and by the probe's own reports.
func Sign(key ed25519.PrivateKey, payload any) ([]byte, error) {
	body, err := json.Marshal(payload)
	if err != nil {
		return nil, err
	}
	protected := b64.EncodeToString([]byte(`{"alg":"EdDSA"}`))
	encoded := b64.EncodeToString(body)
	signature := ed25519.Sign(key, []byte(protected+"."+encoded))
	return json.Marshal(JWS{Protected: protected, Payload: encoded, Signature: b64.EncodeToString(signature)})
}

// CheckAdmission verifies an admission and that it is this probe's: its cluster, pod, boot and key.
func CheckAdmission(raw []byte, instanceKey ed25519.PublicKey, self Identity) (AdmissionClaims, error) {
	f, err := Verify(raw, instanceKey, "clusterId", "podUid", "nodeName", "bootId", "admissionId", "probePublicKey", "startDeadline")
	if err != nil {
		return AdmissionClaims{}, err
	}
	c := AdmissionClaims{ClusterID: f["clusterId"], PodUID: f["podUid"], NodeName: f["nodeName"], BootID: f["bootId"],
		AdmissionID: f["admissionId"], ProbePublicKey: f["probePublicKey"], StartDeadline: f["startDeadline"]}
	if _, err := time.Parse(time.RFC3339, c.StartDeadline); err != nil || len(c.NodeName) == 0 || len(c.NodeName) > 253 {
		return c, errors.New("admission claims malformed")
	}
	switch {
	case c.ClusterID != self.ClusterID:
		return c, errors.New("admission of another cluster")
	case c.PodUID != self.PodUID:
		return c, errors.New("admission of another pod")
	case c.BootID != self.BootID:
		return c, errors.New("admission of another boot")
	case c.ProbePublicKey != b64.EncodeToString(self.PublicKey):
		return c, errors.New("admission of another probe key")
	case !uuid(c.AdmissionID):
		return c, errors.New("admission id malformed")
	}
	return c, nil
}

func uuid(s string) bool {
	if len(s) != 36 {
		return false
	}
	for i, r := range s {
		dash := i == 8 || i == 13 || i == 18 || i == 23
		if dash != (r == '-') || (!dash && !(r >= '0' && r <= '9' || r >= 'a' && r <= 'f')) {
			return false
		}
	}
	return true
}
