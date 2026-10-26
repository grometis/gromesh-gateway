package supervisor

import "syscall"

const prSetChildSubreaper = 36

// Orphaned workers are reparented to the supervisor even when it is not PID 1, so it can reap them and confirm that
// nginx's whole group is gone.
func becomeSubreaper() { _, _, _ = syscall.RawSyscall(syscall.SYS_PRCTL, prSetChildSubreaper, 1, 0) }
