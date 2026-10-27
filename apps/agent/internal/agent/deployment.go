package agent

import (
	"bytes"
	"context"
	"crypto/md5"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"slices"
	"strconv"
	"time"
	"unicode/utf8"
)

// Workspaces mode (GROMESH_HANDOFF_DIR set) speaks agent protocol v2 for deployments: the instance's current
// deployment (snapshot-v2.schema.json) ordered by (epoch, revision), with `config` as opaque as in v1.

const (
	deploymentMeta = "deployment.json"
	// appliedFile (handoff) is AppliedRevision: the last revision Kong confirmed, which the probe compares with the hash
	// the guard canary serves.
	appliedFile = "applied.json"
)

var (
	slugPattern   = regexp.MustCompile(`^[a-z0-9]+(-[a-z0-9]+)*$`)
	counterHeader = regexp.MustCompile(`^[1-9][0-9]{0,17}$`)
	envelopeKeys  = []string{"schemaVersion", "instanceId", "epoch", "revision", "hash", "createdAt", "reason", "members", "mandatoryPluginsVersion", "valuesDigest", "config"}
	memberKeys    = []string{"workspaceId", "slug", "releaseVersion", "contentDigest"}
	reasons       = map[string]bool{"publish": true, "promotion": true, "rollback": true, "reconcile": true, "mandatory-plugins": true, "values": true, "migration": true}
	kongHashRE    = regexp.MustCompile(`^[0-9a-f]{32}$`)
	// deliveryCodes are the DeliveryProblem codes of agent protocol v2 (always 409).
	deliveryCodes = map[string]bool{"workspaces-mode-disabled": true, "delivery-protocol-v1": true, "delivery-protocol-v2": true, "delivery-protocol-switching": true, "epoch-outdated": true, "revision-regression": true, "unknown-deployment": true}
)

// kongConfigHash is the configuration_hash Kong computes for config posted as {"config": "<config>"}, and for the same
// bytes read from KONG_DECLARATIVE_CONFIG at boot: the md5 of exactly those bytes.
func kongConfigHash(config []byte) string {
	sum := md5.Sum(config)
	return hex.EncodeToString(sum[:])
}

// kongConfigBody posts the config as a string, so the hash Kong reports is a function of the authorized bytes; Kong
// hashes a config object after re-encoding it.
func kongConfigBody(config []byte) []byte {
	var b bytes.Buffer
	e := json.NewEncoder(&b)
	e.SetEscapeHTML(false)
	_ = e.Encode(struct {
		Config string `json:"config"`
	}{string(config)})
	return bytes.TrimSuffix(b.Bytes(), []byte("\n"))
}

// AppliedRevision is applied.json (agent protocol v2), written only after Kong confirmed the revision.
type AppliedRevision struct {
	InstanceID     string `json:"instanceId"`
	ClusterID      string `json:"clusterId"`
	NodeID         string `json:"nodeId"`
	PodUID         string `json:"podUid"`
	Epoch          int64  `json:"epoch"`
	Revision       int64  `json:"revision"`
	Hash           string `json:"hash"`
	KongConfigHash string `json:"kongConfigHash"`
	Result         string `json:"result"`
	AppliedAt      string `json:"appliedAt"`
}

// deliveryRefused is a 409 DeliveryProblem of the control plane.
type deliveryRefused struct{ code string }

func (e *deliveryRefused) Error() string { return "refused by the delivery rules: " + e.code }

func refusal(res *http.Response) error {
	var problem struct {
		Code string `json:"code"`
	}
	if json.NewDecoder(io.LimitReader(res.Body, 64<<10)).Decode(&problem) != nil || !deliveryCodes[problem.Code] {
		return fmt.Errorf("HTTP 409 without a delivery refusal code")
	}
	return &deliveryRefused{problem.Code}
}

// invalidEnvelope is a 200 whose body is not a valid envelope, at the position its headers name.
type invalidEnvelope struct {
	at  position
	err error
}

func (e *invalidEnvelope) Error() string { return e.err.Error() }

