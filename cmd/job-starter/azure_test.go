package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/containerapps"
)

const (
	sub    = "11111111-2222-3333-4444-555555555555"
	tenant = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
	jobID  = "/subscriptions/" + sub + "/resourceGroups/rg-jobs/providers/Microsoft.App/jobs/infra-apply"
)

// arm is a stand-in for Azure Resource Manager holding one job and its executions.
type arm struct {
	executions []containerapps.Execution
	started    []containerapps.Template
	stopped    []string
}

func (a *arm) serve(t *testing.T) *httptest.Server {
	return httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		send := func(v any) { _ = json.NewEncoder(w).Encode(v) }
		if r.Header.Get("Authorization") == "" {
			w.Header().Set("WWW-Authenticate", `Bearer authorization_uri="https://login.example.com/`+tenant+`"`)
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		switch {
		case r.Method == http.MethodGet && r.URL.Path == jobID:
			send(map[string]any{"properties": map[string]any{"template": map[string]any{"containers": []map[string]any{
				{"name": "main", "image": "registry.example.com/infra/runner:0", "resources": map[string]any{"cpu": 0.5, "memory": "1Gi"}, "env": []map[string]string{{"name": "STATE_KEY", "secretRef": "state-key"}, {"name": "WORKSPACE", "value": "unset"}}},
				{"name": "sidecar", "image": "registry.example.com/infra/proxy:1"},
			}}}})
		case r.Method == http.MethodPost && r.URL.Path == jobID+"/start":
			var with containerapps.Template
			body, _ := io.ReadAll(r.Body)
			if err := json.Unmarshal(body, &with); err != nil {
				t.Errorf("start body: %v", err)
			}
			a.started = append(a.started, with)
			e := containerapps.Execution{Name: "infra-apply-x7k2"}
			e.Properties.Status, e.Properties.StartTime, e.Properties.Template = "Running", at.Format(time.RFC3339), with
			a.executions = append(a.executions, e)
			send(map[string]string{"name": e.Name, "id": jobID + "/executions/" + e.Name})
		case r.Method == http.MethodGet && r.URL.Path == jobID+"/executions":
			send(map[string]any{"value": a.executions})
		case r.Method == http.MethodPost && strings.HasSuffix(r.URL.Path, "/stop"):
			a.stopped = append(a.stopped, strings.TrimSuffix(strings.TrimPrefix(r.URL.Path, jobID+"/executions/"), "/stop"))
			w.WriteHeader(http.StatusAccepted)
		default:
			t.Errorf("unexpected %s %s", r.Method, r.URL.Path)
			w.WriteHeader(http.StatusNotFound)
		}
	}))
}

func apps(t *testing.T, a *arm) (ContainerApps, Template) {
	t.Helper()
	srv := a.serve(t)
	t.Cleanup(srv.Close)
	tpl := Template{Name: "infra-apply", Images: []string{"registry.example.com/infra/"}, Job: jobID, Container: "main"}
	client := containerapps.Client{Root: srv.URL, HTTP: srv.Client(), Tokens: func(_ context.Context, in string) (string, error) {
		if in != tenant {
			t.Errorf("signed in to %s", in)
		}
		return "arm-token", nil
	}}
	return ContainerApps{Client: client, Config: Config{Platform: PlatformContainerApps, Templates: map[string]Template{"infra-apply": tpl}}, Starter: "jobs", HubURL: "https://orrery-ingest.example.com"}, tpl
}

func envOf(c containerapps.Container) map[string]containerapps.EnvVar {
	out := map[string]containerapps.EnvVar{}
	for _, v := range c.Env {
		out[v.Name] = v
	}
	return out
}

