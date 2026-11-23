package main

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"net/http"
	"net/http/httptest"
	"net/url"
	"strconv"
	"strings"
	"testing"
	"time"
)

// The moment every test asks at.
var at = time.Date(2026, 3, 10, 12, 0, 0, 0, time.UTC)

// asked is one request a stand-in backend got.
type asked struct {
	Path   string
	Query  url.Values
	Header http.Header
}

// store is a stand-in for Loki or Prometheus that answers status and body,
// and keeps what it was asked.
func store(t *testing.T, status int, body string) (*httptest.Server, *[]asked) {
	var got []asked
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method != http.MethodGet {
			t.Errorf("asked with %s: it only reads", r.Method)
		}
		got = append(got, asked{Path: r.URL.Path, Query: r.URL.Query(), Header: r.Header})
		w.WriteHeader(status)
		_, _ = w.Write([]byte(body))
	}))
	t.Cleanup(srv.Close)
	return srv, &got
}

// ask runs the command and gives its exit code, what it printed, and what it
// said went wrong.
func ask(env settings, args ...string) (int, string, string) {
	var out, errOut bytes.Buffer
	code := run(context.Background(), args, env, &out, &errOut, func() time.Time { return at })
	return code, out.String(), errOut.String()
}

// streams is a Loki answer of log streams.
func streams(t *testing.T, each ...map[string]any) string {
	return answer(t, "streams", each)
}

func answer(t *testing.T, kind string, result any) string {
	b, err := json.Marshal(map[string]any{"status": "success", "data": map[string]any{"resultType": kind, "result": result}})
	if err != nil {
		t.Fatal(err)
	}
	return string(b)
}

func nanos(when time.Time) string { return strconv.FormatInt(when.UnixNano(), 10) }

func TestLogsAsksLokiAndPrintsTheNewestFirst(t *testing.T) {
	srv, got := store(t, 200, streams(t,
		map[string]any{
			"stream": map[string]string{"namespace": "shop", "pod": "api-1", "container": "api", "app": "shop-api", "level": "error", "node": "n1", "filename": "/var/log/x"},
			"values": [][2]string{{nanos(at.Add(-time.Minute)), "it broke"}, {nanos(at.Add(-3 * time.Minute)), "first\nsecond"}},
		},
		map[string]any{
			"stream": map[string]string{"namespace": "shop", "detected_level": "info"},
			"values": [][2]string{{nanos(at.Add(-2 * time.Minute)), "it started"}},
		},
	))
	code, out, errOut := ask(settings{LokiURL: srv.URL + "/", LokiToken: "secret", LokiTenant: "acme"}, "logs", "--query", `{namespace="shop"}`, "--since", "2h", "--limit", "50")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := `2026-03-10T11:59:00.000Z {namespace=shop pod=api-1 container=api app=shop-api level=error} it broke
2026-03-10T11:58:00.000Z {namespace=shop level=info} it started
2026-03-10T11:57:00.000Z {namespace=shop pod=api-1 container=api app=shop-api level=error} first\nsecond
3 log lines from the last 2h, newest first.
`
	if out != want {
		t.Fatalf("printed\n%s\nwant\n%s", out, want)
	}
	if len(*got) != 1 {
		t.Fatalf("%d requests", len(*got))
	}
	r := (*got)[0]
	if r.Path != "/loki/api/v1/query_range" {
		t.Fatalf("path %q", r.Path)
	}
	for name, want := range map[string]string{"query": `{namespace="shop"}`, "limit": "50", "direction": "backward", "start": nanos(at.Add(-2 * time.Hour)), "end": nanos(at)} {
		if r.Query.Get(name) != want {
			t.Errorf("%s = %q, want %q", name, r.Query.Get(name), want)
		}
	}
	if r.Header.Get("Authorization") != "Bearer secret" || r.Header.Get("X-Scope-OrgID") != "acme" {
		t.Fatalf("headers %v", r.Header)
	}
}

