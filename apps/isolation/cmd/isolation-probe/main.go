// isolation-probe is the native sidecar that proves the kong pod's isolation and issues its lease.
// isolation-probe        run (rounds every 15 s; the guard canary every second while a lease is out)
// isolation-probe ready  exec readiness: the pod is Ready only in state ok with a valid lease (the probe never listens)
// isolation-probe check-config <file>  validates a configuration with the probe's own rules (chart CI)
// isolation-probe check-trust-set <file>  validates an InstanceTrustSet with the probe's own rules (chart CI)
// isolation-probe install <dir>  copies kong-supervisor and kong-liveness, shipped beside it, into dir (init
// container: the kong image does not carry them)
// Environment: GROMESH_POD_UID, GROMESH_CLUSTER_ID, GROMESH_INSTANCE_KEYS (the InstanceTrustSet file),
// GROMESH_PROBE_DIR, GROMESH_HANDOFF_DIR, GROMESH_PROBE_CONFIG, GROMESH_CANARY_URL, GROMESH_KONG_STATE_FILE
// (kong-supervisor's state, read-only, for the final report).
package main

import (
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
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
	if len(os.Args) == 3 && os.Args[1] == "check-config" {
		// The chart's CI: the configuration it renders, validated by the probe's own rules.
		if _, err := probe.LoadConfig(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("probe config ok")
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "check-trust-set" {
		if _, err := probe.LoadTrustSet(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, err)
			os.Exit(1)
		}
		fmt.Println("instance trust set ok")
		return
	}
	if len(os.Args) == 3 && os.Args[1] == "install" {
		if err := install(os.Args[2]); err != nil {
			fmt.Fprintln(os.Stderr, "isolation-probe install:", err)
			os.Exit(1)
		}
		return
	}
	logf := func(format string, args ...any) { fmt.Fprintf(os.Stderr, "isolation-probe: "+format+"\n", args...) }
	trustFile := env("GROMESH_INSTANCE_KEYS", "/etc/gromesh/instance-keys.json")
	cfg, err := probe.LoadConfig(env("GROMESH_PROBE_CONFIG", "/etc/gromesh/probe.json"))
	if err != nil {
		// Without a complete configuration nothing can be proven: no lease, ever.
		logf("%v: no lease will be issued", err)
		select {}
	}
	canaryURL := env("GROMESH_CANARY_URL", "http://127.0.0.1:8000/.gromesh/guard/current")
	kongState := env("GROMESH_KONG_STATE_FILE", "/gromesh/kong-state/kong-state.json")
	proxy := "127.0.0.1:8000"
	if u, err := url.Parse(canaryURL); err == nil && u.Host != "" {
		proxy = u.Host
	}
	client := &http.Client{Timeout: time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	p := &probe.Probe{
		Dir: dir, Handoff: env("GROMESH_HANDOFF_DIR", "/gromesh/handoff"),
		ClusterID: os.Getenv("GROMESH_CLUSTER_ID"), PodUID: os.Getenv("GROMESH_POD_UID"), Config: cfg, Network: probe.RealNetwork(),
		TrustSet: func() (probe.TrustSet, error) { return probe.LoadTrustSet(trustFile) },
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
	// Without it every applied.json counts as absent: readiness as in N2, and no applied revision is reported.
	p.InstanceID = os.Getenv("GROMESH_INSTANCE_ID")
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
			// The pod's stop: the final report, with what could be confirmed about Kong (probe.KongStopConfirmed).
			p.Terminate(probe.KongStopConfirmed(kongState, proxy))
			return
		case <-tick.C:
		}
	}
}

// install copies each binary through an exclusive temporary of its own, so an interrupted earlier attempt never blocks
// a retry, and renames it into place.
func install(dest string) error {
	self, err := os.Executable()
	if err != nil {
		return err
	}
	return installFrom(filepath.Dir(self), dest)
}

func installFrom(src, dest string) error {
	for _, name := range []string{"kong-supervisor", "kong-liveness"} {
		data, err := os.ReadFile(filepath.Join(src, name))
		if err != nil {
			return err
		}
		f, err := os.CreateTemp(dest, "."+name+".*")
		if err != nil {
			return err
		}
		_, werr := f.Write(data)
		if cerr := f.Close(); werr == nil {
			werr = cerr
		}
		if werr == nil {
			werr = os.Chmod(f.Name(), 0o555)
		}
		if werr == nil {
			werr = os.Rename(f.Name(), filepath.Join(dest, name))
		}
		if werr != nil {
			_ = os.Remove(f.Name())
			return werr
		}
	}
	return nil
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