type Member struct {
	WorkspaceID    string `json:"workspaceId"`
	Slug           string `json:"slug"`
	ReleaseVersion int64  `json:"releaseVersion"`
	ContentDigest  string `json:"contentDigest"`
}

type Deployment struct {
	SchemaVersion           int             `json:"schemaVersion"`
	InstanceID              string          `json:"instanceId"`
	Epoch                   int64           `json:"epoch"`
	Revision                int64           `json:"revision"`
	Hash                    string          `json:"hash"`
	CreatedAt               string          `json:"createdAt"`
	Reason                  json.RawMessage `json:"reason"`
	Members                 *[]Member       `json:"members"`
	MandatoryPluginsVersion *int64          `json:"mandatoryPluginsVersion"`
	ValuesDigest            *string         `json:"valuesDigest"`
	Config                  json.RawMessage `json:"config"`
	// raw is the envelope as received: it is persisted byte for byte.
	raw []byte
}

func DecodeDeployment(data []byte) (*Deployment, error) {
	var d Deployment
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if err := decoder.Decode(&d); err != nil {
		return nil, fmt.Errorf("invalid deployment envelope")
	}
	if err := decoder.Decode(new(json.RawMessage)); err != io.EOF {
		return nil, fmt.Errorf("invalid trailing deployment data")
	}
	if !exactKeys(data, envelopeKeys) {
		return nil, fmt.Errorf("invalid deployment envelope")
	}
	if d.SchemaVersion != 2 || !uuidPattern.MatchString(d.InstanceID) || d.Epoch < 1 || d.Revision < 1 || !hashPattern.MatchString(d.Hash) {
		return nil, fmt.Errorf("invalid deployment schema version, instance ID, epoch, revision or hash")
	}
	if _, err := time.Parse(time.RFC3339Nano, d.CreatedAt); err != nil {
		return nil, fmt.Errorf("invalid deployment creation time")
	}
	if len(d.Reason) > 0 {
		var reason string
		if bytes.Equal(d.Reason, []byte("null")) || json.Unmarshal(d.Reason, &reason) != nil || !reasons[reason] {
			return nil, fmt.Errorf("invalid deployment reason")
		}
	}
	var top struct {
		Members []json.RawMessage `json:"members"`
	}
	if d.Members == nil || json.Unmarshal(data, &top) != nil {
		return nil, fmt.Errorf("deployment members are required")
	}
	for _, m := range top.Members {
		if !exactKeys(m, memberKeys) {
			return nil, fmt.Errorf("invalid deployment member")
		}
	}
	for _, m := range *d.Members {
		if !uuidPattern.MatchString(m.WorkspaceID) || len(m.Slug) > 40 || !slugPattern.MatchString(m.Slug) || m.ReleaseVersion < 1 || !hashPattern.MatchString(m.ContentDigest) {
			return nil, fmt.Errorf("invalid deployment member")
		}
	}
	if d.MandatoryPluginsVersion != nil && *d.MandatoryPluginsVersion < 1 || d.ValuesDigest != nil && !hashPattern.MatchString(*d.ValuesDigest) {
		return nil, fmt.Errorf("invalid deployment mandatory plugins version or values digest")
	}
	config := bytes.TrimSpace(d.Config)
	// Kong receives the config as a JSON string: bytes that are not UTF-8 would not reach it unchanged.
	if len(config) == 0 || config[0] != '{' || !json.Valid(config) || !utf8.Valid(config) {
		return nil, fmt.Errorf("deployment config must be a JSON object")
	}
	d.raw = append([]byte(nil), data...)
	return &d, nil
}

// exactKeys refuses what DisallowUnknownFields lets through: encoding/json matches field names case-insensitively, and
// the contract names every member exactly.
func exactKeys(object []byte, allowed []string) bool {
	var fields map[string]json.RawMessage
	if json.Unmarshal(object, &fields) != nil {
		return false
	}
	for key := range fields {
		if !slices.Contains(allowed, key) {
			return false
		}
	}
	return true
}

