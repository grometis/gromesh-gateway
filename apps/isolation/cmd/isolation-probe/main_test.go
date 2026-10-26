package main

import (
	"os"
	"path/filepath"
	"testing"
)

// An attempt interrupted between write and rename leaves a read-only temporary behind: the retry must still install.
func TestInstallRecoversFromAnInterruptedAttempt(t *testing.T) {
	src, dest := t.TempDir(), t.TempDir()
	for _, name := range []string{"kong-supervisor", "kong-liveness"} {
		if err := os.WriteFile(filepath.Join(src, name), []byte("binary "+name), 0o755); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dest, "."+name), []byte("partial"), 0o555); err != nil {
			t.Fatal(err)
		}
		if err := os.WriteFile(filepath.Join(dest, "."+name+".123"), []byte("partial"), 0o555); err != nil {
			t.Fatal(err)
		}
	}
	if err := installFrom(src, dest); err != nil {
		t.Fatal(err)
	}
	if err := installFrom(src, dest); err != nil {
		t.Fatalf("a second install must succeed too: %v", err)
	}
	for _, name := range []string{"kong-supervisor", "kong-liveness"} {
		info, err := os.Stat(filepath.Join(dest, name))
		data, _ := os.ReadFile(filepath.Join(dest, name))
		if err != nil || info.Mode().Perm() != 0o555 || string(data) != "binary "+name {
			t.Fatalf("%s: %v %v %q", name, err, info.Mode(), data)
		}
	}
}
