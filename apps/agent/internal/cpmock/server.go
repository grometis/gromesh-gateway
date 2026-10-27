// Package cpmock is an in-process implementation of the agent protocol for tests.
package cpmock

import (
	"bytes"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"regexp"
	"strconv"
	"sync"
	"time"
)

const (
	RegistrationToken = "test-registration-token"
	NodeToken         = "test-node-token"
	EnvironmentID     = "00000000-0000-4000-8000-0000000000e1"
	ClusterID         = "00000000-0000-4000-8000-0000000000c1"
)

type Registration struct {
	NodeID       string `json:"nodeId"`
	Hostname     string `json:"hostname"`
	KongVersion  string `json:"kongVersion"`
	AgentVersion string `json:"agentVersion"`
}

type Status struct {
	NodeID         string  `json:"nodeId"`
	State          string  `json:"state"`
	AppliedVersion *int64  `json:"appliedVersion"`
	AppliedHash    *string `json:"appliedHash"`
	FailedVersion  *int64  `json:"failedVersion"`
	Error          *string `json:"error"`
	KongHealthy    bool    `json:"kongHealthy"`
	ReportedAt     string  `json:"reportedAt"`
}

// DeploymentStatus is the StatusReport of agent protocol v2.
type DeploymentStatus struct {
	NodeID          string  `json:"nodeId"`
	Epoch           int64   `json:"epoch"`
	AppliedRevision *int64  `json:"appliedRevision"`
	AppliedHash     *string `json:"appliedHash"`
	FailedRevision  *int64  `json:"failedRevision"`
	FailedHash      *string `json:"failedHash"`
	FailureStatus   *int    `json:"failureStatus"`
	KongHealthy     bool    `json:"kongHealthy"`
	Analytics       *string `json:"analytics"`
	IsolationState  *string `json:"isolationState"`
}

type Server struct {
	HTTP               *httptest.Server
	Registrations      chan Registration
	Statuses           chan Status
	SnapshotRequests   chan string
	EventConnections   chan string
	DeploymentRequests chan string
	DeploymentStatuses chan DeploymentStatus
	// RefusedStatuses receives the epoch of each v2 status refused with 409.
	RefusedStatuses    chan int64
	mu                 sync.Mutex
	deployment         []byte
	deploymentEpoch    int64
	deploymentRevision int64
	deploymentHash     string
	alwaysSendBody     bool
	down               bool
	snapshot           []byte
	hash               string
	sseDown            bool
	subscribers        map[chan string]struct{}
	closed             chan struct{}
	nodeToken          string
	registrationToken  string
	isolation          http.Handler
}

func New() *Server {
	s := &Server{
		Registrations: make(chan Registration, 128), Statuses: make(chan Status, 128),
		SnapshotRequests: make(chan string, 128), EventConnections: make(chan string, 128),
		DeploymentRequests: make(chan string, 128), DeploymentStatuses: make(chan DeploymentStatus, 128), RefusedStatuses: make(chan int64, 128),
		subscribers: make(map[chan string]struct{}), closed: make(chan struct{}),
		nodeToken:         NodeToken,
		registrationToken: RegistrationToken,
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/register", s.register)
	mux.HandleFunc("GET /agent/v1/snapshots/current", s.current)
	mux.HandleFunc("GET /agent/v1/events", s.events)
	mux.HandleFunc("POST /agent/v1/status", s.status)
	mux.HandleFunc("/agent/v2/isolation/", s.isolationRequest)
	mux.HandleFunc("GET /agent/v2/deployments/current", s.currentDeployment)
	mux.HandleFunc("POST /agent/v2/status", s.deploymentStatus)
	s.HTTP = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		s.mu.Lock()
		down := s.down
		s.mu.Unlock()
		if down {
			// An unreachable control plane: the connection drops without an HTTP answer.
			if conn, _, err := w.(http.Hijacker).Hijack(); err == nil {
				conn.Close()
			}
			return
		}
		mux.ServeHTTP(w, r)
	}))
	return s
}

// SetDown makes every request fail without an HTTP response, as if the control plane were unreachable.
func (s *Server) SetDown(down bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.down = down
}

