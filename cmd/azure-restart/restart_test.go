package main

import (
	"context"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync/atomic"
	"testing"
	"time"
)

const (
	sub    = "11111111-2222-3333-4444-555555555555"
	tenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
)

func TestParseTargetTakesOnlyAppsAndMachines(t *testing.T) {
	ok := []string{
		"/subscriptions/" + sub + "/resourceGroups/rg-app/providers/Microsoft.Web/sites/comet-api-prod",
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/microsoft.web/sites/app/slots/staging",
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/web-01/",
	}
	for _, id := range ok {
		if _, err := ParseTarget(id); err != nil {
			t.Errorf("%s: %v", id, err)
		}
	}
	bad := []string{
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Storage/storageAccounts/x",
		"/subscriptions/" + sub + "/resourceGroups/rg",
		"/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/a/config/web",
		"https://example.org/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/a",
	}
	for _, id := range bad {
		if _, err := ParseTarget(id); err == nil {
			t.Errorf("%s was taken", id)
		}
	}
}

// arm stands in for Azure Resource Manager: it names the tenant to a caller with no token, takes a restart with
// the token that tenant gives, and answers a virtual machine's restart through an operation that ends `status`.
func arm(t *testing.T, status int, ends string) (*httptest.Server, *atomic.Int32) {
	var restarts atomic.Int32
	var polls atomic.Int32
	var reads atomic.Int32
	hidden := ends == "hidden"
	var srv *httptest.Server
	srv = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.URL.Path == "/subscriptions/"+sub:
			w.Header().Set("WWW-Authenticate", `Bearer authorization_uri="https://login.microsoftonline.com/`+tenant+`", error="invalid_token"`)
			w.WriteHeader(http.StatusUnauthorized)
		case r.Header.Get("Authorization") != "Bearer token-for-"+tenant:
			w.WriteHeader(http.StatusUnauthorized)
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/restart"):
			// An app's restart must be asked to wait until the app has restarted.
			if strings.Contains(r.URL.Path, "/sites/") && (r.URL.Query().Get("synchronous") != "true" || r.URL.Query().Get("softRestart") != "false") {
				w.WriteHeader(http.StatusBadRequest)
				return
			}
			restarts.Add(1)
			if strings.Contains(r.URL.Path, "virtualMachines") && status == http.StatusAccepted {
				w.Header().Set("Azure-AsyncOperation", srv.URL+"/operations/1")
			}
			w.WriteHeader(status)
			if status >= 300 && status != http.StatusAccepted {
				_, _ = w.Write([]byte(`{"error":{"code":"AuthorizationFailed","message":"no restart here"}}`))
			}
		// The app's one instance runs the deployment site's worker, and its own, which is the old one
		// until it has been read twice, as a worker takes a while to start after a restart.
		case strings.HasSuffix(r.URL.Path, "/instances"):
			if hidden {
				w.WriteHeader(http.StatusForbidden)
				_, _ = w.Write([]byte(`{"error":{"code":"AuthorizationFailed","message":"no reading"}}`))
				return
			}
			_, _ = w.Write([]byte(`{"value":[{"name":"i1"}]}`))
		case strings.HasSuffix(r.URL.Path, "/instances/i1/processes"):
			_, _ = w.Write([]byte(`{"value":[{"properties":{"id":7}},{"properties":{"id":8}}]}`))
		case strings.HasSuffix(r.URL.Path, "/processes/7"):
			_, _ = w.Write([]byte(`{"properties":{"id":7,"start_time":"` + time.Now().UTC().Format(time.RFC3339Nano) + `","is_scm_site":true}}`))
		case strings.HasSuffix(r.URL.Path, "/processes/8"):
			at := time.Now().Add(-time.Hour)
			if reads.Add(1) > 2 {
				at = time.Now().Add(time.Second)
			}
			_, _ = w.Write([]byte(`{"properties":{"id":8,"start_time":"` + at.UTC().Format(time.RFC3339Nano) + `"}}`))
		case r.URL.Path == "/operations/1":
			if polls.Add(1) < 2 {
				_, _ = w.Write([]byte(`{"status":"InProgress"}`))
				return
			}
			_, _ = w.Write([]byte(`{"status":"` + ends + `","error":{"message":"the guest did not come back"}}`))
		default:
			w.WriteHeader(http.StatusNotFound)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &restarts
}

func restarter(root string) Restarter {
	return Restarter{
		Root:   root,
		Tokens: func(_ context.Context, tenant string) (string, error) { return "token-for-" + tenant, nil },
		HTTP:   http.DefaultClient,
		Every:  time.Millisecond,
		Log:    func(string, ...any) {},
	}
}

