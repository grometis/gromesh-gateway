package agent

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"
	"syscall"
	"time"
)

// isolation carries the Workspaces isolation documents between the control plane (agent protocol v2) and the
// isolation-probe through the pod's handoff directory. It decides nothing: the probe verifies every signature and a
// withheld or late document only keeps the pod contained. A communication failure never writes anything that could
// end a containment (releases are withdrawn, nothing else is invented).
type isolation struct {
	config   Config
	client   *client
	log      logger
	interval time.Duration
	retry    func(int) time.Duration
	// refused counts refused requests in a row, for the backoff before the next one.
	refused   int
	nextAsk   time.Time
	lastAcks  []byte
	challenge []byte
}

type logger interface {
	Info(msg string, args ...any)
	Warn(msg string, args ...any)
}

// admissionRequest is what the agent persists of its pending or granted request, to resume it after a restart (a
// second request for the same pod and boot answers 409).
type admissionRequest struct {
	PodUID         string `json:"podUid"`
	BootID         string `json:"bootId"`
	ProbePublicKey string `json:"probePublicKey"`
	RequestID      string `json:"requestId"`
	Granted        bool   `json:"granted"`
}

type admissionStatus struct {
	RequestID string          `json:"requestId"`
	Outcome   string          `json:"outcome"`
	Challenge string          `json:"challenge"`
	Admission json.RawMessage `json:"admission,omitempty"`
	Reason    string          `json:"reason,omitempty"`
}

var (
	probeKeyPattern  = regexp.MustCompile(`^[A-Za-z0-9_-]{43}$`)
	challengePattern = regexp.MustCompile(`^[A-Za-z0-9_-]{22,64}$`)
	outboxName       = regexp.MustCompile(`^[0-9]{20}\.jws$`)
)

const maxReportsPerCall = 500

func (s *isolation) path(name string) string { return filepath.Join(s.config.HandoffDir, name) }

func (s *isolation) requestFile() string {
	return filepath.Join(s.config.StateDir, "isolation-admission.json")
}

// run steps until ctx ends, then sends what is left in the outbox once more: the probe, a later native sidecar, is
// signalled and writes its final report before the agent is.
func (s *isolation) run(ctx context.Context) {
	for {
		s.step(ctx)
		select {
		case <-ctx.Done():
			flush, cancel := context.WithTimeout(context.Background(), 5*time.Second)
			s.reports(flush)
			cancel()
			return
		case <-time.After(s.interval):
		}
	}
}

func (s *isolation) step(ctx context.Context) {
	s.admission(ctx)
	s.refreshChallenge(ctx)
	s.refreshReleases(ctx)
	s.reports(ctx)
}

// admission asks for the admission of (podUid, bootId) with the probe's public key, polls the request until it is
// decided and hands the granted admission to the probe as received. A refused request is asked again.
func (s *isolation) admission(ctx context.Context) {
	pub, err := readRegular(s.path("probe.pub"), 1<<10)
	if err != nil || !probeKeyPattern.Match(pub) {
		return
	}
	bootRaw, err := os.ReadFile(s.config.BootIDFile)
	boot := strings.TrimSpace(string(bootRaw))
	if err != nil || !uuidPattern.MatchString(boot) {
		s.log.Warn("isolation: boot id unreadable")
		return
	}
	want := admissionRequest{PodUID: s.config.PodUID, BootID: boot, ProbePublicKey: string(pub)}
	var req admissionRequest
	if data, err := os.ReadFile(s.requestFile()); err == nil && json.Unmarshal(data, &req) == nil &&
		req.PodUID == want.PodUID && req.BootID == want.BootID && req.ProbePublicKey == want.ProbePublicKey && uuidPattern.MatchString(req.RequestID) {
		want = req
	}
	if want.Granted {
		if _, err := os.Lstat(s.path("admission.jws")); err == nil {
			return
		}
	}
	if want.RequestID == "" {
		if time.Now().Before(s.nextAsk) {
			return
		}
		status, code, err := s.ask(ctx, want)
		if err != nil || code != http.StatusAccepted {
			if code == http.StatusConflict {
				s.log.Warn("isolation: an admission for this pod and boot exists, but not its request")
			} else if ctx.Err() == nil {
				s.log.Warn("isolation: admission request failed", "status", code)
			}
			s.nextAsk = time.Now().Add(s.retry(s.refused))
			s.refused++
			return
		}
		want.RequestID = status.RequestID
		if err := writeAtomic(s.requestFile(), mustJSON(want), 0o600); err != nil {
			s.log.Warn("isolation: cannot persist the admission request")
		}
		s.log.Info("isolation: admission requested", "requestId", status.RequestID)
	}
	status, code, err := s.poll(ctx, want.RequestID)
	switch {
	case err != nil:
		return
	case code == http.StatusNotFound:
		_ = os.Remove(s.requestFile())
		return
	case code != http.StatusOK:
		return
	}
	switch status.Outcome {
	case "granted":
		if err := writeAtomic(s.path("admission.jws"), status.Admission, 0o644); err != nil {
			s.log.Warn("isolation: cannot hand over the admission")
			return
		}
		want.Granted = true
		s.refused = 0
		_ = writeAtomic(s.requestFile(), mustJSON(want), 0o600)
		s.log.Info("isolation: admission granted", "requestId", want.RequestID)
	case "refused":
		s.log.Warn("isolation: admission refused; asking again", "reason", status.Reason)
		_ = os.Remove(s.requestFile())
		s.nextAsk = time.Now().Add(s.retry(s.refused))
		s.refused++
	}
}

