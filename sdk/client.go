// Package sdk is the shared machinery every pusher, runner, and shell job
// uses to talk to an Orrery hub: auth, runs, scopes, batching, retries,
// observedAt, heartbeat, and validation-error reporting. A pusher built on it
// only fetches and shapes.
package sdk

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"math/rand/v2"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Entity is one thing to write. Icon names one icon of the hub's icon set for
// this entity alone; leave it empty and the entity shows its blueprint's
// icon, which a person may then change. Relations hold target ids ("blueprint:key")
// or bare keys of the relation's target blueprint; a nil value clears the
// relation at the source's layer.
type Entity struct {
	Blueprint string         `json:"blueprint"`
	Key       string         `json:"key"`
	Title     string         `json:"title,omitempty"`
	Icon      string         `json:"icon,omitempty"`
	Fields    map[string]any `json:"fields,omitempty"`
	Relations map[string]any `json:"relations,omitempty"`
}

// ID returns the entity identifier the hub uses.
func (e Entity) ID() string { return e.Blueprint + ":" + e.Key }

// WriteError names what the hub refused and why.
type WriteError struct {
	Blueprint string `json:"blueprint,omitempty"`
	Key       string `json:"key,omitempty"`
	Field     string `json:"field,omitempty"`
	Reason    string `json:"reason"`
}

func (e WriteError) String() string {
	s := e.Blueprint + ":" + e.Key
	if e.Field != "" {
		s += "." + e.Field
	}
	return s + ": " + e.Reason
}

// APIError is a non-2xx answer from the hub.
type APIError struct {
	Status  int
	Message string
	Errors  []WriteError
}

func (e *APIError) Error() string {
	if len(e.Errors) > 0 {
		return fmt.Sprintf("orrery: %d %s (%d rejected, first: %s)", e.Status, e.Message, len(e.Errors), e.Errors[0])
	}
	return fmt.Sprintf("orrery: %d %s", e.Status, e.Message)
}

// Client talks to one hub as one source.
type Client struct {
	baseURL string
	token   string
	http    *http.Client
	log     *slog.Logger
	retries int
}

// Option configures a Client.
type Option func(*Client)

// WithHTTPClient replaces the HTTP client.
func WithHTTPClient(h *http.Client) Option { return func(c *Client) { c.http = h } }

// WithLogger sets the logger. Defaults to slog.Default().
func WithLogger(l *slog.Logger) Option { return func(c *Client) { c.log = l } }

// WithRetries sets how many times a failed request is retried on network
// errors and 5xx answers. Defaults to 4.
func WithRetries(n int) Option { return func(c *Client) { c.retries = n } }

// New returns a client for the hub's machine surface, e.g.
// https://orrery-ingest.example.org, authenticating with a source or
// access token.
func New(baseURL, token string, opts ...Option) *Client {
	c := &Client{
		baseURL: strings.TrimRight(baseURL, "/"),
		token:   token,
		http:    &http.Client{Timeout: 60 * time.Second},
		log:     slog.Default(),
		retries: 4,
	}
	for _, o := range opts {
		o(c)
	}
	return c
}

// FromEnv builds a client from ORRERY_URL and ORRERY_TOKEN.
func FromEnv(opts ...Option) (*Client, error) {
	u := os.Getenv("ORRERY_URL")
	t := os.Getenv("ORRERY_TOKEN")
	if u == "" || t == "" {
		return nil, errors.New("ORRERY_URL and ORRERY_TOKEN must be set")
	}
	return New(u, t, opts...), nil
}

// Heartbeat marks the source alive without opening a run.
func (c *Client) Heartbeat(ctx context.Context) error {
	return c.do(ctx, http.MethodPost, "/v1/ingest/heartbeat", nil, nil)
}

// WriteOption tunes a single-entity write.
type WriteOption func(*writeBody)

type writeBody struct {
	Title      string         `json:"title,omitempty"`
	Icon       string         `json:"icon,omitempty"`
	Fields     map[string]any `json:"fields,omitempty"`
	Relations  map[string]any `json:"relations,omitempty"`
	ObservedAt string         `json:"observedAt,omitempty"`
	Mode       string         `json:"mode,omitempty"`
	Scope      string         `json:"scope,omitempty"`
}

