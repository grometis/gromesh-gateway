package agent

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"slices"
	"strings"
	"sync"
	"syscall"
	"testing"
	"time"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

const (
	testPod      = "00000000-0000-4000-8000-00000000d001"
	testBoot     = "00000000-0000-4000-8000-00000000b001"
	testProbeKey = "eJruDCDhWRkOIQ6emzNVbcRU3eSRGM7oJ90NR5dQACU"
	admissionA   = "00000000-0000-4000-8000-00000000a001"
	testRequest  = "00000000-0000-4000-8000-0000000000f1"
	// As the control plane may send it: whitespace and member order are the agent's to keep, not to rewrite.
	grantedJWS = `{ "payload": "eyJ9", "protected": "eyJh", "signature": "c2ln" }`
)

// fakeIsolation is the control plane's side of agent protocol v2 (isolation), recording what the agent sends.
type fakeIsolation struct {
	mu        sync.Mutex
	asks      []map[string]string
	polls     int
	decide    func(ask, poll int) string // outcome of the poll
	challenge string                     // JSON value; "" answers 500
	releases  string                     // JSON body; "" answers 500
	batches   [][]json.RawMessage
	ack       func(batch []json.RawMessage) string
}

func (f *fakeIsolation) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	status := func(outcome string) string {
		switch outcome {
		case "granted":
			return fmt.Sprintf(`{"requestId":%q,"outcome":"granted","challenge":"Q2hhbGxlbmdlLXRlc3Qtb25seS0x","admission":%s}`, testRequest, grantedJWS)
		case "refused":
			return fmt.Sprintf(`{"requestId":%q,"outcome":"refused","challenge":"Q2hhbGxlbmdlLXRlc3Qtb25seS0x","reason":"chain-not-answered"}`, testRequest)
		}
		return fmt.Sprintf(`{"requestId":%q,"outcome":"pending","challenge":"Q2hhbGxlbmdlLXRlc3Qtb25seS0x"}`, testRequest)
	}
	switch r.Method + " " + r.URL.Path {
	case "POST /agent/v2/isolation/admission-requests":
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.asks = append(f.asks, body)
		w.WriteHeader(http.StatusAccepted)
		fmt.Fprint(w, status("pending"))
	case "GET /agent/v2/isolation/admission-requests/" + testRequest:
		f.polls++
		outcome := "pending"
		if f.decide != nil {
			outcome = f.decide(len(f.asks), f.polls)
		}
		fmt.Fprint(w, status(outcome))
	case "GET /agent/v2/isolation/challenge":
		if f.challenge == "" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprintf(w, `{"challenge":%s}`, f.challenge)
	case "GET /agent/v2/isolation/releases":
		if f.releases == "" {
			w.WriteHeader(http.StatusInternalServerError)
			return
		}
		fmt.Fprint(w, f.releases)
	case "POST /agent/v2/isolation/reports":
		var body struct {
			Reports []json.RawMessage `json:"reports"`
		}
		_ = json.NewDecoder(r.Body).Decode(&body)
		f.batches = append(f.batches, body.Reports)
		if f.ack != nil {
			fmt.Fprint(w, f.ack(body.Reports))
			return
		}
		fmt.Fprintf(w, `{"acks":[{"admissionId":%q,"ackedSeq":%d}],"rejected":[]}`, admissionA, seqOf(body.Reports[len(body.Reports)-1]))
	default:
		http.NotFound(w, r)
	}
}

func (f *fakeIsolation) snapshot() (asks []map[string]string, polls int, batches [][]json.RawMessage) {
	f.mu.Lock()
	defer f.mu.Unlock()
	return slices.Clone(f.asks), f.polls, slices.Clone(f.batches)
}

func report(admission string, seq int) []byte {
	payload := base64.RawURLEncoding.EncodeToString(fmt.Appendf(nil, `{"admissionId":%q,"seq":%d}`, admission, seq))
	return fmt.Appendf(nil, `{"protected":"eyJhbGciOiJFZERTQSJ9","payload":%q,"signature":"c2ln"}`, payload)
}

func seqOf(raw json.RawMessage) int {
	var jws struct{ Payload string }
	_ = json.Unmarshal(raw, &jws)
	payload, _ := base64.RawURLEncoding.DecodeString(jws.Payload)
	var r struct{ Seq int }
	_ = json.Unmarshal(payload, &r)
	return r.Seq
}

type isolationWorld struct {
	t       *testing.T
	cp      *fakeIsolation
	server  *httptest.Server
	handoff string
	state   string
	boot    string
}

