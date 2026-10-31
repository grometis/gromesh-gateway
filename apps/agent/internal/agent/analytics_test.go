package agent

import (
	"context"
	"encoding/json"
	"fmt"
	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"reflect"
	"strings"
	"testing"
	"time"
)

func TestAnalyticsContractVectors(t *testing.T) {
	raw, err := os.ReadFile("../../../../contracts/examples/analytics-v2.example.json")
	if err != nil {
		t.Fatal(err)
	}
	var v struct {
		HealthOf struct {
			Cases []struct {
				Name     string          `json:"name"`
				Input    AnalyticsHealth `json:"input"`
				Expected struct {
					State     string   `json:"state"`
					Reasons   []string `json:"reasons"`
					Analytics string   `json:"analytics"`
				} `json:"expected"`
			} `json:"cases"`
		} `json:"healthOf"`
	}
	if err := json.Unmarshal(raw, &v); err != nil {
		t.Fatal(err)
	}
	if len(v.HealthOf.Cases) == 0 {
		t.Fatal("no normative cases")
	}
	for _, c := range v.HealthOf.Cases {
		t.Run(c.Name, func(t *testing.T) {
			h := c.Input
			h.derive()
			if h.State != c.Expected.State || !reflect.DeepEqual(h.Reasons, c.Expected.Reasons) || h.analytics() != c.Expected.Analytics {
				t.Fatalf("got %+v (%s), want %s %v %s", h, h.analytics(), c.Expected.State, c.Expected.Reasons, c.Expected.Analytics)
			}
		})
	}
}

func vectorMetrics(uptime, received, delivered, auth int64) string {
	return fmt.Sprintf(`vector_uptime_seconds  %d
vector_component_sent_events_total{component_id="decode",output="_default"} %d
vector_component_received_events_total{component_id="requests"} %d
vector_component_sent_events_total{component_id="requests"} %d
vector_component_errors_total{component_id="kong",error_code="http_response_401"} %d
vector_buffer_received_events_total{component_id="requests"} %d
vector_buffer_sent_events_total{component_id="requests"} %d
vector_buffer_max_size_events{component_id="requests"} 10000
`, uptime, received, received, delivered, auth, received, received)
}

func TestAnalyticsScrapeAndWindow(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	metrics := vectorMetrics(600, 0, 0, 0)
	requests := int64(100)
	broken := false
	vector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "" {
			t.Error("credential sent to collector")
		}
		if broken {
			w.WriteHeader(503)
			return
		}
		fmt.Fprint(w, metrics)
	}))
	defer vector.Close()
	kong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		fmt.Fprintf(w, `{"server":{"total_requests":%d}}`, requests)
	}))
	defer kong.Close()
	a := newAnalyticsMonitor(&client{config: Config{KongStatusURL: kong.URL}, http: vector.Client()})
	a.metricsURL = vector.URL
	sample := func() AnalyticsHealth { t.Helper(); a.sample(context.Background(), now); return a.health() }
	if h := sample(); h.State != "unknown" {
		t.Fatalf("warmup: %+v", h)
	}
	now = now.Add(300 * time.Second)
	metrics = vectorMetrics(900, 0, 0, 0)
	if h := sample(); h.State != "idle" {
		t.Fatalf("no traffic: %+v", h)
	}
	now = now.Add(15 * time.Second)
	metrics = vectorMetrics(915, 30, 0, 0)
	requests += 30
	if h := sample(); h.State != "degraded" || !strings.Contains(strings.Join(h.Reasons, ","), "delivery-failing") {
		t.Fatalf("live without ACK: %+v", h)
	}
	now = now.Add(300 * time.Second)
	metrics = vectorMetrics(1215, 60, 60, 0)
	requests += 30
	if h := sample(); h.State != "healthy" {
		t.Fatalf("ACK: %+v", h)
	}
	now = now.Add(15 * time.Second)
	metrics = vectorMetrics(1230, 60, 60, 1)
	if h := sample(); h.State != "degraded" || !strings.Contains(strings.Join(h.Reasons, ","), "auth-refusals") {
		t.Fatalf("auth: %+v", h)
	}
	now = now.Add(15 * time.Second)
	metrics = vectorMetrics(1, 0, 0, 0)
	if h := sample(); h.State != "unknown" || h.WindowComplete {
		t.Fatalf("collector restart: %+v", h)
	}
	broken = true
	if h := sample(); h.State != "degraded" || h.CollectorReachable {
		t.Fatalf("unreachable: %+v", h)
	}
	broken = false
	metrics = "vector_uptime_seconds 10\n"
	if h := sample(); h.State != "unknown" {
		t.Fatalf("incomplete scrape: %+v", h)
	}
}