func TestRestartsAnAppInTheTenantItsSubscriptionNames(t *testing.T) {
	srv, restarts := arm(t, http.StatusOK, "")
	target, _ := ParseTarget("/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/comet-api-test")
	var woke atomic.Int32
	r := restarter(srv.URL)
	r.Wake = func(context.Context) { woke.Add(1) }
	out, err := r.Restart(context.Background(), target)
	if err != nil || !out.Sure || !strings.HasPrefix(out.Said, "restarted comet-api-test: a new worker started ") || !strings.HasSuffix(out.Said, " after the restart was asked") || restarts.Load() != 1 {
		t.Fatalf("got %+v, %v, %d restarts", out, err, restarts.Load())
	}
	time.Sleep(10 * time.Millisecond)
	if woke.Load() == 0 {
		t.Fatal("the app was never woken")
	}
}

func TestSaysARestartIsOnlyIssuedWhenItsWorkersCannotBeSeen(t *testing.T) {
	srv, _ := arm(t, http.StatusOK, "hidden")
	target, _ := ParseTarget("/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/comet-api-test")
	out, err := restarter(srv.URL).Restart(context.Background(), target)
	if err != nil || out.Sure || !strings.Contains(out.Said, "issued the restart of comet-api-test, but its workers cannot be seen") {
		t.Fatalf("got %+v, %v", out, err)
	}
}

func TestWaitsForAMachineToComeBack(t *testing.T) {
	srv, _ := arm(t, http.StatusAccepted, "Succeeded")
	target, _ := ParseTarget("/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Compute/virtualMachines/vm1")
	out, err := restarter(srv.URL).Restart(context.Background(), target)
	if err != nil || out != (Outcome{Said: "restarted vm1", Sure: true}) {
		t.Fatalf("got %+v, %v", out, err)
	}
	srv, _ = arm(t, http.StatusAccepted, "Failed")
	if _, err := restarter(srv.URL).Restart(context.Background(), target); err == nil || !strings.Contains(err.Error(), "the guest did not come back") {
		t.Fatalf("a failed restart reads %v", err)
	}
}

func TestSaysWhyAzureRefused(t *testing.T) {
	srv, _ := arm(t, http.StatusForbidden, "")
	target, _ := ParseTarget("/subscriptions/" + sub + "/resourceGroups/rg/providers/Microsoft.Web/sites/x")
	_, err := restarter(srv.URL).Restart(context.Background(), target)
	if err == nil || !strings.Contains(err.Error(), "AuthorizationFailed") || !strings.Contains(err.Error(), "no restart here") {
		t.Fatalf("got %v", err)
	}
}

func TestProbeForJoinsTheAddressAndTheHealthPath(t *testing.T) {
	cases := []struct {
		address, health string
		want            Probe
		ok              bool
	}{
		{"https://a.azurewebsites.net/", "/health", Probe{URL: "https://a.azurewebsites.net/health", Health: true}, true},
		{"a.azurewebsites.net", "", Probe{URL: "https://a.azurewebsites.net"}, true},
		{"", "/health", Probe{}, false},
	}
	for _, c := range cases {
		got, ok := ProbeFor(c.address, c.health)
		if got != c.want || ok != c.ok {
			t.Errorf("%q %q: got %+v %v", c.address, c.health, got, ok)
		}
	}
}

// app answers each ask with the next status in turn, the last for ever after.
func app(t *testing.T, statuses ...int) string {
	var asked atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, _ *http.Request) {
		i := int(asked.Add(1)) - 1
		if i >= len(statuses) {
			i = len(statuses) - 1
		}
		w.WriteHeader(statuses[i])
	}))
	t.Cleanup(srv.Close)
	return srv.URL
}

func TestWaitsUntilTheAppAnswers(t *testing.T) {
	r := restarter("")
	got, err := r.WaitForAnswer(context.Background(), Probe{URL: app(t, 503, 502, 404)})
	if err != nil || !got.Up || got.Status != 404 {
		t.Fatalf("a bare address answering 404 is up: %+v %v", got, err)
	}
	got, err = r.WaitForAnswer(context.Background(), Probe{URL: app(t, 404, 500, 200), Health: true})
	if err != nil || !got.Up || got.Status != 200 {
		t.Fatalf("a health check passes only on 2xx: %+v %v", got, err)
	}
	got, err = r.WaitForAnswer(context.Background(), Probe{URL: app(t, 403)})
	if err != nil || got.Up || !got.Closed {
		t.Fatalf("a refusal says nothing about the app: %+v %v", got, err)
	}
	ctx, cancel := context.WithTimeout(context.Background(), 50*time.Millisecond)
	defer cancel()
	if _, err := r.WaitForAnswer(ctx, Probe{URL: app(t, 503)}); err == nil || !strings.Contains(err.Error(), "it answered 503") {
		t.Fatalf("an app that never comes back fails with its last answer: %v", err)
	}
}
