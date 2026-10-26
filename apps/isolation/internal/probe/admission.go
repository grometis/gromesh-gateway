package probe

import (
	"bytes"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
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

// Verify checks the signature over the received bytes and returns the decoded payload.
func Verify(raw []byte, key ed25519.PublicKey, into any) error {
	var jws JWS
	dec := json.NewDecoder(bytes.NewReader(raw))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&jws); err != nil {
		return fmt.Errorf("jws malformed: %w", err)
	}
	header, err := b64.DecodeString(jws.Protected)
	if err != nil {
		return errors.New("jws protected header malformed")
	}
	var h struct {
		Alg  string   `json:"alg"`
		Crit []string `json:"crit"`
	}
	if err := json.Unmarshal(header, &h); err != nil || h.Alg != "EdDSA" || len(h.Crit) > 0 {
		return errors.New("jws must be alg EdDSA without critical extensions")
	}
	signature, err := b64.DecodeString(jws.Signature)
	if err != nil || len(key) != ed25519.PublicKeySize || !ed25519.Verify(key, []byte(jws.Protected+"."+jws.Payload), signature) {
		return errors.New("jws signature invalid")
	}
	payload, err := b64.DecodeString(jws.Payload)
	if err != nil {
		return errors.New("jws payload malformed")
	}
	pd := json.NewDecoder(bytes.NewReader(payload))
	pd.DisallowUnknownFields()
	if err := pd.Decode(into); err != nil {
		return fmt.Errorf("jws payload: %w", err)
	}
	return nil
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
	var c AdmissionClaims
	if err := Verify(raw, instanceKey, &c); err != nil {
		return c, err
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
