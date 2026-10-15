package agent

import (
	"bytes"
	"errors"
	"os"
	"path/filepath"
	"sync"
	"testing"

	"github.com/gromesh/gateway/apps/agent/internal/cpmock"
)

func commitFixture(t *testing.T, s *store, snapshot *Snapshot) {
	t.Helper()
	p, err := s.stage(snapshot)
	if err != nil {
		t.Fatal(err)
	}
	if err := p.commit(); err != nil {
		p.discard()
		t.Fatal(err)
	}
}

func TestAtomicPersistenceAndRenameFailure(t *testing.T) {
	dir := filepath.Join(t.TempDir(), "declarative")
	s := store{path: filepath.Join(dir, "kong.json")}
	one, two := example(t, 1), example(t, 2)
	commitFixture(t, &s, one)
	pending, err := s.stage(two)
	if err != nil {
		t.Fatal(err)
	}
	before, err := s.load()
	if err != nil || before.Version != 1 {
		t.Fatal("staging exposed an unapplied snapshot")
	}
	s.rename = func(string, string) error { return errors.New("injected rename failure") }
	if err := pending.commit(); err == nil {
		t.Fatal("expected rename failure")
	}
	pending.discard()
	after, err := s.load()
	if err != nil || after.Version != 1 || !bytes.Equal(after.Config, one.Config) {
		t.Fatal("rename failure damaged the good snapshot")
	}
	s.rename = nil
	// Readers of the boot path must only ever see an entire old or new config.
	stop := make(chan struct{})
	failures := make(chan error, 1)
	var wg sync.WaitGroup
	wg.Go(func() {
		for {
			select {
			case <-stop:
				return
			default:
			}
			b, err := os.ReadFile(s.path)
			if err != nil || !bytes.Equal(b, one.Config) && !bytes.Equal(b, two.Config) {
				select {
				case failures <- errors.New("reader observed missing or partial config"):
				default:
				}
				return
			}
		}
	})
	for range 10 {
		commitFixture(t, &s, two)
		commitFixture(t, &s, one)
	}
	close(stop)
	wg.Wait()
	select {
	case err := <-failures:
		t.Fatal(err)
	default:
	}
	entries, err := os.ReadDir(dir)
	if err != nil || len(entries) != 2 {
		t.Fatalf("abandoned temporary generations: %v, %d entries", err, len(entries))
	}
	info, err := os.Stat(s.path)
	if err != nil || info.Mode().Perm() != 0644 {
		t.Fatal("boot config must be readable by Kong's user")
	}
	generation, err := s.generation(info)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{dir, generation} {
		info, err := os.Stat(path)
		if err != nil || info.Mode().Perm() != 0755 {
			t.Fatalf("snapshot directory must be traversable by Kong's user: %s", path)
		}
	}
	info, err = os.Stat(filepath.Join(generation, "snapshot.json"))
	if err != nil || info.Mode().Perm() != 0644 {
		t.Fatal("snapshot metadata must have shared-volume file permissions")
	}
}

func TestDiskFailureRestoresRunningConfig(t *testing.T) {
	cp := cpmock.New()
	t.Cleanup(cp.Close)
	k := newKong(t)
	s1, s2 := example(t, 1), example(t, 2)
	a := newTestAgent(t, cp, k, filepath.Join(t.TempDir(), "kong.json"))
	ctx := t.Context()
	if _, err := a.client.register(ctx); err != nil {
		t.Fatal(err)
	}
	cp.SetSnapshot(encoded(t, s1))
	a.refresh(ctx, s1.EnvironmentID)
	a.store.rename = func(string, string) error { return errors.New("disk failure") }
	cp.SetSnapshot(encoded(t, s2))
	a.refresh(ctx, s1.EnvironmentID)
	if a.applied.Version != 1 || a.status.State != "failed" || k.calls.Load() != 3 {
		t.Fatal("persistence failure did not retain and reapply the good config")
	}
	var last []byte
	for range 3 {
		last = receive(t, k.bodies, nil)
	}
	if !bytes.Equal(last, s1.Config) {
		t.Fatal("running config was not restored")
	}
	saved, err := a.store.load()
	if err != nil || saved.Version != 1 {
		t.Fatal("disk failure changed saved version")
	}
}

func TestBrokenOrMismatchedPersistenceIsRejected(t *testing.T) {
	for _, corrupt := range []string{"missing-config", "mismatched-config", "missing-metadata"} {
		t.Run(corrupt, func(t *testing.T) {
			s := store{path: filepath.Join(t.TempDir(), "kong.json")}
			commitFixture(t, &s, example(t, 1))
			info, err := os.Stat(s.path)
			if err != nil {
				t.Fatal(err)
			}
			dir, err := s.generation(info)
			if err != nil {
				t.Fatal(err)
			}
			target := filepath.Join(dir, "kong.json")
			switch corrupt {
			case "missing-config":
				err = os.Remove(target)
			case "mismatched-config":
				err = os.WriteFile(target, []byte("{}"), 0600)
			case "missing-metadata":
				err = os.Remove(filepath.Join(filepath.Dir(target), "snapshot.json"))
			}
			if err != nil {
				t.Fatal(err)
			}
			if _, err := s.load(); err == nil {
				t.Fatal("corrupt persisted state was accepted")
			}
		})
	}
}
