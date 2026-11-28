package main

import (
	"bytes"
	"context"
	"encoding/json"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync/atomic"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v3/cmd/internal/workload"
)

const (
	sub    = "11111111-2222-3333-4444-555555555555"
	tenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	job    = "/subscriptions/" + sub + "/resourceGroups/orrery/providers/Microsoft.App/jobs/comet-sync"
)

func TestParseJobTakesOnlyContainerAppsJobs(t *testing.T) {
	ok := []string{
		job,
		"/subscriptions/" + sub + "/resourcegroups/rg/providers/microsoft.app/jobs/x/",
	}
	for _, id := range ok {
		j, err := ParseJob(id)
		if err != nil {
			t.Errorf("%s: %v", id, err)
		}
		if j.Subscription != sub {
			t.Errorf("%s: subscription %q", id, j.Subscription)
		}
	}
	if j, _ := ParseJob(job); j.Name != "comet-sync" {
		t.Errorf("name %q", j.Name)
	}
	bad := []string{
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.App/containerApps/x",
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/x",
		job + "/executions/e1",
		"https://example.org" + job,
		"",
	}
	for _, id := range bad {
		if _, err := ParseJob(id); err == nil {
			t.Errorf("%q was taken", id)
		}
	}
}

// arm stands in for Azure Resource Manager: it names the tenant to a caller with no token, takes a start with the
// token that tenant gives, and runs the execution through `statuses`, one per read. With named false the start
// answers 202 with no body, so the execution is found in the list.
func arm(t *testing.T, startStatus int, named bool, statuses ...string) (*httptest.Server, *atomic.Int32) {
	var starts, reads atomic.Int32
	started := time.Now().UTC()
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/subscriptions/"+sub:
			w.Header().Set("WWW-Authenticate", `Bearer authorization_uri="https://login.microsoftonline.com/`+tenant+`", error="invalid_token"`)
			w.WriteHeader(http.StatusUnauthorized)
		case r.Header.Get("Authorization") != "Bearer token-for-"+tenant:
			w.WriteHeader(http.StatusUnauthorized)
		case r.URL.Query().Get("api-version") != apiVersion:
			w.WriteHeader(http.StatusBadRequest)
		case r.Method == http.MethodPost && r.URL.Path == job+"/start":
			starts.Add(1)
			if startStatus >= 300 {
				w.WriteHeader(startStatus)
				_, _ = w.Write([]byte(`{"error":{"code":"AuthorizationFailed","message":"no starting here"}}`))
				return
			}
			w.WriteHeader(startStatus)
			if named {
				_, _ = w.Write([]byte(`{"name":"comet-sync-e1","id":"` + job + `/executions/comet-sync-e1"}`))
			}
		case r.Method == http.MethodGet && r.URL.Path == job+"/executions":
			_ = json.NewEncoder(w).Encode(map[string]any{"value": []map[string]any{
				{"name": "comet-sync-old", "properties": map[string]string{"status": "Succeeded", "startTime": started.Add(-time.Hour).Format(time.RFC3339)}},
				{"name": "comet-sync-e1", "properties": map[string]string{"status": "Running", "startTime": started.Add(time.Second).Format(time.RFC3339)}},
			}})
		case r.Method == http.MethodGet && r.URL.Path == job+"/executions/comet-sync-e1":
			n := int(reads.Add(1)) - 1
			if n >= len(statuses) {
				n = len(statuses) - 1
			}
			// "!drop" cuts the connection, as a reset does; "!503" is Azure busy.
			switch statuses[n] {
			case "!drop":
				conn, _, _ := w.(http.Hijacker).Hijack()
				_ = conn.Close()
				return
			case "!503":
				w.WriteHeader(http.StatusServiceUnavailable)
				return
			}
			p := map[string]string{"status": statuses[n], "startTime": started.Format(time.RFC3339)}
			if terminal[strings.ToLower(statuses[n])] {
				p["endTime"] = started.Add(134 * time.Second).Format(time.RFC3339)
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"name": "comet-sync-e1", "properties": p})
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &starts
}

// identity signs in through a stand-in for Entra that gives each tenant's token by name.
func identity(t *testing.T) func() (workload.Identity, error) {
	entra := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		tenant := strings.Split(strings.TrimPrefix(r.URL.Path, "/"), "/")[0]
		_ = json.NewEncoder(w).Encode(map[string]string{"access_token": "token-for-" + tenant})
	}))
	t.Cleanup(entra.Close)
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("sa"), 0o600); err != nil {
		t.Fatal(err)
	}
	return func() (workload.Identity, error) {
		return workload.Identity{TenantID: tenant, ClientID: "app", TokenFile: file, AuthorityHost: entra.URL + "/"}, nil
	}
}

