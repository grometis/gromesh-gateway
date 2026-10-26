// kong-liveness is the exec liveness probe of the kong container, independent of the supervisor: it fails when the
// supervisor's heartbeat is older than 3 s (CLOCK_BOOTTIME) or when nginx runs without a valid lease. While nginx is
// not running it passes, so waiting for a lease never becomes a restart loop.
package main

import (
	"encoding/json"
	"errors"
	"fmt"
	"os"
	"strconv"
	"strings"
	"syscall"
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
	running, err := nginxRunning()
	if !running {
		return nil
	}
	if err != nil {
		return fmt.Errorf("cannot tell whether nginx runs: %w", err)
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

// nginxRunning reads every process of the container's PID namespace; only a process that vanished during the scan is
// skipped, any other error is a doubt (reported as running).
func nginxRunning() (bool, error) {
	entries, err := os.ReadDir("/proc")
	if err != nil {
		return true, err
	}
	for _, e := range entries {
		if _, err := strconv.Atoi(e.Name()); err != nil {
			continue
		}
		comm, err := os.ReadFile("/proc/" + e.Name() + "/comm")
		if errors.Is(err, os.ErrNotExist) || errors.Is(err, syscall.ESRCH) {
			continue
		}
		if err != nil {
			return true, err
		}
		if strings.TrimSpace(string(comm)) == "nginx" {
			return true, nil
		}
	}
	return false, nil
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