// readStrict decodes a file the agent wrote itself: a regular file, one JSON object with exactly the given members.
func readStrict(path string, v any, keys []string) (bool, error) {
	data, err := readRegular(path, 4<<10)
	if errors.Is(err, os.ErrNotExist) {
		return false, nil
	}
	if err != nil {
		return false, err
	}
	decoder := json.NewDecoder(bytes.NewReader(data))
	decoder.DisallowUnknownFields()
	if decoder.Decode(v) != nil || decoder.Decode(new(json.RawMessage)) != io.EOF || !exactKeys(data, keys) {
		return false, fmt.Errorf("invalid content in %s", path)
	}
	return true, nil
}

func (d *Deployment) position() position { return position{d.Epoch, d.Revision, d.Hash} }

// position is an applied (or confirmed) deployment: a 304 confirms a newer (epoch, revision) of the same hash.
type position struct {
	Epoch    int64  `json:"epoch"`
	Revision int64  `json:"revision"`
	Hash     string `json:"hash"`
}

func (p position) before(q position) bool {
	return p.Epoch < q.Epoch || p.Epoch == q.Epoch && p.Revision < q.Revision
}

// permanentFailure is a revision the agent will not apply: Kong rejected it (status 400/413), or its envelope names
// another instance or is not valid (status 0).
type permanentFailure struct {
	position
	Status int    `json:"status"`
	Reason string `json:"reason"`
}

func (f *permanentFailure) validReason() bool {
	switch f.Reason {
	case "kong-rejected":
		return f.Status == http.StatusBadRequest || f.Status == http.StatusRequestEntityTooLarge
	case "instance-mismatch", "invalid-envelope":
		return f.Status == 0
	}
	return false
}

// applied is what Kong confirmed serving and the agent declared (applied.json, StatusReport).
type confirmation struct {
	position
	kongHash string
}

type deployments struct {
	store   store
	applied *Deployment
	at      *position
	// kongHash is the configuration_hash Kong reports while it serves applied's config.
	kongHash string
	// confirmed is the position Kong confirmed for applied (nil until it does, and while Kong serves another config).
	confirmed *confirmation
	clusterID string
	refusal   string
	failed    *permanentFailure
	// failedSaved is false while the mark is only in memory; every poll writes it again until it is on the volume.
	failedSaved bool
	retry       position
	attempt     int
	next        time.Time
	// repairing re-posts the applied config when Kong serves another one.
	repairAttempt int
	repairNext    time.Time
}

// positionFile holds the latest confirmed position of the persisted deployment. It counts only for the same hash and
// a newer (epoch, revision) than the envelope's, so a stale one left by a crash is ignored.
func (d *deployments) positionFile() string {
	return filepath.Join(filepath.Dir(d.store.path), "."+filepath.Base(d.store.path)+".position")
}

func (p position) valid() bool {
	return p.Epoch >= 1 && p.Revision >= 1 && hashPattern.MatchString(p.Hash)
}

func (d *deployments) loadPosition() (*position, error) {
	var p position
	found, err := readStrict(d.positionFile(), &p, []string{"epoch", "revision", "hash"})
	if !found || err != nil {
		return nil, err
	}
	if !p.valid() {
		return nil, fmt.Errorf("invalid persisted deployment position")
	}
	return &p, nil
}

// failureFile holds the permanent failure mark, so a restart neither resends a rejected deployment nor forgets its
// epoch.
func (d *deployments) failureFile() string {
	return filepath.Join(filepath.Dir(d.store.path), "."+filepath.Base(d.store.path)+".failure")
}

func (d *deployments) loadFailure() (*permanentFailure, error) {
	var f permanentFailure
	found, err := readStrict(d.failureFile(), &f, []string{"epoch", "revision", "hash", "status", "reason"})
	if !found || err != nil {
		return nil, err
	}
	if f.Reason == "" {
		// A mark written before failure reasons existed is Kong's rejection.
		f.Reason = "kong-rejected"
	}
	if !f.valid() || !f.validReason() {
		return nil, fmt.Errorf("invalid persisted deployment failure")
	}
	return &f, nil
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
	FailureReason   *string `json:"failureReason,omitempty"`
	KongConfigHash  *string `json:"kongConfigHash"`
	KongHealthy     bool    `json:"kongHealthy"`
}

