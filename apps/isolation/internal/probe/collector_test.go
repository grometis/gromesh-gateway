package probe

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"testing"
)

// A Vector http_server intake: GET is refused with 405 before any authentication, so only a POST shows whether the
// collector checks its token (CAP-7, B §3.5.2).
func vectorIntake(auth bool) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method != http.MethodPost:
			w.WriteHeader(http.StatusMethodNotAllowed)
		case auth && r.Header.Get("X-Gromesh-Collector-Token") == "":
			w.WriteHeader(http.StatusUnauthorized)
		default:
			w.WriteHeader(http.StatusOK)
		}
	}))
}

func TestCollectorTokenIsProvenOnlyByAPost(t *testing.T) {
	secured, open := vectorIntake(true), vectorIntake(false)
	defer secured.Close()
	defer open.Close()
	check := func(url, method string) string {
		got, _ := evaluate(context.Background(), RealNetwork(), Check{Capability: "CAP-7", Kind: "http", Name: "collector", URL: url + "/kong", ExpectStatus: 401, Method: method})
		return got
	}
	if got := check(secured.URL, http.MethodPost); got != "pass" {
		t.Fatalf("collector with its token check: %s, want pass", got)
	}
	// Negative control: a collector that accepts events without the token is a violation.
	if got := check(open.URL, http.MethodPost); got != "violation" {
		t.Fatalf("collector without auth: %s, want violation", got)
	}
	// Why the method matters: a GET gets 405 from both, proving nothing about the token.
	if a, b := check(secured.URL, ""), check(open.URL, ""); a != b {
		t.Fatalf("GET told the two collectors apart (%s, %s): the test server no longer models Vector", a, b)
	}
}

func TestCheckMethodIsOnlyGetOrPostAndOnlyForHTTP(t *testing.T) {
	base := func() Config {
		cfg := Config{Checks: []Check{{Capability: "CAP-1", Kind: "dns", Name: "dns", Host: "kubernetes.default"}, {Capability: "CAP-1", Kind: "tcp-open", Name: "open", Address: "10.0.0.1:443"}}}
		for _, c := range Capabilities {
			cfg.Checks = append(cfg.Checks, Check{Capability: c, Kind: "tcp", Name: c, Address: "10.0.0.2:1"})
		}
		return cfg
	}
	for _, tc := range []struct {
		check Check
		err   string
	}{
		{Check{Capability: "CAP-7", Kind: "http", Name: "c", URL: "http://127.0.0.1:8686/kong", ExpectStatus: 401, Method: "POST"}, ""},
		{Check{Capability: "CAP-7", Kind: "http", Name: "c", URL: "http://127.0.0.1:8686/kong", ExpectStatus: 401, Method: "DELETE"}, "GET or POST"},
		{Check{Capability: "CAP-7", Kind: "tcp", Name: "c", Address: "127.0.0.1:8686", Method: "POST"}, "only for http"},
	} {
		cfg := base()
		cfg.Checks = append(cfg.Checks, tc.check)
		err := cfg.Validate()
		if (tc.err == "") != (err == nil) || (err != nil && !strings.Contains(err.Error(), tc.err)) {
			t.Fatalf("%+v: got %v, want %q", tc.check, err, tc.err)
		}
	}
}

// Run by e2e/collector-sidecar.mjs inside the pod's network namespace, against the real Vector sidecar: the probe's own
// CAP-7 check (POST without the token, 401 expected) must pass on the product's collector and be a violation on one
// without authentication (negative control).
func TestRealSidecarCollector(t *testing.T) {
	url, want := os.Getenv("GROMESH_REAL_COLLECTOR_URL"), os.Getenv("GROMESH_REAL_COLLECTOR_EXPECT")
	if url == "" {
		t.Skip("only inside the pod's network namespace (e2e/collector-sidecar.mjs)")
	}
	got, detail := evaluate(context.Background(), RealNetwork(), Check{Capability: "CAP-7", Kind: "http", Name: "collector token", URL: url, ExpectStatus: 401, Method: http.MethodPost})
	if got != want {
		t.Fatalf("CAP-7 against %s: %s (%s), want %s", url, got, detail, want)
	}
}
