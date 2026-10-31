package agent

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"regexp"
	"strconv"
	"strings"
	"sync"
	"time"
)

// AnalyticsHealth follows agent-protocol-v2. Unknown counters stay null, never healthy by default.
type AnalyticsHealth struct {
	State              string   `json:"state"`
	Reasons            []string `json:"reasons"`
	ObservedAt         string   `json:"observedAt"`
	WindowSeconds      int      `json:"windowSeconds"`
	WindowComplete     bool     `json:"windowComplete"`
	CollectorReachable bool     `json:"collectorReachable"`
	KongRequests       *int64   `json:"kongRequests"`
	Received           *int64   `json:"received"`
	Delivered          *int64   `json:"delivered"`
	DeliveryErrors     *int64   `json:"deliveryErrors"`
	AuthRefusals       *int64   `json:"authRefusals"`
	Buffered           *int64   `json:"buffered"`
	BufferCapacity     *int64   `json:"bufferCapacity"`
	LastReceivedAt     *string  `json:"lastReceivedAt"`
	LastDeliveredAt    *string  `json:"lastDeliveredAt"`
}

func (h *AnalyticsHealth) derive() {
	h.Reasons = []string{}
	if !h.CollectorReachable {
		h.Reasons = append(h.Reasons, "collector-unreachable")
	} else {
		if h.Received != nil && h.Delivered != nil && *h.Received > 0 && (float64(*h.Delivered) < float64(*h.Received)/2 || (h.DeliveryErrors != nil && *h.DeliveryErrors > 0 && *h.Delivered < *h.Received)) {
			h.Reasons = append(h.Reasons, "delivery-failing")
		}
		if h.Buffered != nil && h.BufferCapacity != nil && float64(*h.Buffered) >= float64(*h.BufferCapacity)/2 {
			h.Reasons = append(h.Reasons, "backlog")
		}
		if h.KongRequests != nil && h.Received != nil && *h.KongRequests >= 20 && float64(*h.Received) < float64(*h.KongRequests)/2 {
			h.Reasons = append(h.Reasons, "events-missing")
		}
		if h.AuthRefusals != nil && *h.AuthRefusals > 0 {
			h.Reasons = append(h.Reasons, "auth-refusals")
		}
	}
	h.State = "unknown"
	if len(h.Reasons) > 0 {
		h.State = "degraded"
		return
	}
	if !h.WindowComplete || h.KongRequests == nil || h.Received == nil || h.Delivered == nil || h.DeliveryErrors == nil || h.AuthRefusals == nil || h.Buffered == nil || h.BufferCapacity == nil {
		return
	}
	if *h.KongRequests == 0 && *h.Received == 0 {
		h.State = "idle"
	} else if *h.Received > 0 && *h.Delivered > 0 {
		h.State = "healthy"
	}
}
func (h AnalyticsHealth) analytics() string {
	if h.State == "healthy" || h.State == "idle" {
		return "analytics-healthy"
	}
	return "analytics-degraded"
}
func count(n int64) *int64 { return &n }

type analyticsSample struct {
	scrapedAt                                                   time.Time
	at                                                          time.Time
	uptime                                                      *int64
	kong, received, delivered, errors, auth, buffered, capacity *int64
}

var metricLabel = regexp.MustCompile(`([a-zA-Z_][a-zA-Z0-9_]*)="((?:[^"\\]|\\.)*)"`)