type currentDeployment struct {
	at         position
	deployment *Deployment // nil on 304
}

func parseCounter(value string) (int64, bool) {
	if !counterHeader.MatchString(value) {
		return 0, false
	}
	n, err := strconv.ParseInt(value, 10, 64)
	return n, err == nil
}

// deployment returns nil when the instance has no deployment yet (404).
func (c *client) deployment(ctx context.Context, hash string) (*currentDeployment, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	headers := map[string]string{}
	if hash != "" {
		headers["If-None-Match"] = hash
	}
	res, err := c.nodeRequest(ctx, "GET", "/agent/v2/deployments/current", nil, headers)
	if err != nil {
		return nil, err
	}
	defer res.Body.Close()
	epoch, epochOK := parseCounter(res.Header.Get("X-Gromesh-Epoch"))
	revision, revisionOK := parseCounter(res.Header.Get("X-Gromesh-Revision"))
	switch res.StatusCode {
	case http.StatusNotFound:
		return nil, nil
	case http.StatusNotModified:
		if hash == "" || !epochOK || !revisionOK {
			return nil, fmt.Errorf("304 without If-None-Match, X-Gromesh-Epoch or X-Gromesh-Revision")
		}
		return &currentDeployment{at: position{epoch, revision, hash}}, nil
	case http.StatusConflict:
		return nil, refusal(res)
	case http.StatusOK:
	default:
		return nil, fmt.Errorf("deployment returned HTTP %d", res.StatusCode)
	}
	b, err := io.ReadAll(io.LimitReader(res.Body, maxSnapshotBytes+1))
	if err != nil || len(b) > maxSnapshotBytes {
		return nil, fmt.Errorf("cannot read deployment or deployment exceeds 64 MiB")
	}
	d, err := DecodeDeployment(b)
	if err != nil {
		// The headers still name the revision, which the agent reports as not applied.
		if tag := res.Header.Get("ETag"); epochOK && revisionOK && hashPattern.MatchString(tag) {
			return nil, &invalidEnvelope{position{epoch, revision, tag}, err}
		}
		return nil, err
	}
	if tag := res.Header.Get("ETag"); tag != "" && tag != d.Hash {
		return nil, fmt.Errorf("deployment ETag does not match envelope hash")
	}
	if v := res.Header.Get("X-Gromesh-Epoch"); v != "" && (!epochOK || epoch != d.Epoch) {
		return nil, fmt.Errorf("X-Gromesh-Epoch does not match envelope epoch")
	}
	if v := res.Header.Get("X-Gromesh-Revision"); v != "" && (!revisionOK || revision != d.Revision) {
		return nil, fmt.Errorf("X-Gromesh-Revision does not match envelope revision")
	}
	return &currentDeployment{at: d.position(), deployment: d}, nil
}

func (c *client) reportDeployment(ctx context.Context, status DeploymentStatus) error {
	status.KongHealthy = c.kongHealthy(ctx)
	body, _ := json.Marshal(status)
	ctx, cancel := context.WithTimeout(ctx, 5*time.Second)
	defer cancel()
	res, err := c.nodeRequest(ctx, "POST", "/agent/v2/status", body, nil)
	if err != nil {
		return err
	}
	defer res.Body.Close()
	switch res.StatusCode {
	case http.StatusNoContent:
		return nil
	case http.StatusConflict:
		return refusal(res)
	}
	return fmt.Errorf("status report returned HTTP %d", res.StatusCode)
}

// servedConfigHash is Kong's own configuration_hash (GET /status); false when Kong gave none (not started, down).
func (c *client) servedConfigHash(ctx context.Context) (string, bool) {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	res, err := c.request(ctx, "GET", endpoint(c.config.KongStatusURL, "/status"), "", nil, nil)
	if err != nil {
		return "", false
	}
	defer res.Body.Close()
	var status struct {
		ConfigurationHash string `json:"configuration_hash"`
	}
	if res.StatusCode != http.StatusOK || json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&status) != nil || !kongHashRE.MatchString(status.ConfigurationHash) {
		return "", false
	}
	return status.ConfigurationHash, true
}