func TestVectorMetricsSemantics(t *testing.T) {
	// Vector registers topology counters at zero, but sink ACK/error/buffer activity counters are lazy.
	raw := `vector_uptime_seconds 600
vector_component_sent_events_total{component_id="decode",output="_default"} 0
vector_component_received_events_total{component_id="requests"} 0
vector_buffer_max_size_events{component_id="requests"} 10000
`
	s, err := parseVectorMetrics(strings.NewReader(raw))
	if err != nil {
		t.Fatal(err)
	}
	if s.received == nil || *s.received != 0 || s.delivered == nil || *s.delivered != 0 || s.buffered == nil || *s.buffered != 0 {
		t.Fatalf("idle topology: %+v", s)
	}
	for _, bad := range []string{strings.Replace(raw, " 600", " NaN", 1), strings.Replace(raw, " 10000", " -1", 1), strings.Replace(raw, " 0", " 1.5", 1), raw + "vector_uptime_seconds 100\n"} {
		if _, err := parseVectorMetrics(strings.NewReader(bad)); err == nil {
			t.Fatal("accepted invalid metrics")
		}
	}
}

func TestAnalyticsIsReportedWithNodeIdentityWithoutChangingDeployment(t *testing.T) {
	var reported DeploymentStatus
	cp := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.URL.Path != "/agent/v2/status" || r.Header.Get("Authorization") != "Bearer node-token" {
			t.Error("wrong route or identity")
		}
		if err := json.NewDecoder(r.Body).Decode(&reported); err != nil {
			t.Error(err)
		}
		w.WriteHeader(http.StatusNoContent)
	}))
	defer cp.Close()
	kong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{}`) }))
	defer kong.Close()
	c := &client{config: Config{ControlPlaneURL: cp.URL, KongStatusURL: kong.URL}, http: cp.Client(), token: "node-token"}
	h := AnalyticsHealth{ObservedAt: "2026-10-31T12:00:00Z", WindowSeconds: 300, WindowComplete: true, CollectorReachable: true, KongRequests: count(30), Received: count(30), Delivered: count(0), DeliveryErrors: count(0), AuthRefusals: count(0), Buffered: count(0), BufferCapacity: count(10000)}
	h.derive()
	monitor := newAnalyticsMonitor(c)
	monitor.latest = h
	revision := int64(4)
	hash := "sha256:" + strings.Repeat("a", 64)
	a := &Agent{client: c, analytics: monitor, deployStatus: &DeploymentStatus{NodeID: "kong-pod-a", Epoch: 2, AppliedRevision: &revision, AppliedHash: &hash}}
	a.reportDeployment(context.Background())
	if reported.NodeID != "kong-pod-a" || reported.Epoch != 2 || reported.AppliedRevision == nil || *reported.AppliedRevision != 4 || reported.AppliedHash == nil || *reported.AppliedHash != hash {
		t.Fatalf("deployment identity changed: %+v", reported)
	}
	if reported.Analytics != "analytics-degraded" || reported.AnalyticsHealth == nil || reported.AnalyticsHealth.State != "degraded" {
		t.Fatalf("health missing: %+v", reported)
	}
	if a.deployStatus.Analytics != "" || a.deployStatus.AnalyticsHealth != nil {
		t.Fatal("mutated the convergence report")
	}
}

func TestPinnedVectorScrapes(t *testing.T) {
	for _, name := range []string{"idle", "auth", "runtime-blocked", "runtime-acked", "runtime-refused"} {
		t.Run(name, func(t *testing.T) {
			f, err := os.Open("testdata/vector-0.57-" + name + ".prom")
			if err != nil {
				t.Fatal(err)
			}
			defer f.Close()
			s, err := parseVectorMetrics(f)
			if err != nil {
				t.Fatal(err)
			}
			received, delivered := int64(0), int64(0)
			if strings.HasPrefix(name, "runtime-") {
				received = 2
			}
			if name == "runtime-acked" || name == "runtime-refused" {
				delivered = 2
			}
			if s.received == nil || *s.received != received || s.delivered == nil || *s.delivered != delivered || s.buffered == nil || *s.buffered != 0 || s.capacity == nil || *s.capacity != 10000 {
				t.Fatalf("unexpected reading %+v", s)
			}

			errors := int64(0)
			if name == "runtime-blocked" {
				errors = 1
			}
			if name == "runtime-acked" || name == "runtime-refused" {
				errors = 3
			}
			if s.errors == nil || *s.errors != errors {
				t.Fatalf("delivery failures: %v, want %d", s.errors, errors)
			}
			want := int64(0)
			if name == "auth" || name == "runtime-refused" {
				want = 1
			}
			if s.auth == nil || *s.auth != want {
				t.Fatalf("auth: %v", s.auth)
			}
		})
	}
}

func TestAnalyticsHasNoInventedObservationAtStartup(t *testing.T) {
	h := newAnalyticsMonitor(&client{}).health()
	if h.ObservedAt != "" {
		t.Fatal("startup invented an observation")
	}
}

func TestAnalyticsAllowsVectorTenSecondScrapesAndRejectsStaleExporter(t *testing.T) {
	now := time.Date(2026, 10, 31, 12, 0, 0, 0, time.UTC)
	metrics := ""
	vector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, metrics) }))
	defer vector.Close()
	kong := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, `{"server":{"total_requests":10}}`) }))
	defer kong.Close()
	m := newAnalyticsMonitor(&client{config: Config{KongStatusURL: kong.URL}, http: vector.Client()})
	m.metricsURL = vector.URL
	start := now
	for i := 0; i <= 60; i++ {
		now = start.Add(time.Duration(i) * 5 * time.Second)
		captured := start.Add(time.Duration(i/2) * 10 * time.Second)
		var lines []string
		for _, line := range strings.Split(strings.TrimSpace(vectorMetrics(600+int64(i/2)*10, 0, 0, 0)), "\n") {
			lines = append(lines, fmt.Sprintf("%s %d", line, captured.UnixMilli()))
		}
		metrics = strings.Join(lines, "\n") + "\n"
		m.sample(context.Background(), now)
	}
	if h := m.health(); h.State != "idle" || !h.WindowComplete {
		t.Fatalf("normal 10s Vector scrapes reset window: %+v", h)
	}
	m.sample(context.Background(), now.Add(40*time.Second))
	if h := m.health(); h.State != "unknown" || h.WindowComplete {
		t.Fatalf("stale exporter declared health: %+v", h)
	}
}

func TestAnalyticsRunsAlongsideDeploymentConvergence(t *testing.T) {
	cp := cpmock.New()
	defer cp.Close()
	k := newKong(t)
	path := filepath.Join(t.TempDir(), "kong.json")
	base := newTestAgent(t, cp, k, path)
	config := base.config
	config.HandoffDir = t.TempDir()
	config.InstanceID = exampleInstance
	config.PodUID = "00000000-0000-4000-8000-000000000001"
	config.PodName = "kong-pod"
	config.NodeName = "worker-a"
	config.KongVersionFile = filepath.Join(t.TempDir(), "version")
	config.BootIDFile = filepath.Join(t.TempDir(), "boot")
	if err := os.WriteFile(config.KongVersionFile, []byte("3.9.4"), 0600); err != nil {
		t.Fatal(err)
	}
	a, err := New(config, nil)
	if err != nil {
		t.Fatal(err)
	}
	if a.analytics == nil {
		t.Fatal("Workspaces agent did not start health monitor")
	}
	a.poll = 20 * time.Millisecond
	a.heartbeat = 25 * time.Millisecond
	vector := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) { fmt.Fprint(w, vectorMetrics(600, 0, 0, 0)) }))
	defer vector.Close()
	a.analytics.metricsURL = vector.URL
	cp.SetDeployment(deploymentEnvelope(t, 1, 1, "a"))
	stop := start(t, a)
	defer stop()
	s := waitDeployment(t, cp, func(s cpmock.DeploymentStatus) bool { return s.AppliedRevision != nil && len(s.AnalyticsHealth) > 0 })
	var h AnalyticsHealth
	if json.Unmarshal(s.AnalyticsHealth, &h) != nil || h.ObservedAt == "" || h.State != "unknown" || s.Analytics == nil || *s.Analytics != "analytics-degraded" {
		t.Fatalf("missing counter did not remain unknown: %+v / %+v", s, h)
	}
	if s.AppliedRevision == nil || *s.AppliedRevision != 1 || s.NodeID != config.NodeID {
		t.Fatalf("health altered deployment: %+v", s)
	}
}

func TestAnalyticsCountsTransientSinkFailuresBeforeRetriesAreExhausted(t *testing.T) {
	for name, extra := range map[string]string{
		"HTTP failure":      `vector_http_client_responses_total{component_id="requests",status="503"} 1`,
		"transport failure": `vector_http_client_errors_total{component_id="requests",error_kind="connection refused"} 1`,
	} {
		t.Run(name, func(t *testing.T) {
			s, err := parseVectorMetrics(strings.NewReader(vectorMetrics(600, 100, 75, 0) + extra + "\n"))
			if err != nil {
				t.Fatal(err)
			}
			h := AnalyticsHealth{WindowComplete: true, CollectorReachable: true, KongRequests: count(100), Received: s.received, Delivered: s.delivered, DeliveryErrors: s.errors, AuthRefusals: s.auth, Buffered: s.buffered, BufferCapacity: s.capacity}
			h.derive()
			if h.State != "degraded" || len(h.Reasons) != 1 || h.Reasons[0] != "delivery-failing" {
				t.Fatalf("transient delivery error hidden: %+v", h)
			}
		})
	}
}