func TestLogsSendsNoTokenOrTenantWhenNoneIsSet(t *testing.T) {
	srv, got := store(t, 200, streams(t))
	code, out, _ := ask(settings{LokiURL: srv.URL}, "logs", "--query", "{app=\"x\"}", "--since", "", "--limit", "")
	if code != 0 || out != "0 log lines from the last 1h, newest first.\n" {
		t.Fatalf("exit %d, printed %q", code, out)
	}
	r := (*got)[0]
	if _, ok := r.Header["Authorization"]; ok {
		t.Fatal("a bearer was sent")
	}
	if _, ok := r.Header["X-Scope-Orgid"]; ok {
		t.Fatal("a tenant was sent")
	}
	// Nothing said is an hour back and 200 lines.
	if r.Query.Get("limit") != "200" || r.Query.Get("start") != nanos(at.Add(-time.Hour)) {
		t.Fatalf("asked %v", r.Query)
	}
}

func TestLogsHoldsToItsCaps(t *testing.T) {
	long := strings.Repeat("é", 2000)
	srv, got := store(t, 200, streams(t, map[string]any{
		"stream": map[string]string{"app": "x"},
		"values": [][2]string{{nanos(at), long}},
	}))
	code, out, _ := ask(settings{LokiURL: srv.URL}, "logs", "--query", "{app=\"x\"}", "--since", "30d", "--limit", "5000")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	r := (*got)[0]
	if r.Query.Get("limit") != "1000" || r.Query.Get("start") != nanos(at.Add(-7*24*time.Hour)) {
		t.Fatalf("asked %v", r.Query)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	// The line is cut at 2000 bytes on a whole character, and says how long it was.
	if !strings.HasSuffix(lines[0], strings.Repeat("é", 1000)+" ... (cut, 4000 bytes in all)") {
		t.Fatalf("line ends %q", lines[0][len(lines[0])-60:])
	}
	if lines[1] != "1 log line from the last 7d (the most --since reads), newest first." {
		t.Fatalf("count line %q", lines[1])
	}
}

func TestLogsStopsPrintingWhenTheAnswerIsFull(t *testing.T) {
	values := make([][2]string, 100)
	for i := range values {
		values[i] = [2]string{nanos(at.Add(-time.Duration(i) * time.Second)), strings.Repeat("x", 1500)}
	}
	srv, _ := store(t, 200, streams(t, map[string]any{"stream": map[string]string{"app": "x"}, "values": values}))
	code, out, _ := ask(settings{LokiURL: srv.URL}, "logs", "--query", "{app=\"x\"}")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	if len(out) > 61*1024 {
		t.Fatalf("printed %d bytes", len(out))
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	last := lines[len(lines)-1]
	if want := fmt.Sprintf("Output cut at 60 KB: %d of 100 log lines shown, from the last 1h. Narrow the query, shorten --since, or lower --limit.", len(lines)-1); last != want {
		t.Fatalf("last line %q, want %q", last, want)
	}
}

func TestLogsSaysWhenTheLimitWasReached(t *testing.T) {
	srv, _ := store(t, 200, streams(t, map[string]any{
		"stream": map[string]string{"app": "x"},
		"values": [][2]string{{nanos(at), "a"}, {nanos(at.Add(-time.Second)), "b"}},
	}))
	_, out, _ := ask(settings{LokiURL: srv.URL}, "logs", "--query", "{app=\"x\"}", "--limit", "2")
	if !strings.HasSuffix(out, "2 log lines from the last 1h, newest first. That is the limit, so older lines may exist.\n") {
		t.Fatalf("printed %q", out)
	}
}

func TestMetricsAsksForTheValueNow(t *testing.T) {
	srv, got := store(t, 200, answer(t, "vector", []map[string]any{
		{"metric": map[string]string{"__name__": "up", "job": "shop", "instance": "a:80"}, "value": []any{at.Unix(), "1"}},
		{"metric": map[string]string{"__name__": "up", "job": "desk", "instance": "b:80"}, "value": []any{at.Unix(), "0"}},
	}))
	// An empty --since asks for the value now, whatever --step says.
	code, out, errOut := ask(settings{PrometheusURL: srv.URL, PrometheusToken: "secret", LokiTenant: "acme"}, "metrics", "--query", "up", "--since", "", "--step", "1m")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	want := `up{instance="a:80",job="shop"} 1
up{instance="b:80",job="desk"} 0
2 series, for now, 2026-03-10T12:00:00Z.
`
	if out != want {
		t.Fatalf("printed\n%s\nwant\n%s", out, want)
	}
	r := (*got)[0]
	if r.Path != "/api/v1/query" || r.Query.Get("query") != "up" || r.Query.Get("time") != strconv.FormatInt(at.Unix(), 10) {
		t.Fatalf("asked %s %v", r.Path, r.Query)
	}
	if r.Header.Get("Authorization") != "Bearer secret" {
		t.Fatalf("headers %v", r.Header)
	}
	// The tenant is Loki's alone.
	if _, ok := r.Header["X-Scope-Orgid"]; ok {
		t.Fatal("a tenant was sent to Prometheus")
	}
}

func TestMetricsAsksForARangeAndSamplesIt(t *testing.T) {
	values := make([][]any, 61)
	for i := range values {
		values[i] = []any{at.Add(time.Duration(i-60) * time.Minute).Unix(), strconv.Itoa(i)}
	}
	srv, got := store(t, 200, answer(t, "matrix", []map[string]any{
		{"metric": map[string]string{"job": "shop"}, "values": values},
		{"metric": map[string]string{"job": "desk"}, "values": [][]any{{at.Unix(), "NaN"}}},
	}))
	code, out, errOut := ask(settings{PrometheusURL: srv.URL}, "metrics", "--query", "rate(x[5m])", "--since", "1h", "--step", "")
	if code != 0 {
		t.Fatalf("exit %d: %s", code, errOut)
	}
	r := (*got)[0]
	if r.Path != "/api/v1/query_range" || r.Query.Get("step") != "60" || r.Query.Get("start") != strconv.FormatInt(at.Add(-time.Hour).Unix(), 10) || r.Query.Get("end") != strconv.FormatInt(at.Unix(), 10) {
		t.Fatalf("asked %s %v", r.Path, r.Query)
	}
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(lines) != 5 {
		t.Fatalf("printed\n%s", out)
	}
	if lines[0] != `{job="desk"} min=none max=none last=NaN points=1` || lines[1] != "  2026-03-10T12:00:00Z=NaN" {
		t.Fatalf("first series\n%s\n%s", lines[0], lines[1])
	}
	if lines[2] != `{job="shop"} min=0 max=60 last=60 points=61` {
		t.Fatalf("second series %q", lines[2])
	}
	points := strings.Fields(lines[3])
	if len(points) != 30 || points[0] != "2026-03-10T11:00:00Z=0" || points[29] != "2026-03-10T12:00:00Z=60" {
		t.Fatalf("points %v", points)
	}
	if lines[4] != "2 series, for the last 1h, a point every 1m." {
		t.Fatalf("count line %q", lines[4])
	}
}

func TestMetricsWidensAStepThatWouldGiveTooManyPoints(t *testing.T) {
	srv, got := store(t, 200, answer(t, "matrix", []any{}))
	code, out, _ := ask(settings{PrometheusURL: srv.URL}, "metrics", "--query", "up", "--since", "2w", "--step", "15s")
	if code != 0 {
		t.Fatalf("exit %d", code)
	}
	r := (*got)[0]
	// Seven days at most, in no more than a thousand points.
	if r.Query.Get("start") != strconv.FormatInt(at.Add(-7*24*time.Hour).Unix(), 10) || r.Query.Get("step") != "605" {
		t.Fatalf("asked %v", r.Query)
	}
	if out != "0 series, for the last 7d (the most --since reads), a point every 10m5s.\n" {
		t.Fatalf("printed %q", out)
	}
}

func TestMetricsStopsPrintingWhenTheAnswerIsFull(t *testing.T) {
	found := make([]map[string]any, 2000)
	for i := range found {
		found[i] = map[string]any{"metric": map[string]string{"__name__": "up", "pod": fmt.Sprintf("pod-%04d-%s", i, strings.Repeat("x", 40))}, "value": []any{at.Unix(), "1"}}
	}
	srv, _ := store(t, 200, answer(t, "vector", found))
	_, out, _ := ask(settings{PrometheusURL: srv.URL}, "metrics", "--query", "up")
	lines := strings.Split(strings.TrimSpace(out), "\n")
	if len(out) > 61*1024 || !strings.HasPrefix(lines[len(lines)-1], fmt.Sprintf("Output cut at 60 KB: %d of 2000 series shown, for now, ", len(lines)-1)) {
		t.Fatalf("%d bytes, last line %q", len(out), lines[len(lines)-1])
	}
}

func TestABackendErrorIsSaidAndFails(t *testing.T) {
	loki, _ := store(t, 400, "parse error at line 1, col 2: syntax error: unexpected IDENTIFIER\n")
	code, out, errOut := ask(settings{LokiURL: loki.URL}, "logs", "--query", "{nope")
	if code != 1 || out != "" || errOut != "Loki answered 400: parse error at line 1, col 2: syntax error: unexpected IDENTIFIER\n" {
		t.Fatalf("exit %d, printed %q, said %q", code, out, errOut)
	}
	prom, _ := store(t, 422, `{"status":"error","errorType":"execution","error":"query timed out in expression evaluation"}`)
	code, out, errOut = ask(settings{PrometheusURL: prom.URL}, "metrics", "--query", "up")
	if code != 1 || out != "" || errOut != "Prometheus answered 422: query timed out in expression evaluation\n" {
		t.Fatalf("exit %d, printed %q, said %q", code, out, errOut)
	}
	down := httptest.NewServer(http.NotFoundHandler())
	down.Close()
	code, _, errOut = ask(settings{PrometheusURL: down.URL}, "metrics", "--query", "up")
	if code != 1 || !strings.HasPrefix(errOut, "Prometheus did not answer: ") {
		t.Fatalf("exit %d, said %q", code, errOut)
	}
}

func TestAskedWronglyAsksNoBackend(t *testing.T) {
	srv, got := store(t, 200, streams(t))
	env := settings{LokiURL: srv.URL, PrometheusURL: srv.URL}
	for _, c := range []struct {
		args []string
		says string
	}{
		{nil, "Usage:"},
		{[]string{"delete", "--query", "up"}, `"delete" is not a command`},
		{[]string{"logs"}, "--query is required"},
		{[]string{"logs", "--query", "  "}, "--query is required"},
		{[]string{"logs", "--query", "{a=\"b\"}", "--since", "soon"}, `--since: "soon" is not a time span`},
		{[]string{"logs", "--query", "{a=\"b\"}", "--limit", "0"}, "--limit:"},
		{[]string{"logs", "--query", "{a=\"b\"}", "--url", "http://elsewhere.example.org"}, "flag provided but not defined: -url"},
		{[]string{"logs", "--query", "{a=\"b\"}", "http://elsewhere.example.org"}, "unexpected argument"},
		{[]string{"metrics", "--query", "up", "--limit", "5"}, "--limit belongs to logs"},
	} {
		code, out, errOut := ask(env, c.args...)
		if code != 2 || out != "" || !strings.Contains(errOut, c.says) {
			t.Errorf("%v: exit %d, printed %q, said %q", c.args, code, out, errOut)
		}
	}
	if len(*got) != 0 {
		t.Fatalf("%d requests were made", len(*got))
	}
}

func TestEachCommandNeedsOnlyItsOwnAddress(t *testing.T) {
	code, _, errOut := ask(settings{PrometheusURL: "http://prometheus.example.org"}, "logs", "--query", "{a=\"b\"}")
	if code != 2 || !strings.HasPrefix(errOut, "LOKI_URL is not set") {
		t.Fatalf("exit %d, said %q", code, errOut)
	}
	code, _, errOut = ask(settings{LokiURL: "http://loki.example.org"}, "metrics", "--query", "up")
	if code != 2 || !strings.HasPrefix(errOut, "PROMETHEUS_URL is not set") {
		t.Fatalf("exit %d, said %q", code, errOut)
	}
}
