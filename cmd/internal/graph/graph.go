// Package graph is Microsoft Graph for the Entra commands: signing in as a
// workload identity, never with a secret, and reading and writing with one
// token. A throttled call waits for Retry-After and asks again.
package graph

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strconv"
	"strings"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/workload"
)

// Root is Microsoft Graph's v1.0 endpoint.
const Root = "https://graph.microsoft.com/v1.0"

// Graph calls Microsoft Graph with one access token.
type Graph struct {
	root  string
	token string
	http  *http.Client
}

// SignIn trades the workload identity's service account token for a Graph
// token in its home tenant.
func SignIn(ctx context.Context, id workload.Identity) (*Graph, error) {
	token, err := id.Token(ctx, id.TenantID, "https://graph.microsoft.com/.default")
	if err != nil {
		return nil, err
	}
	return New(Root, token), nil
}

// New calls the Graph at root with token.
func New(root, token string) *Graph {
	return &Graph{root: strings.TrimRight(root, "/"), token: token, http: &http.Client{Timeout: 60 * time.Second}}
}

// Error is an answer Graph refused, with its status and error code.
type Error struct {
	Path    string
	Status  int
	Code    string
	Message string
}

func (e *Error) Error() string {
	return fmt.Sprintf("graph %s: %d %s: %s", e.Path, e.Status, e.Code, e.Message)
}

// Code is the Graph error code of err, or empty when err is not a Graph
// refusal.
func Code(err error) string {
	var e *Error
	if errors.As(err, &e) {
		return e.Code
	}
	return ""
}

// Status is the HTTP status of err, or 0 when err is not a Graph refusal.
func Status(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

// List reads every page of a Graph collection at path into out, following
// @odata.nextLink.
func (g *Graph) List(ctx context.Context, path string, out any) error {
	next := g.root + path
	var all []json.RawMessage
	for next != "" {
		var page struct {
			Value    []json.RawMessage `json:"value"`
			NextLink string            `json:"@odata.nextLink"`
		}
		if err := g.call(ctx, http.MethodGet, next, nil, &page); err != nil {
			return err
		}
		all = append(all, page.Value...)
		next = page.NextLink
	}
	joined, err := json.Marshal(all)
	if err != nil {
		return err
	}
	return json.Unmarshal(joined, out)
}

// Get reads one object at path into out.
func (g *Graph) Get(ctx context.Context, path string, out any) error {
	return g.call(ctx, http.MethodGet, g.root+path, nil, out)
}

// Post sends body to path and reads the answer into out, when out is not nil.
func (g *Graph) Post(ctx context.Context, path string, body, out any) error {
	return g.call(ctx, http.MethodPost, g.root+path, body, out)
}

// Delete removes the object at path.
func (g *Graph) Delete(ctx context.Context, path string) error {
	return g.call(ctx, http.MethodDelete, g.root+path, nil, nil)
}

// throttleRetries is how many times a throttled call waits and asks again.
const throttleRetries = 3

// Bytes reads the raw body at path, such as a photo's $value, refusing one
// larger than limit bytes.
func (g *Graph) Bytes(ctx context.Context, path string, limit int64) ([]byte, error) {
	data, err := g.send(ctx, http.MethodGet, g.root+path, nil, limit)
	if err == nil && int64(len(data)) > limit {
		return nil, fmt.Errorf("graph %s: larger than %d bytes", path, limit)
	}
	return data, err
}

// maxAnswer is the most a JSON answer is read.
const maxAnswer = 64 << 20

func (g *Graph) call(ctx context.Context, method, target string, body, out any) error {
	data, err := g.send(ctx, method, target, body, maxAnswer)
	if err != nil || out == nil || len(data) == 0 {
		return err
	}
	return json.Unmarshal(data, out)
}

// send makes one call, waiting out throttling, and answers its body: at most
// limit+1 bytes of it, so a caller can tell one that is too large.
func (g *Graph) send(ctx context.Context, method, target string, body any, limit int64) ([]byte, error) {
	var payload []byte
	if body != nil {
		var err error
		if payload, err = json.Marshal(body); err != nil {
			return nil, err
		}
	}
	for attempt := 0; ; attempt++ {
		req, err := http.NewRequestWithContext(ctx, method, target, bytes.NewReader(payload))
		if err != nil {
			return nil, err
		}
		req.Header.Set("Authorization", "Bearer "+g.token)
		if body != nil {
			req.Header.Set("Content-Type", "application/json")
		}
		res, err := g.http.Do(req)
		if err != nil {
			return nil, err
		}
		data, err := io.ReadAll(io.LimitReader(res.Body, limit+1))
		res.Body.Close()
		if err != nil {
			return nil, err
		}
		if res.StatusCode == http.StatusTooManyRequests && attempt < throttleRetries {
			wait, _ := strconv.Atoi(res.Header.Get("Retry-After"))
			select {
			case <-ctx.Done():
				return nil, ctx.Err()
			case <-time.After(time.Duration(max(wait, 1)) * time.Second):
			}
			continue
		}
		if res.StatusCode < 200 || res.StatusCode > 299 {
			var e struct {
				Error struct{ Code, Message string } `json:"error"`
			}
			_ = json.Unmarshal(data, &e)
			path := strings.SplitN(strings.TrimPrefix(target, g.root), "?", 2)[0]
			return nil, &Error{Path: path, Status: res.StatusCode, Code: e.Error.Code, Message: strings.TrimSpace(e.Error.Message)}
		}
		return data, nil
	}
}