func (c *client) kongHealthy(ctx context.Context) bool {
	ctx, cancel := context.WithTimeout(ctx, 2*time.Second)
	defer cancel()
	res, err := c.request(ctx, "GET", endpoint(c.config.KongStatusURL, "/status"), "", nil, nil)
	if err != nil {
		return false
	}
	res.Body.Close()
	return res.StatusCode == http.StatusOK
}

// restoreDeployment adopts the deployment on the volume, which Kong boots from (KONG_DECLARATIVE_CONFIG), so a cold
// start with the control plane down serves it, and declares it once Kong reports its hash. Anything unusable (a v1
// snapshot or another instance's deployment included) is ignored.
func (a *Agent) restoreDeployment() {
	d := a.deploy
	data, config, err := d.store.loadRaw()
	var saved *Deployment
	if err == nil && data != nil {
		if saved, err = DecodeDeployment(data); err == nil && !bytes.Equal(config, saved.Config) {
			err = fmt.Errorf("persisted config does not match deployment metadata")
		} else if err == nil && saved.InstanceID != a.config.InstanceID {
			err = fmt.Errorf("persisted deployment belongs to another instance")
		}
	}
	if err != nil {
		a.log.Warn("ignoring unusable persisted deployment", "error", err)
		saved = nil
	}
	if saved != nil {
		at := saved.position()
		confirmed, err := d.loadPosition()
		if err != nil {
			a.log.Warn("ignoring unusable persisted deployment position", "error", err)
		} else if confirmed != nil && confirmed.Hash == at.Hash && at.before(*confirmed) {
			at = *confirmed
		}
		a.acceptDeployment(saved, at, false)
	}
	failed, err := d.loadFailure()
	if err != nil {
		a.log.Warn("ignoring unusable persisted deployment failure", "error", err)
	}
	// A mark at or below the applied position is stale: a newer revision already replaced it.
	if failed != nil && (d.at == nil || d.at.before(failed.position)) {
		d.failed, d.failedSaved = failed, true
		a.publishDeploymentStatus()
	}
}

func (a *Agent) markFailure(failed *permanentFailure) {
	d := a.deploy
	d.failed = failed
	d.retry, d.attempt, d.next = position{}, 0, time.Time{}
	a.saveFailure()
	a.publishDeploymentStatus()
}

func (a *Agent) saveFailure() {
	d := a.deploy
	data, _ := json.Marshal(d.failed)
	err := writeAtomic(d.failureFile(), data, 0o644)
	d.failedSaved = err == nil
	if err != nil {
		a.log.Warn("cannot persist the permanent failure mark; retrying on the next poll", "error", err)
	}
}

func (a *Agent) clearFailure() {
	d := a.deploy
	d.failed, d.failedSaved = nil, false
	if err := os.Remove(d.failureFile()); err != nil && !errors.Is(err, os.ErrNotExist) {
		a.log.Warn("cannot remove the permanent failure mark", "error", err)
	}
	a.publishDeploymentStatus()
}

// refuseRevision marks a revision the agent will never apply (another instance, an invalid envelope): Kong keeps the
// configuration it serves.
func (a *Agent) refuseRevision(ctx context.Context, at position, reason string) {
	a.markFailure(&permanentFailure{position: at, Reason: reason})
	a.failures.Add(1)
	a.log.Error("deployment refused", "epoch", at.Epoch, "revision", at.Revision, "reason", reason)
	a.reportDeployment(ctx)
}

