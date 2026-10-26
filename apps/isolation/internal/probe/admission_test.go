package probe

import (
	"bytes"
	"context"
	"crypto/ed25519"
	"encoding/hex"
	"encoding/json"
	"os"
	"strings"
	"testing"
)

// vector is contracts/examples/isolation-signatures.example.json, the byte-level vector the control plane signs to.
type vector struct {
	Seeds struct {
		Instance, UnknownInstance, Probe string
	} `json:"testOnlySeedsHex"`
	TrustSet        json.RawMessage `json:"trustSet"`
	Admission       json.RawMessage `json:"admission"`
	AdmissionClaims AdmissionClaims `json:"admissionClaims"`
	Release         json.RawMessage `json:"release"`
	ReleaseClaims   ReleaseClaims   `json:"releaseClaims"`
	Report          json.RawMessage `json:"report"`
	ReportClaims    json.RawMessage `json:"reportClaims"`
	MustRefuse      []struct {
		Reason string          `json:"reason"`
		JWS    json.RawMessage `json:"jws"`
	} `json:"mustRefuse"`
}

func loadVector(t *testing.T) vector {
	t.Helper()
	data, err := os.ReadFile("../../../../contracts/examples/isolation-signatures.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var v vector
	if err := json.Unmarshal(data, &v); err != nil {
		t.Fatal(err)
	}
	return v
}

func seedKey(t *testing.T, seedHex string) ed25519.PrivateKey {
	t.Helper()
	seed, err := hex.DecodeString(seedHex)
	if err != nil || len(seed) != ed25519.SeedSize {
		t.Fatalf("seed %q", seedHex)
	}
	return ed25519.NewKeyFromSeed(seed)
}

func (v vector) self(t *testing.T) Identity {
	c := v.AdmissionClaims
	return Identity{ClusterID: c.ClusterID, PodUID: c.PodUID, BootID: c.BootID, PublicKey: seedKey(t, v.Seeds.Probe).Public().(ed25519.PublicKey)}
}

func TestTheContractVectorIsAcceptedExactly(t *testing.T) {
	v := loadVector(t)
	trust, err := ParseTrustSet(v.TrustSet)
	if err != nil {
		t.Fatal(err)
	}
	instance := seedKey(t, v.Seeds.Instance)
	if !bytes.Equal(trust["LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic"], instance.Public().(ed25519.PublicKey)) {
		t.Fatal("the vector's kid does not name the instance key derived from its seed")
	}
	claims, kid, err := CheckAdmission(v.Admission, trust, v.self(t))
	if err != nil || claims != v.AdmissionClaims || kid != "LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic" {
		t.Fatalf("admission: %v %+v %s", err, claims, kid)
	}
	release, err := CheckRelease(v.Release, trust, v.AdmissionClaims.ClusterID)
	if err != nil || release != v.ReleaseClaims {
		t.Fatalf("release: %v %+v", err, release)
	}
	if _, err := CheckRelease(v.Release, trust, "00000000-0000-4000-8000-00000000c002"); err == nil {
		t.Fatal("a release of another cluster was accepted")
	}
	// The probe's own report: the same bytes as the vector (Ed25519 is deterministic), and it verifies.
	probeKey := seedKey(t, v.Seeds.Probe)
	payload, err := VerifyReport(v.Report, probeKey.Public().(ed25519.PublicKey))
	if err != nil {
		t.Fatal(err)
	}
	report, err := ParseReport(payload)
	if err != nil {
		t.Fatal(err)
	}
	signed, _, err := SignReport(probeKey, report)
	if err != nil {
		t.Fatal(err)
	}
	var compact bytes.Buffer
	_ = json.Compact(&compact, v.Report)
	if !bytes.Equal(signed, compact.Bytes()) {
		t.Fatalf("our report differs from the vector:\n%s\n%s", signed, compact.Bytes())
	}
	var want bytes.Buffer
	_ = json.Compact(&want, v.ReportClaims)
	if !bytes.Equal(payload, want.Bytes()) {
		t.Fatalf("report payload differs from reportClaims:\n%s\n%s", payload, want.Bytes())
	}
	// Documents are typed: an admission is not a release, nor a report, and the reverse.
	if _, err := CheckRelease(v.Admission, trust, v.AdmissionClaims.ClusterID); err == nil {
		t.Fatal("an admission was accepted as a release")
	}
	if _, err := VerifyReport(v.Admission, instance.Public().(ed25519.PublicKey)); err == nil {
		t.Fatal("an admission was accepted as a report")
	}
	if _, _, err := CheckAdmission(v.Report, trust, v.self(t)); err == nil {
		t.Fatal("a report was accepted as an admission")
	}
}

// Every case is refused, and for its own reason: a check that stops being made fails its case here.
func TestEveryMustRefuseCaseOfTheVectorIsRefusedForItsReason(t *testing.T) {
	v := loadVector(t)
	trust, err := ParseTrustSet(v.TrustSet)
	if err != nil {
		t.Fatal(err)
	}
	why := map[string]string{
		"unknown kid (signed by a key outside the trust set)": "is not in the instance trust set",
		"known kid, signed by another key":                    "signature invalid",
		"release presented as an admission (typ)":             `typ "gromesh-isolation-release+json"`,
		"no typ":                                 `missing member "typ"`,
		"no kid":                                 `missing member "kid"`,
		"embedded jwk header member":             "unexpected member jwk",
		"crit header member":                     "unexpected member crit",
		"alg other than EdDSA":                   `alg "none"`,
		"payload member outside AdmissionClaims": "unexpected member extra",
		"duplicated header member":               `duplicated member "typ"`,
		"payload changed after signing (signature invalid)": "signature invalid",
	}
	if len(v.MustRefuse) != len(why) {
		t.Fatalf("the vector has %d cases to refuse, this test knows %d", len(v.MustRefuse), len(why))
	}
	for _, c := range v.MustRefuse {
		_, _, err := CheckAdmission(c.JWS, trust, v.self(t))
		if err == nil {
			t.Errorf("%s: accepted", c.Reason)
			continue
		}
		if want, ok := why[c.Reason]; !ok || !strings.Contains(err.Error(), want) {
			t.Errorf("%s: refused for another reason: %v", c.Reason, err)
		}
	}
}

func TestTheTrustSetIsRefusedWholeOnAnyDeviation(t *testing.T) {
	v := loadVector(t)
	good := string(v.TrustSet)
	if _, err := ParseTrustSet([]byte(good)); err != nil {
		t.Fatal(err)
	}
	_, other := instanceKey()
	otherPub := ""
	{
		priv, _ := instanceKey()
		otherPub = b64.EncodeToString(priv.Public().(ed25519.PublicKey))
	}
	entry := func(kid, key string) string { return `{"kid":"` + kid + `","publicKey":"` + key + `"}` }
	k1 := entry("LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic", "vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4")
	k2 := entry(Thumbprint(otherPub), otherPub)
	for name, doc := range map[string]string{
		"empty":              `{"keys":[]}`,
		"four keys":          `{"keys":[` + k1 + `,` + k2 + `,` + entry(Thumbprint(b64.EncodeToString(make([]byte, 32))), b64.EncodeToString(make([]byte, 32))) + `,` + entry(Thumbprint(strings.Repeat("A", 42)+"E"), strings.Repeat("A", 42)+"E") + `]}`,
		"wrong thumbprint":   `{"keys":[` + entry(other, "vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4") + `]}`,
		"duplicated kid":     `{"keys":[` + k1 + `,` + k1 + `]}`,
		"unknown member":     `{"keys":[{"kid":"LduU6YNgsIRbClfLYYXfg5VEWL3S5q8TsrvV01NRaic","publicKey":"vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V4","use":"sig"}]}`,
		"unknown top member": `{"keys":[` + k1 + `],"x":1}`,
		"malformed key":      `{"keys":[` + entry(Thumbprint("vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V"), "vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V") + `]}`,
		"non-canonical key":  `{"keys":[` + entry(Thumbprint("vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V5"), "vIeB87e8hCwQ5rBCgRDOAdhiVQhLPBJSuNoepr249V5") + `]}`,
		"duplicated member":  `{"keys":[` + k1 + `],"keys":[` + k2 + `]}`,
		"trailing data":      good + `{}`,
		"keys not an array":  `{"keys":{}}`,
	} {
		if _, err := ParseTrustSet([]byte(doc)); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	if set, err := ParseTrustSet([]byte(`{"keys":[` + k1 + `,` + k2 + `]}`)); err != nil || len(set) != 2 {
		t.Fatalf("two keys of a rotation: %v", err)
	}
}

func TestAnAdmissionWhoseKidLeavesTheTrustSetStopsCountingAtTheNextRound(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.expect("verifying", true)
	// The rollout of the chart without the key: another key only.
	rotated, kid := instanceKey()
	w.trust = TrustSet{kid: rotated.Public().(ed25519.PublicKey)}
	w.now += uint64(Period)
	w.round()
	w.expect("awaiting-admission", false)
	// The same admission handed again is still refused; one signed with the key of the set is adopted.
	w.round()
	w.expect("awaiting-admission", false)
	w.instKey, w.kid = rotated, kid
	w.admit(func(c *AdmissionClaims) { c.AdmissionID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ae" })
	w.round()
	w.expect("verifying", true)
}

func TestAnInvalidTrustSetIssuesNoLease(t *testing.T) {
	w := newWorld(t, t.TempDir())
	w.admit(nil)
	w.round()
	w.canary = CanaryResult{Status: 204, Nonce: w.p.State.Nonce}
	w.p.CanaryStep(context.Background())
	w.expect("ok", true)
	good := w.trust
	w.trust = nil
	w.now += uint64(Period)
	w.round()
	w.expect("no-proof", false)
	// Fixed again: the admission counts again, after the two passes no-proof needs.
	w.trust = good
	w.round()
	w.expect("no-proof", false)
	w.round()
	w.expect("verifying", true)
}

func TestReleasesAndReportsAreTypedToo(t *testing.T) {
	w := newWorld(t, t.TempDir())
	release := ReleaseClaims{ClusterID: cluster, PendencyID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000e1", Kind: "confirmed-violation", ExpiresAt: "2026-10-26T12:15:00Z"}
	if _, err := CheckRelease(signInstance(w.instKey, w.kid, TypRelease, release), w.trust, cluster); err != nil {
		t.Fatal(err)
	}
	for name, raw := range map[string][]byte{
		"admission typ":       signInstance(w.instKey, w.kid, TypAdmission, release),
		"unknown kid":         signInstance(w.instKey, "x"+w.kid[1:], TypRelease, release),
		"unknown kind":        signInstance(w.instKey, w.kid, TypRelease, ReleaseClaims{ClusterID: cluster, PendencyID: release.PendencyID, Kind: "everything", ExpiresAt: release.ExpiresAt}),
		"report-style header": sign(w.instKey, []byte(`{"alg":"EdDSA","typ":"`+TypRelease+`"}`), []byte(`{}`)),
	} {
		if _, err := CheckRelease(raw, w.trust, cluster); err == nil {
			t.Errorf("%s: accepted", name)
		}
	}
	// A report header carries no kid: one with a kid is refused.
	jws, _, _ := SignReport(w.p.key, Report{ClusterID: cluster, PodUID: pod, BootID: boot1, AdmissionID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad", Seq: 1, State: "ok"})
	if _, err := VerifyReport(jws, w.p.key.Public().(ed25519.PublicKey)); err != nil {
		t.Fatal(err)
	}
	withKid := sign(w.p.key, []byte(`{"alg":"EdDSA","kid":"`+w.kid+`","typ":"`+TypReport+`"}`), []byte(`{}`))
	if _, err := VerifyReport(withKid, w.p.key.Public().(ed25519.PublicKey)); err == nil {
		t.Fatal("a report header with a kid was accepted")
	}
}