// summary is what the last log line that carries one says.
func summary(out *bytes.Buffer) string {
	var said string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var l struct {
			Summary string `json:"summary"`
		}
		if json.Unmarshal([]byte(line), &l) == nil && l.Summary != "" {
			said = l.Summary
		}
	}
	return said
}

// steps is every step the log lines started, in order.
func steps(out *bytes.Buffer) string {
	var named []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var l struct {
			Step string `json:"step"`
		}
		if json.Unmarshal([]byte(line), &l) == nil && l.Step != "" && (len(named) == 0 || named[len(named)-1] != l.Step) {
			named = append(named, l.Step)
		}
	}
	return strings.Join(named, ",")
}

func TestRunStartsTheJobAndFollowsItToTheEnd(t *testing.T) {
	pollEvery = time.Millisecond
	cases := []struct {
		name     string
		start    int
		named    bool
		statuses []string
		args     []string
		code     int
		said     string
		steps    string
	}{
		{"succeeds", http.StatusOK, true, []string{"Running", "Running", "Succeeded"}, nil, 0, "comet-sync ran for 2m14s and succeeded.", "Sign in,Start,Run"},
		{"found in the list", http.StatusAccepted, false, []string{"Processing", "Succeeded"}, nil, 0, "comet-sync ran for 2m14s and succeeded.", "Sign in,Start,Run"},
		{"fails", http.StatusOK, true, []string{"Running", "Failed"}, nil, 1, "comet-sync ran for 2m14s and ended failed.", "Sign in,Start,Run"},
		{"degraded", http.StatusOK, true, []string{"Degraded"}, nil, 1, "comet-sync ran for 2m14s and ended degraded.", "Sign in,Start,Run"},
		{"stopped", http.StatusOK, true, []string{"Stopped"}, nil, 1, "comet-sync ran for 2m14s and ended stopped.", "Sign in,Start,Run"},
		{"times out", http.StatusOK, true, []string{"Running"}, []string{"--wait", "300ms"}, 1, "comet-sync did not end within 300ms: the wait ran out: comet-sync-e1 was still running", "Sign in,Start,Run"},
		{"rides out a dropped read", http.StatusOK, true, []string{"Running", "!drop", "!503", "Succeeded"}, nil, 0, "comet-sync ran for 2m14s and succeeded.", "Sign in,Start,Run"},
		{"loses it for good", http.StatusOK, true, []string{"Running", "!drop"}, nil, 1, "comet-sync started as comet-sync-e1, but could not be followed: following comet-sync-e1 after 5 tries:", "Sign in,Start,Run"},
		{"refused", http.StatusForbidden, true, nil, nil, 1, "comet-sync did not start: Azure refused it (403 AuthorizationFailed): no starting here", "Sign in,Start"},
	}
	for _, c := range cases {
		t.Run(c.name, func(t *testing.T) {
			srv, starts := arm(t, c.start, c.named, c.statuses...)
			var out bytes.Buffer
			log := slog.New(slog.NewJSONHandler(&out, nil))
			code := run(context.Background(), append(c.args, job), log, identity(t), srv.URL)
			if said := summary(&out); code != c.code || !strings.HasPrefix(said, c.said) || (said != c.said && !strings.HasSuffix(c.said, ":")) {
				t.Fatalf("exit %d, summary %q", code, said)
			}
			if got := steps(&out); got != c.steps {
				t.Fatalf("steps %q, want %q", got, c.steps)
			}
			if starts.Load() != 1 {
				t.Fatalf("started %d times", starts.Load())
			}
		})
	}
}

func TestRunRefusesWhatIsNotAJob(t *testing.T) {
	srv, starts := arm(t, http.StatusOK, true, "Succeeded")
	var out bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	for _, args := range [][]string{
		{"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/app"},
		{},
		{job, job},
	} {
		if code := run(context.Background(), args, log, identity(t), srv.URL); code != 2 {
			t.Errorf("%v: exit %d", args, code)
		}
	}
	if starts.Load() != 0 {
		t.Fatalf("started %d times", starts.Load())
	}
}
