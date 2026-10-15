package agent

import (
	"bytes"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
	"time"
	"unicode/utf8"
)

func TestSnapshotEnvelopeValidation(t *testing.T) {
	valid := example(t, 1)
	b := encoded(t, valid)
	for _, test := range []struct{ name, old, replacement string }{
		{"unknown field", `"version":1`, `"extra":true,"version":1`},
		{"missing version", `"version":1,`, ""},
		{"zero version", `"version":1`, `"version":0`},
		{"fractional version", `"version":1`, `"version":1.5`},
		{"invalid hash", valid.Hash, "sha256:bad"},
		{"invalid environment", valid.EnvironmentID, "bad"},
		{"invalid date", valid.CreatedAt, "yesterday"},
		{"null config", string(valid.Config), "null"},
		{"array config", string(valid.Config), "[]"},
	} {
		t.Run(test.name, func(t *testing.T) {
			bad := bytes.Replace(b, []byte(test.old), []byte(test.replacement), 1)
			if _, err := DecodeSnapshot(bad); err == nil {
				t.Fatal("invalid envelope accepted")
			}
		})
	}
	if _, err := DecodeSnapshot(append(b, []byte(" {}")...)); err == nil {
		t.Fatal("trailing JSON accepted")
	}
	decoded, err := DecodeSnapshot(b)
	if err != nil || !bytes.Equal(decoded.Config, valid.Config) {
		t.Fatal("opaque config bytes changed")
	}
}

func TestConfigFromEnv(t *testing.T) {
	for _, key := range []string{"GROMESH_NODE_ID", "KONG_ADMIN_URL", "KONG_STATUS_URL", "SNAPSHOT_PATH"} {
		t.Setenv(key, "")
	}
	t.Setenv("GROMESH_CP_URL", "https://cp.example/base")
	t.Setenv("GROMESH_REGISTRATION_TOKEN", "secret")
	c, err := ConfigFromEnv()
	if err != nil {
		t.Fatal(err)
	}
	hostname, err := os.Hostname()
	if err != nil {
		t.Fatal(err)
	}
	if c.NodeID != hostname || c.Hostname != hostname || c.KongAdminURL != "http://127.0.0.1:8001" || c.KongStatusURL != "http://127.0.0.1:8100" || c.SnapshotPath != "/kong/declarative/kong.json" {
		t.Fatalf("incorrect defaults: %+v", c)
	}
	t.Setenv("GROMESH_NODE_ID", "explicit-node")
	t.Setenv("KONG_ADMIN_URL", "http://localhost:9001")
	t.Setenv("KONG_STATUS_URL", "http://localhost:9101")
	t.Setenv("SNAPSHOT_PATH", "/tmp/config.json")
	c, err = ConfigFromEnv()
	if err != nil || c.NodeID != "explicit-node" || c.KongAdminURL != "http://localhost:9001" || c.KongStatusURL != "http://localhost:9101" || c.SnapshotPath != "/tmp/config.json" {
		t.Fatal("environment overrides were ignored")
	}
	for _, value := range []string{"", "file:///tmp/config", "https://user:pass@cp.example", "http://cp.example?token=secret"} {
		t.Setenv("GROMESH_CP_URL", value)
		if _, err := ConfigFromEnv(); err == nil {
			t.Fatal("invalid control plane URL accepted")
		}
	}
	t.Setenv("GROMESH_CP_URL", "https://cp.example")
	t.Setenv("GROMESH_REGISTRATION_TOKEN", "")
	if _, err := ConfigFromEnv(); err == nil {
		t.Fatal("missing token accepted")
	}
}

func TestRegistrationRejectsInvalidContractResponses(t *testing.T) {
	k := newKong(t)
	for _, body := range []string{
		`{}`, `{"nodeToken":"token","clusterId":"bad","environmentId":"bad","pollIntervalSeconds":5,"heartbeatIntervalSeconds":5}`,
		`{"nodeToken":"token","clusterId":"00000000-0000-4000-8000-0000000000c1","environmentId":"00000000-0000-4000-8000-0000000000e1","pollIntervalSeconds":4,"heartbeatIntervalSeconds":5}`,
	} {
		t.Run(body, func(t *testing.T) {
			cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) { w.Write([]byte(body)) }))
			defer cp.Close()
			c := client{config: Config{ControlPlaneURL: cp.URL, KongAdminURL: k.server.URL}, http: cp.Client()}
			if _, err := c.register(t.Context()); err == nil {
				t.Fatal("invalid registration response accepted")
			}
		})
	}
}

func TestSnapshotRejectsMismatchedETag(t *testing.T) {
	s := example(t, 1)
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("ETag", "sha256:"+strings.Repeat("0", 64))
		w.Write(encoded(t, s))
	}))
	defer cp.Close()
	c := client{config: Config{ControlPlaneURL: cp.URL}, http: cp.Client()}
	if _, err := c.snapshot(t.Context(), ""); err == nil {
		t.Fatal("mismatched ETag accepted")
	}
}

func TestBackoffIsBoundedAndHasJitter(t *testing.T) {
	seen := make(map[time.Duration]bool)
	for attempt := range 20 {
		for range 20 {
			d := retryDelay(attempt)
			ceiling := min(time.Second*time.Duration(1<<min(attempt, 5)), 30*time.Second)
			if d < ceiling/2 || d > ceiling {
				t.Fatalf("backoff outside exponential bounds: %v", d)
			}
			seen[d] = true
		}
	}
	if len(seen) < 2 {
		t.Fatal("backoff has no jitter")
	}
}

func TestKongErrorIsUTF8BoundedAndTokensAreRedacted(t *testing.T) {
	k := newKong(t)
	k.onApply = func(w http.ResponseWriter, _ *http.Request, _ []byte) {
		w.WriteHeader(http.StatusBadRequest)
		fmtBody := "registration-secret node-secret " + strings.Repeat("界", 4096)
		w.Write([]byte(fmtBody))
	}
	c := client{config: Config{KongAdminURL: k.server.URL, RegistrationToken: "registration-secret"}, token: "node-secret", http: k.server.Client()}
	err := c.apply(t.Context(), []byte("{}"))
	if err == nil || len(err.Error()) > 8<<10 || !utf8.ValidString(err.Error()) || strings.Contains(err.Error(), "secret") {
		t.Fatal("Kong error is unbounded or contains tokens")
	}
}
