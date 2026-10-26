// Package node reads what a lease is checked against: the boot id, CLOCK_BOOTTIME and the time namespace offsets.
package node

import (
	"errors"
	"os"
	"strings"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

const (
	BootIDFile      = "/proc/sys/kernel/random/boot_id"
	TimeOffsetsFile = "/proc/self/timens_offsets"
)

// Observe reads the reader's own view; podUID comes from the downward API (GROMESH_POD_UID).
func Observe(podUID string) lease.Node {
	n := lease.Node{PodUID: podUID}
	if b, err := os.ReadFile(BootIDFile); err == nil {
		n.BootID = strings.TrimSpace(string(b))
	}
	n.Now, n.ClockErr = BootTime()
	n.TimeNamespaceZero = timeNamespaceZero()
	return n
}

// A kernel without time namespaces has no offsets file: zero by definition.
func timeNamespaceZero() bool {
	b, err := os.ReadFile(TimeOffsetsFile)
	if errors.Is(err, os.ErrNotExist) {
		return true
	}
	if err != nil {
		return false
	}
	return offsetsZero(string(b))
}

// offsetsZero parses lines "<clock> <seconds> <nanoseconds>".
func offsetsZero(text string) bool {
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		f := strings.Fields(line)
		if len(f) == 0 {
			continue
		}
		if len(f) != 3 || f[1] != "0" || f[2] != "0" {
			return false
		}
	}
	return true
}
