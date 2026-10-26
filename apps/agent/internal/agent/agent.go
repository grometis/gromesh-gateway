package agent

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"math/rand/v2"
	"net"
	"net/http"
	"net/url"
	"sync"
	"sync/atomic"
	"time"
)

type Agent struct {
	config       Config
	client       *client
	store        store
	log          *slog.Logger
	status       StatusReport
	statusMu     sync.RWMutex
	applied      *Snapshot
	failedHash   string
	retryHash    string
	applyAttempt int
	nextApply    time.Time
	applyRetry   func(int) time.Duration
	streamIdle   time.Duration
	poll         time.Duration
	heartbeat    time.Duration
	retry        func(int) time.Duration
	appliedGauge atomic.Int64
	failures     atomic.Uint64
	lastSuccess  atomic.Int64
}

func New(config Config, logger *slog.Logger) (*Agent, error) {
	if config.StateDir == "" {
		config.StateDir = defaultStateDir
	}
	if err := config.validate(); err != nil {
		return nil, err
	}
	if logger == nil {
		logger = slog.Default()
	}
	transport := http.DefaultTransport.(*http.Transport).Clone()
	transport.ResponseHeaderTimeout = 10 * time.Second
	// A unix:// Kong URL is requested at a reserved placeholder host that is only ever dialed at its socket.
	sockets := map[string]string{}
	for host, u := range map[string]*string{"kong-admin.invalid": &config.KongAdminURL, "kong-status.invalid": &config.KongStatusURL} {
		if path, ok := unixSocket(*u); ok {
			sockets[host] = path
			*u = "http://" + host
		}
	}
	dialer := &net.Dialer{Timeout: 30 * time.Second, KeepAlive: 30 * time.Second}
	transport.DialContext = func(ctx context.Context, network, addr string) (net.Conn, error) {
		if host, _, err := net.SplitHostPort(addr); err == nil && sockets[host] != "" {
			return dialer.DialContext(ctx, "unix", sockets[host])
		}
		return dialer.DialContext(ctx, network, addr)
	}
	transport.Proxy = func(r *http.Request) (*url.URL, error) {
		if sockets[r.URL.Hostname()] != "" {
			return nil, nil
		}
		return http.ProxyFromEnvironment(r)
	}
	// Never forward bearer tokens (or config credentials) through redirects.
	httpClient := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	applyTransport := transport.Clone()
	applyTransport.ResponseHeaderTimeout = 60 * time.Second
	applyHTTP := *httpClient
	applyHTTP.Transport = applyTransport
	return &Agent{
		config: config, client: &client{config: config, http: httpClient, applyHTTP: &applyHTTP, unauthorized: make(chan struct{}, 1)},
		store: store{path: config.SnapshotPath}, log: logger,
		status:     StatusReport{NodeID: config.NodeID, State: "idle"},
		streamIdle: 45 * time.Second, retry: retryDelay, applyRetry: applyRetryDelay,
	}, nil
}

func applyRetryDelay(attempt int) time.Duration {
	ceiling := min(time.Second*time.Duration(1<<min(attempt, 6)), 60*time.Second)
	return time.Duration(float64(ceiling) * (0.5 + 0.5*rand.Float64()))
}

func (a *Agent) resetApplyRetry(hash string) {
	a.retryHash = hash
	a.failedHash = ""
	a.applyAttempt = 0
	a.nextApply = time.Time{}
}