// ObservedAt tells the hub when the value was true; older writes are ignored.
func ObservedAt(t time.Time) WriteOption {
	return func(b *writeBody) { b.ObservedAt = t.UTC().Format(time.RFC3339Nano) }
}

// Enrich only adds fields to entities that already exist and never keeps
// them alive.
func Enrich() WriteOption { return func(b *writeBody) { b.Mode = "enrich" } }

// InScope records the scope on entities this write creates.
func InScope(scope string) WriteOption { return func(b *writeBody) { b.Scope = scope } }

// Put creates or replaces one entity.
func (c *Client) Put(ctx context.Context, e Entity, opts ...WriteOption) error {
	return c.write(ctx, http.MethodPut, e, opts)
}

// Patch merges the given fields into one entity.
func (c *Client) Patch(ctx context.Context, e Entity, opts ...WriteOption) error {
	return c.write(ctx, http.MethodPatch, e, opts)
}

func (c *Client) write(ctx context.Context, method string, e Entity, opts []WriteOption) error {
	body := writeBody{Title: e.Title, Icon: e.Icon, Fields: e.Fields, Relations: e.Relations}
	for _, o := range opts {
		o(&body)
	}
	return c.do(ctx, method, "/v1/ingest/entities/"+url.PathEscape(e.Blueprint)+"/"+url.PathEscape(e.Key), body, nil)
}

// Delete removes an entity now. The source needs a delete grant for the
// blueprint; the hub blocks re-creation from snapshots for a short window.
func (c *Client) Delete(ctx context.Context, blueprint, key string) error {
	return c.do(ctx, http.MethodDelete, "/v1/ingest/entities/"+url.PathEscape(blueprint)+"/"+url.PathEscape(key), nil, nil)
}

// Call sends one request to the hub's machine surface and decodes the JSON
// answer into out. It is what the runner protocol and anything not covered
// by the typed helpers use.
func (c *Client) Call(ctx context.Context, method, path string, in, out any) error {
	return c.do(ctx, method, path, in, out)
}

// RefreshGitSource asks the hub to pull a git source now. The token must
// belong to that source.
func (c *Client) RefreshGitSource(ctx context.Context, id string) error {
	return c.do(ctx, http.MethodPost, "/v1/ingest/sources/"+url.PathEscape(id)+"/refresh", nil, nil)
}

// PutIcon puts an image as the hub's custom icon name: SVG, PNG, or WebP,
// its type in contentType. The same bytes again change nothing. The token
// may be a source token.
func (c *Client) PutIcon(ctx context.Context, name, contentType string, data []byte) error {
	return c.send(ctx, http.MethodPut, "/v1/icons/"+url.PathEscape(name), contentType, data, nil)
}

// Picture is a person's photo a source keeps on the hub: the address it
// is kept under and the digest of its bytes (PictureSHA).
type Picture struct {
	Address string `json:"address"`
	SHA256  string `json:"sha256"`
}

// PictureSHA is the digest the hub keeps of a photo: the hex SHA-256 of the
// small JPEG followed by the large one.
func PictureSHA(small, large []byte) string {
	h := sha256.New()
	h.Write(small)
	h.Write(large)
	return hex.EncodeToString(h.Sum(nil))
}

// PutPicture puts a person's photo on the hub under their address, as two
// JPEGs: small is 64 by 64 and at most 16 KiB, large 256 by 256 and at most
// 64 KiB. It answers the digest the hub keeps. The same bytes again change
// nothing. The token may be a source token.
func (c *Client) PutPicture(ctx context.Context, address string, small, large []byte) (string, error) {
	var out Picture
	body := map[string]string{"small": base64.StdEncoding.EncodeToString(small), "large": base64.StdEncoding.EncodeToString(large)}
	if err := c.do(ctx, http.MethodPut, "/v1/ingest/pictures/"+url.PathEscape(address), body, &out); err != nil {
		return "", err
	}
	return out.SHA256, nil
}

// DeletePicture removes the photo this source put under address. A photo
// already gone is not an error.
func (c *Client) DeletePicture(ctx context.Context, address string) error {
	err := c.do(ctx, http.MethodDelete, "/v1/ingest/pictures/"+url.PathEscape(address), nil, nil)
	var apiErr *APIError
	if errors.As(err, &apiErr) && apiErr.Status == http.StatusNotFound {
		return nil
	}
	return err
}

