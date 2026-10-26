package node

import "testing"

func TestOffsetsZero(t *testing.T) {
	for text, want := range map[string]bool{
		"monotonic 0 0\nboottime 0 0\n": true,
		"":                              false,
		"monotonic 0 0":                 false,
		"monotonic 0 0\nmonotonic 0 0":  false,
		"monotonic 0 0\nboottime 0 0\nrealtime 0 0": false,
		"monotonic 0 0\nboottime 3600 0":            false,
		"boottime 0 1":                              false,
		"garbage":                                   false,
	} {
		if got := offsetsZero(text); got != want {
			t.Errorf("%q: got %v", text, got)
		}
	}
}
