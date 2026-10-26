package probe

import (
	"bytes"
	"crypto/ed25519"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"os"
	"regexp"
	"slices"
	"time"
)

// Typed protected headers of agent-protocol-v2 (Signatures).
const (
	TypAdmission = "gromesh-admission+json"
	TypRelease   = "gromesh-isolation-release+json"
	TypReport    = "gromesh-probe-report+json"
)

// JWS is the flattened JSON serialization with an attached payload (agent-protocol-v2, Jws), alg EdDSA.
type JWS struct {
	Protected string `json:"protected"`
	Payload   string `json:"payload"`
	Signature string `json:"signature"`
}

// AdmissionClaims is the payload of an admission, signed with an instance key and recorded before signing.
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

// ReleaseClaims is the payload of a release of a pendency, signed with an instance key.
type ReleaseClaims struct {
	ClusterID  string `json:"clusterId"`
	PendencyID string `json:"pendencyId"`
	Kind       string `json:"kind"`
	// Checked by the control plane's clock only: the probe uses a release only while the agent hands it over from
	// listIsolationReleases, which lists releases not expired.
	ExpiresAt string `json:"expiresAt"`
	// Admissions are what the release covers: each admission with the highest seq of its chain acknowledged when it
	// was issued.
	Admissions []ReleasedAdmission `json:"admissions"`
}

// ReleasedAdmission is one admission a release covers, through which seq of its chain.
type ReleasedAdmission struct {
	AdmissionID string `json:"admissionId"`
	ThroughSeq  uint64 `json:"throughSeq"`
}

// Identity is what the probe knows about itself; an admission for anything else is ignored.
type Identity struct {
	ClusterID string
	PodUID    string
	BootID    string
	PublicKey ed25519.PublicKey
}

// TrustSet is the probe's InstanceTrustSet: the only instance keys it trusts, by kid.
type TrustSet map[string]ed25519.PublicKey

var (
	b64      = base64.RawURLEncoding
	b64url   = regexp.MustCompile(`^[A-Za-z0-9_-]+$`)
	b64url43 = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
)

// Thumbprint is the RFC 7638 JWK thumbprint of an Ed25519 public key: the kid of an instance key.
func Thumbprint(publicKey string) string {
	sum := sha256.Sum256([]byte(`{"crv":"Ed25519","kty":"OKP","x":"` + publicKey + `"}`))
	return b64.EncodeToString(sum[:])
}

// decodeKey accepts only the canonical base64url of 32 bytes, so a key has exactly one spelling (and one kid).
func decodeKey(s string) (ed25519.PublicKey, error) {
	if !b64url43.MatchString(s) {
		return nil, errors.New("not 43 base64url characters")
	}
	raw, err := b64.Strict().DecodeString(s)
	if err != nil || len(raw) != ed25519.PublicKeySize || b64.EncodeToString(raw) != s {
		return nil, errors.New("not a canonical base64url Ed25519 public key")
	}
	return ed25519.PublicKey(raw), nil
}

// LoadTrustSet reads the trust set the chart renders. It is a configuration of the pod (a ConfigMap, whose files are
// symlinks the kubelet swaps atomically), never a file of the handoff.
func LoadTrustSet(path string) (TrustSet, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return nil, fmt.Errorf("instance trust set: %w", err)
	}
	return ParseTrustSet(data)
}

// ParseTrustSet refuses the whole set on any deviation: then no admission counts and no lease is issued.
func ParseTrustSet(data []byte) (TrustSet, error) {
	fail := func(why string) (TrustSet, error) { return nil, errors.New("instance trust set invalid: " + why) }
	top, err := strictRaw(data, []string{"keys"}, nil)
	if err != nil {
		return fail(err.Error())
	}
	dec := json.NewDecoder(bytes.NewReader(top["keys"]))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return fail("keys must be an array")
	}
	set, keys := TrustSet{}, map[string]bool{}
	for dec.More() {
		var item json.RawMessage
		if err := dec.Decode(&item); err != nil {
			return fail("keys malformed")
		}
		entry, err := strictObject(item, "kid", "publicKey")
		if err != nil {
			return fail(err.Error())
		}
		key, err := decodeKey(entry["publicKey"])
		switch {
		case err != nil:
			return fail("publicKey " + err.Error())
		case !b64url43.MatchString(entry["kid"]) || entry["kid"] != Thumbprint(entry["publicKey"]):
			return fail("kid " + entry["kid"] + " is not the RFC 7638 thumbprint of its publicKey")
		case set[entry["kid"]] != nil || keys[entry["publicKey"]]:
			return fail("duplicated kid or key")
		}
		set[entry["kid"]], keys[entry["publicKey"]] = key, true
	}
	if len(set) < 1 || len(set) > 3 {
		return fail("needs 1 to 3 keys")
	}
	return set, nil
}

