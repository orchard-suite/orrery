package main

import (
	"context"
	"errors"
	"io"
	"log/slog"
	"strings"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
)

// fakeHub is the hub as a starter sees it: the runs it holds, and what it was told.
type fakeHub struct {
	runs    []Run
	asked   [][]string
	reports []told
	refuse  map[string]int
}

type told struct {
	run string
	r   sdk.ActionReport
}

func (h *fakeHub) Claim(context.Context, int) ([]Job, error) { return nil, nil }

func (h *fakeHub) Runs(_ context.Context, seen []string) ([]Run, error) {
	h.asked = append(h.asked, seen)
	named := map[string]bool{}
	for _, id := range seen {
		named[id] = true
	}
	var out []Run
	for _, r := range h.runs {
		if r.State == "running" || named[r.Run] {
			out = append(out, r)
		}
	}
	return out, nil
}

func (h *fakeHub) Report(_ context.Context, run string, r sdk.ActionReport) error {
	if status, ok := h.refuse[run]; ok {
		return &sdk.APIError{Status: status, Message: "already ended"}
	}
	h.reports = append(h.reports, told{run, r})
	// The hub ends the run as its starter says.
	for i := range h.runs {
		if h.runs[i].Run == run && r.State != "" {
			h.runs[i].State = r.State
		}
	}
	return nil
}

// fakePlatform is a platform that shows what a test puts on it.
type fakePlatform struct {
	jobs    []Seen
	started []Job
	stopped []string
	err     error
	failing error
}

func (p *fakePlatform) Start(_ context.Context, t Template, j Job) (string, error) {
	if p.failing != nil {
		return "", p.failing
	}
	p.started = append(p.started, j)
	ref := t.Namespace + "/" + jobName(j.Run, j.Try)
	p.jobs = append(p.jobs, Seen{Run: j.Run, Try: j.Try, Ref: ref, Template: t.Name, Created: time.Now()})
	return ref, nil
}

func (p *fakePlatform) Seen(context.Context) ([]Seen, error) { return p.jobs, p.err }

func (p *fakePlatform) Stop(_ context.Context, s Seen) error {
	p.stopped = append(p.stopped, s.Ref)
	return nil
}

var at = time.Date(2030, 1, 2, 12, 0, 0, 0, time.UTC)

func ago(d time.Duration) string { return at.Add(-d).Format(time.RFC3339Nano) }

func newStarter(h *fakeHub, p *fakePlatform) *Starter {
	cfg := Config{Platform: PlatformKubernetes, StartWithin: 15 * time.Minute, Templates: map[string]Template{"infra-apply": {Name: "infra-apply", Images: []string{"registry.example.com/infra/"}, Namespace: "infra-jobs", Manifest: "job.yaml"}}}
	return &Starter{Hub: h, Platform: p, Config: cfg, Log: slog.New(slog.NewTextHandler(io.Discard, nil)), Now: func() time.Time { return at }}
}

func job(run string) Job {
	return Job{Run: run, Action: "infra_apply", Try: 1, Template: "infra-apply", Image: "registry.example.com/infra/runner:1.4.0", Token: "orr_run_secret", CeilingMs: (7 * 24 * time.Hour).Milliseconds()}
}

func TestTakeStartsAJobFromTheTemplateAndSaysSo(t *testing.T) {
	h, p := &fakeHub{}, &fakePlatform{}
	s := newStarter(h, p)
	s.Take(context.Background(), job("a1"))
	if len(p.started) != 1 || p.started[0].Run != "a1" {
		t.Fatalf("started %+v", p.started)
	}
	if len(h.reports) != 1 || h.reports[0].r.State != "" || h.reports[0].r.Label != "job infra-jobs/orrery-a1-1" {
		t.Fatalf("reports %+v", h.reports)
	}
	if got := h.reports[0].r.Log[0]; got != "started job infra-jobs/orrery-a1-1 from template infra-apply, image registry.example.com/infra/runner:1.4.0" {
		t.Fatalf("line %q", got)
	}
	// The credential is never said to the hub or a log.
	for _, line := range h.reports[0].r.Log {
		if strings.Contains(line, "orr_run_secret") {
			t.Fatalf("the credential is in a log line: %q", line)
		}
	}
}

