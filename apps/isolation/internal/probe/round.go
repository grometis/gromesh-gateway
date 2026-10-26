// Package probe is the isolation-probe: a native sidecar in the kong pod's network namespace that proves, by trying
// them, that what Kong must not reach is unreachable (CAP-1 to CAP-7), and only then issues the lease the guard, the
// supervisor and the liveness read. A NetworkPolicy manifest is never proof; only a conclusive round is.
package probe

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net"
	"net/http"
	"net/url"
	"os"
	"sort"
	"sync"
	"syscall"
	"time"
)

// Capabilities every Workspaces-mode probe must prove (agent-protocol-v2).
var Capabilities = []string{"CAP-1", "CAP-2", "CAP-3", "CAP-4", "CAP-5", "CAP-6", "CAP-7"}

// Check is one target of a round.
//   - tcp: Address must NOT accept a connection (refused, timeout, unresolvable: unreachable).
//   - http: URL must be unreachable or answer exactly ExpectStatus (an internal service that refuses this client).
//   - dns, tcp-open: positive controls; failing them makes the round inconclusive, never passing.
type Check struct {
	Capability   string `json:"capability"`
	Kind         string `json:"kind"`
	Name         string `json:"name"`
	Address      string `json:"address,omitempty"`
	URL          string `json:"url,omitempty"`
	ExpectStatus int    `json:"expectStatus,omitempty"`
	Host         string `json:"host,omitempty"`
}

type Config struct {
	Checks []Check `json:"checks"`
}

// LoadConfig refuses a configuration that leaves a capability without a forbidden target: it could never be proven.
func LoadConfig(path string) (Config, error) {
	data, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	var cfg Config
	dec := json.NewDecoder(bytes.NewReader(data))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&cfg); err != nil {
		return Config{}, fmt.Errorf("probe config: %w", err)
	}
	return cfg, cfg.Validate()
}

func (c Config) Validate() error {
	covered, controls := map[string]bool{}, map[string]bool{}
	for i, ch := range c.Checks {
		known := false
		for _, cap := range Capabilities {
			known = known || cap == ch.Capability
		}
		if !known || ch.Name == "" {
			return fmt.Errorf("probe config: check %d needs a known capability and a name", i)
		}
		switch ch.Kind {
		case "tcp", "tcp-open":
			if host, port, err := net.SplitHostPort(ch.Address); err != nil || host == "" || port == "" {
				return fmt.Errorf("probe config: check %q needs an address host:port", ch.Name)
			}
		case "http":
			u, err := url.Parse(ch.URL)
			if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || ch.ExpectStatus < 100 || ch.ExpectStatus > 599 {
				return fmt.Errorf("probe config: check %q needs an http(s) url and expectStatus", ch.Name)
			}
		case "dns":
			if ch.Host == "" {
				return fmt.Errorf("probe config: check %q needs a host", ch.Name)
			}
		default:
			return fmt.Errorf("probe config: check %q has unknown kind %q", ch.Name, ch.Kind)
		}
		if ch.Kind == "tcp" || ch.Kind == "http" {
			covered[ch.Capability] = true
		}
		controls[ch.Kind] = true
	}
	for _, cap := range Capabilities {
		if !covered[cap] {
			return fmt.Errorf("probe config: %s has no forbidden target", cap)
		}
	}
	// Without positive controls an unreachable target proves nothing: the network itself could be down.
	if !controls["dns"] || !controls["tcp-open"] {
		return errors.New("probe config: needs a dns and a tcp-open positive control")
	}
	return nil
}

// Verdict of one round. Violated wins over everything; Inconclusive means no capability was found broken but the
// round could not prove all of them.
type Verdict struct {
	Violated     []string
	Inconclusive []string
	Proven       []string
	Failures     []string
}

// Network is what a round uses; tests replace it.
type Network interface {
	Dial(ctx context.Context, address string) error
	Get(ctx context.Context, url string) (int, error)
	Resolve(ctx context.Context, host string) error
}

type realNetwork struct{ timeout time.Duration }

func (n realNetwork) Dial(ctx context.Context, address string) error {
	conn, err := (&net.Dialer{Timeout: n.timeout}).DialContext(ctx, "tcp", address)
	if err == nil {
		_ = conn.Close()
	}
	return err
}

func (n realNetwork) Get(ctx context.Context, url string) (int, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, url, nil)
	if err != nil {
		return 0, err
	}
	client := &http.Client{Timeout: n.timeout, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	_ = res.Body.Close()
	return res.StatusCode, nil
}