func (s *isolation) ask(ctx context.Context, r admissionRequest) (admissionStatus, int, error) {
	body := mustJSON(map[string]string{"podUid": r.PodUID, "podName": s.config.PodName, "nodeName": s.config.NodeName, "bootId": r.BootID, "probePublicKey": r.ProbePublicKey})
	return s.status(ctx, "POST", "/agent/v2/isolation/admission-requests", body, http.StatusAccepted)
}

func (s *isolation) poll(ctx context.Context, requestID string) (admissionStatus, int, error) {
	return s.status(ctx, "GET", "/agent/v2/isolation/admission-requests/"+requestID, nil, http.StatusOK)
}

// status calls the control plane and decodes an AdmissionRequestStatus when the answer is `ok`.
func (s *isolation) status(ctx context.Context, method, path string, body []byte, ok int) (admissionStatus, int, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := s.client.nodeRequest(ctx, method, path, body, nil)
	if err != nil {
		return admissionStatus{}, 0, err
	}
	defer res.Body.Close()
	if res.StatusCode != ok {
		return admissionStatus{}, res.StatusCode, nil
	}
	var st admissionStatus
	if err := decodeStrict(res.Body, 1<<20, &st); err != nil || !uuidPattern.MatchString(st.RequestID) || !challengePattern.MatchString(st.Challenge) {
		return st, 0, errors.New("invalid admission request status")
	}
	granted := st.Outcome == "granted" && len(st.Admission) > 0 && bytes.TrimSpace(st.Admission)[0] == '{' && st.Reason == ""
	refused := st.Outcome == "refused" && len(st.Admission) == 0 && st.Reason != ""
	pending := st.Outcome == "pending" && len(st.Admission) == 0 && st.Reason == ""
	if !granted && !refused && !pending {
		return st, 0, errors.New("invalid admission request status")
	}
	return st, res.StatusCode, nil
}

// refreshChallenge hands the cluster's latest challenge to the probe; a failure keeps the previous one, which never
// answers a newer challenge.
func (s *isolation) refreshChallenge(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	res, err := s.client.nodeRequest(ctx, "GET", "/agent/v2/isolation/challenge", nil, nil)
	if err != nil {
		return
	}
	defer res.Body.Close()
	var body struct {
		Challenge *string `json:"challenge"`
	}
	if res.StatusCode != http.StatusOK || decodeStrict(res.Body, 1<<10, &body) != nil {
		return
	}
	if body.Challenge == nil {
		if err := os.Remove(s.path("challenge")); err == nil || errors.Is(err, os.ErrNotExist) {
			s.challenge = nil
		}
		return
	}
	if !challengePattern.MatchString(*body.Challenge) || bytes.Equal(s.challenge, []byte(*body.Challenge)) {
		return
	}
	if err := writeAtomic(s.path("challenge"), []byte(*body.Challenge), 0o644); err == nil {
		s.challenge = []byte(*body.Challenge)
	}
}

// refreshReleases hands the releases the control plane lists (not expired by its clock) to the probe. Without an
// answer they are withdrawn: an expired release must never stay where the probe could still use it.
func (s *isolation) refreshReleases(ctx context.Context) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	var body struct {
		Items []json.RawMessage `json:"items"`
	}
	res, err := s.client.nodeRequest(ctx, "GET", "/agent/v2/isolation/releases", nil, nil)
	if err == nil {
		defer res.Body.Close()
		if res.StatusCode != http.StatusOK {
			err = fmt.Errorf("releases returned HTTP %d", res.StatusCode)
		} else {
			err = decodeStrict(res.Body, 1<<20, &body)
		}
	}
	if err != nil || body.Items == nil {
		if rmErr := os.Remove(s.path("releases.json")); rmErr != nil && !errors.Is(rmErr, os.ErrNotExist) {
			s.log.Warn("isolation: cannot withdraw releases")
		}
		return
	}
	if err := writeAtomic(s.path("releases.json"), mustJSON(body), 0o644); err != nil {
		s.log.Warn("isolation: cannot hand over releases")
	}
}