func newIsolationWorld(t *testing.T) *isolationWorld {
	w := &isolationWorld{t: t, cp: &fakeIsolation{challenge: "null", releases: `{"items":[]}`}, handoff: t.TempDir(), state: t.TempDir()}
	w.server = httptest.NewServer(http.HandlerFunc(func(rw http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer node-token" {
			t.Error("isolation request without the node token")
		}
		w.cp.ServeHTTP(rw, r)
	}))
	t.Cleanup(w.server.Close)
	w.boot = filepath.Join(w.state, "boot_id")
	_ = os.WriteFile(w.boot, []byte(testBoot+"\n"), 0o644)
	_ = os.Mkdir(filepath.Join(w.handoff, "outbox"), 0o755)
	return w
}

func (w *isolationWorld) agent() *isolation {
	config := Config{ControlPlaneURL: w.server.URL, HandoffDir: w.handoff, StateDir: w.state, PodUID: testPod, PodName: "dp-0", NodeName: "worker-1", BootIDFile: w.boot}
	c := &client{config: config, http: w.server.Client(), token: "node-token", unauthorized: make(chan struct{}, 1)}
	return &isolation{config: config, client: c, log: slog.New(slog.NewJSONHandler(io.Discard, nil)), interval: 10 * time.Millisecond, retry: func(int) time.Duration { return 0 }}
}

func (w *isolationWorld) file(name string) string {
	data, err := os.ReadFile(filepath.Join(w.handoff, name))
	if err != nil {
		return ""
	}
	return string(data)
}

func (w *isolationWorld) write(name, content string) {
	w.t.Helper()
	if err := os.WriteFile(filepath.Join(w.handoff, name), []byte(content), 0o644); err != nil {
		w.t.Fatal(err)
	}
}

func TestTheAdmissionIsAskedPolledAndHandedOverAsReceived(t *testing.T) {
	w := newIsolationWorld(t)
	w.cp.decide = func(_, poll int) string {
		if poll < 2 {
			return "pending"
		}
		return "granted"
	}
	a := w.agent()
	a.step(t.Context())
	if w.file("admission.jws") != "" {
		t.Fatal("an admission without the probe's key")
	}
	w.write("probe.pub", testProbeKey)
	a.step(t.Context())
	if w.file("admission.jws") != "" {
		t.Fatal("a pending request handed over an admission")
	}
	a.step(t.Context())
	if got := w.file("admission.jws"); got != grantedJWS {
		t.Fatalf("admission.jws %q, want the bytes received", got)
	}
	a.step(t.Context())
	asks, polls, _ := w.cp.snapshot()
	want := map[string]string{"podUid": testPod, "podName": "dp-0", "nodeName": "worker-1", "bootId": testBoot, "probePublicKey": testProbeKey}
	if len(asks) != 1 || fmt.Sprint(asks[0]) != fmt.Sprint(want) || polls != 2 {
		t.Fatalf("asks %v polls %d", asks, polls)
	}
}

func TestARefusedRequestIsAskedAgainAndAPendingOneSurvivesARestart(t *testing.T) {
	w := newIsolationWorld(t)
	w.write("probe.pub", testProbeKey)
	w.cp.decide = func(ask, _ int) string {
		if ask == 1 {
			return "refused"
		}
		return "pending"
	}
	a := w.agent()
	a.step(t.Context())
	a.step(t.Context())
	// A restart while pending: the same request is polled, never a second one (409 for the same pod and boot).
	w.agent().step(t.Context())
	asks, polls, _ := w.cp.snapshot()
	if len(asks) != 2 || polls != 3 {
		t.Fatalf("asks %d polls %d", len(asks), polls)
	}
	w.cp.decide = func(int, int) string { return "granted" }
	w.agent().step(t.Context())
	if w.file("admission.jws") != grantedJWS {
		t.Fatal("not granted")
	}
	// A new probe key (or boot) is another admission.
	w.write("probe.pub", strings.Repeat("A", 43))
	w.agent().step(t.Context())
	if asks, _, _ := w.cp.snapshot(); len(asks) != 3 || asks[2]["probePublicKey"] != strings.Repeat("A", 43) {
		t.Fatalf("asks %v", asks)
	}
}

func TestOnlyARegularProbeKeyIsRead(t *testing.T) {
	w := newIsolationWorld(t)
	target := filepath.Join(w.state, "key")
	_ = os.WriteFile(target, []byte(testProbeKey), 0o644)
	_ = os.Symlink(target, filepath.Join(w.handoff, "probe.pub"))
	w.agent().step(t.Context())
	_ = os.Remove(filepath.Join(w.handoff, "probe.pub"))
	if err := syscall.Mkfifo(filepath.Join(w.handoff, "probe.pub"), 0o644); err != nil {
		t.Fatal(err)
	}
	done := make(chan struct{})
	go func() { w.agent().step(t.Context()); close(done) }()
	select {
	case <-done:
	case <-time.After(5 * time.Second):
		t.Fatal("a FIFO as probe.pub blocked the agent")
	}
	if asks, _, _ := w.cp.snapshot(); len(asks) != 0 {
		t.Fatalf("asked with a key read through a symlink or a FIFO: %v", asks)
	}
}