func (n realNetwork) Resolve(ctx context.Context, host string) error {
	ctx, cancel := context.WithTimeout(ctx, n.timeout)
	defer cancel()
	addrs, err := net.DefaultResolver.LookupHost(ctx, host)
	if err == nil && len(addrs) == 0 {
		err = errors.New("no address")
	}
	return err
}

// RealNetwork dials from the probe's network namespace, which is the kong container's: 2 s per target.
func RealNetwork() Network { return realNetwork{timeout: 2 * time.Second} }

// Round runs every check in parallel within the round budget T; onViolation is called as soon as one forbidden
// target answers, before the others finish (the violation lease is written at once).
func Round(ctx context.Context, cfg Config, network Network, budget time.Duration, onViolation func(capability string)) Verdict {
	ctx, cancel := context.WithTimeout(ctx, budget)
	defer cancel()
	type result struct {
		check   Check
		outcome string // pass | violation | inconclusive
		detail  string
	}
	results := make([]result, len(cfg.Checks))
	var once sync.Once
	var wg sync.WaitGroup
	for i, ch := range cfg.Checks {
		wg.Add(1)
		go func() {
			defer wg.Done()
			outcome, detail := evaluate(ctx, network, ch)
			results[i] = result{ch, outcome, detail}
			if outcome == "violation" && onViolation != nil {
				once.Do(func() { onViolation(ch.Capability) })
			}
		}()
	}
	wg.Wait()

	state := map[string]string{}
	var v Verdict
	for _, r := range results {
		rank := map[string]int{"pass": 0, "inconclusive": 1, "violation": 2}
		if cur, ok := state[r.check.Capability]; !ok || rank[r.outcome] > rank[cur] {
			state[r.check.Capability] = r.outcome
		}
		if r.outcome != "pass" {
			v.Failures = append(v.Failures, fmt.Sprintf("%s %s: %s", r.check.Capability, r.check.Name, r.detail))
		}
	}
	// A round cut by its budget proves nothing.
	timedOut := ctx.Err() != nil
	for _, cap := range Capabilities {
		switch {
		case state[cap] == "violation":
			v.Violated = append(v.Violated, cap)
		case state[cap] == "inconclusive" || timedOut:
			v.Inconclusive = append(v.Inconclusive, cap)
		default:
			v.Proven = append(v.Proven, cap)
		}
	}
	sort.Strings(v.Failures)
	return v
}

// Unreachable is proven only by the network refusing or dropping the connection. A name that does not resolve, a TLS
// or protocol error, or any other failure proves nothing about the destination: inconclusive.
func unreachable(err error) bool {
	var dnsErr *net.DNSError
	if errors.As(err, &dnsErr) {
		return false
	}
	var opErr *net.OpError
	if errors.As(err, &opErr) && opErr.Op == "dial" {
		return true
	}
	return errors.Is(err, syscall.ECONNREFUSED) || errors.Is(err, syscall.EHOSTUNREACH) || errors.Is(err, syscall.ENETUNREACH) || errors.Is(err, os.ErrDeadlineExceeded)
}

func evaluate(ctx context.Context, network Network, ch Check) (string, string) {
	switch ch.Kind {
	case "tcp":
		err := network.Dial(ctx, ch.Address)
		if err == nil {
			return "violation", "reachable " + ch.Address
		}
		if unreachable(err) {
			return "pass", ""
		}
		return "inconclusive", ch.Address + ": " + err.Error()
	case "http":
		status, err := network.Get(ctx, ch.URL)
		if err == nil && status == ch.ExpectStatus {
			return "pass", ""
		}
		if err == nil {
			return "violation", fmt.Sprintf("%s answered %d", ch.URL, status)
		}
		// Connected but without the expected answer (TLS, protocol, no response) is reachable, not refused.
		if dialErr := network.Dial(ctx, hostPort(ch.URL)); dialErr == nil {
			return "violation", ch.URL + " reachable without the expected answer: " + err.Error()
		} else if unreachable(dialErr) {
			return "pass", ""
		}
		return "inconclusive", ch.URL + ": " + err.Error()
	case "tcp-open":
		if err := network.Dial(ctx, ch.Address); err != nil {
			return "inconclusive", "positive control unreachable: " + err.Error()
		}
		return "pass", ""
	case "dns":
		if err := network.Resolve(ctx, ch.Host); err != nil {
			return "inconclusive", "positive control unresolved: " + err.Error()
		}
		return "pass", ""
	}
	return "inconclusive", "unknown kind"
}

func hostPort(raw string) string {
	u, err := url.Parse(raw)
	if err != nil {
		return ""
	}
	if u.Port() != "" {
		return u.Host
	}
	if u.Scheme == "https" {
		return net.JoinHostPort(u.Hostname(), "443")
	}
	return net.JoinHostPort(u.Hostname(), "80")
}
