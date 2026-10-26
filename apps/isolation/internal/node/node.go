// Package node reads what a lease is checked against: the boot id, CLOCK_BOOTTIME and the time namespace offsets.
package node

import (
	"errors"
	"os"
	"strings"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
)

const (
	BootIDFile        = "/proc/sys/kernel/random/boot_id"
	TimeOffsetsFile   = "/proc/self/timens_offsets"
	TimeNamespaceFile = "/proc/self/ns/time"
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

// Zero only when the offsets file lists exactly monotonic and boottime with 0 0, or when the kernel has no time
// namespaces at all (neither the offsets file nor /proc/self/ns/time). Anything else is a doubt.
func timeNamespaceZero() bool {
	b, err := os.ReadFile(TimeOffsetsFile)
	if errors.Is(err, os.ErrNotExist) {
		_, nsErr := os.Lstat(TimeNamespaceFile)
		return errors.Is(nsErr, os.ErrNotExist)
	}
	if err != nil {
		return false
	}
	return offsetsZero(string(b))
}

func offsetsZero(text string) bool {
	seen := map[string]bool{}
	for _, line := range strings.Split(strings.TrimSpace(text), "\n") {
		f := strings.Fields(line)
		if len(f) != 3 || (f[0] != "monotonic" && f[0] != "boottime") || seen[f[0]] || f[1] != "0" || f[2] != "0" {
			return false
		}
		seen[f[0]] = true
	}
	return seen["monotonic"] && seen["boottime"]
}