func (a *Agent) acceptDeployment(deployment *Deployment, at position, success bool) {
	d := a.deploy
	d.applied, d.at, d.kongHash = deployment, &at, kongConfigHash(deployment.Config)
	d.retry, d.attempt, d.next = position{}, 0, time.Time{}
	a.appliedGauge.Store(at.Revision)
	if success {
		a.lastSuccess.Store(time.Now().Unix())
	}
	// The mark goes only once a newer revision is applied or confirmed: until then it keeps its epoch known.
	if d.failed != nil && !at.before(d.failed.position) {
		a.clearFailure()
		return
	}
	a.publishDeploymentStatus()
}

// confirmApplied declares the applied position after Kong reported serving its config: applied.json first, then the
// StatusReport. Nothing else ever declares a revision applied.
func (a *Agent) confirmApplied() {
	d := a.deploy
	if d.clusterID == "" {
		return
	}
	data, _ := json.Marshal(AppliedRevision{
		InstanceID: a.config.InstanceID, ClusterID: d.clusterID, NodeID: a.config.NodeID, PodUID: a.config.PodUID,
		Epoch: d.at.Epoch, Revision: d.at.Revision, Hash: d.at.Hash, KongConfigHash: d.kongHash, Result: "applied",
		AppliedAt: time.Now().UTC().Format(time.RFC3339Nano),
	})
	if err := writeAtomic(filepath.Join(a.config.HandoffDir, appliedFile), data, 0o644); err != nil {
		a.log.Warn("cannot write applied.json; retrying on the next poll", "error", err)
		return
	}
	d.confirmed = &confirmation{*d.at, d.kongHash}
	a.publishDeploymentStatus()
}

// waitKongHash waits for Kong's /status to report want: Kong answers POST /config before every worker reloaded.
func (a *Agent) waitKongHash(ctx context.Context, want string) bool {
	deadline := time.Now().Add(a.kongConfirmWait)
	for {
		if served, ok := a.client.servedConfigHash(ctx); ok && served == want {
			return true
		}
		if !time.Now().Before(deadline) || !wait(ctx, a.kongConfirmStep) {
			return false
		}
	}
}

// checkKong declares the applied position once Kong serves it (a cold start included: Kong boots from the volume
// only after the pod's admission), withdraws the declaration when Kong serves another config, and posts the applied
// one again. A Kong that does not answer proves nothing either way.
func (a *Agent) checkKong(ctx context.Context) {
	d := a.deploy
	if d.at == nil {
		return
	}
	served, ok := a.client.servedConfigHash(ctx)
	if !ok {
		return
	}
	if served == d.kongHash {
		d.repairAttempt, d.repairNext = 0, time.Time{}
		if d.confirmed == nil || d.confirmed.position != *d.at {
			a.confirmApplied()
		}
		return
	}
	if d.confirmed != nil {
		a.log.Warn("Kong serves a configuration other than the applied one", "epoch", d.at.Epoch, "revision", d.at.Revision)
		d.confirmed = nil
		a.publishDeploymentStatus()
	}
	// A newer revision being applied owns Kong; it is never reverted here.
	if d.retry != (position{}) || time.Now().Before(d.repairNext) {
		return
	}
	if err := a.client.apply(ctx, kongConfigBody(d.applied.Config)); err == nil && a.waitKongHash(ctx, d.kongHash) {
		d.repairAttempt, d.repairNext = 0, time.Time{}
		a.log.Info("applied configuration posted again", "epoch", d.at.Epoch, "revision", d.at.Revision)
		a.confirmApplied()
		return
	}
	d.repairNext = time.Now().Add(a.applyRetry(d.repairAttempt))
	d.repairAttempt++
	a.failures.Add(1)
}