// The topology counters are registered at startup. Driver ACK/error and buffer activity counters are lazy in
// Vector 0.57: absence is zero only after the sink topology and capacity have been positively identified.
func parseVectorMetrics(r io.Reader) (analyticsSample, error) {
	s := analyticsSample{}
	totals := map[string]int64{}
	seen := map[string]bool{}
	sink := false
	scan := bufio.NewScanner(r)
	scan.Buffer(make([]byte, 4096), 128<<10)
	for scan.Scan() {
		line := strings.TrimSpace(scan.Text())
		if line == "" || strings.HasPrefix(line, "#") {
			continue
		}
		end := strings.IndexAny(line, "{ \t")
		if end < 0 {
			return s, fmt.Errorf("invalid metric")
		}
		name := line[:end]
		switch name {
		case "vector_uptime_seconds", "vector_component_sent_events_total", "vector_component_received_events_total", "vector_component_errors_total", "vector_http_client_errors_total", "vector_http_client_responses_total", "vector_buffer_received_events_total", "vector_buffer_sent_events_total", "vector_buffer_max_size_events":
		default:
			continue
		}
		rest := strings.TrimSpace(line[end:])
		labels := map[string]string{}
		key := name
		if strings.HasPrefix(rest, "{") {
			close := strings.Index(rest, "}")
			if close < 0 {
				return s, fmt.Errorf("invalid labels")
			}
			raw := rest[1:close]
			key += rest[:close+1]
			matches := metricLabel.FindAllStringSubmatchIndex(raw, -1)
			pos := 0
			for _, m := range matches {
				sep := strings.TrimSpace(raw[pos:m[0]])
				if (pos == 0 && sep != "") || (pos > 0 && sep != ",") {
					return s, fmt.Errorf("invalid labels")
				}
				k := raw[m[2]:m[3]]
				v, err := strconv.Unquote(`"` + raw[m[4]:m[5]] + `"`)
				if err != nil {
					return s, fmt.Errorf("invalid label")
				}
				if _, ok := labels[k]; ok {
					return s, fmt.Errorf("duplicate label")
				}
				labels[k] = v
				pos = m[1]
			}
			if strings.TrimSpace(raw[pos:]) != "" {
				return s, fmt.Errorf("invalid labels")
			}
			rest = strings.TrimSpace(rest[close+1:])
		}
		component := labels["component_id"]
		if name != "vector_uptime_seconds" && component != "requests" && component != "decode" && component != "kong" {
			continue
		}
		fields := strings.Fields(rest)
		if len(fields) < 1 || len(fields) > 2 {
			return s, fmt.Errorf("invalid sample")
		}
		n, err := strconv.ParseFloat(fields[0], 64)
		if err != nil || math.IsNaN(n) || math.IsInf(n, 0) || n < 0 || n >= float64(math.MaxInt64) || math.Trunc(n) != n {
			return s, fmt.Errorf("invalid counter")
		}
		if seen[key] {
			return s, fmt.Errorf("duplicate sample")
		}
		seen[key] = true
		v := int64(n)
		switch {
		case name == "vector_uptime_seconds":
			if s.uptime != nil {
				return s, fmt.Errorf("ambiguous collector")
			}
			s.uptime = count(v)
			if len(fields) == 2 {
				millis, err := strconv.ParseInt(fields[1], 10, 64)
				if err != nil || millis < 0 {
					return s, fmt.Errorf("invalid scrape timestamp")
				}
				s.scrapedAt = time.UnixMilli(millis)
			}
		case name == "vector_component_sent_events_total" && component == "decode" && (labels["output"] == "_default" || labels["output"] == ""):
			totals["received"] += v
			s.received = count(totals["received"])
		case name == "vector_component_received_events_total" && component == "requests":
			sink = true
		case name == "vector_component_sent_events_total" && component == "requests":
			totals["delivered"] += v
		case (name == "vector_component_errors_total" || name == "vector_http_client_errors_total") && component == "requests":
			totals["errors"] += v
		case name == "vector_http_client_responses_total" && component == "requests":
			status, err := strconv.Atoi(labels["status"])
			if err != nil || status < 100 || status > 599 {
				return s, fmt.Errorf("invalid sink response status")
			}
			// component_errors_total only records terminal failures; retries must also be visible while delivery is pending.
			if status < 200 || status >= 300 {
				totals["errors"] += v
			}
		case name == "vector_component_errors_total" && component == "kong" && (labels["error_code"] == "http_response_401" || labels["error_code"] == "http_response_403"):
			totals["auth"] += v
		case name == "vector_buffer_received_events_total" && component == "requests":
			totals["bufferIn"] += v
		case name == "vector_buffer_sent_events_total" && component == "requests":
			totals["bufferOut"] += v
		case name == "vector_buffer_max_size_events" && component == "requests":
			if v < 1 || s.capacity != nil {
				return s, fmt.Errorf("invalid capacity")
			}
			s.capacity = count(v)
		}
	}
	if err := scan.Err(); err != nil {
		return s, err
	}
	if sink && s.uptime != nil && s.capacity != nil {
		s.delivered = count(totals["delivered"])
		s.errors = count(totals["errors"])
		s.auth = count(totals["auth"])
		buffered := totals["bufferIn"] - totals["bufferOut"]
		if buffered < 0 {
			return s, fmt.Errorf("invalid buffer")
		}
		s.buffered = count(buffered)
	}
	return s, nil
}