func TestTakeRefusesWhatTheEstateDidNotAllowAndStartsNothing(t *testing.T) {
	for name, tc := range map[string]struct {
		change func(*Job)
		want   string
	}{
		"a template the starter does not have": {func(j *Job) { j.Template = "anything" }, `the starter has no job template "anything"`},
		"an image the template does not allow": {func(j *Job) { j.Image = "docker.io/evil/miner:latest" }, `template "infra-apply" does not allow the image "docker.io/evil/miner:latest"`},
		"a sibling of the allowed prefix":      {func(j *Job) { j.Image = "registry.example.com/infra-evil/runner:1" }, `does not allow the image`},
	} {
		t.Run(name, func(t *testing.T) {
			h, p := &fakeHub{}, &fakePlatform{}
			j := job("a1")
			tc.change(&j)
			newStarter(h, p).Take(context.Background(), j)
			if len(p.started) != 0 {
				t.Fatalf("started %+v", p.started)
			}
			if len(h.reports) != 1 || h.reports[0].r.State != "failed" || !strings.Contains(h.reports[0].r.Summary, tc.want) {
				t.Fatalf("reports %+v", h.reports)
			}
			// Asking again changes nothing, so the failure is final.
			if h.reports[0].r.Log[0] != "::final::" {
				t.Fatalf("not final: %+v", h.reports[0].r.Log)
			}
		})
	}
}

func TestTakeFailsTheRunWhenThePlatformRefusesTheJob(t *testing.T) {
	h, p := &fakeHub{}, &fakePlatform{failing: errors.New("jobs.batch is forbidden")}
	newStarter(h, p).Take(context.Background(), job("a1"))
	if len(h.reports) != 1 || h.reports[0].r.State != "failed" || h.reports[0].r.Summary != "its job could not be started: jobs.batch is forbidden" {
		t.Fatalf("reports %+v", h.reports)
	}
	// It may be tried again: the platform may take it next time.
	if len(h.reports[0].r.Log) != 0 {
		t.Fatalf("log %+v", h.reports[0].r.Log)
	}
}

func TestPassSaysARunningRunIsAliveWhileItsJobIs(t *testing.T) {
	h := &fakeHub{runs: []Run{{Run: "a1", Try: 1, State: "running", StartedAt: ago(3 * 24 * time.Hour), CeilingMs: (7 * 24 * time.Hour).Milliseconds()}}}
	p := &fakePlatform{jobs: []Seen{{Run: "a1", Try: 1, Ref: "infra-jobs/orrery-a1-1", Started: true, Created: at.Add(-3 * 24 * time.Hour)}}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	// One report that carries nothing: the run is alive, three days in.
	if len(h.reports) != 1 || h.reports[0].run != "a1" || h.reports[0].r.State != "" || len(h.reports[0].r.Log) != 0 || h.reports[0].r.Summary != "" {
		t.Fatalf("reports %+v", h.reports)
	}
	if len(p.stopped) != 0 {
		t.Fatalf("stopped %+v", p.stopped)
	}
}

func TestPassReportsHowAJobEndedEvenWhenTheJobSaidNothing(t *testing.T) {
	h := &fakeHub{runs: []Run{
		{Run: "ok", Try: 1, State: "running", StartedAt: ago(time.Hour)},
		{Run: "bad", Try: 1, State: "running", StartedAt: ago(time.Hour)},
		{Run: "said", Try: 1, State: "running", StartedAt: ago(time.Hour), Summary: "plan failed: 2 errors"},
	}}
	p := &fakePlatform{jobs: []Seen{
		{Run: "ok", Try: 1, Ref: "ns/orrery-ok-1", Phase: Succeeded, Started: true, Ended: at.Add(-time.Minute)},
		{Run: "bad", Try: 1, Ref: "ns/orrery-bad-1", Phase: Failed, Started: true, Why: "exit 137: OOMKilled", Ended: at.Add(-time.Minute)},
		{Run: "said", Try: 1, Ref: "ns/orrery-said-1", Phase: Failed, Started: true, Why: "exit 1: Error", Ended: at.Add(-time.Minute)},
	}}
	s := newStarter(h, p)
	if err := s.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := map[string]sdk.ActionReport{}
	for _, r := range h.reports {
		got[r.run] = r.r
	}
	if got["ok"].State != "succeeded" || got["ok"].Summary != "" {
		t.Fatalf("ok %+v", got["ok"])
	}
	if got["bad"].State != "failed" || got["bad"].Summary != "exit 137: OOMKilled" || got["bad"].Log[0] != "job ns/orrery-bad-1 ended: failed: exit 137: OOMKilled" {
		t.Fatalf("bad %+v", got["bad"])
	}
	// What the job said of itself stands; the platform's reason is in the log.
	if got["said"].Summary != "plan failed: 2 errors" || got["said"].Log[0] != "job ns/orrery-said-1 ended: failed: exit 1: Error" {
		t.Fatalf("said %+v", got["said"])
	}
	// The next pass says nothing more of runs that ended.
	h.reports = nil
	if err := s.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.reports) != 0 {
		t.Fatalf("reports %+v", h.reports)
	}
}

