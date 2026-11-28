package main

import (
	"bytes"
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
)

const families = `{"columns":[{"id":"week","title":"Week"},{"id":"misses","title":"Misses"}],"rows":[["2026-11-23T00:00:00Z",null]]}`

func annals(t *testing.T, status int, body string, asked *string) *httptest.Server {
	t.Helper()
	s := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Header.Get("Authorization") != "Bearer secret" {
			w.WriteHeader(http.StatusUnauthorized)
			w.Write([]byte(`{"error":"a bearer token is required","reason":"no_token"}`))
			return
		}
		*asked = r.URL.String()
		w.WriteHeader(status)
		w.Write([]byte(body))
	}))
	t.Cleanup(s.Close)
	return s
}

func call(t *testing.T, env settings, args ...string) (int, string, string) {
	t.Helper()
	var out, errOut bytes.Buffer
	code := run(context.Background(), args, env, http.DefaultClient, &out, &errOut)
	return code, out.String(), errOut.String()
}

func TestReadsATable(t *testing.T) {
	var asked string
	s := annals(t, http.StatusOK, families, &asked)
	env := settings{URL: s.URL + "/", Token: "secret"}
	code, out, errOut := call(t, env, "gate-families", "--weeks", "4")
	if code != 0 || strings.TrimSpace(out) != families || asked != "/v1/gate/families?weeks=4" {
		t.Fatalf("%d %q %q asked %s", code, out, errOut, asked)
	}
	if code, _, _ := call(t, env, "gate-drafts", "--weeks", ""); code != 0 || asked != "/v1/gate/drafts" {
		t.Errorf("an empty --weeks is Annals' default: %d %s", code, asked)
	}
}

func TestAskedWrongly(t *testing.T) {
	env := settings{URL: "http://annals.example.org", Token: "secret"}
	for _, args := range [][]string{
		nil,
		{"events"},
		{"gate-families", "--weeks", "53"},
		{"gate-families", "--weeks", "two"},
		{"gate-families", "extra"},
		{"gate-families", "--query", "x"},
	} {
		if code, _, _ := call(t, env, args...); code != 2 {
			t.Errorf("%v: exit %d", args, code)
		}
	}
	if code, _, errOut := call(t, settings{Token: "secret"}, "gate-families"); code != 2 || !strings.Contains(errOut, "ANNALS_URL") {
		t.Errorf("no address: %d %s", code, errOut)
	}
	if code, _, errOut := call(t, settings{URL: "http://annals.example.org"}, "gate-families"); code != 2 || !strings.Contains(errOut, "ANNALS_TOKEN") {
		t.Errorf("no token: %d %s", code, errOut)
	}
}

func TestAnnalsFails(t *testing.T) {
	var asked string
	s := annals(t, http.StatusInternalServerError, `{"error":"the change events could not be read","reason":"store_error"}`, &asked)
	code, out, errOut := call(t, settings{URL: s.URL, Token: "secret"}, "gate-families")
	if code != 1 || out != "" || !strings.Contains(errOut, "500: the change events could not be read") {
		t.Errorf("%d %q %q", code, out, errOut)
	}
	if code, _, errOut := call(t, settings{URL: s.URL, Token: "wrong"}, "gate-families"); code != 1 || !strings.Contains(errOut, "401") {
		t.Errorf("a refused token: %d %s", code, errOut)
	}
	for _, body := range []string{`{"rows":[]}`, `[]`, `{"columns":[],"rows":[],"next":"x"}`} {
		s := annals(t, http.StatusOK, body, &asked)
		if code, _, _ := call(t, settings{URL: s.URL, Token: "secret"}, "gate-drafts"); code != 1 {
			t.Errorf("%s is no table: exit %d", body, code)
		}
	}
	big := `{"columns":[{"id":"x"}],"rows":[` + strings.Repeat(`["`+strings.Repeat("a", 1000)+`"],`, 70) + `["a"]]}`
	s = annals(t, http.StatusOK, big, &asked)
	if code, _, errOut := call(t, settings{URL: s.URL, Token: "secret"}, "gate-families"); code != 1 || !strings.Contains(errOut, "fewer --weeks") {
		t.Errorf("too large: %d %s", code, errOut)
	}
}