// reports sends the probe's outbox in order, at most 500 per call, and relays what the control plane acknowledged for
// the admission of the reports sent.
func (s *isolation) reports(ctx context.Context) {
	entries, err := os.ReadDir(s.path("outbox"))
	if err != nil {
		return
	}
	var names []string
	for _, e := range entries {
		if outboxName.MatchString(e.Name()) && e.Type().IsRegular() {
			names = append(names, e.Name())
		}
	}
	sort.Strings(names)
	ackAdmission, ackedSeq := s.currentAck()
	var batch []json.RawMessage
	admission := ""
	for _, name := range names {
		if len(batch) == maxReportsPerCall {
			break
		}
		raw, err := readRegular(s.path(filepath.Join("outbox", name)), 64<<10)
		if err != nil || !json.Valid(raw) || bytes.TrimSpace(raw)[0] != '{' {
			continue
		}
		seq, _ := strconv.ParseUint(name[:20], 10, 64)
		id := reportAdmission(raw)
		if id == "" || (admission != "" && id != admission) {
			// The probe exposes one admission's chain at a time; anything else waits for the next call.
			continue
		}
		if id == ackAdmission && seq <= ackedSeq {
			continue
		}
		admission = id
		batch = append(batch, raw)
	}
	if len(batch) == 0 {
		return
	}
	ctx, cancel := context.WithTimeout(ctx, 30*time.Second)
	defer cancel()
	res, err := s.client.nodeRequest(ctx, "POST", "/agent/v2/isolation/reports", mustJSON(map[string]any{"reports": batch}), nil)
	if err != nil {
		return
	}
	defer res.Body.Close()
	var acks struct {
		Acks []struct {
			AdmissionID string `json:"admissionId"`
			AckedSeq    *int64 `json:"ackedSeq"`
		} `json:"acks"`
		Rejected []struct {
			Index  *int   `json:"index"`
			Reason string `json:"reason"`
		} `json:"rejected"`
	}
	if res.StatusCode != http.StatusOK || decodeStrict(res.Body, 1<<20, &acks) != nil || acks.Acks == nil || acks.Rejected == nil {
		if ctx.Err() == nil {
			s.log.Warn("isolation: reports not accepted", "status", res.StatusCode)
		}
		return
	}
	for _, r := range acks.Rejected {
		s.log.Warn("isolation: report rejected", "reason", r.Reason)
	}
	for _, a := range acks.Acks {
		if a.AdmissionID != admission || a.AckedSeq == nil || *a.AckedSeq < 0 {
			continue
		}
		data := mustJSON(map[string]any{"admissionId": a.AdmissionID, "ackedSeq": *a.AckedSeq})
		if bytes.Equal(data, s.lastAcks) {
			continue
		}
		if err := writeAtomic(s.path("acks.json"), data, 0o644); err == nil {
			s.lastAcks = data
		}
	}
}

func (s *isolation) currentAck() (string, uint64) {
	var a struct {
		AdmissionID string `json:"admissionId"`
		AckedSeq    uint64 `json:"ackedSeq"`
	}
	if raw, err := readRegular(s.path("acks.json"), 1<<10); err != nil || json.Unmarshal(raw, &a) != nil {
		return "", 0
	}
	return a.AdmissionID, a.AckedSeq
}

// reportAdmission reads the admissionId of a report's payload to group the reports per admission; the signature is
// the control plane's to verify.
func reportAdmission(raw []byte) string {
	var jws struct {
		Payload string `json:"payload"`
	}
	if json.Unmarshal(raw, &jws) != nil {
		return ""
	}
	payload, err := base64.RawURLEncoding.DecodeString(jws.Payload)
	var claims struct {
		AdmissionID string `json:"admissionId"`
	}
	if err != nil || json.Unmarshal(payload, &claims) != nil || !uuidPattern.MatchString(claims.AdmissionID) {
		return ""
	}
	return claims.AdmissionID
}

func decodeStrict(r io.Reader, limit int64, into any) error {
	d := json.NewDecoder(io.LimitReader(r, limit))
	d.DisallowUnknownFields()
	if err := d.Decode(into); err != nil {
		return err
	}
	if err := d.Decode(new(json.RawMessage)); err != io.EOF {
		return errors.New("trailing data")
	}
	return nil
}

func mustJSON(v any) []byte {
	b, _ := json.Marshal(v)
	return b
}

// readRegular reads a file of the handoff: only a regular file, never through a symlink, never blocking on a FIFO.
func readRegular(path string, limit int64) ([]byte, error) {
	f, err := os.OpenFile(path, os.O_RDONLY|syscall.O_NOFOLLOW|syscall.O_NONBLOCK, 0)
	if err != nil {
		return nil, err
	}
	defer f.Close()
	info, err := f.Stat()
	if err != nil || !info.Mode().IsRegular() || info.Size() > limit {
		return nil, errors.New("not a regular file within the limit")
	}
	return io.ReadAll(io.LimitReader(f, limit))
}

// writeAtomic replaces path through an exclusive temporary of its own (never an existing name, which could be a
// planted symlink), fsync, rename over the target and fsync of the directory.
func writeAtomic(path string, data []byte, mode os.FileMode) error {
	f, err := os.CreateTemp(filepath.Dir(path), "."+filepath.Base(path)+".*")
	if err != nil {
		return err
	}
	tmp := f.Name()
	defer os.Remove(tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(mode)
	}
	if err == nil {
		err = f.Sync()
	}
	if cerr := f.Close(); err == nil {
		err = cerr
	}
	if err != nil {
		return err
	}
	if err := os.Rename(tmp, path); err != nil {
		return err
	}
	return syncDir(filepath.Dir(path))
}
