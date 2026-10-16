// Run from repository root: tests/load/agents/run.sh
// Standard library only. Simulates distribution/application ACKs, not 200 Kong
// processes. The separate k6 test exercises real snapshot application in Kong.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/http/cookiejar"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"syscall"
	"time"
)

func env(key, fallback string) string {
	if v := os.Getenv(key); v != "" {
		return v
	}
	return fallback
}

type driver struct {
	cp, agent string
	http      *http.Client
	errors5xx atomic.Int64
	failures  chan error
}

func (d *driver) request(ctx context.Context, method, url, token, lastID string, body interface{}, expected int) (*http.Response, error) {
	var reader io.Reader
	if body != nil {
		raw, err := json.Marshal(body)
		if err != nil {
			return nil, err
		}
		reader = bytes.NewReader(raw)
	}
	req, err := http.NewRequestWithContext(ctx, method, url, reader)
	if err != nil {
		return nil, err
	}
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
	}
	if lastID != "" {
		req.Header.Set("Last-Event-ID", lastID)
	}
	if method != "GET" && token == "" && !strings.HasSuffix(url, "/auth/login") {
		var csrf struct{ CSRFToken string }
		res, err := d.request(ctx, "GET", d.cp+"/auth/csrf", "", "", nil, 200)
		if err != nil {
			return nil, err
		}
		err = json.NewDecoder(res.Body).Decode(&csrf)
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		req.Header.Set("X-CSRF-Token", csrf.CSRFToken)
	}
	res, err := d.http.Do(req)
	if err != nil {
		return nil, fmt.Errorf("%s request failed: %w", method, err)
	}
	if res.StatusCode >= 500 {
		d.errors5xx.Add(1)
	}
	if res.StatusCode != expected {
		res.Body.Close()
		// No response bodies/tokens in errors.
		return nil, fmt.Errorf("%s %s: HTTP %d, expected %d", method, req.URL.Path, res.StatusCode, expected)
	}
	return res, nil
}
func (d *driver) json(ctx context.Context, method, path string, body, target interface{}, expected int) error {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := d.request(ctx, method, d.cp+path, "", "", body, expected)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	if target == nil {
		_, err = io.Copy(io.Discard, res.Body)
		return err
	}
	return json.NewDecoder(res.Body).Decode(target)
}

type node struct {
	id, token string
	applied   publication
}

func (d *driver) register(ctx context.Context, registration string, i int) (*node, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	id := fmt.Sprintf("load-node-%03d", i)
	body := map[string]interface{}{"nodeId": id, "hostname": id, "kongVersion": "simulated", "agentVersion": "w8-x1-load"}
	res, err := d.request(ctx, "POST", d.agent+"/register", registration, "", body, 200)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	var registered struct{ NodeToken string }
	if err := json.NewDecoder(res.Body).Decode(&registered); err != nil {
		return nil, err
	}
	if registered.NodeToken == "" {
		return nil, errors.New("registration did not return a node token")
	}
	return &node{id: id, token: registered.NodeToken}, nil
}
func (d *driver) apply(ctx context.Context, n *node, event publication) error {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	res, err := d.request(ctx, "GET", d.agent+"/snapshots/current", n.token, "", nil, 200)
	if err != nil {
		return err
	}
	// Config stays opaque, as in the real agent. No data-plane JSON is assembled here.
	var snapshot struct {
		Version int
		Hash    string
		Config  json.RawMessage
	}
	err = json.NewDecoder(res.Body).Decode(&snapshot)
	res.Body.Close()
	if err != nil {
		return err
	}
	if snapshot.Version < event.Version || snapshot.Hash == "" || len(snapshot.Config) == 0 {
		return errors.New("invalid/stale current snapshot")
	}
	if snapshot.Version == event.Version && snapshot.Hash != event.Hash {
		return errors.New("event/snapshot hash mismatch")
	}
	report := map[string]interface{}{"nodeId": n.id, "state": "applied", "appliedVersion": snapshot.Version, "appliedHash": snapshot.Hash, "kongHealthy": true, "reportedAt": time.Now().UTC().Format(time.RFC3339Nano)}
	res, err = d.request(ctx, "POST", d.agent+"/status", n.token, "", report, 204)
	if err != nil {
		return err
	}
	res.Body.Close()
	n.applied = publication{Version: snapshot.Version, Hash: snapshot.Hash}
	return nil
}
func (d *driver) failed(err error) {
	select {
	case d.failures <- err:
	default:
	}
}
func (d *driver) check() error {
	select {
	case err := <-d.failures:
		return err
	default:
		return nil
	}
}