// strictRaw decodes one JSON object until EOF with unique keys: every required name, optional ones at most once,
// nothing else.
func strictRaw(data []byte, required, optional []string) (map[string]json.RawMessage, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil, errors.New("not an object")
	}
	allowed := map[string]bool{}
	for _, n := range append(append([]string{}, required...), optional...) {
		allowed[n] = true
	}
	out := map[string]json.RawMessage{}
	for dec.More() {
		tok, err := dec.Token()
		key, ok := tok.(string)
		if err != nil || !ok || !allowed[key] {
			return nil, fmt.Errorf("unexpected member %v", tok)
		}
		if _, dup := out[key]; dup {
			return nil, fmt.Errorf("duplicated member %q", key)
		}
		var raw json.RawMessage
		if err := dec.Decode(&raw); err != nil {
			return nil, err
		}
		out[key] = raw
	}
	if tok, err := dec.Token(); err != nil || tok != json.Delim('}') {
		return nil, errors.New("unterminated object")
	}
	if _, err := dec.Token(); err != io.EOF {
		return nil, errors.New("trailing data")
	}
	for _, n := range required {
		if _, ok := out[n]; !ok {
			return nil, fmt.Errorf("missing member %q", n)
		}
	}
	return out, nil
}

// strictObject is strictRaw for an object whose members are exactly the names given, each a string.
func strictObject(data []byte, names ...string) (map[string]string, error) {
	raw, err := strictRaw(data, names, nil)
	if err != nil {
		return nil, err
	}
	out := map[string]string{}
	for key, value := range raw {
		var s string
		if len(value) == 0 || value[0] != '"' || json.Unmarshal(value, &s) != nil {
			return nil, fmt.Errorf("member %q must be a string", key)
		}
		out[key] = s
	}
	return out, nil
}

// verify checks a JWS whose protected header has exactly the members given (alg EdDSA and typ, plus kid for
// instance-signed documents), takes the key from key (never from the document), checks the signature over the received
// bytes and only then returns the decoded payload.
func verify(raw []byte, typ string, withKid bool, key func(kid string) (ed25519.PublicKey, error)) ([]byte, error) {
	jws, err := strictObject(raw, "protected", "payload", "signature")
	if err != nil {
		return nil, fmt.Errorf("jws malformed: %w", err)
	}
	for _, field := range []string{"protected", "payload", "signature"} {
		if !b64url.MatchString(jws[field]) {
			return nil, fmt.Errorf("jws %s must match ^[A-Za-z0-9_-]+$", field)
		}
	}
	header, err := b64.DecodeString(jws["protected"])
	if err != nil {
		return nil, errors.New("jws protected header malformed")
	}
	names := []string{"alg", "typ"}
	if withKid {
		names = append(names, "kid")
	}
	h, err := strictObject(header, names...)
	if err != nil {
		return nil, fmt.Errorf("jws protected header: %w", err)
	}
	if h["alg"] != "EdDSA" {
		return nil, fmt.Errorf("jws alg %q is not EdDSA", h["alg"])
	}
	if h["typ"] != typ {
		return nil, fmt.Errorf("jws typ %q is not %s", h["typ"], typ)
	}
	k, err := key(h["kid"])
	if err != nil {
		return nil, err
	}
	signature, err := b64.DecodeString(jws["signature"])
	if err != nil || len(k) != ed25519.PublicKeySize || !ed25519.Verify(k, []byte(jws["protected"]+"."+jws["payload"]), signature) {
		return nil, errors.New("jws signature invalid")
	}
	payload, err := b64.DecodeString(jws["payload"])
	if err != nil {
		return nil, errors.New("jws payload malformed")
	}
	return payload, nil
}

// VerifyInstance verifies a document signed with an instance key of trust: the kid must name one of its keys.
func VerifyInstance(raw []byte, typ string, trust TrustSet) (payload []byte, kid string, err error) {
	payload, err = verify(raw, typ, true, func(k string) (ed25519.PublicKey, error) {
		kid = k
		if key := trust[k]; key != nil {
			return key, nil
		}
		return nil, fmt.Errorf("jws kid %q is not in the instance trust set", k)
	})
	return payload, kid, err
}

// VerifyReport verifies a probe report with the probe key bound to its admission.
func VerifyReport(raw []byte, probeKey ed25519.PublicKey) ([]byte, error) {
	return verify(raw, TypReport, false, func(string) (ed25519.PublicKey, error) { return probeKey, nil })
}

// sign produces the flattened JWS with the protected header given as bytes (members in a fixed order).
func sign(key ed25519.PrivateKey, header []byte, payload []byte) []byte {
	protected := b64.EncodeToString(header)
	encoded := b64.EncodeToString(payload)
	signature := ed25519.Sign(key, []byte(protected+"."+encoded))
	out, _ := json.Marshal(JWS{Protected: protected, Payload: encoded, Signature: b64.EncodeToString(signature)})
	return out
}