func TestContainerAppsStartsOneExecutionWithTheRunOnTheJobsOwnTemplate(t *testing.T) {
	a := &arm{}
	p, tpl := apps(t, a)
	ctx := context.Background()
	ref, err := p.Start(ctx, tpl, asked())
	if err != nil {
		t.Fatal(err)
	}
	if ref != jobID+"/executions/infra-apply-x7k2" {
		t.Fatalf("ref %s", ref)
	}
	if len(a.started) != 1 || len(a.started[0].Containers) != 2 {
		t.Fatalf("started %+v", a.started)
	}
	main, sidecar := a.started[0].Containers[0], a.started[0].Containers[1]
	// The other container, and the job's own resources and secrets, stand.
	if sidecar.Image != "registry.example.com/infra/proxy:1" || !strings.Contains(string(main.Resources), "1Gi") {
		t.Fatalf("the job's template did not stand: %+v", a.started[0])
	}
	if main.Name != "main" || main.Image != "registry.example.com/infra/runner:1.4.0" || strings.Join(main.Command, " ") != "infra apply" || strings.Join(main.Args, " ") != "--workspace network" {
		t.Fatalf("container %+v", main)
	}
	env := envOf(main)
	if env["STATE_KEY"].SecretRef != "state-key" {
		t.Fatalf("the job's secret was lost: %+v", env["STATE_KEY"])
	}
	for name, value := range map[string]string{"WORKSPACE": "network", "ASKED_BY": "a user", EnvURL: "https://orrery-ingest.example.com", EnvRun: "9F2c41aa07b3", EnvAction: "infra_apply", EnvTry: "2", EnvStarter: "jobs", EnvToken: "orr_run_s3cret"} {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
	// Asked again for the same try, as a starter that restarted would: no second execution.
	if again, err := p.Start(ctx, tpl, asked()); err != nil || again != ref || len(a.started) != 1 {
		t.Fatalf("again %s %v, started %d", again, err, len(a.started))
	}
}

func TestContainerAppsSeesTheExecutionsItStartedByTheRunTheyCarry(t *testing.T) {
	a := &arm{}
	p, tpl := apps(t, a)
	ctx := context.Background()
	if _, err := p.Start(ctx, tpl, asked()); err != nil {
		t.Fatal(err)
	}
	// An execution the job's own schedule started, and one of another starter: neither is this starter's.
	scheduled := containerapps.Execution{Name: "infra-apply-cron"}
	scheduled.Properties.Status = "Running"
	foreign := containerapps.Execution{Name: "infra-apply-other"}
	foreign.Properties.Status = "Running"
	foreign.Properties.Template.Containers = []containerapps.Container{{Name: "main", Env: []containerapps.EnvVar{{Name: EnvRun, Value: "zzz"}, {Name: EnvTry, Value: "1"}, {Name: EnvStarter, Value: "another"}}}}
	a.executions = append(a.executions, scheduled, foreign)
	seen, err := p.Seen(ctx)
	if err != nil {
		t.Fatal(err)
	}
	if len(seen) != 1 || seen[0].Run != "9F2c41aa07b3" || seen[0].Try != 2 || seen[0].Phase != Active || !seen[0].Started || seen[0].Template != "infra-apply" {
		t.Fatalf("seen %+v", seen)
	}
	for status, want := range map[string]Phase{"Succeeded": Succeeded, "Failed": Failed, "Stopped": Failed, "Degraded": Failed, "Processing": Active, "Unknown": Active} {
		a.executions[0].Properties.Status = status
		a.executions[0].Properties.EndTime = at.Add(time.Minute).Format(time.RFC3339)
		seen, _ := p.Seen(ctx)
		if seen[0].Phase != want {
			t.Errorf("%s read as %v, want %v", status, seen[0].Phase, want)
		}
		if want == Failed && seen[0].Why != "the execution ended "+strings.ToLower(status) {
			t.Errorf("%s: why %q", status, seen[0].Why)
		}
	}
	if err := p.Stop(ctx, seen[0]); err != nil {
		t.Fatal(err)
	}
	if len(a.stopped) != 1 || a.stopped[0] != "infra-apply-x7k2" {
		t.Fatalf("stopped %+v", a.stopped)
	}
}
