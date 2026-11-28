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
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v3/cmd/internal/workload"
)

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
func summary(t *testing.T, out *bytes.Buffer) string {
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

func TestRunRestartsWaitsForTheAppAndSaysHowItWent(t *testing.T) {
	answerEvery = time.Millisecond
	srv, _ := arm(t, http.StatusOK, "")
	id := "/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/comet-api-test"
	var out bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	code := run(context.Background(), []string{"--url", app(t, 503, 200), "--health", "/health", id}, log, identity(t), srv.URL)
	if said := summary(t, &out); code != 0 || !strings.HasPrefix(said, "Restarted comet-api-test: a new worker started ") || !strings.Contains(said, " after the restart was asked, and its health check answered 200. ") || !strings.HasSuffix(said, " in all.") {
		t.Fatalf("exit %d, summary %q", code, said)
	}
	// An app's restart ends in Verify: the new worker, then the app's answer.
	if got := steps(&out); got != "Sign in,Restart,Verify" {
		t.Fatalf("steps %q", got)
	}
	out.Reset()
	srv, _ = arm(t, http.StatusOK, "")
	code = run(context.Background(), []string{"--url", app(t, 503), "--wait", "50ms", id}, log, identity(t), srv.URL)
	if said := summary(t, &out); code != 1 || !strings.Contains(said, "did not answer within 50ms") {
		t.Fatalf("exit %d, summary %q", code, said)
	}
	out.Reset()
	hidden, _ := arm(t, http.StatusOK, "hidden")
	code = run(context.Background(), []string{"--url", app(t, 200), id}, log, identity(t), hidden.URL)
	if said := summary(t, &out); code != 0 || !strings.Contains(said, "its address answered 200, which may be the worker that ran before") {
		t.Fatalf("exit %d, summary %q", code, said)
	}
	out.Reset()
	// A virtual machine's restart is done when Azure says so: nothing is looked at after, so no Verify.
	vm, _ := arm(t, http.StatusAccepted, "Succeeded")
	code = run(context.Background(), []string{"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm-1"}, log, identity(t), vm.URL)
	if got := steps(&out); code != 0 || got != "Sign in,Restart" {
		t.Fatalf("exit %d, steps %q", code, got)
	}
	out.Reset()
	if code := run(context.Background(), []string{"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x"}, log, identity(t), srv.URL); code != 2 {
		t.Fatalf("a storage account was taken: exit %d", code)
	}
}
