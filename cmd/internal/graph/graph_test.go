package graph

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestListFollowsNextLinks(t *testing.T) {
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		if r.URL.Query().Get("page") == "2" {
			json.NewEncoder(w).Encode(map[string]any{"value": []map[string]string{{"id": "c"}}})
			return
		}
		json.NewEncoder(w).Encode(map[string]any{"value": []map[string]string{{"id": "a"}, {"id": "b"}}, "@odata.nextLink": srv.URL + "/servicePrincipals?page=2"})
	}))
	defer srv.Close()
	var got []struct{ ID string }
	if err := New(srv.URL, "tok").List(context.Background(), "/servicePrincipals", &got); err != nil {
		t.Fatal(err)
	}
	if len(got) != 3 || got[2].ID != "c" {
		t.Fatalf("got %+v", got)
	}
}

func TestARefusalCarriesItsStatusAndCode(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		w.WriteHeader(403)
		w.Write([]byte(`{"error":{"code":"Authorization_RequestDenied","message":"no"}}`))
	}))
	defer srv.Close()
	var got []struct{ ID string }
	err := New(srv.URL, "tok").List(context.Background(), "/servicePrincipals?$top=1", &got)
	if Status(err) != 403 || Code(err) != "Authorization_RequestDenied" || err.Error() != "graph /servicePrincipals: 403 Authorization_RequestDenied: no" {
		t.Fatalf("got %v", err)
	}
}

func TestPostSendsJSONAndTakesAnEmptyAnswer(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		if r.Method != http.MethodPost || r.Header.Get("Content-Type") != "application/json" || json.NewDecoder(r.Body).Decode(&body) != nil || body["a"] != "b" {
			w.WriteHeader(400)
			return
		}
		w.WriteHeader(204)
	}))
	defer srv.Close()
	if err := New(srv.URL, "tok").Post(context.Background(), "/x", map[string]string{"a": "b"}, nil); err != nil {
		t.Fatal(err)
	}
}

func TestBytesReadsTheRawBodyUpToItsLimit(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/users/a/photo/$value":
			w.Write([]byte("\xff\xd8\xffjpeg"))
		case "/users/big/photo/$value":
			w.Write(make([]byte, 11))
		default:
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"ImageNotFound","message":"none"}}`))
		}
	}))
	defer srv.Close()
	g, ctx := New(srv.URL, "tok"), context.Background()
	if got, err := g.Bytes(ctx, "/users/a/photo/$value", 10); err != nil || string(got) != "\xff\xd8\xffjpeg" {
		t.Fatalf("got %q %v", got, err)
	}
	if _, err := g.Bytes(ctx, "/users/big/photo/$value", 10); err == nil {
		t.Fatal("a body over the limit must be refused")
	}
	if _, err := g.Bytes(ctx, "/users/none/photo/$value", 10); Status(err) != 404 {
		t.Fatalf("got %v", err)
	}
}
