package probe

import (
	"crypto/rand"
	"crypto/sha256"
	"encoding/json"
	"errors"
	"fmt"
	"io/fs"
	"net"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"syscall"
	"time"

	"github.com/gromesh/gateway/apps/isolation/internal/supervisor"
)

// QueueLimit is the size of the report queue (agent-protocol-v2, Probe persistence): full, the probe stops renewing.
const QueueLimit = 64 << 20

// maxReportBytes bounds one report's JWS: the queue counts as full once the next report might not fit.
const maxReportBytes = 4 << 10

// Chain is the report chain of one admission: seq without gaps, each report hashing the payload of the previous one.
type Chain struct {
	AdmissionID string `json:"admissionId"`
	BootID      string `json:"bootId"`
	// ProbeKey is the key the admission names: a chain is never continued with another (after a lost key).
	ProbeKey   string `json:"probeKey"`
	Seq        uint64 `json:"seq"`
	LastDigest string `json:"lastDigest,omitempty"`
	// Closed after a final report: nothing more is reported or served on the admission.
	Closed bool `json:"closed,omitempty"`
	// ViolationSeq is the report of the chain's last round that detected a failure (or its first violation report, for
	// a violation carried from an earlier admission): a release ends the violation only through it
	// (IsolationReleaseClaims).
	ViolationSeq uint64 `json:"violationSeq,omitempty"`
}

// queued is one report of the queue: Dir/queue/<order>.jws, kept until the control plane acks it.
type queued struct {
	order       uint64
	admissionID string
	seq         uint64
	size        int64
}

var queueName = regexp.MustCompile(`^[0-9]{20}\.jws$`)

func (p *Probe) queueDir() string { return filepath.Join(p.Dir, "queue") }

func (q queued) file(dir string) string { return filepath.Join(dir, fmt.Sprintf("%020d.jws", q.order)) }

// loadQueue reads the queue back after a restart and moves the chain head to the last report it holds: a report
// written to the queue before the state that counts it is never numbered twice.
func (p *Probe) loadQueue() error {
	if err := os.MkdirAll(p.queueDir(), 0o755); err != nil {
		return err
	}
	entries, err := os.ReadDir(p.queueDir())
	if err != nil {
		return err
	}
	p.queue, p.queueBytes, p.nextOrder = nil, 0, 1
	var last *Report
	var lastPayload, lastRaw []byte
	var reports []Report
	// ReadDir sorts by name, and names are the zero-padded order: the last one read is the newest report.
	for _, e := range entries {
		path := filepath.Join(p.queueDir(), e.Name())
		if !queueName.MatchString(e.Name()) || !e.Type().IsRegular() {
			// Temporaries of an interrupted write.
			_ = os.Remove(path)
			continue
		}
		order, _ := strconv.ParseUint(e.Name()[:20], 10, 64)
		data, err := os.ReadFile(path)
		var payload []byte
		var r Report
		if err == nil {
			// Not verified: a report signed with a key lost since is still its admission's, and only the probe writes here.
			payload, err = reportPayload(data)
		}
		if err == nil {
			r, err = ParseReport(payload)
		}
		if err != nil {
			// Only the probe writes here; a report it cannot read back is lost, which the control plane sees as a gap.
			p.Logf("queued report %s unreadable (%v): dropped", e.Name(), err)
			_ = os.Remove(path)
			continue
		}
		p.queue = append(p.queue, queued{order: order, admissionID: r.AdmissionID, seq: r.Seq, size: int64(len(data))})
		p.queueBytes += int64(len(data))
		p.nextOrder = max(p.nextOrder, order+1)
		last, lastPayload, lastRaw = &r, payload, data
		reports = append(reports, r)
	}
	if last == nil {
		return nil
	}
	saved := p.State.Chain
	defer func() {
		// What the queue holds is also durable: an admission whose final report is queued has ended, and a violation
		// report the state never counted moves the chain's ViolationSeq (it may be a detection's).
		for _, r := range reports {
			if r.Final && !slices.Contains(p.State.ClosedAdmissions, r.AdmissionID) {
				p.State.ClosedAdmissions = keepLast(append(p.State.ClosedAdmissions, r.AdmissionID), 64)
			}
			if r.State == "violation" && r.AdmissionID == p.State.Chain.AdmissionID && (saved.AdmissionID != r.AdmissionID || r.Seq > saved.Seq) {
				p.State.Chain.ViolationSeq = max(p.State.Chain.ViolationSeq, r.Seq)
			}
		}
	}()
	c := &p.State.Chain
	switch {
	case c.AdmissionID == "":
		// The state was lost: the chain continues from the queue, never from seq 1 again.
		*c = Chain{AdmissionID: last.AdmissionID, BootID: last.BootID, Seq: last.Seq, LastDigest: digest(lastPayload), Closed: last.Final}
		if _, err := VerifyReport(lastRaw, p.publicKey()); err == nil {
			c.ProbeKey = p.PublicKey()
		}
	case c.AdmissionID == last.AdmissionID && last.Seq > c.Seq:
		c.Seq, c.LastDigest = last.Seq, digest(lastPayload)
		c.Closed = c.Closed || last.Final
	}
	return nil
}