// publishDeploymentStatus reports against the newest epoch the agent accepted: the applied position Kong confirmed and
// the permanent failure count only in that epoch. Before any epoch is known there is nothing the contract lets it
// report.
func (a *Agent) publishDeploymentStatus() {
	d := a.deploy
	var epoch int64
	if d.at != nil {
		epoch = d.at.Epoch
	}
	if d.failed != nil && d.failed.Epoch > epoch {
		epoch = d.failed.Epoch
	}
	var status *DeploymentStatus
	if epoch > 0 {
		status = &DeploymentStatus{NodeID: a.config.NodeID, Epoch: epoch}
		if c := d.confirmed; c != nil && c.Epoch == epoch {
			revision, hash, kongHash := c.Revision, c.Hash, c.kongHash
			status.AppliedRevision, status.AppliedHash, status.KongConfigHash = &revision, &hash, &kongHash
		}
		if f := d.failed; f != nil && f.Epoch == epoch {
			revision, hash, reason := f.Revision, f.Hash, f.Reason
			status.FailedRevision, status.FailedHash, status.FailureReason = &revision, &hash, &reason
			if f.Reason == "kong-rejected" {
				code := f.Status
				status.FailureStatus = &code
			}
		}
	}
	a.statusMu.Lock()
	a.deployStatus = status
	a.statusMu.Unlock()
}

func (a *Agent) reportDeployment(ctx context.Context) {
	a.statusMu.RLock()
	status := a.deployStatus
	a.statusMu.RUnlock()
	if status == nil {
		return
	}
	err := a.client.reportDeployment(ctx, *status)
	var refused *deliveryRefused
	switch {
	case err == nil:
	case errors.As(err, &refused) && (refused.code == "epoch-outdated" || refused.code == "revision-regression" || refused.code == "unknown-deployment"):
		// Not recorded: the current deployment is fetched again, and reported afresh.
		a.log.Warn("status report refused; fetching the current deployment", "code", refused.code)
		select {
		case a.wake <- struct{}{}:
		default:
		}
	case ctx.Err() == nil:
		a.log.Warn("status report failed", "error", err)
	}
}

func (a *Agent) refreshDeployment(ctx context.Context) {
	d := a.deploy
	// Whatever the control plane serves now, a mark only in memory is written again: it keeps its epoch known.
	if d.failed != nil && !d.failedSaved {
		a.saveFailure()
	}
	// What Kong serves decides what the agent may declare, with the control plane up or down.
	a.checkKong(ctx)
	hash := ""
	if d.at != nil {
		hash = d.at.Hash
	}
	current, err := a.client.deployment(ctx, hash)
	var refused *deliveryRefused
	var invalid *invalidEnvelope
	switch {
	case errors.As(err, &refused):
		// Nothing to apply now (Workspaces mode off, a v1 or switching cluster): Kong keeps what it serves.
		if refused.code != d.refusal {
			a.log.Warn("the control plane delivers no deployment to this node; keeping the applied configuration", "code", refused.code)
		}
		d.refusal = refused.code
		return
	case errors.As(err, &invalid):
		current = &currentDeployment{at: invalid.at}
	case err != nil:
		if ctx.Err() == nil {
			a.log.Warn("deployment fetch failed", "error", err)
		}
		return
	}
	d.refusal = ""
	if current == nil {
		return
	}
	next := current.at
	var epoch int64
	if d.at != nil {
		epoch = d.at.Epoch
	}
	if d.failed != nil && d.failed.Epoch > epoch {
		epoch = d.failed.Epoch
	}
	if next.Epoch < epoch {
		a.log.Warn("refusing a deployment of an older epoch", "epoch", next.Epoch, "currentEpoch", epoch)
		return
	}
	if d.at != nil {
		// A newer epoch wins whatever its revision; inside an epoch only a higher revision does.
		if !d.at.before(next) {
			if next != *d.at {
				a.log.Warn("refusing a deployment that is not newer than the applied one", "epoch", next.Epoch, "revision", next.Revision)
			}
			return
		}
	}
	if d.failed != nil && d.failed.position == next {
		return
	}
	if invalid != nil {
		a.log.Error("invalid deployment envelope", "error", invalid.err)
		a.refuseRevision(ctx, next, "invalid-envelope")
		return
	}
	if d.at != nil && next.Hash == d.at.Hash {
		a.confirmDeployment(ctx, current)
		return
	}
	deployment := current.deployment
	if deployment.InstanceID != a.config.InstanceID {
		a.refuseRevision(ctx, next, "instance-mismatch")
		return
	}
	if next != d.retry {
		d.retry, d.attempt, d.next = next, 0, time.Time{}
	}
	if time.Now().Before(d.next) {
		return
	}
	pending, err := d.store.stageRaw(deployment.raw, deployment.Config)
	if err != nil {
		a.retryDeployment(next, "cannot stage deployment on disk")
		return
	}
	committed := false
	defer func() {
		if !committed {
			pending.discard()
		}
	}()
	if err := a.client.apply(ctx, kongConfigBody(deployment.Config)); err != nil {
		var responseErr *applyError
		if errors.As(err, &responseErr) && (responseErr.statusCode == http.StatusBadRequest || responseErr.statusCode == http.StatusRequestEntityTooLarge) {
			a.markFailure(&permanentFailure{next, responseErr.statusCode, "kong-rejected"})
			a.failures.Add(1)
			a.log.Error("deployment rejected by Kong", "epoch", next.Epoch, "revision", next.Revision, "status", responseErr.statusCode)
			a.reportDeployment(ctx)
			return
		}
		a.retryDeployment(next, "deployment application failed")
		return
	}
	// Applied means Kong serves it: its own hash of the posted bytes, nothing the agent computes alone.
	if !a.waitKongHash(ctx, kongConfigHash(deployment.Config)) {
		a.retryDeployment(next, "Kong does not report the hash of the posted configuration")
		return
	}
	if err := pending.commit(); err != nil {
		if pending.published {
			committed = true
			a.acceptDeployment(deployment, next, true)
			a.confirmApplied()
			a.failures.Add(1)
			a.log.Error("deployment applied but directory durability could not be confirmed", "epoch", next.Epoch, "revision", next.Revision)
			a.reportDeployment(ctx)
			return
		}
		// Restore the running config when the durable commit cannot be completed.
		if d.applied != nil && ctx.Err() == nil {
			if rollbackErr := a.client.apply(ctx, kongConfigBody(d.applied.Config)); rollbackErr != nil {
				a.log.Error("failed to restore running config after persistence failure")
			}
		}
		a.retryDeployment(next, "cannot commit deployment on disk")
		return
	}
	committed = true
	a.acceptDeployment(deployment, next, true)
	a.confirmApplied()
	a.log.Info("deployment applied", "epoch", next.Epoch, "revision", next.Revision)
	a.reportDeployment(ctx)
}