func (a *Agent) Run(ctx context.Context) error {
	saved, err := a.store.load()
	if err != nil {
		a.log.Warn("ignoring unusable persisted snapshot", "error", err)
		saved = nil
	}
	identity := identityStore{dir: a.config.StateDir}
	registration, err := identity.load(a.config, a.log)
	if err != nil {
		return err
	}
	if registration != nil {
		a.client.token = registration.NodeToken
	}
	for ctx.Err() == nil {
		if registration == nil {
			for attempt := 0; ; attempt++ {
				if ctx.Err() != nil {
					return nil
				}
				registered, err := a.client.register(ctx)
				if err == nil {
					if err := identity.save(a.config, registered); err != nil {
						return err
					}
					registration = &registered
					break
				}
				a.log.Warn("registration failed; retrying", "error", err)
				if !wait(ctx, a.retry(attempt)) {
					return nil
				}
			}
		}
		if a.runSession(ctx, *registration, saved) {
			return nil
		}
		// All requests from this session have stopped before the token changes.
		if err := identity.revoke(); err != nil {
			return err
		}
		a.client.token = ""
		a.client.unauthorized = make(chan struct{}, 1)
		registration = nil
		saved = a.applied
		a.log.Warn("node token rejected; registering again")
	}
	return nil
}

// runSession returns false only when a node request received 401.
func (a *Agent) runSession(ctx context.Context, registration Registration, saved *Snapshot) bool {
	if saved != nil && saved.EnvironmentID != registration.EnvironmentID {
		a.log.Warn("ignoring persisted snapshot from another environment")
		saved = nil
	}
	if saved != nil {
		a.accept(saved, false)
	}
	pollInterval := a.poll
	if pollInterval == 0 {
		pollInterval = time.Duration(registration.PollIntervalSeconds) * time.Second
	}
	heartbeatInterval := a.heartbeat
	if heartbeatInterval == 0 {
		heartbeatInterval = time.Duration(registration.HeartbeatIntervalSeconds) * time.Second
	}
	a.log.Info("node authenticated", "nodeId", a.config.NodeID)
	a.report(ctx)
	ctx, cancel := context.WithCancel(ctx)
	done := make(chan struct{})
	heartbeatDone := make(chan struct{})
	wake := make(chan struct{}, 1)
	go func() {
		defer close(done)
		a.events(ctx, wake)
	}()
	defer func() {
		cancel()
		<-done
		<-heartbeatDone
		a.client.http.CloseIdleConnections()
		a.client.applyHTTP.CloseIdleConnections()
	}()
	poll := time.NewTicker(pollInterval)
	defer poll.Stop()
	go func() {
		defer close(heartbeatDone)
		ticker := time.NewTicker(heartbeatInterval)
		defer ticker.Stop()
		for {
			select {
			case <-ctx.Done():
				return
			case <-ticker.C:
				a.report(ctx)
			}
		}
	}()
	a.refresh(ctx, registration.EnvironmentID)
	for {
		select {
		case <-ctx.Done():
			return true
		case <-a.client.unauthorized:
			return false
		case <-wake:
			a.refresh(ctx, registration.EnvironmentID)
		case <-poll.C:
			a.refresh(ctx, registration.EnvironmentID)
		}
	}
}

func (a *Agent) report(ctx context.Context) {
	a.statusMu.RLock()
	status := a.status
	a.statusMu.RUnlock()
	if err := a.client.report(ctx, status); err != nil && ctx.Err() == nil {
		a.log.Warn("status report failed", "error", err)
	}
}

func (a *Agent) accept(snapshot *Snapshot, success bool) {
	a.applied = snapshot
	a.statusMu.Lock()
	a.status.State = "applied"
	a.status.AppliedVersion = &snapshot.Version
	a.status.AppliedHash = &snapshot.Hash
	a.status.FailedVersion, a.status.Error = nil, nil
	a.statusMu.Unlock()
	a.resetApplyRetry(snapshot.Hash)
	a.appliedGauge.Store(snapshot.Version)
	if success {
		a.lastSuccess.Store(time.Now().Unix())
	}
}

func (a *Agent) fail(ctx context.Context, snapshot *Snapshot, message string, permanent bool) {
	if permanent {
		a.failedHash = snapshot.Hash
	} else {
		a.nextApply = time.Now().Add(a.applyRetry(a.applyAttempt))
		a.applyAttempt++
	}
	a.statusMu.Lock()
	a.status.State = "failed"
	a.status.FailedVersion = &snapshot.Version
	a.status.Error = &message
	a.statusMu.Unlock()
	a.failures.Add(1)
	a.log.Error("snapshot application failed", "version", snapshot.Version)
	a.report(ctx)
}

