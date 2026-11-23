package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"testing"
)

func TestRunCheck(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer tok" {
			w.WriteHeader(401)
			return
		}
		w.Write([]byte("hello orrery"))
	}))
	defer srv.Close()
	var c check
	c.Entity.Blueprint, c.Entity.Key, c.Field = "web_app", "site", "health"
	c.Check.URL = srv.URL
	c.Check.ExpectStatus = "2xx"
	c.Check.ExpectBody = "orrery"
	c.Check.Auth = &struct {
		Type   string `json:"type"`
		Header string `json:"header"`
	}{Type: "bearer"}
	c.Secret = "tok"
	r := run(context.Background(), c)
	if !r.OK || r.Status == nil || *r.Status != 200 {
		t.Fatalf("expected ok 200, got %+v", r)
	}
	c.Secret = "wrong"
	r = run(context.Background(), c)
	if r.OK || r.Error == nil {
		t.Fatalf("expected failure, got %+v", r)
	}
	c.Check.URL = "http://127.0.0.1:1"
	c.Secret = "tok"
	if r := run(context.Background(), c); r.OK || r.Status != nil {
		t.Fatalf("expected a connection failure, got %+v", r)
	}
}