type analyticsMonitor struct {
	client     *client
	metricsURL string
	samples    []analyticsSample
	mu         sync.RWMutex
	latest     AnalyticsHealth
}

func newAnalyticsMonitor(c *client) *analyticsMonitor {
	h := AnalyticsHealth{State: "unknown", Reasons: []string{}, WindowSeconds: 300}
	return &analyticsMonitor{client: c, metricsURL: "http://127.0.0.1:9598/metrics", latest: h}
}
func (m *analyticsMonitor) health() AnalyticsHealth {
	m.mu.RLock()
	defer m.mu.RUnlock()
	return m.latest
}
func delta(current, base *int64) *int64 {
	if current == nil || base == nil || *current < *base {
		return nil
	}
	return count(*current - *base)
}
func (m *analyticsMonitor) sample(ctx context.Context, now time.Time) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	s := analyticsSample{at: now}
	h := AnalyticsHealth{ObservedAt: now.UTC().Format(time.RFC3339Nano), WindowSeconds: 300}
	// Loopback only, no bearer token, no redirects. Failure here never touches the gateway's state or lease.
	res, err := m.client.request(ctx, "GET", m.metricsURL, "", nil, nil)
	if err == nil {
		func() {
			defer res.Body.Close()
			if res.StatusCode != http.StatusOK {
				return
			}
			h.CollectorReachable = true
			parsed, e := parseVectorMetrics(io.LimitReader(res.Body, 2<<20))
			if e == nil && (parsed.scrapedAt.IsZero() || math.Abs(now.Sub(parsed.scrapedAt).Seconds()) <= 30) {
				s = parsed
				s.at = now
				h.CollectorReachable = true
			}
		}()
	}
	res, err = m.client.request(ctx, "GET", endpoint(m.client.config.KongStatusURL, "/status"), "", nil, nil)
	if err == nil {
		func() {
			defer res.Body.Close()
			var status struct {
				Server struct {
					Total *int64 `json:"total_requests"`
				} `json:"server"`
			}
			if res.StatusCode == http.StatusOK && json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&status) == nil && status.Server.Total != nil && *status.Server.Total >= 0 {
				s.kong = status.Server.Total
			}
		}()
	}
	if len(m.samples) > 0 {
		prev := m.samples[len(m.samples)-1]
		reset := s.uptime == nil || prev.uptime == nil || *s.uptime < *prev.uptime
		if !reset {
			// Vector exports internally every 10s, independently of our 5s sampling. Compare process origins at
			// the metric's own scrape time, not at fetch time; a repeated scrape is not a collector restart.
			if !s.scrapedAt.IsZero() && !prev.scrapedAt.IsZero() {
				reset = math.Abs(s.scrapedAt.Add(-time.Duration(*s.uptime)*time.Second).Sub(prev.scrapedAt.Add(-time.Duration(*prev.uptime)*time.Second)).Seconds()) > 2
			} else {
				reset = math.Abs(float64(*s.uptime-*prev.uptime)-now.Sub(prev.at).Seconds()) > 15
			}
		}
		for _, p := range [][2]*int64{{s.kong, prev.kong}, {s.received, prev.received}, {s.delivered, prev.delivered}, {s.errors, prev.errors}, {s.auth, prev.auth}} {
			if p[0] == nil || p[1] == nil || *p[0] < *p[1] {
				reset = true
			}
		}
		if reset {
			m.samples = nil
		}
	}
	m.samples = append(m.samples, s)
	cutoff := now.Add(-300 * time.Second)
	for len(m.samples) > 1 && !m.samples[1].at.After(cutoff) {
		m.samples = m.samples[1:]
	}
	base := m.samples[0]
	h.WindowComplete = !base.at.After(cutoff) && s.uptime != nil && *s.uptime >= 300
	h.KongRequests = delta(s.kong, base.kong)
	h.Received = delta(s.received, base.received)
	h.Delivered = delta(s.delivered, base.delivered)
	h.DeliveryErrors = delta(s.errors, base.errors)
	h.AuthRefusals = delta(s.auth, base.auth)
	h.Buffered = s.buffered
	h.BufferCapacity = s.capacity
	h.derive()
	m.mu.Lock()
	m.latest = h
	m.mu.Unlock()
}
func (m *analyticsMonitor) run(ctx context.Context) {
	ticker := time.NewTicker(5 * time.Second)
	defer ticker.Stop()
	for {
		m.sample(ctx, time.Now())
		select {
		case <-ctx.Done():
			return
		case <-ticker.C:
		}
	}
}
