package sdk

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
)

func TestRunBatchesAndCommits(t *testing.T) {
	var batches, commits atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/ingest/runs":
			json.NewEncoder(w).Encode(map[string]string{"id": "r1"})
		case r.Method == "PUT" && r.URL.Path == "/v1/ingest/runs/r1/entities":
			var body struct {
				Entities []Entity `json:"entities"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			batches.Add(1)
			if len(body.Entities) > 2 {
				t.Errorf("batch too large: %d", len(body.Entities))
			}
			json.NewEncoder(w).Encode(map[string]any{"accepted": len(body.Entities), "rejected": []WriteError{{Blueprint: "x", Key: "bad", Reason: "nope"}}})
		case r.Method == "POST" && r.URL.Path == "/v1/ingest/runs/r1/commit":
			commits.Add(1)
			json.NewEncoder(w).Encode(RunResult{ID: "r1", State: "committed", Counts: RunCounts{Created: 5}})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", WithRetries(0))
	res, err := c.Snapshot(context.Background(), "home", func(add func(Entity) error) error {
		for i := 0; i < 5; i++ {
			if err := add(Entity{Blueprint: "x", Key: string(rune('a' + i))}); err != nil {
				return err
			}
		}
		return nil
	}, BatchSize(2))
	if err != nil {
		t.Fatal(err)
	}
	if res.Counts.Created != 5 || commits.Load() != 1 || batches.Load() != 3 {
		t.Fatalf("got created=%d commits=%d batches=%d", res.Counts.Created, commits.Load(), batches.Load())
	}
}

func TestSnapshotFailsRunOnError(t *testing.T) {
	var failed atomic.Bool
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/v1/ingest/runs":
			json.NewEncoder(w).Encode(map[string]string{"id": "r2"})
		case "/v1/ingest/runs/r2/fail":
			failed.Store(true)
			w.Write([]byte(`{}`))
		case "/v1/ingest/runs/r2/commit":
			t.Error("commit must not be called")
		default:
			w.Write([]byte(`{}`))
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", WithRetries(0))
	_, err := c.Snapshot(context.Background(), "home", func(add func(Entity) error) error {
		return context.DeadlineExceeded
	})
	if err == nil || !failed.Load() {
		t.Fatalf("expected failure and a fail call, got err=%v failed=%v", err, failed.Load())
	}
}

func TestRetriesOn5xxNotOn4xx(t *testing.T) {
	var calls atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		n := calls.Add(1)
		if n == 1 {
			w.WriteHeader(503)
			return
		}
		if r.URL.Path == "/v1/ingest/entities/x/bad" {
			w.WriteHeader(422)
			w.Write([]byte(`{"error":"rejected","errors":[{"blueprint":"x","key":"bad","field":"f","reason":"expected a number"}]}`))
			return
		}
		w.Write([]byte(`{"outcome":"created"}`))
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", WithRetries(2))
	if err := c.Put(context.Background(), Entity{Blueprint: "x", Key: "ok"}); err != nil {
		t.Fatal(err)
	}
	if calls.Load() != 2 {
		t.Fatalf("expected one retry, got %d calls", calls.Load())
	}
	before := calls.Load()
	err := c.Put(context.Background(), Entity{Blueprint: "x", Key: "bad"})
	apiErr, ok := err.(*APIError)
	if !ok || apiErr.Status != 422 || len(apiErr.Errors) != 1 || apiErr.Errors[0].Field != "f" {
		t.Fatalf("expected a 422 with one validation error, got %v", err)
	}
	if calls.Load() != before+1 {
		t.Fatalf("4xx must not retry")
	}
}

func TestPutIconSendsTheImage(t *testing.T) {
	var got struct{ method, path, kind, auth, body string }
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		body, _ := io.ReadAll(r.Body)
		got.method, got.path, got.kind, got.auth, got.body = r.Method, r.URL.Path, r.Header.Get("Content-Type"), r.Header.Get("Authorization"), string(body)
		json.NewEncoder(w).Encode(map[string]string{"name": "entra_abc"})
	}))
	defer srv.Close()
	if err := New(srv.URL, "tok", WithRetries(0)).PutIcon(context.Background(), "entra_abc", "image/png", []byte("\x89PNG")); err != nil {
		t.Fatal(err)
	}
	if got.method != "PUT" || got.path != "/v1/icons/entra_abc" || got.kind != "image/png" || got.auth != "Bearer tok" || got.body != "\x89PNG" {
		t.Fatalf("sent %+v", got)
	}
}

func TestPicturesPutListAndDelete(t *testing.T) {
	small, large := []byte("\xff\xd8\xffsmall"), []byte("\xff\xd8\xfflarge")
	held := map[string]string{}
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		address, _ := strings.CutPrefix(r.URL.Path, "/v1/ingest/pictures/")
		switch {
		case r.Method == "PUT":
			var body struct{ Small, Large string }
			json.NewDecoder(r.Body).Decode(&body)
			s, _ := base64.StdEncoding.DecodeString(body.Small)
			l, _ := base64.StdEncoding.DecodeString(body.Large)
			held[address] = PictureSHA(s, l)
			json.NewEncoder(w).Encode(Picture{Address: address, SHA256: held[address]})
		case r.Method == "GET" && r.URL.Path == "/v1/ingest/pictures":
			var out []Picture
			for a, s := range held {
				out = append(out, Picture{Address: a, SHA256: s})
			}
			json.NewEncoder(w).Encode(map[string]any{"pictures": out})
		case r.Method == "DELETE":
			if _, ok := held[address]; !ok {
				w.WriteHeader(404)
				w.Write([]byte(`{"error":"no picture"}`))
				return
			}
			delete(held, address)
			w.WriteHeader(204)
		}
	}))
	defer srv.Close()
	c, ctx := New(srv.URL, "tok", WithRetries(0)), context.Background()
	sha, err := c.PutPicture(ctx, "a.person@example.org", small, large)
	if err != nil || sha != PictureSHA(small, large) {
		t.Fatalf("put: %q %v", sha, err)
	}
	if sha == PictureSHA(large, small) {
		t.Fatal("the digest must follow the order of the two images")
	}
	got, err := c.Pictures(ctx)
	if err != nil || len(got) != 1 || got[0].Address != "a.person@example.org" || got[0].SHA256 != sha {
		t.Fatalf("list: %+v %v", got, err)
	}
	if err := c.DeletePicture(ctx, "a.person@example.org"); err != nil {
		t.Fatal(err)
	}
	if err := c.DeletePicture(ctx, "a.person@example.org"); err != nil {
		t.Fatalf("a photo already gone is not an error: %v", err)
	}
}

// A hub that takes sightings: it keeps the digest each full write came with,
// and wants in full any entity named by a digest it does not hold.
func TestRunSendsOnlyWhatTheHubWants(t *testing.T) {
	kept := map[string]string{}
	var full, named atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == "POST" && r.URL.Path == "/v1/ingest/runs":
			json.NewEncoder(w).Encode(map[string]any{"id": "r3", "sightings": true})
		case r.Method == "PUT" && r.URL.Path == "/v1/ingest/runs/r3/entities":
			var body struct {
				Entities []map[string]any `json:"entities"`
			}
			json.NewDecoder(r.Body).Decode(&body)
			var wanted []map[string]string
			for _, e := range body.Entities {
				id := e["blueprint"].(string) + ":" + e["key"].(string)
				digest, _ := e["digest"].(string)
				if digest == "" {
					t.Errorf("%s came without a digest", id)
				}
				if _, whole := e["title"]; whole {
					full.Add(1)
					kept[id] = digest
					continue
				}
				named.Add(1)
				if kept[id] != digest {
					wanted = append(wanted, map[string]string{"blueprint": e["blueprint"].(string), "key": e["key"].(string)})
				}
			}
			json.NewEncoder(w).Encode(map[string]any{"accepted": len(body.Entities) - len(wanted), "rejected": []WriteError{}, "wanted": wanted})
		case r.Method == "POST" && r.URL.Path == "/v1/ingest/runs/r3/commit":
			json.NewEncoder(w).Encode(RunResult{ID: "r3", State: "committed"})
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	c := New(srv.URL, "tok", WithRetries(0))
	push := func(size int) {
		t.Helper()
		full.Store(0)
		named.Store(0)
		_, err := c.Snapshot(context.Background(), "home", func(add func(Entity) error) error {
			for _, k := range []string{"a", "b", "c"} {
				fields := map[string]any{"size": 1}
				if k == "c" {
					fields["size"] = size
				}
				if err := add(Entity{Blueprint: "x", Key: k, Title: k, Fields: fields}); err != nil {
					return err
				}
			}
			return nil
		})
		if err != nil {
			t.Fatal(err)
		}
	}
	push(1)
	if named.Load() != 3 || full.Load() != 3 {
		t.Fatalf("first run: named %d, sent in full %d; want every entity named, then sent in full", named.Load(), full.Load())
	}
	push(1)
	if named.Load() != 3 || full.Load() != 0 {
		t.Fatalf("same run again: named %d, sent in full %d; want nothing sent in full", named.Load(), full.Load())
	}
	push(2)
	if full.Load() != 1 {
		t.Fatalf("one entity changed: sent in full %d; want 1", full.Load())
	}
}

func TestDigestFollowsWhatIsSent(t *testing.T) {
	a := Entity{Blueprint: "x", Key: "k", Fields: map[string]any{"b": 1, "a": "two"}}
	b := Entity{Blueprint: "x", Key: "k", Fields: map[string]any{"a": "two", "b": 1}}
	if Digest(a) != Digest(b) {
		t.Fatal("the same entity gave two digests")
	}
	b.Fields["b"] = 2
	if Digest(a) == Digest(b) {
		t.Fatal("a changed entity kept its digest")
	}
}
