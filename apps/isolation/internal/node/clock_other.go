//go:build !linux

package node

import "errors"

// Only Linux has CLOCK_BOOTTIME; elsewhere every lease is invalid.
func BootTime() (uint64, error) { return 0, errors.New("CLOCK_BOOTTIME is only available on Linux") }
