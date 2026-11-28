package main

import (
	"context"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
)

func TestRunJobStreamsAndFinishes(t *testing.T) {
	var mu sync.Mutex
	var reports []sdk.ActionReport
	collect := func(r sdk.ActionReport) {
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
	}
	state, summary := runJob(context.Background(), job{Run: "r1", Command: []string{"sh", "-c", "echo one; echo $WHO >&2; echo two"}, Env: map[string]string{"WHO": "orrery"}, TimeoutMs: 5000}, collect)
	if state != "succeeded" || summary != "exit 0" {
		t.Fatalf("expected success, got %s %s", state, summary)
	}
	var lines []string
	for _, r := range reports {
		lines = append(lines, r.Log...)
	}
	got := strings.Join(lines, ",")
	for _, want := range []string{"one", "two", "orrery"} {
		if !strings.Contains(got, want) {
			t.Fatalf("log lacks %q: %q", want, got)
		}
	}
	state, summary = runJob(context.Background(), job{Run: "r2", Command: []string{"sh", "-c", "exit 3"}, TimeoutMs: 5000}, collect)
	if state != "failed" || summary != "exit 3" {
		t.Fatalf("expected exit 3, got %s %s", state, summary)
	}
	state, summary = runJob(context.Background(), job{Run: "r3", Command: []string{"sleep", "5"}, TimeoutMs: 200}, collect)
	if state != "failed" || !strings.HasPrefix(summary, "timed out") {
		t.Fatalf("expected a timeout, got %s %s", state, summary)
	}
	if state, _ := runJob(context.Background(), job{Run: "r4", Command: []string{"/no/such/binary"}}, collect); state != "failed" {
		t.Fatalf("expected a missing binary to fail")
	}
}

func TestRunJobSaysItStillHoldsACommandThatPrintsNothing(t *testing.T) {
	was := heartbeat
	heartbeat = 300 * time.Millisecond
	defer func() { heartbeat = was }()
	var mu sync.Mutex
	var reports []sdk.ActionReport
	state, _ := runJob(context.Background(), job{Run: "quiet", Command: []string{"sh", "-c", "sleep 2.5; echo done"}, TimeoutMs: 10000}, func(r sdk.ActionReport) {
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
	})
	if state != "succeeded" {
		t.Fatalf("state %s", state)
	}
	empty := 0
	for _, r := range reports {
		if r.State == "" && len(r.Log) == 0 && r.Summary == "" {
			empty++
		}
	}
	// It printed nothing for over two seconds: the runner said it was alive at least once, with nothing in the report.
	if empty < 1 {
		t.Fatalf("no report that carries nothing among %+v", reports)
	}
}

func TestJobsLoopClaimsAndReports(t *testing.T) {
	var mu sync.Mutex
	var posted []sdk.ActionReport
	var asked []string
	finished := make(chan struct{})
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet && r.URL.Path == "/v1/ingest/runner/jobs":
			mu.Lock()
			asked = append(asked, r.URL.RawQuery)
			first := len(asked) == 1
			mu.Unlock()
			if first {
				json.NewEncoder(w).Encode(map[string]any{"jobs": []job{{Run: "abc", Action: "say", Command: []string{"echo", "hello"}, TimeoutMs: 1000}}})
				return
			}
			// The line is held open until the runner hangs up.
			<-r.Context().Done()
		case r.Method == http.MethodPost && r.URL.Path == "/v1/ingest/runner/jobs/abc/report":
			var rep sdk.ActionReport
			json.NewDecoder(r.Body).Decode(&rep)
			mu.Lock()
			posted = append(posted, rep)
			mu.Unlock()
			w.Write([]byte("{}"))
			if rep.State != "" {
				close(finished)
			}
		default:
			w.WriteHeader(404)
		}
	}))
	defer srv.Close()
	client := sdk.New(srv.URL, "tok", sdk.WithRetries(0))
	ctx, cancel := context.WithCancel(context.Background())
	defer cancel()
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		jobsLoop(ctx, client, 3, discard())
	}()
	select {
	case <-finished:
	case <-time.After(5 * time.Second):
		t.Fatal("the job never reported its outcome")
	}
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the loop did not stop when asked")
	}
	mu.Lock()
	defer mu.Unlock()
	if asked[0] != "wait=25&max=3&width=3" {
		t.Fatalf("expected a held claim for every free slot, got %q", asked[0])
	}
	if len(posted) < 2 {
		t.Fatalf("expected a log report and a final report, got %+v", posted)
	}
	last := posted[len(posted)-1]
	if last.State != "succeeded" || last.Summary != "exit 0" {
		t.Fatalf("expected a succeeded finish, got %+v", last)
	}
	if strings.Join(posted[0].Log, "") != "hello" {
		t.Fatalf("expected the output as the log, got %+v", posted[0])
	}
}

