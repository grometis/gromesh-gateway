// test-lease-writer stands in for the isolation-probe in e2e tests only (never shipped in an image): every 500 ms it
// writes the lease for GROMESH_POD_UID according to the mode in the file GROMESH_TEST_MODE_FILE:
// ok | violation | other-boot | other-pod | duplicate-state | trailing-data | stop (stop renewing; the last lease
// expires on its own). duplicate-state and trailing-data write documents no reader may accept.
package main

import (
	"crypto/rand"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/lease"
	"github.com/gromesh/gateway/apps/isolation/internal/node"
)

func main() {
	file := os.Getenv("GROMESH_LEASE_FILE")
	modeFile := os.Getenv("GROMESH_TEST_MODE_FILE")
	pod := os.Getenv("GROMESH_POD_UID")
	for {
		mode := "stop"
		if b, err := os.ReadFile(modeFile); err == nil {
			mode = strings.TrimSpace(string(b))
		}
		if mode != "stop" {
			if err := write(file, mode, pod); err != nil {
				fmt.Fprintln(os.Stderr, "test-lease-writer:", err)
			}
		}
		time.Sleep(500 * time.Millisecond)
	}
}

func write(file, mode, pod string) error {
	n := node.Observe(pod)
	if n.ClockErr != nil {
		return n.ClockErr
	}
	nonce := make([]byte, 16)
	_, _ = rand.Read(nonce)
	l := lease.Lease{State: "ok", PodUID: pod, BootID: n.BootID, AdmissionID: "6a1f3c2e-0b7d-4c1a-9f10-0000000000ad",
		IssuedBoottimeNs: n.Now, ExpiresBoottimeNs: n.Now + uint64(lease.Validity), Nonce: base64.RawURLEncoding.EncodeToString(nonce),
		Capabilities: []string{"CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6", "CAP-7"}, IssuedAt: time.Now().UTC().Format(time.RFC3339)}
	switch mode {
	case "violation":
		l.State = "violation"
	case "other-boot":
		l.BootID = "0b5d6a4e-1f2c-4d3b-8a9e-000000000000"
	case "other-pod":
		l.PodUID = "6a1f3c2e-0b7d-4c1a-9f10-0000000000ff"
	}
	data, _ := json.Marshal(l)
	switch mode {
	case "duplicate-state":
		data = []byte(strings.Replace(string(data), `{"state":"ok"`, `{"state":"violation","state":"ok"`, 1))
	case "trailing-data":
		data = append(data, ']')
	}
	tmp := filepath.Join(filepath.Dir(file), ".lease.tmp")
	if err := os.WriteFile(tmp, data, 0o644); err != nil {
		return err
	}
	return os.Rename(tmp, file)
}