func (a *Agent) refresh(ctx context.Context, environmentID string) {
	hash := ""
	if a.applied != nil {
		hash = a.applied.Hash
	}
	snapshot, err := a.client.snapshot(ctx, hash)
	if err != nil {
		if ctx.Err() == nil {
			a.log.Warn("snapshot fetch failed", "error", err)
		}
		return
	}
	if snapshot == nil {
		return
	}
	if snapshot.EnvironmentID != environmentID {
		a.log.Warn("snapshot environment mismatch")
		return
	}
	if snapshot.Hash != a.retryHash {
		a.resetApplyRetry(snapshot.Hash)
	}
	if snapshot.Hash == a.failedHash || time.Now().Before(a.nextApply) {
		return
	}
	if a.applied != nil && snapshot.Version <= a.applied.Version {
		return
	}
	pending, err := a.store.stage(snapshot)
	if err != nil {
		a.fail(ctx, snapshot, "cannot stage snapshot on disk", false)
		return
	}
	committed := false
	defer func() {
		if !committed {
			pending.discard()
		}
	}()
	if snapshot.Hash != hash {
		a.statusMu.Lock()
		a.status.State = "applying"
		a.status.FailedVersion, a.status.Error = nil, nil
		a.statusMu.Unlock()
		a.report(ctx)
		if err := a.client.apply(ctx, snapshot.Config); err != nil {
			var responseErr *applyError
			permanent := errors.As(err, &responseErr) && (responseErr.statusCode == http.StatusBadRequest || responseErr.statusCode == http.StatusRequestEntityTooLarge)
			a.fail(ctx, snapshot, err.Error(), permanent)
			return
		}
	}
	if err := pending.commit(); err != nil {
		if pending.published {
			a.accept(snapshot, true)
			a.fail(ctx, snapshot, "snapshot applied but directory durability could not be confirmed", false)
			return
		}
		// Restore the running config when the durable commit cannot be completed.
		if a.applied != nil && ctx.Err() == nil {
			if rollbackErr := a.client.apply(ctx, a.applied.Config); rollbackErr != nil {
				a.log.Error("failed to restore running config after persistence failure")
			}
		}
		a.fail(ctx, snapshot, "cannot commit snapshot on disk", false)
		return
	}
	committed = true
	a.accept(snapshot, true)
	a.log.Info("snapshot applied", "version", snapshot.Version)
	a.report(ctx)
}

func (a *Agent) MetricsHandler() http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		// Kong shares the pod's network namespace: a route aimed at the agent's own address must not read it, as Kong's
		// 8100 refuses its own pod (loopback, or the address the connection arrived on).
		if fromOwnPod(r) {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		if r.URL.Path != "/metrics" {
			http.NotFound(w, r)
			return
		}
		w.Header().Set("Content-Type", "text/plain; version=0.0.4; charset=utf-8")
		fmt.Fprintf(w, "# TYPE gromesh_agent_applied_version gauge\ngromesh_agent_applied_version %d\n# TYPE gromesh_agent_apply_failures_total counter\ngromesh_agent_apply_failures_total %d\n# TYPE gromesh_agent_last_success_timestamp_seconds gauge\ngromesh_agent_last_success_timestamp_seconds %d\n", a.appliedGauge.Load(), a.failures.Load(), a.lastSuccess.Load())
	})
}

func fromOwnPod(r *http.Request) bool {
	remote, _, err := net.SplitHostPort(r.RemoteAddr)
	ip := net.ParseIP(remote)
	if err != nil || ip == nil {
		return true
	}
	if ip.IsLoopback() || ip.IsUnspecified() {
		return true
	}
	if local, ok := r.Context().Value(http.LocalAddrContextKey).(net.Addr); ok {
		if host, _, err := net.SplitHostPort(local.String()); err == nil {
			if own := net.ParseIP(host); own != nil && own.Equal(ip) {
				return true
			}
		}
	}
	return false
}