func TestRunJobTakesTheSummaryAJobGives(t *testing.T) {
	quiet := func(sdk.ActionReport) {}
	state, summary := runJob(context.Background(), job{Run: "s1", Command: []string{"sh", "-c", `echo '{"msg":"working","summary":"first"}'; echo plain; echo '{"msg":"done","summary":"app restarted in 40s"}'`}, TimeoutMs: 5000}, quiet)
	if state != "succeeded" || summary != "app restarted in 40s" {
		t.Fatalf("got %s %q", state, summary)
	}
	state, summary = runJob(context.Background(), job{Run: "s2", Command: []string{"sh", "-c", `echo '{"msg":"no","summary":"app did not come back"}'; exit 1`}, TimeoutMs: 5000}, quiet)
	if state != "failed" || summary != "app did not come back" {
		t.Fatalf("got %s %q", state, summary)
	}
}

func TestRunJobPassesMarkersThroughItsBatchesInOrder(t *testing.T) {
	var mu sync.Mutex
	var reports []sdk.ActionReport
	collect := func(r sdk.ActionReport) {
		mu.Lock()
		defer mu.Unlock()
		reports = append(reports, r)
	}
	// More lines than one batch holds, with a step and an output on each side of where it is cut.
	script := `echo "::step:: Restart"; for i in $(seq 1 60); do echo "line $i"; done; echo "::output:: url=https://example.org/a?b=c"; echo "::step:: Verify"; echo "seen"`
	if state, _ := runJob(context.Background(), job{Run: "r1", Command: []string{"sh", "-c", script}, TimeoutMs: 5000}, collect); state != "succeeded" {
		t.Fatalf("expected success, got %s", state)
	}
	var lines []string
	for _, r := range reports {
		if r.Step != "" || r.Outputs != nil {
			t.Fatalf("the runner named a step or an output itself: %+v", r)
		}
		lines = append(lines, r.Log...)
	}
	if len(lines) != 64 || lines[0] != "::step:: Restart" || lines[1] != "line 1" || lines[60] != "line 60" || lines[61] != "::output:: url=https://example.org/a?b=c" || lines[62] != "::step:: Verify" || lines[63] != "seen" {
		t.Fatalf("the lines changed on the way: %d lines, %q", len(lines), lines)
	}
}

func TestRunJobPassesWriteBackLinesThroughAsPrinted(t *testing.T) {
	var lines []string
	collect := func(r sdk.ActionReport) { lines = append(lines, r.Log...) }
	script := `echo '::refresh:: allowed_origins=["https://a.example.org","https://b.example.org"]'; echo '::refresh:: allow_credentials=true'`
	if state, _ := runJob(context.Background(), job{Run: "r1", Command: []string{"sh", "-c", script}, TimeoutMs: 5000}, collect); state != "succeeded" {
		t.Fatalf("expected success, got %s", state)
	}
	want := []string{`::refresh:: allowed_origins=["https://a.example.org","https://b.example.org"]`, "::refresh:: allow_credentials=true"}
	if len(lines) != 2 || lines[0] != want[0] || lines[1] != want[1] {
		t.Fatalf("the write-back lines changed on the way: %q", lines)
	}
}

func TestAStoppingRunnerReportsTheJobItCutShort(t *testing.T) {
	var mu sync.Mutex
	var last sdk.ActionReport
	handed := false
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch {
		case r.Method == http.MethodGet:
			mu.Lock()
			first := !handed
			handed = true
			mu.Unlock()
			if first {
				json.NewEncoder(w).Encode(map[string]any{"jobs": []job{{Run: "long", Action: "wait", Command: []string{"sleep", "30"}, TimeoutMs: 60000}}})
				return
			}
			<-r.Context().Done()
		default:
			var rep sdk.ActionReport
			json.NewDecoder(r.Body).Decode(&rep)
			mu.Lock()
			if rep.State != "" {
				last = rep
			}
			mu.Unlock()
			w.Write([]byte("{}"))
		}
	}))
	defer srv.Close()
	client := sdk.New(srv.URL, "tok", sdk.WithRetries(0))
	ctx, cancel := context.WithCancel(context.Background())
	stopped := make(chan struct{})
	go func() {
		defer close(stopped)
		jobsLoop(ctx, client, 1, discard())
	}()
	time.Sleep(300 * time.Millisecond)
	cancel()
	select {
	case <-stopped:
	case <-time.After(5 * time.Second):
		t.Fatal("the loop did not stop when asked")
	}
	mu.Lock()
	defer mu.Unlock()
	if last.State != "failed" || !strings.Contains(last.Summary, "runner stopped") {
		t.Fatalf("expected the cut job to be reported failed, got %+v", last)
	}
}
