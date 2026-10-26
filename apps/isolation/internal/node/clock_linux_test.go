package node

import (
	"testing"
	"time"
)

func TestBootTimeIsMonotonicAndCountsTime(t *testing.T) {
	a, err := BootTime()
	if err != nil || a == 0 {
		t.Fatalf("CLOCK_BOOTTIME: %d %v", a, err)
	}
	time.Sleep(20 * time.Millisecond)
	b, _ := BootTime()
	if b < a+uint64(15*time.Millisecond) {
		t.Fatalf("CLOCK_BOOTTIME did not advance: %d → %d", a, b)
	}
}