// Pictures lists the photos this source keeps on the hub.
func (c *Client) Pictures(ctx context.Context) ([]Picture, error) {
	var out struct {
		Pictures []Picture `json:"pictures"`
	}
	if err := c.do(ctx, http.MethodGet, "/v1/ingest/pictures", nil, &out); err != nil {
		return nil, err
	}
	return out.Pictures, nil
}

func (c *Client) do(ctx context.Context, method, path string, in, out any) error {
	var payload []byte
	if in != nil {
		var err error
		if payload, err = json.Marshal(in); err != nil {
			return err
		}
	}
	return c.send(ctx, method, path, "application/json", payload, out)
}

// send sends one request with retries; payload, when not nil, is sent as
// contentType.
func (c *Client) send(ctx context.Context, method, path, contentType string, payload []byte, out any) error {
	var last error
	for attempt := 0; attempt <= c.retries; attempt++ {
		if attempt > 0 {
			wait := time.Duration(1<<uint(attempt-1))*time.Second + time.Duration(rand.IntN(500))*time.Millisecond
			c.log.Warn("orrery request retry", "method", method, "path", path, "attempt", attempt, "wait", wait, "error", last)
			select {
			case <-ctx.Done():
				return ctx.Err()
			case <-time.After(wait):
			}
		}
		req, err := http.NewRequestWithContext(ctx, method, c.baseURL+path, bytes.NewReader(payload))
		if err != nil {
			return err
		}
		req.Header.Set("Authorization", "Bearer "+c.token)
		req.Header.Set("Accept", "application/json")
		if payload != nil {
			req.Header.Set("Content-Type", contentType)
		}
		res, err := c.http.Do(req)
		if err != nil {
			last = err
			continue
		}
		body, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
		res.Body.Close()
		if err != nil {
			last = err
			continue
		}
		if res.StatusCode >= 500 {
			last = &APIError{Status: res.StatusCode, Message: strings.TrimSpace(string(body))}
			continue
		}
		if res.StatusCode >= 400 {
			apiErr := &APIError{Status: res.StatusCode}
			var parsed struct {
				Error  string       `json:"error"`
				Errors []WriteError `json:"errors"`
			}
			if json.Unmarshal(body, &parsed) == nil && parsed.Error != "" {
				apiErr.Message = parsed.Error
				apiErr.Errors = parsed.Errors
			} else {
				apiErr.Message = strings.TrimSpace(string(body))
			}
			return apiErr
		}
		if out != nil && len(body) > 0 {
			return json.Unmarshal(body, out)
		}
		return nil
	}
	return fmt.Errorf("orrery: giving up after %d attempts: %w", c.retries+1, last)
}

// ActionReport is what a backend tells the hub about an action run. Log
// lines are appended; a terminal State (succeeded or failed) closes the run.
//
// Step names the step the run is in from here on: the report's lines are kept
// under it, and the run page shows how long it took. A backend's last step is
// named Verify, and checks that the effect was observed. Outputs are the
// values the run ends with, by name: text, a number, or a boolean, and nil
// takes one away. Whoever may see the run sees them, so a secret never goes
// in one.
//
// A line may say the same itself, which is how a shell job does it:
// "::step:: <name>" starts a step, "::output:: <name>=<value>" sets an output,
// "::refresh:: <field>=<json>" hands back a value of the run's entity to write
// once the run succeeds (only a field its action refreshes), and a JSON log
// line that carries "step" starts that step.
type ActionReport struct {
	State   string         `json:"state,omitempty"`
	Label   string         `json:"label,omitempty"`
	Link    string         `json:"link,omitempty"`
	Summary string         `json:"summary,omitempty"`
	Log     []string       `json:"log,omitempty"`
	Step    string         `json:"step,omitempty"`
	Outputs map[string]any `json:"outputs,omitempty"`
}

// ReportActionRun reports progress on an action run from a backend such as a
// workflow or a webhook target. The token is an access token whose role holds
// actions.report.
func (c *Client) ReportActionRun(ctx context.Context, runID string, report ActionReport) error {
	return c.do(ctx, http.MethodPost, "/v1/action-runs/"+url.PathEscape(runID)+"/report", report, nil)
}
