package sdk

import (
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"net/http"
	"net/url"
	"time"
)

// RunMode says whether a run is a full snapshot of its scope or a partial
// update. Only a committed snapshot can cause deletions, and only within its
// own source and scope.
type RunMode string

const (
	Snapshot    RunMode = "snapshot"
	Incremental RunMode = "incremental"
)

// RunCounts is what the hub did with a run.
type RunCounts struct {
	Received  int `json:"received"`
	Created   int `json:"created"`
	Updated   int `json:"updated"`
	Unchanged int `json:"unchanged"`
	Rejected  int `json:"rejected"`
	Missing   int `json:"missing"`
	Deleted   int `json:"deleted"`
	// Sighted counts the entities named by their digest alone and taken as
	// sent again; Received counts the ones sent in full.
	Sighted int `json:"sighted"`
}

// RunResult is the committed run.
type RunResult struct {
	ID       string       `json:"id"`
	Source   string       `json:"source"`
	Mode     RunMode      `json:"mode"`
	Scope    string       `json:"scope"`
	State    string       `json:"state"`
	Counts   RunCounts    `json:"counts"`
	Errors   []WriteError `json:"errors"`
	MassDrop bool         `json:"massDrop"`
}

// Run is an open run. Add entities, then Commit; on any failure call Fail so
// the hub deletes nothing.
type Run struct {
	client     *Client
	ID         string
	Mode       RunMode
	Scope      string
	batchSize  int
	observedAt string
	// sightings says the hub takes an entity named by its digest alone.
	sightings bool
	buffer    []Entity
	rejected  []WriteError
	sent      int
	sighted   int
}

// RunOption tunes a run.
type RunOption func(*runOpts)

type runOpts struct {
	batchSize  int
	observedAt string
	write      string
}

// BatchSize sets how many entities travel per request. Defaults to 200.
func BatchSize(n int) RunOption { return func(o *runOpts) { o.batchSize = n } }

// RunObservedAt stamps every batch with the time the snapshot was taken.
func RunObservedAt(t time.Time) RunOption {
	return func(o *runOpts) { o.observedAt = t.UTC().Format(time.RFC3339Nano) }
}

// EnrichOnly makes the run add fields to existing entities only.
func EnrichOnly() RunOption { return func(o *runOpts) { o.write = "enrich" } }

// OpenRun starts a run over a scope: a cluster, an org, a subscription.
func (c *Client) OpenRun(ctx context.Context, mode RunMode, scope string, opts ...RunOption) (*Run, error) {
	o := runOpts{batchSize: 200, write: "upsert"}
	for _, opt := range opts {
		opt(&o)
	}
	var res struct {
		ID        string `json:"id"`
		Sightings bool   `json:"sightings"`
	}
	if err := c.do(ctx, http.MethodPost, "/v1/ingest/runs", map[string]string{"mode": string(mode), "scope": scope, "write": o.write}, &res); err != nil {
		return nil, err
	}
	c.log.Info("orrery run opened", "run", res.ID, "mode", mode, "scope", scope, "sightings", res.Sightings)
	return &Run{client: c, ID: res.ID, Mode: mode, Scope: scope, batchSize: o.batchSize, observedAt: o.observedAt, sightings: res.Sightings}, nil
}

// Add buffers an entity and flushes a full batch.
func (r *Run) Add(ctx context.Context, e Entity) error {
	r.buffer = append(r.buffer, e)
	if len(r.buffer) >= r.batchSize {
		return r.Flush(ctx)
	}
	return nil
}

// whole is an entity as a batch carries it in full, with the digest the hub
// keeps for it.
type whole struct {
	Entity
	Digest string `json:"digest,omitempty"`
}

// ref names an entity.
type ref struct {
	Blueprint string `json:"blueprint"`
	Key       string `json:"key"`
}

// sighting names an entity by the digest of what was last sent of it.
type sighting struct {
	Blueprint string `json:"blueprint"`
	Key       string `json:"key"`
	Digest    string `json:"digest"`
}

// Digest is the fingerprint of what is sent of an entity: the same entity
// always gives the same digest, and any change to it gives another.
func Digest(e Entity) string {
	b, _ := json.Marshal(e)
	sum := sha256.Sum256(b)
	return base64.RawURLEncoding.EncodeToString(sum[:16])
}

