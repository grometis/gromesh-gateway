// Package cpmock is an in-process implementation of the agent protocol for tests.
package cpmock

import (
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
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

type Server struct {
	HTTP             *httptest.Server
	Registrations    chan Registration
	Statuses         chan Status
	SnapshotRequests chan string
	EventConnections chan string
	mu               sync.Mutex
	snapshot         []byte
	hash             string
	sseDown          bool
	subscribers      map[chan string]struct{}
	closed           chan struct{}
}

func New() *Server {
	s := &Server{
		Registrations: make(chan Registration, 128), Statuses: make(chan Status, 128),
		SnapshotRequests: make(chan string, 128), EventConnections: make(chan string, 128),
		subscribers: make(map[chan string]struct{}), closed: make(chan struct{}),
	}
	mux := http.NewServeMux()
	mux.HandleFunc("POST /agent/v1/register", s.register)
	mux.HandleFunc("GET /agent/v1/snapshots/current", s.current)
	mux.HandleFunc("GET /agent/v1/events", s.events)
	mux.HandleFunc("POST /agent/v1/status", s.status)
	s.HTTP = httptest.NewServer(mux)
	return s
}

func (s *Server) Close() {
	close(s.closed)
	s.HTTP.Close()
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
	if !authorized(w, r, RegistrationToken) {
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
		"nodeToken": NodeToken, "clusterId": ClusterID, "environmentId": EnvironmentID,
		"pollIntervalSeconds": 5, "heartbeatIntervalSeconds": 5,
	})
}

func (s *Server) current(w http.ResponseWriter, r *http.Request) {
	if !authorized(w, r, NodeToken) {
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
	if !authorized(w, r, NodeToken) {
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
	if !authorized(w, r, NodeToken) {
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
