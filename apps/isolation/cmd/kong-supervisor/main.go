// kong-supervisor is PID 1 of the kong container in Workspaces mode: kong-supervisor [--] <command...>.
// Environment: GROMESH_POD_UID (downward API), GROMESH_LEASE_FILE, GROMESH_KONG_STATE_FILE.
package main

import (
	"fmt"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
	"github.com/gromesh/gateway/apps/isolation/internal/node"
	"github.com/gromesh/gateway/apps/isolation/internal/supervisor"
)

func main() {
	command := os.Args[1:]
	if len(command) > 0 && command[0] == "--" {
		command = command[1:]
	}
	if len(command) == 0 {
		command = []string{"/usr/local/bin/gromesh-entrypoint", "kong", "docker-start"}
	}
	leaseFile := env("GROMESH_LEASE_FILE", "/gromesh/isolation/lease.json")
	podUID := os.Getenv("GROMESH_POD_UID")
	logf := func(format string, args ...any) {
		fmt.Fprintf(os.Stderr, "kong-supervisor: "+format+"\n", args...)
	}

	stop := make(chan os.Signal, 4)
	signal.Notify(stop, syscall.SIGQUIT, syscall.SIGTERM, syscall.SIGINT)
	children := make(chan os.Signal, 16)
	signal.Notify(children, syscall.SIGCHLD)

	os.Exit(supervisor.Run(supervisor.Config{
		Command: command,
		Check: func() error {
			l, err := lease.Read(leaseFile)
			if err != nil {
				return err
			}
			return lease.Check(l, node.Observe(podUID))
		},
		Boottime:  node.BootTime,
		StateFile: env("GROMESH_KONG_STATE_FILE", "/gromesh/kong-state/kong-state.json"),
		Period:    time.Second,
		KillAfter: 500 * time.Millisecond,
		Drain:     18 * time.Second,
		Logf:      logf,
	}, stop, children))
}

func env(name, fallback string) string {
	if v := os.Getenv(name); v != "" {
		return v
	}
	return fallback
}