func TestPassEndsARunWhoseJobIsGoneOnceItHadTimeToShow(t *testing.T) {
	h := &fakeHub{runs: []Run{
		{Run: "gone", Try: 1, State: "running", StartedAt: ago(10 * time.Minute)},
		{Run: "new", Try: 1, State: "running", StartedAt: ago(30 * time.Second)},
		{Run: "starting", Try: 1, State: "running", StartedAt: ago(10 * time.Minute)},
	}}
	p := &fakePlatform{}
	s := newStarter(h, p)
	s.mark("starting", true)
	if err := s.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.reports) != 1 || h.reports[0].run != "gone" || h.reports[0].r.State != "unknown" || !strings.HasPrefix(h.reports[0].r.Summary, "its job is gone") {
		t.Fatalf("reports %+v", h.reports)
	}
}

func TestPassJudgesNothingWhenThePlatformCannotBeRead(t *testing.T) {
	h := &fakeHub{runs: []Run{{Run: "a1", Try: 1, State: "running", StartedAt: ago(time.Hour)}}}
	p := &fakePlatform{err: errors.New("the API server is away")}
	if err := newStarter(h, p).Pass(context.Background()); err == nil {
		t.Fatal("no error")
	}
	// Not one run is called gone because the platform did not answer.
	if len(h.reports) != 0 || len(h.asked) != 0 {
		t.Fatalf("reports %+v asked %+v", h.reports, h.asked)
	}
}