func reportPayload(raw []byte) ([]byte, error) {
	jws, err := strictObject(raw, "protected", "payload", "signature")
	if err != nil {
		return nil, err
	}
	return b64.DecodeString(jws["payload"])
}

func digest(payload []byte) string {
	return fmt.Sprintf("sha256:%x", sha256.Sum256(payload))
}

var errQueueFull = errors.New("report queue full")

func (p *Probe) queueFull() bool { return p.queueBytes+maxReportBytes > QueueLimit }

// emit numbers, signs and queues the next report of the chain: written with fsync to the probe's volume, counted in
// the state, and only then exposed to the agent.
func (p *Probe) emit(r Report) error {
	c := &p.State.Chain
	if c.AdmissionID == "" || c.Closed || c.ProbeKey != p.PublicKey() {
		return errors.New("no open report chain of this probe key")
	}
	if p.queueFull() {
		return errQueueFull
	}
	r.ClusterID, r.PodUID, r.AdmissionID, r.BootID, r.Seq = p.ClusterID, p.PodUID, c.AdmissionID, c.BootID, c.Seq+1
	r.PrevDigest = nil
	if r.Seq > 1 {
		prev := c.LastDigest
		r.PrevDigest = &prev
	}
	jws, payload, err := SignReport(p.key, r)
	if err != nil {
		return err
	}
	q := queued{order: p.nextOrder, admissionID: r.AdmissionID, seq: r.Seq, size: int64(len(jws))}
	if err := writeSynced(q.file(p.queueDir()), jws, 0o644); err != nil {
		return fmt.Errorf("report not queued: %w", err)
	}
	p.nextOrder++
	p.queue = append(p.queue, q)
	p.queueBytes += q.size
	c.Seq, c.LastDigest = r.Seq, digest(payload)
	if r.Final {
		c.Closed = true
	}
	if r.State == "violation" && (p.State.ViolationEvidence || c.ViolationSeq == 0) {
		c.ViolationSeq, p.State.ViolationEvidence = r.Seq, false
	}
	if err := p.save(); err != nil {
		// Not exposed until the seq is saved: an ack could otherwise remove the only durable copy of the advance.
		return fmt.Errorf("report %d queued, its seq not saved: %w", r.Seq, err)
	}
	p.syncOutbox()
	return nil
}

// roundReport is the report of a round: the state it ended in, what failed, the latest challenge and the lease left.
func (p *Probe) roundReport(now uint64) Report {
	r := Report{State: p.State.State, FailedCapabilities: p.failedCapabilities(), Challenge: p.challenge()}
	if p.State.LeaseExpiresNs > now {
		ms := (p.State.LeaseExpiresNs - now) / uint64(1e6)
		r.LeaseRemainingMs = &ms
	}
	return r
}

func (p *Probe) failedCapabilities() []string {
	failed := map[string]bool{}
	for _, c := range append(append([]string{}, p.State.Violated...), p.inconclusive...) {
		failed[c] = reportCaps[c]
	}
	if p.State.State == "violation" && len(p.State.Violated) > 0 && !anyTrue(failed) {
		// The latch could not tell which capability (unreadable): any of them may be the one.
		for _, c := range Capabilities {
			failed[c] = true
		}
	}
	if p.State.State == "guard-missing" {
		failed["guard-canary"] = true
	}
	out := []string{}
	for _, c := range append(append([]string{}, Capabilities...), "guard-canary") {
		if failed[c] {
			out = append(out, c)
		}
	}
	return out
}

func anyTrue(m map[string]bool) bool {
	for _, v := range m {
		if v {
			return true
		}
	}
	return false
}

// challenge is the latest challenge the agent handed over, or null when it handed none (or anything else).
func (p *Probe) challenge() *string {
	raw, err := readHandoff(filepath.Join(p.Handoff, "challenge"), 1<<10)
	if err != nil || !challengeRE.Match(raw) {
		return nil
	}
	s := string(raw)
	return &s
}

