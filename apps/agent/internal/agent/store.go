package agent

import (
	"bytes"
	"fmt"
	"io"
	"os"
	"path/filepath"
	"strings"
)

type store struct {
	path   string
	rename func(string, string) error
}

type stagedSnapshot struct {
	store     *store
	dir       string
	link      string
	published bool
}

func (s *store) load() (*Snapshot, error) {
	f, err := os.Open(s.path)
	if os.IsNotExist(err) {
		if _, linkErr := os.Lstat(s.path); linkErr == nil {
			return nil, fmt.Errorf("persisted snapshot link is broken")
		}
		return nil, nil
	}
	if err != nil {
		return nil, fmt.Errorf("read persisted config: %w", err)
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil {
		return nil, err
	}
	dir, err := s.generation(info)
	if err != nil {
		return nil, err
	}
	config, err := io.ReadAll(io.LimitReader(f, maxSnapshotBytes+1))
	if err != nil || len(config) > maxSnapshotBytes {
		return nil, fmt.Errorf("cannot read persisted config or config exceeds 64 MiB")
	}
	data, err := os.ReadFile(filepath.Join(dir, "snapshot.json"))
	if err != nil {
		return nil, fmt.Errorf("read persisted snapshot metadata: %w", err)
	}
	snapshot, err := DecodeSnapshot(data)
	if err != nil {
		return nil, err
	}
	if !bytes.Equal(config, snapshot.Config) {
		return nil, fmt.Errorf("persisted config does not match snapshot metadata")
	}
	return snapshot, nil
}

func (s *store) generation(info os.FileInfo) (string, error) {
	parent := filepath.Dir(s.path)
	entries, err := os.ReadDir(parent)
	if err != nil {
		return "", err
	}
	for _, entry := range entries {
		if !entry.IsDir() || !strings.HasPrefix(entry.Name(), "."+filepath.Base(s.path)+"-") {
			continue
		}
		dir := filepath.Join(parent, entry.Name())
		candidate, err := os.Stat(filepath.Join(dir, "kong.json"))
		if err == nil && os.SameFile(info, candidate) {
			return dir, nil
		}
	}
	return "", fmt.Errorf("persisted config has no matching snapshot metadata")
}

func writeSynced(path string, data []byte) error {
	// The volume is private to the pod; Kong must be able to read it.
	f, err := os.OpenFile(path, os.O_WRONLY|os.O_CREATE|os.O_EXCL, 0644)
	if err != nil {
		return err
	}
	_, writeErr := f.Write(data)
	if writeErr == nil {
		writeErr = f.Sync()
	}
	closeErr := f.Close()
	if writeErr != nil {
		return writeErr
	}
	return closeErr
}

func syncDir(path string) error {
	d, err := os.Open(path)
	if err != nil {
		return err
	}
	defer d.Close()
	return d.Sync()
}

func (s *store) stage(snapshot *Snapshot) (*stagedSnapshot, error) {
	parent := filepath.Dir(s.path)
	if err := os.MkdirAll(parent, 0755); err != nil {
		return nil, err
	}
	dir, err := os.MkdirTemp(parent, "."+filepath.Base(s.path)+"-*")
	if err != nil {
		return nil, err
	}
	p := &stagedSnapshot{store: s, dir: dir, link: dir + ".link"}
	if err := os.Chmod(dir, 0755); err != nil {
		p.discard()
		return nil, err
	}
	data, err := snapshot.MarshalJSON()
	if err == nil {
		err = writeSynced(filepath.Join(dir, "snapshot.json"), data)
	}
	if err == nil {
		err = writeSynced(filepath.Join(dir, "kong.json"), snapshot.Config)
	}
	if err == nil {
		err = syncDir(dir)
	}
	if err == nil {
		err = os.Link(filepath.Join(dir, "kong.json"), p.link)
	}
	if err != nil {
		p.discard()
		return nil, err
	}
	return p, nil
}

func (p *stagedSnapshot) discard() {
	if p.published {
		return
	}
	os.Remove(p.link)
	os.RemoveAll(p.dir)
}

func (p *stagedSnapshot) commit() error {
	previous := ""
	if info, err := os.Stat(p.store.path); err == nil {
		previous, _ = p.store.generation(info)
	}
	rename := p.store.rename
	if rename == nil {
		rename = os.Rename
	}
	// The boot path and generation share an inode, binding metadata to this exact
	// file. Rename publishes a regular file, so removing an old generation cannot
	// break readers that opened the previous boot config concurrently.
	if err := rename(p.link, p.store.path); err != nil {
		return err
	}
	p.published = true
	if err := syncDir(filepath.Dir(p.store.path)); err != nil {
		return fmt.Errorf("sync snapshot directory: %w", err)
	}
	if previous != "" && previous != p.dir {
		os.RemoveAll(previous)
	}
	return nil
}