func TestPassStopsTheJobOfARunThatWasCancelled(t *testing.T) {
	h := &fakeHub{runs: []Run{{Run: "a1", Try: 1, State: "cancelled", StartedAt: ago(time.Hour)}}}
	p := &fakePlatform{jobs: []Seen{{Run: "a1", Try: 1, Ref: "ns/orrery-a1-1", Started: true}}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(p.stopped) != 1 || p.stopped[0] != "ns/orrery-a1-1" || len(h.reports) != 0 {
		t.Fatalf("stopped %+v reports %+v", p.stopped, h.reports)
	}
}

func TestPassStopsAJobPastItsCeilingAndOneThatNeverStarts(t *testing.T) {
	h := &fakeHub{runs: []Run{
		{Run: "long", Try: 1, State: "running", StartedAt: ago(13 * time.Hour), CeilingMs: (12 * time.Hour).Milliseconds()},
		{Run: "stuck", Try: 1, State: "running", StartedAt: ago(20 * time.Minute), CeilingMs: (12 * time.Hour).Milliseconds()},
		{Run: "pulling", Try: 1, State: "running", StartedAt: ago(5 * time.Minute), CeilingMs: (12 * time.Hour).Milliseconds()},
	}}
	p := &fakePlatform{jobs: []Seen{
		{Run: "long", Try: 1, Ref: "ns/orrery-long-1", Started: true, Created: at.Add(-13 * time.Hour)},
		{Run: "stuck", Try: 1, Ref: "ns/orrery-stuck-1", Why: "ImagePullBackOff: manifest unknown", Created: at.Add(-20 * time.Minute)},
		{Run: "pulling", Try: 1, Ref: "ns/orrery-pulling-1", Why: "ContainerCreating", Created: at.Add(-5 * time.Minute)},
	}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	got := map[string]sdk.ActionReport{}
	for _, r := range h.reports {
		got[r.run] = r.r
	}
	if got["long"].State != "failed" || got["long"].Summary != "stopped: it ran past its ceiling of 12h0m0s" || got["long"].Log[0] != "::final::" {
		t.Fatalf("long %+v", got["long"])
	}
	if got["stuck"].State != "failed" || got["stuck"].Summary != "its container did not start within 15m0s: ImagePullBackOff: manifest unknown" {
		t.Fatalf("stuck %+v", got["stuck"])
	}
	// One still within its time to start is alive.
	if got["pulling"].State != "" {
		t.Fatalf("pulling %+v", got["pulling"])
	}
	if strings.Join(p.stopped, ",") != "ns/orrery-long-1,ns/orrery-stuck-1" {
		t.Fatalf("stopped %+v", p.stopped)
	}
}

func TestPassSettlesARunTheHubGaveUpOnWhileTheStarterWasAway(t *testing.T) {
	h := &fakeHub{runs: []Run{
		{Run: "alive", Try: 1, State: "unknown", StartedAt: ago(5 * time.Hour), CeilingMs: (12 * time.Hour).Milliseconds()},
		{Run: "done", Try: 1, State: "unknown", StartedAt: ago(5 * time.Hour), CeilingMs: (12 * time.Hour).Milliseconds()},
	}}
	p := &fakePlatform{jobs: []Seen{
		{Run: "alive", Try: 1, Ref: "ns/orrery-alive-1", Started: true},
		{Run: "done", Try: 1, Ref: "ns/orrery-done-1", Phase: Succeeded, Started: true, Ended: at.Add(-time.Hour)},
	}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The job still going is left to go on, and never stopped for the hub's silence; the one that ended is settled.
	if len(p.stopped) != 0 {
		t.Fatalf("stopped %+v", p.stopped)
	}
	if len(h.reports) != 1 || h.reports[0].run != "done" || h.reports[0].r.State != "succeeded" {
		t.Fatalf("reports %+v", h.reports)
	}
}

func TestPassLeavesAnEarlierTrysJobAndFollowsTheCurrentOne(t *testing.T) {
	h := &fakeHub{runs: []Run{{Run: "a1", Try: 2, State: "running", StartedAt: ago(10 * time.Minute)}}}
	p := &fakePlatform{jobs: []Seen{
		{Run: "a1", Try: 1, Ref: "ns/orrery-a1-1", Phase: Failed, Started: true, Why: "exit 1", Ended: at.Add(-20 * time.Minute)},
		{Run: "a1", Try: 2, Ref: "ns/orrery-a1-2", Started: true},
	}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	// The first try's failure was told when it happened: only the second try is spoken for now.
	if len(h.reports) != 1 || h.reports[0].r.State != "" {
		t.Fatalf("reports %+v", h.reports)
	}
}

func TestPassLeavesAloneAJobWhoseRunTheHubDoesNotSayIsItsOwn(t *testing.T) {
	h := &fakeHub{}
	p := &fakePlatform{jobs: []Seen{{Run: "foreign", Try: 1, Ref: "ns/orrery-foreign-1", Started: true}}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(p.stopped) != 0 || len(h.reports) != 0 {
		t.Fatalf("stopped %+v reports %+v", p.stopped, h.reports)
	}
}

func TestPassNoLongerAsksAboutJobsThatEndedLongAgo(t *testing.T) {
	h := &fakeHub{}
	p := &fakePlatform{jobs: []Seen{
		{Run: "old", Try: 1, Ref: "ns/orrery-old-1", Phase: Succeeded, Ended: at.Add(-25 * time.Hour)},
		{Run: "recent", Try: 1, Ref: "ns/orrery-recent-1", Phase: Succeeded, Ended: at.Add(-23 * time.Hour)},
	}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.asked) != 1 || strings.Join(h.asked[0], ",") != "recent" {
		t.Fatalf("asked %+v", h.asked)
	}
}

func TestAStarterThatRestartsCarriesOnFromTheHubAndThePlatformAlone(t *testing.T) {
	h, p := &fakeHub{}, &fakePlatform{}
	first := newStarter(h, p)
	first.Take(context.Background(), job("a1"))
	h.runs = []Run{{Run: "a1", Try: 1, State: "running", StartedAt: ago(time.Hour), CeilingMs: (7 * 24 * time.Hour).Milliseconds()}}
	h.reports = nil
	// A new process, with nothing kept from the first: it finds the job by the run it carries.
	p.jobs[0].Started = true
	second := newStarter(h, p)
	if err := second.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.reports) != 1 || h.reports[0].run != "a1" || h.reports[0].r.State != "" {
		t.Fatalf("reports %+v", h.reports)
	}
	p.jobs[0].Phase, p.jobs[0].Ended = Succeeded, at
	h.reports = nil
	if err := second.Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
	if len(h.reports) != 1 || h.reports[0].r.State != "succeeded" {
		t.Fatalf("reports %+v", h.reports)
	}
}

func TestAReportOnARunThatEndedMeanwhileIsNoFailure(t *testing.T) {
	h := &fakeHub{runs: []Run{{Run: "a1", Try: 1, State: "running", StartedAt: ago(time.Hour)}}, refuse: map[string]int{"a1": 409}}
	p := &fakePlatform{jobs: []Seen{{Run: "a1", Try: 1, Ref: "ns/orrery-a1-1", Phase: Succeeded, Ended: at}}}
	if err := newStarter(h, p).Pass(context.Background()); err != nil {
		t.Fatal(err)
	}
}

func TestConfigHoldsATemplateToItsPlatformAndItsImages(t *testing.T) {
	good := `
platform: kubernetes
start_within: 10m
templates:
  infra-apply:
    images: ["registry.example.com/infra/", "registry.example.com/tools/plan:1.2.3"]
    namespace: infra-jobs
    manifest: infra-apply.yaml
`
	c, err := ParseConfig([]byte(good), "/etc/job-starter")
	if err != nil {
		t.Fatal(err)
	}
	if c.StartWithin != 10*time.Minute || c.Templates["infra-apply"].Name != "infra-apply" {
		t.Fatalf("config %+v", c)
	}
	tpl := c.Templates["infra-apply"]
	for image, want := range map[string]bool{
		"registry.example.com/infra/runner:1.4.0":          true,
		"registry.example.com/infra/runner@sha256:abcd":    true,
		"registry.example.com/tools/plan:1.2.3":            true,
		"registry.example.com/tools/plan:1.2.3-evil":       false,
		"registry.example.com/infra/":                      false,
		"registry.example.com/infra-evil/runner:1":         false,
		"docker.io/library/alpine":                         false,
		"":                                                 false,
		"registry.example.com/infra/runner:1 --privileged": false,
	} {
		if got := tpl.Allows(image); got != want {
			t.Errorf("Allows(%q) = %v, want %v", image, got, want)
		}
	}
	for name, bad := range map[string]string{
		"no platform":            "templates: {a: {images: [x/], namespace: n, manifest: m.yaml}}",
		"no templates":           "platform: kubernetes",
		"no images":              "platform: kubernetes\ntemplates: {a: {namespace: n, manifest: m.yaml}}",
		"a wildcard image":       "platform: kubernetes\ntemplates: {a: {images: ['*'], namespace: n, manifest: m.yaml}}",
		"no namespace":           "platform: kubernetes\ntemplates: {a: {images: [x/], manifest: m.yaml}}",
		"a manifest elsewhere":   "platform: kubernetes\ntemplates: {a: {images: [x/], namespace: n, manifest: ../../etc/passwd}}",
		"an absolute manifest":   "platform: kubernetes\ntemplates: {a: {images: [x/], namespace: n, manifest: /etc/passwd}}",
		"a job on kubernetes":    "platform: kubernetes\ntemplates: {a: {images: [x/], namespace: n, manifest: m.yaml, job: /subscriptions/x}}",
		"not a job on azure":     "platform: azure-container-apps\ntemplates: {a: {images: [x/], job: /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.Web/sites/app}}",
		"a namespace on azure":   "platform: azure-container-apps\ntemplates: {a: {images: [x/], namespace: n, job: /subscriptions/00000000-0000-0000-0000-000000000000/resourceGroups/rg/providers/Microsoft.App/jobs/j}}",
		"a bad name":             "platform: kubernetes\ntemplates: {'A B': {images: [x/], namespace: n, manifest: m.yaml}}",
		"a start time of nought": "platform: kubernetes\nstart_within: 0s\ntemplates: {a: {images: [x/], namespace: n, manifest: m.yaml}}",
	} {
		if _, err := ParseConfig([]byte(bad), "/etc/job-starter"); err == nil {
			t.Errorf("%s: taken", name)
		}
	}
}