func TestTheChallengeAndTheReleasesAreRelayedAndReleasesWithdrawnOnFailure(t *testing.T) {
	w := newIsolationWorld(t)
	a := w.agent()
	w.cp.challenge = `"Q2hhbGxlbmdlLXRlc3Qtb25seS0x"`
	w.cp.releases = `{"items":[{"protected":"a","payload":"b","signature":"c"}]}`
	a.step(t.Context())
	if w.file("challenge") != "Q2hhbGxlbmdlLXRlc3Qtb25seS0x" || w.file("releases.json") != `{"items":[{"protected":"a","payload":"b","signature":"c"}]}` {
		t.Fatalf("challenge %q releases %q", w.file("challenge"), w.file("releases.json"))
	}
	// The control plane fails: the challenge stays (it answers no newer one), the releases go.
	w.cp.mu.Lock()
	w.cp.challenge, w.cp.releases = "", ""
	w.cp.mu.Unlock()
	a.step(t.Context())
	if w.file("challenge") != "Q2hhbGxlbmdlLXRlc3Qtb25seS0x" {
		t.Fatal("the challenge was dropped on a failure")
	}
	if _, err := os.Stat(filepath.Join(w.handoff, "releases.json")); err == nil {
		t.Fatal("releases kept without an answer")
	}
	w.cp.mu.Lock()
	w.cp.challenge, w.cp.releases = "null", `{"items":[],"extra":1}`
	w.cp.mu.Unlock()
	a.step(t.Context())
	if _, err := os.Stat(filepath.Join(w.handoff, "challenge")); err == nil {
		t.Fatal("a null challenge left the previous one")
	}
	if _, err := os.Stat(filepath.Join(w.handoff, "releases.json")); err == nil {
		t.Fatal("a malformed answer wrote releases")
	}
	// A control plane that is down hands over nothing that could end a containment.
	w.server.Close()
	w.write("probe.pub", testProbeKey)
	w.agent().step(t.Context())
	for _, name := range []string{"admission.jws", "releases.json", "acks.json"} {
		if _, err := os.Stat(filepath.Join(w.handoff, name)); err == nil {
			t.Fatalf("%s written without the control plane", name)
		}
	}
}

func TestReportsGoInOrderAtMost500PerCallAndOnlyTheirAckIsRelayed(t *testing.T) {
	w := newIsolationWorld(t)
	for seq := 600; seq >= 1; seq-- {
		w.write(filepath.Join("outbox", fmt.Sprintf("%020d.jws", seq)), string(report(admissionA, seq)))
	}
	w.write(filepath.Join("outbox", "planted.jws"), string(report(admissionA, 9999)))
	_ = os.Symlink(filepath.Join(w.state, "boot_id"), filepath.Join(w.handoff, "outbox", fmt.Sprintf("%020d.jws", 601)))
	a := w.agent()
	a.step(t.Context())
	if got := w.file("acks.json"); got != `{"ackedSeq":500,"admissionId":"`+admissionA+`"}` {
		t.Fatalf("acks.json %q", got)
	}
	// The probe has not dropped them yet: what was acknowledged is not sent again.
	a.step(t.Context())
	_, _, batches := w.cp.snapshot()
	if len(batches) != 2 || len(batches[0]) != 500 || len(batches[1]) != 100 {
		t.Fatalf("batches of %v", lens(batches))
	}
	for i, raw := range append(batches[0], batches[1]...) {
		if seqOf(raw) != i+1 || string(raw) != string(report(admissionA, i+1)) {
			t.Fatalf("report %d sent as seq %d", i, seqOf(raw))
		}
	}
	// An ack of another admission, or a malformed answer, is never relayed.
	w.cp.mu.Lock()
	w.cp.ack = func([]json.RawMessage) string {
		return `{"acks":[{"admissionId":"00000000-0000-4000-8000-00000000a002","ackedSeq":700}],"rejected":[{"index":0,"reason":"other-pod"}]}`
	}
	w.cp.mu.Unlock()
	_ = os.Remove(filepath.Join(w.handoff, "acks.json"))
	a.lastAcks = nil
	a.step(t.Context())
	if _, err := os.Stat(filepath.Join(w.handoff, "acks.json")); err == nil {
		t.Fatal("an ack of another admission was relayed")
	}
	w.cp.mu.Lock()
	w.cp.ack = func([]json.RawMessage) string {
		return `{"acks":[{"admissionId":"` + admissionA + `","ackedSeq":600}]}`
	}
	w.cp.mu.Unlock()
	a.step(t.Context())
	if _, err := os.Stat(filepath.Join(w.handoff, "acks.json")); err == nil {
		t.Fatal("a malformed answer was relayed")
	}
	if entries, _ := os.ReadDir(filepath.Join(w.handoff, "outbox")); len(entries) != 602 {
		t.Fatalf("the agent changed the outbox: %d entries", len(entries))
	}
}