// SetDeployment serves data (snapshot-v2) as the instance's current deployment; nil serves 404.
func (s *Server) SetDeployment(data []byte) {
	var envelope struct {
		Epoch    int64  `json:"epoch"`
		Revision int64  `json:"revision"`
		Hash     string `json:"hash"`
	}
	if data != nil {
		if err := json.Unmarshal(data, &envelope); err != nil {
			panic(err)
		}
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.deployment = append([]byte(nil), data...)
	if data == nil {
		s.deployment = nil
	}
	s.deploymentEpoch, s.deploymentRevision, s.deploymentHash = envelope.Epoch, envelope.Revision, envelope.Hash
}

// SetAlwaysSendBody answers 200 with the deployment even when If-None-Match names its hash.
func (s *Server) SetAlwaysSendBody(always bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.alwaysSendBody = always
}

func (s *Server) currentDeployment(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	defer func() {
		select {
		case s.DeploymentRequests <- r.Header.Get("If-None-Match"):
		default:
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.deployment == nil {
		w.WriteHeader(http.StatusNotFound)
		return
	}
	// A 304 still carries the current epoch and revision, which the agent confirms.
	w.Header().Set("X-Gromesh-Epoch", strconv.FormatInt(s.deploymentEpoch, 10))
	w.Header().Set("X-Gromesh-Revision", strconv.FormatInt(s.deploymentRevision, 10))
	if r.Header.Get("If-None-Match") == s.deploymentHash && !s.alwaysSendBody {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("ETag", s.deploymentHash)
	w.Header().Set("Content-Type", "application/json")
	w.Write(s.deployment)
}

var digest = regexp.MustCompile(`^sha256:[0-9a-f]{64}$`)

func validDeploymentStatus(body []byte) (DeploymentStatus, bool) {
	var status DeploymentStatus
	var fields map[string]json.RawMessage
	d := json.NewDecoder(bytes.NewReader(body))
	d.DisallowUnknownFields()
	if d.Decode(&status) != nil || json.Unmarshal(body, &fields) != nil {
		return status, false
	}
	for _, required := range []string{"nodeId", "epoch", "appliedRevision", "appliedHash", "kongHealthy"} {
		if _, ok := fields[required]; !ok {
			return status, false
		}
	}
	if string(fields["kongHealthy"]) != "true" && string(fields["kongHealthy"]) != "false" {
		return status, false
	}
	for _, name := range []string{"analytics", "isolationState"} {
		if raw, ok := fields[name]; ok && string(raw) == "null" {
			return status, false
		}
	}
	revision := func(r *int64) bool { return r == nil || *r >= 1 }
	hash := func(h *string) bool { return h == nil || digest.MatchString(*h) }
	analytics := status.Analytics == nil || *status.Analytics == "analytics-healthy" || *status.Analytics == "analytics-degraded"
	isolation := status.IsolationState == nil
	if status.IsolationState != nil {
		switch *status.IsolationState {
		case "awaiting-admission", "verifying", "ok", "inconclusive", "kong-unavailable", "guard-missing", "no-proof", "violation":
			isolation = true
		}
	}
	ok := status.NodeID != "" && len(status.NodeID) <= 253 && status.Epoch >= 1 && revision(status.AppliedRevision) &&
		hash(status.AppliedHash) && revision(status.FailedRevision) && hash(status.FailedHash) && analytics && isolation
	return status, ok
}

func (s *Server) deploymentStatus(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	var body bytes.Buffer
	if _, err := body.ReadFrom(r.Body); err != nil || r.Header.Get("Content-Type") != "application/json" {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	status, ok := validDeploymentStatus(body.Bytes())
	if !ok {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	s.mu.Lock()
	current := s.deploymentEpoch
	s.mu.Unlock()
	if status.Epoch < current {
		select {
		case s.RefusedStatuses <- status.Epoch:
		default:
		}
		w.WriteHeader(http.StatusConflict)
		return
	}
	select {
	case s.DeploymentStatuses <- status:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

// SetIsolation serves the agent protocol v2 isolation operations with h, behind the node token.
func (s *Server) SetIsolation(h http.Handler) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.isolation = h
}

func (s *Server) isolationRequest(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	s.mu.Lock()
	h := s.isolation
	s.mu.Unlock()
	if h == nil {
		http.NotFound(w, r)
		return
	}
	h.ServeHTTP(w, r)
}

func (s *Server) Close() {
	close(s.closed)
	s.HTTP.Close()
}

func (s *Server) SetNodeToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.nodeToken = token
}

func (s *Server) currentNodeToken() string {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.nodeToken
}

func (s *Server) SetRegistrationToken(token string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.registrationToken = token
}

func (s *Server) SetSSEDown(down bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	s.sseDown = down
	if down {
		for ch := range s.subscribers {
			close(ch)
			delete(s.subscribers, ch)
		}
	}
}

func (s *Server) SetSnapshot(data []byte) {
	var envelope struct {
		Hash string `json:"hash"`
	}
	if err := json.Unmarshal(data, &envelope); err != nil {
		panic(err)
	}
	s.mu.Lock()
	defer s.mu.Unlock()
	s.snapshot, s.hash = append([]byte(nil), data...), envelope.Hash
}

func (s *Server) Emit(event string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	for ch := range s.subscribers {
		select {
		case ch <- event:
		default:
		}
	}
}

func authorized(w http.ResponseWriter, r *http.Request, token string) bool {
	if r.Header.Get("Authorization") != "Bearer "+token {
		w.Header().Set("Content-Type", "application/problem+json")
		w.WriteHeader(http.StatusUnauthorized)
		fmt.Fprint(w, `{"type":"about:blank","title":"Unauthorized","status":401}`)
		return false
	}
	return true
}

func (s *Server) register(w http.ResponseWriter, r *http.Request) {
	s.mu.Lock()
	token := s.registrationToken
	s.mu.Unlock()
	if !authorized(w, r, token) {
		return
	}
	var registration Registration
	if r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&registration) != nil || registration.NodeID == "" || registration.Hostname == "" || registration.KongVersion == "" || registration.AgentVersion == "" {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	s.Registrations <- registration
	w.Header().Set("Content-Type", "application/json")
	json.NewEncoder(w).Encode(map[string]any{
		"nodeToken": s.currentNodeToken(), "clusterId": ClusterID, "environmentId": EnvironmentID,
		"pollIntervalSeconds": 5, "heartbeatIntervalSeconds": 5,
	})
}

func (s *Server) current(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	defer func() {
		select {
		case s.SnapshotRequests <- r.Header.Get("If-None-Match"):
		default:
		}
	}()
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.snapshot == nil {
		w.WriteHeader(http.StatusNoContent)
		return
	}
	w.Header().Set("ETag", s.hash)
	if r.Header.Get("If-None-Match") == s.hash {
		w.WriteHeader(http.StatusNotModified)
		return
	}
	w.Header().Set("Content-Type", "application/json")
	w.Write(s.snapshot)
}

func (s *Server) status(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	var status Status
	if r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&status) != nil || status.NodeID == "" {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	if _, err := time.Parse(time.RFC3339Nano, status.ReportedAt); err != nil {
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	switch status.State {
	case "idle", "applying", "applied", "failed":
	default:
		w.WriteHeader(http.StatusUnprocessableEntity)
		return
	}
	select {
	case s.Statuses <- status:
	default:
	}
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) events(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, s.currentNodeToken()) {
		return
	}
	s.mu.Lock()
	if s.sseDown {
		s.mu.Unlock()
		w.WriteHeader(http.StatusServiceUnavailable)
		return
	}
	ch := make(chan string, 16)
	s.subscribers[ch] = struct{}{}
	s.mu.Unlock()
	defer func() {
		s.mu.Lock()
		delete(s.subscribers, ch)
		s.mu.Unlock()
	}()
	w.Header().Set("Content-Type", "text/event-stream")
	fmt.Fprint(w, "event: ping\n\n")
	w.(http.Flusher).Flush()
	select {
	case s.EventConnections <- r.Header.Get("Last-Event-ID"):
	default:
	}
	ping := time.NewTicker(15 * time.Second)
	defer ping.Stop()
	for {
		select {
		case <-s.closed:
			return
		case <-r.Context().Done():
			return
		case event, ok := <-ch:
			if !ok {
				return
			}
			fmt.Fprint(w, event)
			w.(http.Flusher).Flush()
		case <-ping.C:
			fmt.Fprint(w, "event: ping\n\n")
			w.(http.Flusher).Flush()
		}
	}
}
