package agent

import (
	"fmt"
	"net/url"
	"os"
	"strings"
)

const Version = "0.1.0"

type Config struct {
	ControlPlaneURL   string
	RegistrationToken string
	NodeID            string
	Hostname          string
	KongAdminURL      string
	KongStatusURL     string
	SnapshotPath      string
	StateDir          string
	// Workspaces mode (GROMESH_HANDOFF_DIR set): the agent asks for the pod's isolation admission and carries the
	// probe's documents through the handoff; it never interprets them.
	HandoffDir string
	PodUID     string
	PodName    string
	NodeName   string
	BootIDFile string
}

func ConfigFromEnv() (Config, error) {
	hostname, err := os.Hostname()
	if err != nil {
		return Config{}, fmt.Errorf("get hostname: %w", err)
	}
	value := func(key, fallback string) string {
		if v := os.Getenv(key); v != "" {
			return v
		}
		return fallback
	}
	c := Config{
		ControlPlaneURL: os.Getenv("GROMESH_CP_URL"), RegistrationToken: os.Getenv("GROMESH_REGISTRATION_TOKEN"),
		NodeID: value("GROMESH_NODE_ID", hostname), Hostname: hostname,
		KongAdminURL:  value("KONG_ADMIN_URL", "unix:///kong/admin/admin.sock"),
		KongStatusURL: value("KONG_STATUS_URL", "unix:///kong/admin/status.sock"),
		SnapshotPath:  value("SNAPSHOT_PATH", "/kong/declarative/kong.json"),
		StateDir:      value("GROMESH_STATE_DIR", defaultStateDir),
		HandoffDir:    os.Getenv("GROMESH_HANDOFF_DIR"), PodUID: os.Getenv("GROMESH_POD_UID"),
		PodName: os.Getenv("GROMESH_POD_NAME"), NodeName: os.Getenv("GROMESH_NODE_NAME"),
		BootIDFile: value("GROMESH_BOOT_ID_FILE", "/proc/sys/kernel/random/boot_id"),
	}
	return c, c.validate()
}

func (c Config) validate() error {
	if strings.TrimSpace(c.RegistrationToken) == "" || strings.ContainsAny(c.RegistrationToken, "\r\n") {
		return fmt.Errorf("GROMESH_REGISTRATION_TOKEN is required and must be a single line")
	}
	if c.NodeID == "" || c.Hostname == "" || c.SnapshotPath == "" {
		return fmt.Errorf("node ID, hostname and snapshot path are required")
	}
	if c.HandoffDir != "" && (!uuidPattern.MatchString(c.PodUID) || c.PodName == "" || len(c.PodName) > 253 || c.NodeName == "" || len(c.NodeName) > 253 || c.BootIDFile == "") {
		return fmt.Errorf("GROMESH_HANDOFF_DIR requires GROMESH_POD_UID (UUID), GROMESH_POD_NAME and GROMESH_NODE_NAME")
	}
	for _, field := range []struct {
		name, value string
		socket      bool
	}{
		{"GROMESH_CP_URL", c.ControlPlaneURL, false}, {"KONG_ADMIN_URL", c.KongAdminURL, true}, {"KONG_STATUS_URL", c.KongStatusURL, true},
	} {
		if _, ok := unixSocket(field.value); ok && field.socket {
			continue
		}
		u, err := url.Parse(field.value)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			if field.socket {
				return fmt.Errorf("%s must be unix:///<absolute path> or an HTTP(S) URL without credentials, query or fragment", field.name)
			}
			return fmt.Errorf("%s must be an HTTP(S) URL without credentials, query or fragment", field.name)
		}
	}
	return nil
}

// unixSocket returns the socket path of a unix:///<absolute path> URL. Kong's Admin and status APIs listen
// only on Unix sockets in the pod (contract: agent-protocol), so no proxied request can reach them.
func unixSocket(raw string) (string, bool) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "unix" || u.Host != "" || !strings.HasPrefix(u.Path, "/") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
		return "", false
	}
	return u.Path, true
}