// CheckAdmission verifies an admission against the trust set and that it is this probe's: its cluster, pod, boot and
// key. It returns the kid that signed it.
func CheckAdmission(raw []byte, trust TrustSet, self Identity) (AdmissionClaims, string, error) {
	payload, kid, err := VerifyInstance(raw, TypAdmission, trust)
	if err != nil {
		return AdmissionClaims{}, kid, err
	}
	f, err := strictObject(payload, "clusterId", "podUid", "nodeName", "bootId", "admissionId", "probePublicKey", "startDeadline")
	if err != nil {
		return AdmissionClaims{}, kid, fmt.Errorf("admission claims: %w", err)
	}
	c := AdmissionClaims{ClusterID: f["clusterId"], PodUID: f["podUid"], NodeName: f["nodeName"], BootID: f["bootId"],
		AdmissionID: f["admissionId"], ProbePublicKey: f["probePublicKey"], StartDeadline: f["startDeadline"]}
	if _, err := time.Parse(time.RFC3339, c.StartDeadline); err != nil || len(c.NodeName) == 0 || len(c.NodeName) > 253 || !b64url43.MatchString(c.ProbePublicKey) {
		return c, kid, errors.New("admission claims malformed")
	}
	switch {
	case c.ClusterID != self.ClusterID:
		return c, kid, errors.New("admission of another cluster")
	case c.PodUID != self.PodUID:
		return c, kid, errors.New("admission of another pod")
	case c.BootID != self.BootID:
		return c, kid, errors.New("admission of another boot")
	case c.ProbePublicKey != b64.EncodeToString(self.PublicKey):
		return c, kid, errors.New("admission of another probe key")
	case !uuid(c.AdmissionID):
		return c, kid, errors.New("admission id malformed")
	}
	return c, kid, nil
}

// CheckRelease verifies a release against the trust set and that it is of this cluster.
func CheckRelease(raw []byte, trust TrustSet, clusterID string) (ReleaseClaims, error) {
	payload, _, err := VerifyInstance(raw, TypRelease, trust)
	if err != nil {
		return ReleaseClaims{}, err
	}
	fields, err := strictRaw(payload, []string{"clusterId", "pendencyId", "kind", "expiresAt", "admissions"}, nil)
	if err != nil {
		return ReleaseClaims{}, fmt.Errorf("release claims: %w", err)
	}
	f := map[string]string{}
	for _, name := range []string{"clusterId", "pendencyId", "kind", "expiresAt"} {
		var s string
		if v := fields[name]; len(v) == 0 || v[0] != '"' || json.Unmarshal(v, &s) != nil {
			return ReleaseClaims{}, fmt.Errorf("release claims: member %q must be a string", name)
		}
		f[name] = s
	}
	c := ReleaseClaims{ClusterID: f["clusterId"], PendencyID: f["pendencyId"], Kind: f["kind"], ExpiresAt: f["expiresAt"]}
	if _, err := time.Parse(time.RFC3339, c.ExpiresAt); err != nil || !uuid(c.PendencyID) || (c.Kind != "confirmed-violation" && c.Kind != "unconfirmed-isolation") {
		return c, errors.New("release claims malformed")
	}
	if c.Admissions, err = releasedAdmissions(fields["admissions"]); err != nil {
		return c, fmt.Errorf("release claims: %w", err)
	}
	if c.ClusterID != clusterID {
		return c, errors.New("release of another cluster")
	}
	return c, nil
}

// releasedAdmissions decodes the admissions of a release strictly: an array of {admissionId, throughSeq}, each
// admission named once (two entries for one admission would leave its seq ambiguous).
func releasedAdmissions(data json.RawMessage) ([]ReleasedAdmission, error) {
	dec := json.NewDecoder(bytes.NewReader(data))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('[') {
		return nil, errors.New("admissions must be an array")
	}
	out := []ReleasedAdmission{}
	for dec.More() {
		var item json.RawMessage
		if err := dec.Decode(&item); err != nil {
			return nil, errors.New("admissions malformed")
		}
		f, err := strictRaw(item, []string{"admissionId", "throughSeq"}, nil)
		var a ReleasedAdmission
		if err != nil || len(f["admissionId"]) == 0 || f["admissionId"][0] != '"' || json.Unmarshal(f["admissionId"], &a.AdmissionID) != nil ||
			!uuid(a.AdmissionID) || !digits.Match(f["throughSeq"]) || json.Unmarshal(f["throughSeq"], &a.ThroughSeq) != nil {
			return nil, errors.New("admissions item malformed")
		}
		if slices.ContainsFunc(out, func(o ReleasedAdmission) bool { return o.AdmissionID == a.AdmissionID }) {
			return nil, errors.New("admission " + a.AdmissionID + " named twice")
		}
		out = append(out, a)
	}
	if _, err := dec.Token(); err != nil {
		return nil, errors.New("admissions malformed")
	}
	return out, nil
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
