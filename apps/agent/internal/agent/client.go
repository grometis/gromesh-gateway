package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"strings"
	"time"
	"unicode/utf8"
)

const maxSnapshotBytes = 64 << 20

type client struct {
	config       Config
	http         *http.Client
	applyHTTP    *http.Client
	token        string
	unauthorized chan struct{}
}

type applyError struct {
	statusCode int
	message    string
}

func (e *applyError) Error() string { return e.message }

func (c *client) request(ctx context.Context, method, endpoint, token string, body []byte, headers map[string]string) (*http.Response, error) {
	req, err := http.NewRequestWithContext(ctx, method, endpoint, bytes.NewReader(body))
	if err != nil {
		return nil, fmt.Errorf("create HTTP request")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	for k, v := range headers {
		req.Header.Set(k, v)
	}
	res, err := c.http.Do(req)
	if err != nil {
		// URLs and request bodies can contain credentials; keep transport errors out of logs.
		return nil, fmt.Errorf("HTTP request failed")
	}
	return res, nil
}

func endpoint(base, path string) string { return strings.TrimRight(base, "/") + path }

func (c *client) nodeRequest(ctx context.Context, method, path string, body []byte, headers map[string]string) (*http.Response, error) {
	res, err := c.request(ctx, method, endpoint(c.config.ControlPlaneURL, path), c.token, body, headers)
	if err == nil && res.StatusCode == http.StatusUnauthorized {
		select {
		case c.unauthorized <- struct{}{}:
		default:
		}
	}
	return res, err
}

func (c *client) register(ctx context.Context) (Registration, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := c.request(ctx, "GET", c.config.KongAdminURL, "", nil, nil)
	if err != nil {
		return Registration{}, fmt.Errorf("read Kong version: %w", err)
	}
	var info struct {
		Version string `json:"version"`
	}
	err = json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&info)
	res.Body.Close()
	if res.StatusCode != http.StatusOK || err != nil || info.Version == "" {
		return Registration{}, fmt.Errorf("invalid Kong version response (HTTP %d)", res.StatusCode)
	}
	body, _ := json.Marshal(RegisterRequest{NodeID: c.config.NodeID, Hostname: c.config.Hostname, KongVersion: info.Version, AgentVersion: Version})
	res, err = c.request(ctx, "POST", endpoint(c.config.ControlPlaneURL, "/agent/v1/register"), c.config.RegistrationToken, body, nil)
	if err != nil {
		return Registration{}, err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusOK {
		return Registration{}, fmt.Errorf("registration returned HTTP %d", res.StatusCode)
	}
	var r Registration
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&r); err != nil {
		return r, fmt.Errorf("invalid registration response")
	}
	if !validRegistration(r) {
		return r, fmt.Errorf("invalid registration fields or intervals")
	}
	c.token = r.NodeToken
	return r, nil
}

func (c *client) snapshot(ctx context.Context, hash string) (*Snapshot, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	headers := map[string]string{}
	if hash != "" {
		headers["If-None-Match"] = hash
	}
	res, err := c.nodeRequest(ctx, "GET", "/agent/v1/snapshots/current", nil, headers)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent, http.StatusNotModified:
		return nil, nil
	case http.StatusOK:
	default:
		return nil, fmt.Errorf("snapshot returned HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxSnapshotBytes+1))
	if err != nil || len(b) > maxSnapshotBytes {
		return nil, fmt.Errorf("cannot read snapshot or snapshot exceeds 64 MiB")
	}
	s, err := DecodeSnapshot(b)
	if err != nil {
		return nil, err
	}
	if tag := res.Header.Get("ETag"); tag != "" && tag != s.Hash {
		return nil, fmt.Errorf("snapshot ETag does not match envelope hash")
	}
	return s, nil
}

func (c *client) apply(ctx context.Context, config []byte) error {
	ctx, cancel := context.WithTimeout(ctx, 60*time.Second)
	defer cancel()
	applyClient := *c
	if c.applyHTTP != nil {
		applyClient.http = c.applyHTTP
	}
	res, err := applyClient.request(ctx, "POST", endpoint(c.config.KongAdminURL, "/config"), "", config, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode >= 200 && res.StatusCode < 300 {
		return nil
	}
	b, _ := io.ReadAll(io.LimitReader(res.Body, 8<<10))
	message := strings.ToValidUTF8(string(b), "�")
	for len(message) > 8<<10 {
		_, size := utf8.DecodeLastRuneInString(message)
		message = message[:len(message)-size]
	}
	// Kong may echo submitted credentials in its validation error.
	message = strings.ReplaceAll(message, c.config.RegistrationToken, "REDACTED")
	if c.token != "" {
		message = strings.ReplaceAll(message, c.token, "REDACTED")
	}
	for len(message) > 8<<10 {
		_, size := utf8.DecodeLastRuneInString(message)
		message = message[:len(message)-size]
	}
	if message == "" {
		message = fmt.Sprintf("Kong returned HTTP %d", res.StatusCode)
	}
	return &applyError{statusCode: res.StatusCode, message: message}
}

func (c *client) report(ctx context.Context, status StatusReport) error {
	healthCtx, cancelHealth := context.WithTimeout(ctx, 2*time.Second)
	res, err := c.request(healthCtx, "GET", endpoint(c.config.KongStatusURL, "/status"), "", nil, nil)
	if err == nil {
		status.KongHealthy = res.StatusCode == http.StatusOK
		res.Body.Close()
	}
	cancelHealth()
	status.ReportedAt = time.Now().UTC().Format(time.RFC3339Nano)
	body, _ := json.Marshal(status)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err = c.nodeRequest(ctx, "POST", "/agent/v1/status", body, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if res.StatusCode != http.StatusNoContent {
		return fmt.Errorf("status report returned HTTP %d", res.StatusCode)
	}
	return nil
}
