// isolation-probe is the native sidecar that proves the kong pod's isolation and issues its lease.
// isolation-probe        run (rounds every 15 s; the guard canary every second while a lease is out)
// isolation-probe ready  exec readiness: the pod is Ready only in state ok with a valid lease (the probe never listens)
// Environment: GROMESH_POD_UID, GROMESH_CLUSTER_ID, GROMESH_INSTANCE_PUBLIC_KEY (Ed25519, base64url),
// GROMESH_PROBE_DIR, GROMESH_HANDOFF_DIR, GROMESH_PROBE_CONFIG, GROMESH_CANARY_URL.
package main

import (
	"context"
	"crypto/ed25519"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"os"
	"os/signal"
	"path/filepath"
	"strings"
	"sync/atomic"
	"syscall"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
	"github.com/gromesh/gateway/apps/isolation/internal/node"
	"github.com/gromesh/gateway/apps/isolation/internal/probe"
)

func main() {
	dir := env("GROMESH_PROBE_DIR", "/gromesh/isolation")
	if len(os.Args) > 1 && os.Args[1] == "ready" {
		os.Exit(ready(dir))
	}
	logf := func(format string, args ...any) { fmt.Fprintf(os.Stderr, "isolation-probe: "+format+"\n", args...) }
	key, err := base64.RawURLEncoding.DecodeString(os.Getenv("GROMESH_INSTANCE_PUBLIC_KEY"))
	if err != nil || len(key) != ed25519.PublicKeySize {
		logf("GROMESH_INSTANCE_PUBLIC_KEY must be an Ed25519 public key in base64url: no lease will be issued")
		select {}
	}
	cfg, err := probe.LoadConfig(env("GROMESH_PROBE_CONFIG", "/etc/gromesh/probe.json"))
	if err != nil {
		// Without a complete configuration nothing can be proven: no lease, ever.
		logf("%v: no lease will be issued", err)
		select {}
	}
	canaryURL := env("GROMESH_CANARY_URL", "http://127.0.0.1:8000/.gromesh/guard/current")
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	p := &probe.Probe{
		Dir: dir, Handoff: env("GROMESH_HANDOFF_DIR", "/gromesh/handoff"),
		ClusterID: os.Getenv("GROMESH_CLUSTER_ID"), PodUID: os.Getenv("GROMESH_POD_UID"), InstanceKey: key,
		Config: cfg, Network: probe.RealNetwork(),
		Canary: func(ctx context.Context) probe.CanaryResult {
			req, _ := http.NewRequestWithContext(ctx, http.MethodGet, canaryURL, nil)
			res, err := client.Do(req)
			if err != nil {
				return probe.CanaryResult{Unreachable: true}
			}
			_ = res.Body.Close()
			return probe.CanaryResult{Status: res.StatusCode, Nonce: res.Header.Get("X-Gromesh-Lease-Nonce"), ConfigHash: res.Header.Get("X-Gromesh-Config-Hash")}
		},
		BootID: func() string {
			b, _ := os.ReadFile(node.BootIDFile)
			return strings.TrimSpace(string(b))
		},
		Boottime: node.BootTime, WallClock: time.Now, Logf: logf,
	}
	if err := p.Open(); err != nil {
		logf("cannot open %s: %v: no lease will be issued", dir, err)
		select {}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGTERM, syscall.SIGINT)
	defer stop()
	tick := time.NewTicker(time.Second)
	defer tick.Stop()
	// Rounds run beside the canary, which keeps checking every second even while a round waits on its targets: a
	// configuration without the guard is caught within 1 s.
	var last time.Time
	var rounding atomic.Bool
	for {
		if time.Since(last) >= probe.Period && rounding.CompareAndSwap(false, true) {
			last = time.Now()
			go func() {
				defer rounding.Store(false)
				p.Round(ctx)
			}()
		}
		p.CanaryStep(ctx)
		select {
		case <-ctx.Done():
			// The final report (kongStopConfirmed) is task N2-D3.
			return
		case <-tick.C:
		}
	}
}

func ready(dir string) int {
	var s probe.Persisted
	data, err := os.ReadFile(filepath.Join(dir, "probe-state.json"))
	if err != nil || json.Unmarshal(data, &s) != nil || s.State != "ok" {
		return 1
	}
	l, err := lease.Read(filepath.Join(dir, "lease.json"))
	if err != nil || lease.Check(l, node.Observe(os.Getenv("GROMESH_POD_UID"))) != nil {
		return 1
	}
	return 0
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
