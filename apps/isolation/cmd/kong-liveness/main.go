// kong-liveness is the exec liveness probe of the kong container, independent of the supervisor: it fails when the
// supervisor's heartbeat is older than 3 s (CLOCK_BOOTTIME) or when nginx runs without a valid lease. While nginx is
// not running it passes, so waiting for a lease never becomes a restart loop.
package main

import (
	"encoding/json"
	"fmt"
	"os"
	"strings"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
	"github.com/gromesh/gateway/apps/isolation/internal/node"
	"github.com/gromesh/gateway/apps/isolation/internal/supervisor"
)

const maxHeartbeatAge = 3 * time.Second

func main() {
	if err := live(); err != nil {
		fmt.Fprintln(os.Stderr, "kong-liveness:", err)
		os.Exit(1)
	}
}

func live() error {
	data, err := os.ReadFile(env("GROMESH_KONG_STATE_FILE", "/gromesh/kong-state/kong-state.json"))
	if err != nil {
		return fmt.Errorf("supervisor state unreadable: %w", err)
	}
	var state supervisor.State
	if err := json.Unmarshal(data, &state); err != nil {
		return fmt.Errorf("supervisor state malformed: %w", err)
	}
	n := node.Observe(os.Getenv("GROMESH_POD_UID"))
	if n.ClockErr != nil {
		return fmt.Errorf("CLOCK_BOOTTIME unreadable: %w", n.ClockErr)
	}
	if n.Now < state.HeartbeatBoottimeNs || n.Now-state.HeartbeatBoottimeNs > uint64(maxHeartbeatAge) {
		return fmt.Errorf("supervisor heartbeat older than %s", maxHeartbeatAge)
	}
	// Whether nginx runs is read from the container's own PID namespace, not from the supervisor.
	if !nginxRunning() {
		return nil
	}
	l, err := lease.Read(env("GROMESH_LEASE_FILE", "/gromesh/isolation/lease.json"))
	if err == nil {
		err = lease.Check(l, n)
	}
	if err != nil {
		return fmt.Errorf("nginx runs without a valid lease: %w", err)
	}
	return nil
}

func nginxRunning() bool {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true
	}
	for _, e := range entries {
		if comm, err := os.ReadFile("/proc/" + e.Name() + "/comm"); err == nil && strings.TrimSpace(string(comm)) == "nginx" {
			return true
		}
	}
	return false
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
