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
		KongAdminURL:  value("KONG_ADMIN_URL", "http://127.0.0.1:8001"),
		KongStatusURL: value("KONG_STATUS_URL", "http://127.0.0.1:8100"),
		SnapshotPath:  value("SNAPSHOT_PATH", "/kong/declarative/kong.json"),
		StateDir:      value("GROMESH_STATE_DIR", defaultStateDir),
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
	for _, field := range []struct{ name, value string }{
		{"GROMESH_CP_URL", c.ControlPlaneURL}, {"KONG_ADMIN_URL", c.KongAdminURL}, {"KONG_STATUS_URL", c.KongStatusURL},
	} {
		u, err := url.Parse(field.value)
		if err != nil || u.Host == "" || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil || u.RawQuery != "" || u.Fragment != "" {
			return fmt.Errorf("%s must be an HTTP(S) URL without credentials, query or fragment", field.name)
		}
	}
	return nil
}