// drainAcks drops from the queue the reports the control plane acknowledged, as the agent relays it in acks.json:
// only that admission's, only up to ackedSeq. A false ack can only lose reports (a gap the control plane holds on).
func (p *Probe) drainAcks() {
	if !p.saved() {
		return
	}
	raw, err := readHandoff(filepath.Join(p.Handoff, "acks.json"), 1<<10)
	if err != nil {
		return
	}
	fields, err := strictRaw(raw, []string{"admissionId", "ackedSeq"}, nil)
	var admission string
	var acked uint64
	if err != nil || len(fields["admissionId"]) == 0 || fields["admissionId"][0] != '"' || json.Unmarshal(fields["admissionId"], &admission) != nil ||
		!uuid(admission) || !digits.Match(fields["ackedSeq"]) || json.Unmarshal(fields["ackedSeq"], &acked) != nil {
		return
	}
	kept := p.queue[:0]
	dropped := 0
	for _, q := range p.queue {
		if q.admissionID == admission && q.seq <= acked {
			if err := os.Remove(q.file(p.queueDir())); err != nil && !errors.Is(err, os.ErrNotExist) {
				p.Logf("acked report not removed: %v", err)
				kept = append(kept, q)
				continue
			}
			p.queueBytes -= q.size
			dropped++
			continue
		}
		kept = append(kept, q)
	}
	p.queue = kept
	if dropped > 0 {
		p.syncOutbox()
	}
}

// syncOutbox exposes in handoff/outbox the reports of the oldest admission in the queue, named by seq: one chain at a
// time, so the seq names of two admissions never meet and the agent sends each chain in order. It works below the
// handoff through an os.Root, never following a symlink out of it, and removes only names of its own pattern.
func (p *Probe) syncOutbox() {
	if !p.saved() {
		p.Logf("outbox: the state is not saved: reports withheld")
		return
	}
	root, err := os.OpenRoot(p.Handoff)
	if err != nil {
		p.Logf("outbox: %v", err)
		return
	}
	defer root.Close()
	if info, err := root.Lstat("outbox"); errors.Is(err, fs.ErrNotExist) {
		if err := root.Mkdir("outbox", 0o755); err != nil {
			p.Logf("outbox: %v", err)
			return
		}
	} else if err != nil || !info.IsDir() {
		// Not a directory of its own: nothing is exposed until the agent leaves it alone (the reports wait in the queue).
		p.Logf("outbox is not a directory: reports withheld")
		return
	}
	out, err := root.OpenRoot("outbox")
	if err != nil {
		p.Logf("outbox: %v", err)
		return
	}
	defer out.Close()
	want := map[string]queued{}
	for _, q := range p.queue {
		if q.admissionID == p.queue[0].admissionID {
			want[fmt.Sprintf("%020d.jws", q.seq)] = q
		}
	}
	if p.exposed == nil {
		p.exposed = map[string]uint64{}
	}
	if dir, err := out.Open("."); err == nil {
		names, _ := dir.Readdirnames(-1)
		dir.Close()
		for _, name := range names {
			_, keep := want[name]
			if (queueName.MatchString(name) && !keep) || (len(name) > 0 && name[0] == '.') {
				_ = out.Remove(name)
				delete(p.exposed, name)
			}
		}
	}
	changed := false
	for name, q := range want {
		if p.exposed[name] == q.order {
			continue
		}
		data, err := os.ReadFile(q.file(p.queueDir()))
		if err == nil {
			err = writeInRoot(out, name, data)
		}
		if err != nil {
			p.Logf("outbox %s: %v", name, err)
			continue
		}
		p.exposed[name] = q.order
		changed = true
	}
	if changed {
		if dir, err := out.Open("."); err == nil {
			_ = dir.Sync()
			dir.Close()
		}
	}
}

// writeInRoot is writeSynced below an os.Root: an exclusive temporary, fsync, rename over the name.
func writeInRoot(root *os.Root, name string, data []byte) error {
	var suffix [8]byte
	if _, err := rand.Read(suffix[:]); err != nil {
		return err
	}
	tmp := fmt.Sprintf(".%s.%x", name, suffix)
	f, err := root.OpenFile(tmp, os.O_WRONLY|os.O_CREATE|os.O_EXCL|syscall.O_NOFOLLOW, 0o644)
	if err != nil {
		return err
	}
	defer root.Remove(tmp)
	_, err = f.Write(data)
	if err == nil {
		err = f.Chmod(0o644)
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
	return root.Rename(tmp, name)
}

// KongStopConfirmed is what the probe checks itself when it receives the pod's stop signal, beyond the native sidecar
// order (the kubelet signals the sidecars only after the kong container exited, on Kubernetes >= 1.33, which the
// chart requires): kong-supervisor recorded the stop and the exit of nginx's whole process group, and nothing listens
// on the proxy port any more. Both are written or controlled by the kong container itself, so they only confirm what
// the order already guarantees; a supervisor killed by the kubelet (grace exhausted) never records the stop, and then
// the report says false.
func KongStopConfirmed(stateFile, proxyAddress string) bool {
	raw, err := readHandoff(stateFile, 64<<10)
	if err != nil {
		return false
	}
	var s supervisor.State
	if json.Unmarshal(raw, &s) != nil || !s.Stopping || s.Nginx != "stopped" || s.Pid != 0 {
		return false
	}
	conn, err := net.DialTimeout("tcp", proxyAddress, 500*time.Millisecond)
	if err == nil {
		conn.Close()
		return false
	}
	return errors.Is(err, syscall.ECONNREFUSED)
}