// Flush sends buffered entities. Updates apply on the hub immediately. Where
// the hub takes sightings, each entity is named by its digest first, and only
// the ones the hub wants are sent in full, so a run costs what changed.
func (r *Run) Flush(ctx context.Context) error {
	if len(r.buffer) == 0 {
		return nil
	}
	batch := r.buffer
	r.buffer = nil
	if !r.sightings {
		return r.write(ctx, batch)
	}
	named := make([]sighting, len(batch))
	for i, e := range batch {
		named[i] = sighting{Blueprint: e.Blueprint, Key: e.Key, Digest: Digest(e)}
	}
	wanted, err := r.put(ctx, named)
	if err != nil {
		return err
	}
	want := make(map[string]bool, len(wanted))
	for _, w := range wanted {
		want[w.Blueprint+":"+w.Key] = true
	}
	r.sighted += len(batch) - len(wanted)
	var full []Entity
	for _, e := range batch {
		if want[e.ID()] {
			full = append(full, e)
		}
	}
	if len(full) == 0 {
		return nil
	}
	return r.write(ctx, full)
}

// write sends entities in full, each with its digest where the hub keeps them.
func (r *Run) write(ctx context.Context, entities []Entity) error {
	items := make([]whole, len(entities))
	for i, e := range entities {
		items[i] = whole{Entity: e}
		if r.sightings {
			items[i].Digest = Digest(e)
		}
	}
	if _, err := r.put(ctx, items); err != nil {
		return err
	}
	r.sent += len(entities)
	return nil
}

// put sends one batch and answers what the hub wants sent in full.
func (r *Run) put(ctx context.Context, items any) ([]ref, error) {
	body := map[string]any{"entities": items}
	if r.observedAt != "" {
		body["observedAt"] = r.observedAt
	}
	var res struct {
		Accepted int          `json:"accepted"`
		Rejected []WriteError `json:"rejected"`
		Wanted   []ref        `json:"wanted"`
	}
	if err := r.client.do(ctx, http.MethodPut, "/v1/ingest/runs/"+url.PathEscape(r.ID)+"/entities", body, &res); err != nil {
		return nil, err
	}
	r.rejected = append(r.rejected, res.Rejected...)
	for _, e := range res.Rejected {
		r.client.log.Warn("orrery rejected entity", "run", r.ID, "entity", e.Blueprint+":"+e.Key, "field", e.Field, "reason", e.Reason)
	}
	return res.Wanted, nil
}

// Rejected lists every entity the hub refused so far, with the reason.
func (r *Run) Rejected() []WriteError { return r.rejected }

// Commit flushes and commits. A snapshot commit marks everything in the
// scope that the run did not mention as missing.
func (r *Run) Commit(ctx context.Context) (*RunResult, error) {
	if err := r.Flush(ctx); err != nil {
		return nil, err
	}
	var res RunResult
	if err := r.client.do(ctx, http.MethodPost, "/v1/ingest/runs/"+url.PathEscape(r.ID)+"/commit", nil, &res); err != nil {
		return nil, err
	}
	r.client.log.Info("orrery run committed", "run", r.ID, "scope", r.Scope, "sent", r.sent, "sighted", r.sighted, "created", res.Counts.Created, "updated", res.Counts.Updated, "unchanged", res.Counts.Unchanged, "rejected", res.Counts.Rejected, "missing", res.Counts.Missing, "deleted", res.Counts.Deleted, "massDrop", res.MassDrop)
	return &res, nil
}

// Fail closes the run without committing. Nothing is deleted.
func (r *Run) Fail(ctx context.Context, reason string) error {
	r.client.log.Warn("orrery run failed", "run", r.ID, "reason", reason)
	return r.client.do(ctx, http.MethodPost, "/v1/ingest/runs/"+url.PathEscape(r.ID)+"/fail", map[string]string{"reason": reason}, nil)
}

// Snapshot runs fn inside a snapshot of scope and commits it. If fn returns
// an error the run is failed instead, so a partial read never deletes.
func (c *Client) Snapshot(ctx context.Context, scope string, fn func(add func(Entity) error) error, opts ...RunOption) (*RunResult, error) {
	return c.run(ctx, Snapshot, scope, fn, opts)
}

// Incremental runs fn inside an incremental run of scope and commits it.
// What the run does not mention is left alone, so it suits things that
// happened and only accumulate: deployments, incidents. Give it a scope of
// its own; a snapshot of the same scope would mark its entities missing.
func (c *Client) Incremental(ctx context.Context, scope string, fn func(add func(Entity) error) error, opts ...RunOption) (*RunResult, error) {
	return c.run(ctx, Incremental, scope, fn, opts)
}

func (c *Client) run(ctx context.Context, mode RunMode, scope string, fn func(add func(Entity) error) error, opts []RunOption) (*RunResult, error) {
	run, err := c.OpenRun(ctx, mode, scope, opts...)
	if err != nil {
		return nil, err
	}
	if err := fn(func(e Entity) error { return run.Add(ctx, e) }); err != nil {
		_ = run.Fail(ctx, err.Error())
		return nil, fmt.Errorf("%s run of %s failed: %w", mode, scope, err)
	}
	return run.Commit(ctx)
}