func lens(b [][]json.RawMessage) []int {
	var out []int
	for _, x := range b {
		out = append(out, len(x))
	}
	return out
}

// Through Run: the session carries the isolation documents with the node token, and the final report the probe
// writes when it is signalled (before the agent) is still sent on the agent's own stop.
func TestTheSessionCarriesIsolationAndSendsTheFinalReportOnStop(t *testing.T) {
	cp := cpmock.New()
	defer cp.Close()
	k := newKong(t)
	w := newIsolationWorld(t)
	w.cp.decide = func(int, int) string { return "granted" }
	cp.SetIsolation(w.cp)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	a.config.HandoffDir, a.config.PodUID, a.config.PodName, a.config.NodeName, a.config.BootIDFile = w.handoff, testPod, "dp-0", "worker-1", w.boot
	a.isolation = &isolation{config: a.config, client: a.client, log: a.log, interval: time.Hour, retry: func(int) time.Duration { return 0 }}
	a.isolation.config.StateDir = w.state
	w.write("probe.pub", testProbeKey)
	stop := start(t, a)
	deadline := time.Now().Add(4 * time.Second)
	for w.file("releases.json") == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if w.file("admission.jws") != grantedJWS {
		t.Fatal("the session did not hand over the admission")
	}
	time.Sleep(100 * time.Millisecond)
	w.write(filepath.Join("outbox", fmt.Sprintf("%020d.jws", 1)), string(report(admissionA, 1)))
	stop()
	if _, _, batches := w.cp.snapshot(); len(batches) != 1 || seqOf(batches[0][0]) != 1 {
		t.Fatalf("the final flush sent %v", lens(batches))
	}
}

// Cold start in Workspaces mode: Kong (and so its Admin API) starts only after the admission, which needs the node
// token; the agent registers with the version seed-config read from the pinned image and the admission follows (N2-E2
// finding F1).
func TestWorkspacesModeRegistersBeforeKongExistsAndGetsTheAdmission(t *testing.T) {
	cp := cpmock.New()
	defer cp.Close()
	k := newKong(t)
	w := newIsolationWorld(t)
	w.cp.decide = func(int, int) string { return "granted" }
	cp.SetIsolation(w.cp)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	// No Kong yet: its Admin API and status endpoint are sockets nobody listens on.
	none := t.TempDir()
	a.config.KongAdminURL, a.config.KongStatusURL = "unix://"+filepath.Join(none, "admin.sock"), "unix://"+filepath.Join(none, "status.sock")
	a.client.config.KongAdminURL, a.client.config.KongStatusURL = a.config.KongAdminURL, a.config.KongStatusURL
	a.config.HandoffDir, a.config.PodUID, a.config.PodName, a.config.NodeName, a.config.BootIDFile = w.handoff, testPod, "dp-0", "worker-1", w.boot
	a.config.KongVersionFile = filepath.Join(t.TempDir(), "version")
	if err := os.WriteFile(a.config.KongVersionFile, []byte("3.9.4"), 0o644); err != nil {
		t.Fatal(err)
	}
	a.client.config.HandoffDir, a.client.config.KongVersionFile = a.config.HandoffDir, a.config.KongVersionFile
	a.isolation = &isolation{config: a.config, client: a.client, log: a.log, interval: time.Hour, retry: func(int) time.Duration { return 0 }}
	a.isolation.config.StateDir = w.state
	w.write("probe.pub", testProbeKey)
	stop := start(t, a)
	defer stop()
	select {
	case r := <-cp.Registrations:
		if r.KongVersion != "3.9.4" {
			t.Fatalf("registered Kong %q, want the image's 3.9.4", r.KongVersion)
		}
	case <-time.After(4 * time.Second):
		t.Fatal("the agent never registered while Kong was not running")
	}
	deadline := time.Now().Add(4 * time.Second)
	for w.file("admission.jws") == "" && time.Now().Before(deadline) {
		time.Sleep(10 * time.Millisecond)
	}
	if w.file("admission.jws") != grantedJWS {
		t.Fatal("no admission was handed over before Kong started")
	}
}

