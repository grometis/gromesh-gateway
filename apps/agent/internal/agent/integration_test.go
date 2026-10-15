//go:build integration

package agent

import (
	"context"
	"encoding/json"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

func TestIntegrationAppliesExampleToComposeKong(t *testing.T) {
	admin := os.Getenv("KONG_ADMIN_URL")
	if admin == "" {
		admin = "http://127.0.0.1:8001"
	}
	httpClient := &http.Client{Timeout: 3 * time.Second}
	res, err := httpClient.Get(admin)
	if err != nil {
		t.Skipf("Kong Admin API is unreachable: %v", err)
	}
	defer res.Body.Close()
	var info struct {
		Version       string `json:"version"`
		Configuration struct {
			Database string `json:"database"`
		} `json:"configuration"`
	}
	if err := json.NewDecoder(res.Body).Decode(&info); err != nil || res.StatusCode != http.StatusOK || info.Configuration.Database != "off" {
		t.Fatalf("expected a reachable DB-less Kong, HTTP %d: %v", res.StatusCode, err)
	}
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	data, err := os.ReadFile("../../../../contracts/examples/snapshot.example.json")
	if err != nil {
		t.Fatal(err)
	}
	cp.SetSnapshot(data)
	statusURL := os.Getenv("KONG_STATUS_URL")
	if statusURL == "" {
		statusURL = "http://127.0.0.1:8100"
	}
	a, err := New(Config{
		ControlPlaneURL: cp.HTTP.URL, RegistrationToken: cpmock.RegistrationToken,
		NodeID: "integration-node", Hostname: "integration-host", KongAdminURL: admin,
		KongStatusURL: statusURL, SnapshotPath: filepath.Join(t.TempDir(), "kong.json"),
	}, slog.New(slog.NewJSONHandler(io.Discard, nil)))
	if err != nil {
		t.Fatal(err)
	}
	start(t, a)
	registration := receive(t, cp.Registrations, nil)
	if registration.KongVersion != info.Version {
		t.Fatal("agent did not discover the running Kong version")
	}
	waitState(t, cp, "applied", 1)
	saved, err := a.store.load()
	if err != nil || saved.Hash != example(t, 1).Hash {
		t.Fatalf("example was not persisted: %v", err)
	}
	proxy := os.Getenv("KONG_PROXY_URL")
	if proxy == "" {
		u, err := url.Parse(admin)
		if err != nil {
			t.Fatal(err)
		}
		u.Host = u.Hostname() + ":8000"
		u.Path = ""
		proxy = u.String()
	}
	ctx, cancel := context.WithTimeout(t.Context(), 10*time.Second)
	defer cancel()
	for {
		req, _ := http.NewRequestWithContext(ctx, "GET", endpoint(proxy, "/echo"), nil)
		res, err := httpClient.Do(req)
		if err != nil {
			t.Fatalf("Kong proxy is unreachable: %v", err)
		}
		res.Body.Close()
		if res.StatusCode == http.StatusUnauthorized {
			break
		}
		if ctx.Err() != nil || !wait(ctx, 100*time.Millisecond) {
			t.Fatalf("example key-auth route did not become active, HTTP %d", res.StatusCode)
		}
	}
	req, _ := http.NewRequestWithContext(ctx, "GET", endpoint(proxy, "/echo"), nil)
	req.Header.Set("apikey", "demo-key-123")
	res, err = httpClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(res.Body)
	if err != nil || res.StatusCode != http.StatusOK || !strings.Contains(string(body), "Hostname") || !strings.Contains(string(body), "demo-app") {
		t.Fatalf("example did not reach echo with its consumer: HTTP %d, read error %v", res.StatusCode, err)
	}
	if res.Header.Get("X-RateLimit-Limit-Minute") != "60" && res.Header.Get("RateLimit-Limit") != "60" {
		t.Fatal("example rate-limiting plugin is not active")
	}
	t.Logf("applied the contract example to Kong %s and verified proxy, key-auth, consumer and rate limit", info.Version)
}
