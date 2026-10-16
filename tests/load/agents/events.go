// Run: tests/load/agents/run.sh
package main

import (
	"bufio"
	"encoding/json"
	"fmt"
	"io"
	"strings"
)

type publication struct {
	Version int    `json:"version"`
	Hash    string `json:"hash"`
}

// SSE data can span lines; only complete frames may trigger a snapshot download.
func readEvents(r io.Reader, apply func(publication) error) error {
	scanner := bufio.NewScanner(r)
	scanner.Buffer(make([]byte, 4096), 1024*1024)
	var event string
	var data []string
	for scanner.Scan() {
		line := scanner.Text()
		if line == "" {
			if event == "snapshot.published" {
				var p publication
				if err := json.Unmarshal([]byte(strings.Join(data, "\n")), &p); err != nil {
					return fmt.Errorf("invalid publication event: %w", err)
				}
				if p.Version < 1 || p.Hash == "" {
					return fmt.Errorf("publication event missing version/hash")
				}
				if err := apply(p); err != nil {
					return err
				}
			}
			event, data = "", nil
			continue
		}
		field, value, _ := strings.Cut(line, ":")
		value = strings.TrimPrefix(value, " ")
		switch field {
		case "event":
			event = value
		case "data":
			data = append(data, value)
		}
	}
	return scanner.Err()
}

type nodeStatus struct {
	State          string
	AppliedVersion int
	KongHealthy    bool
}
type cluster struct {
	ID                string
	RegistrationToken string
	Status            string
	Nodes             []nodeStatus
}

// The public nodes omit appliedHash; the server includes hash equality in status.
func (c cluster) converged(n int, p publication) bool {
	if c.Status != "converged" || len(c.Nodes) != n {
		return false
	}
	for _, node := range c.Nodes {
		if node.State != "applied" || !node.KongHealthy || node.AppliedVersion != p.Version {
			return false
		}
	}
	return true
}
