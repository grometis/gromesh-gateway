package node

import (
	"syscall"
	"unsafe"
)

const clockBoottime = 7

// BootTime is CLOCK_BOOTTIME in nanoseconds: monotonic, unaffected by wall clock changes, counting suspend.
func BootTime() (uint64, error) {
	var ts syscall.Timespec
	if _, _, errno := syscall.Syscall(syscall.SYS_CLOCK_GETTIME, clockBoottime, uintptr(unsafe.Pointer(&ts)), 0); errno != 0 {
		return 0, errno
	}
	return uint64(ts.Sec)*1e9 + uint64(ts.Nsec), nil
}