type streams struct {
	cancel context.CancelFunc
	wg     sync.WaitGroup
}

func (s *streams) close() { s.cancel(); s.wg.Wait() }
func (d *driver) connect(ctx context.Context, nodes []*node) (*streams, error) {
	ctx, cancel := context.WithCancel(ctx)
	s := &streams{cancel: cancel}
	ready := make(chan error, len(nodes))
	start := make(chan struct{})
	for _, n := range nodes {
		s.wg.Add(1)
		go func(n *node) {
			defer s.wg.Done()
			<-start
			last := ""
			if n.applied.Version > 0 {
				last = strconv.Itoa(n.applied.Version)
			}
			res, err := d.request(ctx, "GET", d.agent+"/events", n.token, last, nil, 200)
			if err != nil {
				ready <- err
				return
			}
			defer res.Body.Close()
			if !strings.HasPrefix(res.Header.Get("Content-Type"), "text/event-stream") {
				ready <- errors.New("SSE content type missing")
				return
			}
			ready <- nil
			err = readEvents(res.Body, func(event publication) error { return d.apply(ctx, n, event) })
			if ctx.Err() == nil {
				if err == nil {
					err = errors.New("unexpected SSE EOF")
				}
				d.failed(err)
			}
		}(n)
	}
	close(start)
	timer := time.NewTimer(30 * time.Second)
	defer timer.Stop()
	for range nodes {
		select {
		case err := <-ready:
			if err != nil {
				s.close()
				return nil, err
			}
		case <-timer.C:
			s.close()
			return nil, errors.New("200 SSE connections did not open within 30 seconds")
		case <-ctx.Done():
			s.close()
			return nil, ctx.Err()
		}
	}
	return s, d.check()
}
func (d *driver) converge(ctx context.Context, clusterID string, count int, p publication) error {
	for {
		if err := d.check(); err != nil {
			return err
		}
		var c cluster
		if err := d.json(ctx, "GET", "/clusters/"+clusterID, nil, &c, 200); err != nil {
			return err
		}
		if c.converged(count, p) {
			return nil
		}
		select {
		case <-ctx.Done():
			return errors.New("agents failed to converge within 30 seconds")
		case <-time.After(100 * time.Millisecond):
		}
	}
}
func (d *driver) hold(ctx context.Context) error {
	// Covers the server's periodic 15s ping and detects unexpected stream closure.
	select {
	case err := <-d.failures:
		return err
	case <-ctx.Done():
		return ctx.Err()
	case <-time.After(16 * time.Second):
		return nil
	}
}
func run(ctx context.Context) (result map[string]interface{}, err error) {
	const count = 200
	jar, _ := cookiejar.New(nil)
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.MaxIdleConns, transport.MaxIdleConnsPerHost = 1000, 1000
	transport.ResponseHeaderTimeout = 10 * time.Second
	client := &http.Client{Transport: transport, Jar: jar, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	defer client.CloseIdleConnections()
	cp := strings.TrimRight(env("CP_URL", "http://127.0.0.1:3000/api/v1"), "/")
	d := &driver{cp: cp, agent: strings.TrimSuffix(cp, "/api/v1") + "/agent/v1", http: client, failures: make(chan error, count*2)}
	if err = d.json(ctx, "POST", "/auth/login", map[string]string{"email": env("BOOTSTRAP_ADMIN_EMAIL", "admin@gromesh.dev"), "password": env("BOOTSTRAP_ADMIN_PASSWORD", "gromesh-dev-admin")}, nil, 200); err != nil {
		return nil, err
	}
	var environment struct{ ID string }
	var c cluster
	var active *streams
	defer func() {
		if active != nil {
			active.close()
		}
		cleanup, cancel := context.WithTimeout(context.Background(), 30*time.Second)
		defer cancel()
		var cleanErrors []error
		if c.ID != "" {
			cleanErrors = append(cleanErrors, d.json(cleanup, "DELETE", "/clusters/"+c.ID, nil, nil, 204))
		}
		if environment.ID != "" {
			cleanErrors = append(cleanErrors, d.json(cleanup, "DELETE", "/environments/"+environment.ID, nil, nil, 204))
		}
		cleanErrors = append(cleanErrors, d.json(cleanup, "POST", "/auth/logout", nil, nil, 204))
		err = errors.Join(append([]error{err}, cleanErrors...)...)
	}()
	if err = d.json(ctx, "POST", "/environments", map[string]string{"name": fmt.Sprintf("agents-%d", time.Now().UnixNano()), "publishMode": "manual"}, &environment, 201); err != nil {
		return nil, err
	}
	path := "/environments/" + environment.ID
	if err = d.json(ctx, "POST", path+"/clusters", map[string]string{"name": "sse-load"}, &c, 201); err != nil {
		return nil, err
	}
	var service struct{ ID string }
	spec := map[string]interface{}{"name": "agent-echo", "protocol": "http", "host": "echo", "port": 80}
	if err = d.json(ctx, "POST", path+"/services", spec, &service, 201); err != nil {
		return nil, err
	}
	nodes := make([]*node, count)
	registered := make(chan error, count)
	barrier := make(chan struct{})
	for i := range nodes {
		go func(i int) {
			<-barrier
			n, err := d.register(ctx, c.RegistrationToken, i)
			nodes[i] = n
			registered <- err
		}(i)
	}
	close(barrier)
	for range nodes {
		if e := <-registered; e != nil {
			err = errors.Join(err, e)
		}
	}
	if err != nil {
		return nil, err
	}
	connectionStart := time.Now()
	if active, err = d.connect(ctx, nodes); err != nil {
		return nil, err
	}
	connectedMs := time.Since(connectionStart).Milliseconds()
	fmt.Fprintln(os.Stderr, "200 SSE connections open; publishing")
	start := time.Now()
	deadline, cancel := context.WithDeadline(ctx, start.Add(30*time.Second))
	var first publication
	err = d.json(deadline, "POST", path+"/snapshots", map[string]string{"message": "200 agent fan-out"}, &first, 201)
	if err == nil {
		err = d.converge(deadline, c.ID, count, first)
	}
	cancel()
	if err != nil {
		return nil, err
	}
	firstMs := time.Since(start).Milliseconds()
	if err = d.hold(ctx); err != nil {
		return nil, err
	}
	active.close()
	active = nil
	// Publish while all streams are disconnected: reconnect must catch up using
	// Last-Event-ID, rather than passing by observing the already-applied version.
	spec["tags"] = []string{"reconnect"}
	if err = d.json(ctx, "PUT", path+"/services/"+service.ID, spec, nil, 200); err != nil {
		return nil, err
	}
	var second publication
	if err = d.json(ctx, "POST", path+"/snapshots", map[string]interface{}{"message": "reconnect catch-up", "expectedCurrentVersion": first.Version}, &second, 201); err != nil {
		return nil, err
	}
	start = time.Now()
	deadline, cancel = context.WithDeadline(ctx, start.Add(30*time.Second))
	active, err = d.connect(ctx, nodes)
	if err == nil {
		err = d.converge(deadline, c.ID, count, second)
	}
	// Measure convergence separately from the subsequent stream observation.
	reconnectMs := time.Since(start).Milliseconds()
	if err == nil {
		err = d.hold(ctx)
	}
	if err == nil {
		err = d.check()
	}
	if active != nil {
		active.close()
		active = nil
	}
	cancel()
	if err != nil {
		return nil, err
	}
	if d.errors5xx.Load() != 0 {
		return nil, fmt.Errorf("control plane returned %d server errors", d.errors5xx.Load())
	}
	return map[string]interface{}{"recordedAt": time.Now().UTC().Format(time.RFC3339), "agents": count, "application": "simulated ACK; opaque snapshot downloaded per event", "connectionMs": connectedMs, "firstConvergenceMs": firstMs, "reconnectConvergenceMs": reconnectMs, "firstVersion": first.Version, "reconnectVersion": second.Version, "http5xx": d.errors5xx.Load(), "unexpectedDisconnects": 0, "observationSecondsPerPhase": 16}, nil
}
func main() {
	ctx, stop := signal.NotifyContext(context.Background(), os.Interrupt, syscall.SIGTERM)
	defer stop()
	ctx, cancel := context.WithTimeout(ctx, 3*time.Minute)
	defer cancel()
	result, err := run(ctx)
	if err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
	encoder := json.NewEncoder(os.Stdout)
	encoder.SetIndent("", "  ")
	if err = encoder.Encode(result); err != nil {
		fmt.Fprintln(os.Stderr, err)
		os.Exit(1)
	}
}