func TestWorkspacesModeRequiresTheKongVersionFile(t *testing.T) {
	c := Config{RegistrationToken: "t", NodeID: "n", Hostname: "h", SnapshotPath: "/s", ControlPlaneURL: "http://cp",
		KongAdminURL: "unix:///a", KongStatusURL: "unix:///s", StateDir: "/state",
		HandoffDir: "/gromesh/handoff", PodUID: testPod, PodName: "dp-0", NodeName: "worker-1", BootIDFile: "/b",
		InstanceID: "00000000-0000-4000-8000-0000000000a1"}
	if c.validate() == nil {
		t.Fatal("Workspaces mode accepted no GROMESH_KONG_VERSION_FILE")
	}
	c.KongVersionFile = "/gromesh/kong-version/version"
	if err := c.validate(); err != nil {
		t.Fatalf("a version file was refused: %v", err)
	}
	for _, instance := range []string{"", "instance"} {
		c.InstanceID = instance
		if c.validate() == nil {
			t.Fatalf("Workspaces mode accepted the instance %q", instance)
		}
	}
}

// Only a well-formed version in a regular file registers; anything else is an error, never a guess.
func TestWorkspacesModeRefusesAMissingOrMalformedKongVersion(t *testing.T) {
	dir := t.TempDir()
	target := filepath.Join(dir, "target")
	if err := os.WriteFile(target, []byte("3.9.4"), 0o644); err != nil {
		t.Fatal(err)
	}
	link := filepath.Join(dir, "link")
	if err := os.Symlink(target, link); err != nil {
		t.Fatal(err)
	}
	c := &client{config: Config{HandoffDir: "/gromesh/handoff"}}
	for name, content := range map[string]string{"empty": "", "short": "3.9", "suffix": "3.9.4-abc", "newline": "3.9.4\n", "tag": "latest"} {
		c.config.KongVersionFile = filepath.Join(dir, name)
		if err := os.WriteFile(c.config.KongVersionFile, []byte(content), 0o644); err != nil {
			t.Fatal(err)
		}
		if v, err := c.kongVersion(context.Background()); err == nil {
			t.Fatalf("%s: registered Kong %q", name, v)
		}
	}
	// 65 bytes that start like a version: the size limit alone refuses it.
	long := filepath.Join(dir, "long")
	if err := os.WriteFile(long, []byte("3.9.4"+strings.Repeat("0", 60)), 0o644); err != nil {
		t.Fatal(err)
	}
	fifo := filepath.Join(dir, "fifo")
	if err := syscall.Mkfifo(fifo, 0o644); err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{filepath.Join(dir, "missing"), link, long, fifo} {
		done := make(chan error, 1)
		c.config.KongVersionFile = path
		go func() { _, err := c.kongVersion(context.Background()); done <- err }()
		select {
		case err := <-done:
			if err == nil {
				t.Fatalf("%s: registered a Kong version", path)
			}
		case <-time.After(2 * time.Second):
			t.Fatalf("%s: reading the version blocked", path)
		}
	}
	c.config.KongVersionFile = target
	if v, err := c.kongVersion(context.Background()); err != nil || v != "3.9.4" {
		t.Fatalf("got %q, %v", v, err)
	}
}

// N2-F3: the probe removes probe.pub at the pod's stop signal. A pending request is then neither polled nor asked again,
// so a stopping pod is granted no admission that its probe could no longer close.
func TestNoAdmissionIsPolledOrAskedOnceTheProbeRemovedItsKey(t *testing.T) {
	w := newIsolationWorld(t)
	w.write("probe.pub", testProbeKey)
	w.cp.decide = func(int, int) string { return "pending" }
	a := w.agent()
	a.step(t.Context())
	asks, polls, _ := w.cp.snapshot()
	if len(asks) != 1 || polls != 1 {
		t.Fatalf("asks %d polls %d", len(asks), polls)
	}
	if err := os.Remove(filepath.Join(w.handoff, "probe.pub")); err != nil {
		t.Fatal(err)
	}
	w.cp.decide = func(int, int) string { return "granted" }
	a.step(t.Context())
	a.step(t.Context())
	if asks, polls, _ := w.cp.snapshot(); len(asks) != 1 || polls != 1 {
		t.Fatalf("after the probe's stop: asks %d polls %d", len(asks), polls)
	}
	if w.file("admission.jws") != "" {
		t.Fatal("an admission handed over after the probe's stop")
	}
}