func (a *Agent) retryDeployment(at position, message string) {
	d := a.deploy
	d.next = time.Now().Add(a.applyRetry(d.attempt))
	d.attempt++
	a.failures.Add(1)
	a.log.Error(message, "epoch", at.Epoch, "revision", at.Revision)
}

// confirmDeployment records a newer (epoch, revision) of the running config without posting it again: the envelope
// when the control plane sent one (200), otherwise the position (304). Nothing is confirmed that is not on the
// volume, and it is declared only once Kong reports serving that config.
func (a *Agent) confirmDeployment(ctx context.Context, current *currentDeployment) {
	d := a.deploy
	deployment := d.applied
	if current.deployment != nil {
		deployment = current.deployment
		if deployment.InstanceID != a.config.InstanceID {
			a.refuseRevision(ctx, current.at, "instance-mismatch")
			return
		}
		pending, err := d.store.stageRaw(deployment.raw, deployment.Config)
		if err == nil {
			if err = pending.commit(); err != nil && !pending.published {
				pending.discard()
			} else {
				err = nil
			}
		}
		if err != nil {
			a.log.Warn("cannot persist the confirmed deployment; retrying on the next poll", "error", err)
			return
		}
	} else {
		data, _ := json.Marshal(current.at)
		if err := writeAtomic(d.positionFile(), data, 0o644); err != nil {
			a.log.Warn("cannot persist the confirmed revision; retrying on the next poll", "error", err)
			return
		}
	}
	a.acceptDeployment(deployment, current.at, true)
	a.checkKong(ctx)
	a.log.Info("deployment revision confirmed", "epoch", current.at.Epoch, "revision", current.at.Revision)
	a.reportDeployment(ctx)
}
