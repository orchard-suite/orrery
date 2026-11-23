package main

import (
	"bytes"
	"encoding/json"
	"errors"
	"io"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeHub answers as a hub would, from what a test gives it, and keeps what it was asked.
type fakeHub struct {
	t      *testing.T
	mu     sync.Mutex
	asked  []string
	bodies map[string]string
	routes map[string]func(r *http.Request) (int, any)
}

func (h *fakeHub) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	h.mu.Lock()
	defer h.mu.Unlock()
	if r.Header.Get("authorization") != "Bearer key-of-ada" {
		w.WriteHeader(http.StatusUnauthorized)
		_ = json.NewEncoder(w).Encode(map[string]string{"error": "Unknown token"})
		return
	}
	asked := r.Method + " " + r.URL.EscapedPath()
	h.asked = append(h.asked, asked)
	body, _ := io.ReadAll(r.Body)
	h.bodies[asked] = string(body)
	route, ok := h.routes[asked]
	if !ok {
		h.t.Errorf("the hub was asked %s, which the test did not expect", asked)
		w.WriteHeader(http.StatusNotFound)
		return
	}
	status, answer := route(r)
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(answer)
}

func (h *fakeHub) times(asked string) int {
	h.mu.Lock()
	defer h.mu.Unlock()
	n := 0
	for _, a := range h.asked {
		if a == asked {
			n++
		}
	}
	return n
}

// always answers the same thing every time.
func always(status int, answer any) func(*http.Request) (int, any) {
	return func(*http.Request) (int, any) { return status, answer }
}

// inTurn answers each ask with the next answer, and the last one from then on.
func inTurn(answers ...any) func(*http.Request) (int, any) {
	i := 0
	return func(*http.Request) (int, any) {
		answer := answers[min(i, len(answers)-1)]
		i++
		return http.StatusOK, answer
	}
}

// fakeTTY is a terminal that keeps what was written to it.
type fakeTTY struct{ bytes.Buffer }

func (*fakeTTY) Close() error { return nil }

// fakeKeys keeps keys in memory and hands back a command that prints one.
type fakeKeys struct{ kept map[string]string }

func (k *fakeKeys) store(hub, key string) (string, error) {
	k.kept[hub] = key
	return "printf %s " + key, nil
}
func (k *fakeKeys) remove(hub string) error { delete(k.kept, hub); return nil }
func (k *fakeKeys) owns(hub, command string) bool {
	return command == "printf %s "+k.kept[hub]
}

type bench struct {
	*cli
	hub    *fakeHub
	url    string
	out    *bytes.Buffer
	err    *bytes.Buffer
	tty    *fakeTTY
	tokens string
	keys   *fakeKeys
}

// signedInBench is a command line signed in to a fake hub as a person.
func signedInBench(t *testing.T, routes map[string]func(*http.Request) (int, any)) *bench {
	t.Helper()
	hub := &fakeHub{t: t, bodies: map[string]string{}, routes: routes}
	server := httptest.NewServer(hub)
	t.Cleanup(server.Close)
	tokens := filepath.Join(t.TempDir(), "tokens")
	if err := writeTokenLine(tokens, server.URL, "printf %s key-of-ada"); err != nil {
		t.Fatal(err)
	}
	b := &bench{hub: hub, url: server.URL, out: &bytes.Buffer{}, err: &bytes.Buffer{}, tty: &fakeTTY{}, tokens: tokens, keys: &fakeKeys{kept: map[string]string{}}}
	env := map[string]string{"ORRERY_TOKENS_FILE": tokens}
	b.cli = &cli{in: strings.NewReader(""), out: b.out, err: b.err, getenv: func(k string) string { return env[k] }, secret: func(string) (string, error) { return "key-of-ada\n", nil }, tty: func() (io.WriteCloser, error) { return b.tty, nil }, keys: b.keys, http: server.Client(), poll: time.Millisecond}
	return b
}

func (b *bench) run(args ...string) error { return b.cli.person(args) }

func codeOf(err error) int {
	var ended *exit
	if errors.As(err, &ended) {
		return ended.code
	}
	if err != nil {
		return 1
	}
	return 0
}

var person1 = map[string]any{"identity": map[string]any{"kind": "user", "name": "ada@example.org", "admin": false, "roles": []string{"dev"}}, "version": "1.2.3"}

func TestTheTokensFileKeepsOneLineAHubAndIsThePersonsAlone(t *testing.T) {
	path := filepath.Join(t.TempDir(), "orrery", "tokens")
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(path, []byte("# my hubs\nhttps://a.example.org  old command\nhttps://b.example.org\tvault read b\n"), 0o644); err != nil {
		t.Fatal(err)
	}
	if err := writeTokenLine(path, "https://a.example.org/", "new command"); err != nil {
		t.Fatal(err)
	}
	if err := writeTokenLine(path, "https://c.example.org", "third"); err != nil {
		t.Fatal(err)
	}
	data, _ := os.ReadFile(path)
	if want := "# my hubs\nhttps://a.example.org/  new command\nhttps://b.example.org\tvault read b\nhttps://c.example.org  third\n"; string(data) != want {
		t.Fatalf("the file reads\n%s\nwant\n%s", data, want)
	}
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("the file is %v, and others may read it", info.Mode().Perm())
	}
	lines, err := readTokens(path)
	if err != nil || len(lines) != 3 || lines[1] != (hubLine{URL: "https://b.example.org", Command: "vault read b"}) {
		t.Fatalf("read %v, %v", lines, err)
	}
	if err := writeTokenLine(path, "https://a.example.org", ""); err != nil {
		t.Fatal(err)
	}
	if lines, _ = readTokens(path); len(lines) != 2 || lines[0].URL != "https://b.example.org" {
		t.Fatalf("after removing a hub the file names %v", lines)
	}
}

func TestAKeyKeptInAFileIsReadBackByItsCommandAndByNobodyElse(t *testing.T) {
	keys := fileKeys{dir: filepath.Join(t.TempDir(), "keys")}
	command, err := keys.store("https://hub.example.org:8443", "orr_usr_abc")
	if err != nil {
		t.Fatal(err)
	}
	path, _ := keys.path("https://hub.example.org:8443")
	if info, _ := os.Stat(path); info.Mode().Perm() != 0o600 {
		t.Fatalf("the key file is %v", info.Mode().Perm())
	}
	token, err := tokenFrom(hubLine{URL: "https://hub.example.org:8443", Command: command}, io.Discard)
	if err != nil || token != "orr_usr_abc" {
		t.Fatalf("the command printed %q, %v", token, err)
	}
	if !keys.owns("https://hub.example.org:8443", command) || keys.owns("https://hub.example.org:8443", "vault read x") {
		t.Fatal("it does not tell its own command from a person's")
	}
	if err := keys.remove("https://hub.example.org:8443"); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(path); !errors.Is(err, os.ErrNotExist) {
		t.Fatal("the key file is still there")
	}
	if _, err := tokenFrom(hubLine{URL: "h", Command: "true"}, io.Discard); err == nil {
		t.Fatal("a command that printed nothing gave a token")
	}
}

func TestLoginAsksTheHubWhoTheKeyIsBeforeItKeepsIt(t *testing.T) {
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/whoami": always(200, person1)})
	if err := os.Remove(b.tokens); err != nil {
		t.Fatal(err)
	}
	if err := b.run("login", "--hub", b.url); err != nil {
		t.Fatal(err)
	}
	if b.keys.kept[b.url] != "key-of-ada" {
		t.Fatalf("the keychain holds %v", b.keys.kept)
	}
	lines, _ := readTokens(b.tokens)
	if len(lines) != 1 || !sameHub(lines[0].URL, b.url) || lines[0].Command != "printf %s key-of-ada" {
		t.Fatalf("the tokens file names %v", lines)
	}
	if got := b.out.String(); got != "signed in to "+b.url+" as ada@example.org\n" {
		t.Fatalf("it said %q", got)
	}
	// Signed in, the next command needs no hub named.
	b.out.Reset()
	if err := b.run("whoami"); err != nil || !strings.Contains(b.out.String(), "ada@example.org") {
		t.Fatalf("whoami said %q, %v", b.out.String(), err)
	}
	b.out.Reset()
	if err := b.run("logout"); err != nil {
		t.Fatal(err)
	}
	if lines, _ = readTokens(b.tokens); len(lines) != 0 || len(b.keys.kept) != 0 {
		t.Fatalf("after logout the file names %v and the keychain holds %v", lines, b.keys.kept)
	}
}

func TestLoginKeepsNothingTheHubDoesNotKnowAsAPerson(t *testing.T) {
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/whoami": always(200, map[string]any{"identity": map[string]any{"kind": "token", "name": "ci"}})})
	_ = os.Remove(b.tokens)
	if err := b.run("login", "--hub", b.url); err == nil || !strings.Contains(err.Error(), "not a person's") {
		t.Fatalf("a machine's token signed a person in: %v", err)
	}
	b.cli.secret = func(string) (string, error) { return "wrong-key", nil }
	if err := b.run("login", "--hub", b.url); err == nil || !strings.Contains(err.Error(), "Unknown token") {
		t.Fatalf("a key the hub does not know was kept: %v", err)
	}
	if lines, _ := readTokens(b.tokens); len(lines) != 0 || len(b.keys.kept) != 0 {
		t.Fatalf("something was kept: %v, %v", lines, b.keys.kept)
	}
}

func TestLoginWithACommandKeepsTheCommandAndNoKey(t *testing.T) {
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/whoami": always(200, person1)})
	_ = os.Remove(b.tokens)
	if err := b.run("login", "--hub", b.url, "--command", "printf %s key-of-ada"); err != nil {
		t.Fatal(err)
	}
	if lines, _ := readTokens(b.tokens); len(lines) != 1 || lines[0].Command != "printf %s key-of-ada" || len(b.keys.kept) != 0 {
		t.Fatalf("kept %v and %v", lines, b.keys.kept)
	}
}

func TestInputsAreSentAsTextAsJSONOrAsAList(t *testing.T) {
	got, err := inputsOf([]string{"why=stuck=again", "days=30", "groups=dev", "groups=ops", "groups=sec", "tags:=[\"a\",1]", "dry:=true"})
	if err != nil {
		t.Fatal(err)
	}
	sent, _ := json.Marshal(got)
	if want := `{"days":"30","dry":true,"groups":["dev","ops","sec"],"tags":["a",1],"why":"stuck=again"}`; string(sent) != want {
		t.Fatalf("sent %s, want %s", sent, want)
	}
	for _, bad := range []string{"novalue", "=x", "n:=not json"} {
		if _, err := inputsOf([]string{bad}); err == nil {
			t.Fatalf("%q was taken", bad)
		}
	}
}

func runOf(state string, more map[string]any) map[string]any {
	run := map[string]any{"id": "r1", "action": "restart", "entity": map[string]any{"blueprint": "service", "key": "shop/checkout"}, "state": state, "log": []any{}, "steps": []any{}, "outputs": map[string]any{}}
	for k, v := range more {
		run[k] = v
	}
	return run
}

func TestRunAsksAsThePersonAndFollowsTheRunToItsEnd(t *testing.T) {
	line := func(message, step string) map[string]any {
		return map[string]any{"at": "2026-01-02T03:04:05Z", "message": message, "step": step}
	}
	b := signedInBench(t, map[string]func(*http.Request) (int, any){
		"GET /v1/actions/restart":      always(200, map[string]any{"id": "restart", "backend": map[string]any{"type": "runner"}}),
		"POST /v1/actions/restart/run": always(201, runOf("queued", map[string]any{"log": []any{line("requested by ada@example.org", "")}})),
		"GET /v1/action-runs/r1": inTurn(
			runOf("running", map[string]any{"log": []any{line("requested by ada@example.org", ""), line("draining", "Stop")}}),
			runOf("succeeded", map[string]any{"summary": "restarted", "link": "https://ci.example.org/9", "log": []any{line("requested by ada@example.org", ""), line("draining", "Stop"), line("3 replicas ready", "Verify")}, "steps": []any{map[string]any{"name": "Stop"}, map[string]any{"name": "Verify"}}, "outputs": map[string]any{"replicas": 3, "url": "https://shop.example.org"}}),
		),
	})
	if err := b.run("run", "restart", "--entity", "service:shop/checkout", "--input", "why=stuck", "--input", "wait=30"); err != nil {
		t.Fatal(err)
	}
	if want := `{"entity":{"blueprint":"service","key":"shop/checkout"},"inputs":{"wait":"30","why":"stuck"}}`; b.hub.bodies["POST /v1/actions/restart/run"] != want {
		t.Fatalf("asked with %s", b.hub.bodies["POST /v1/actions/restart/run"])
	}
	out := b.out.String()
	for _, want := range []string{"run r1 of restart on service:shop/checkout\n", "requested by ada@example.org\n== Stop ==\n", "draining\n== Verify ==\n", "3 replicas ready\n", "state    succeeded\n", "summary  restarted\n", "steps    Stop, Verify\n", "link     https://ci.example.org/9\n", "outputs:\n  replicas  3\n  url       https://shop.example.org\n"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the output lacks %q:\n%s", want, out)
		}
	}
	if strings.Count(out, "draining") != 1 {
		t.Fatalf("a log line was printed twice:\n%s", out)
	}
}

func TestARunThatFailsOrIsRefusedEndsNonZero(t *testing.T) {
	action := always(200, map[string]any{"id": "restart", "backend": map[string]any{"type": "webhook"}})
	for state, code := range map[string]int{"failed": 1, "unknown": 1, "declined": 1, "cancelled": 1, "returned": 1, "succeeded": 0} {
		b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/actions/restart": action, "POST /v1/actions/restart/run": always(201, runOf(state, map[string]any{"summary": "the backend answered 500"}))})
		err := b.run("run", "restart", "-o", "json")
		if codeOf(err) != code {
			t.Fatalf("a %s run ended with %d (%v)", state, codeOf(err), err)
		}
		var printed map[string]any
		if json.Unmarshal(b.out.Bytes(), &printed) != nil || printed["state"] != state {
			t.Fatalf("with -o json a %s run printed %s", state, b.out.String())
		}
	}
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/actions/restart": action, "POST /v1/actions/restart/run": always(400, map[string]any{"error": "why is required", "input": "why"})})
	err := b.run("run", "restart")
	if codeOf(err) != 1 || err.Error() != "why is required (input: why)" {
		t.Fatalf("a refusal read %v", err)
	}
	b = signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/actions/nope": always(404, map[string]any{"error": `Unknown action "nope"`})})
	if err := b.run("run", "nope"); codeOf(err) != 1 || b.hub.times("POST /v1/actions/nope/run") != 0 {
		t.Fatalf("an action the person may not see was asked for: %v", err)
	}
}

func TestARunStillGoingAtTheTimeoutEndsWithTwoAndNoWaitReturnsAtOnce(t *testing.T) {
	routes := map[string]func(*http.Request) (int, any){
		"GET /v1/actions/restart":      always(200, map[string]any{"id": "restart", "backend": map[string]any{"type": "runner"}}),
		"POST /v1/actions/restart/run": always(201, runOf("awaiting", nil)),
		"GET /v1/action-runs/r1":       always(200, runOf("awaiting", nil)),
	}
	b := signedInBench(t, routes)
	err := b.run("run", "restart", "--timeout", "20ms")
	if codeOf(err) != 2 || !strings.Contains(err.Error(), "orrery watch r1") || !strings.Contains(b.err.String(), "waiting for approval") {
		t.Fatalf("got %d, %v, %q", codeOf(err), err, b.err.String())
	}
	b = signedInBench(t, routes)
	if err := b.run("run", "restart", "--no-wait"); err != nil || b.hub.times("GET /v1/action-runs/r1") != 0 || !strings.Contains(b.out.String(), "orrery watch r1") {
		t.Fatalf("--no-wait followed the run: %v, %q", err, b.out.String())
	}
}

func TestWatchOnceReadsARunAsItStandsAndFollowsNothing(t *testing.T) {
	going := runOf("running", nil)
	routes := map[string]func(*http.Request) (int, any){"GET /v1/action-runs/r1": always(200, going)}
	b := signedInBench(t, routes)
	// A run still going is read once and left: no second read, and no failure.
	if err := b.run("watch", "r1", "--once"); err != nil || b.hub.times("GET /v1/action-runs/r1") != 1 || !strings.Contains(b.out.String(), "running") {
		t.Fatalf("got %v after %d reads: %q", err, b.hub.times("GET /v1/action-runs/r1"), b.out.String())
	}
	b = signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/action-runs/r1": always(200, runOf("failed", nil))})
	if err := b.run("watch", "r1", "--once"); codeOf(err) != 1 {
		t.Fatalf("a failed run read once ended %d, %v", codeOf(err), err)
	}
}

func TestAnAnswerRevealedOnceGoesToTheTerminalAndNowhereElse(t *testing.T) {
	routes := map[string]func(*http.Request) (int, any){
		"GET /v1/actions/reveal-key":      always(200, map[string]any{"id": "reveal-key", "backend": map[string]any{"type": "webhook", "finish": "reveal"}}),
		"POST /v1/actions/reveal-key/run": always(201, runOf("succeeded", map[string]any{"action": "reveal-key", "told": "s3cret-recovery-key"})),
	}
	for _, format := range []string{"table", "json"} {
		b := signedInBench(t, routes)
		if err := b.run("run", "reveal-key", "-o", format); err != nil {
			t.Fatal(err)
		}
		if got := b.tty.String(); got != "s3cret-recovery-key\n" {
			t.Fatalf("the terminal was shown %q", got)
		}
		if strings.Contains(b.out.String()+b.err.String(), "s3cret") || strings.Contains(b.out.String(), "told") {
			t.Fatalf("with -o %s the answer left the terminal: %q %q", format, b.out.String(), b.err.String())
		}
	}
	// With no terminal to show it on, the run is never asked for: the answer would be given once and lost, or written where it must not be.
	b := signedInBench(t, routes)
	b.cli.tty = func() (io.WriteCloser, error) { return nil, errors.New("no terminal") }
	err := b.run("run", "reveal-key")
	if codeOf(err) != 1 || !strings.Contains(err.Error(), "terminal") || b.hub.times("POST /v1/actions/reveal-key/run") != 0 {
		t.Fatalf("with no terminal it %v, and asked %v", err, b.hub.asked)
	}
}

func TestActionsListsWhatThePersonMayRunHereOrOnOneEntity(t *testing.T) {
	routes := map[string]func(*http.Request) (int, any){
		"GET /v1/actions": always(200, map[string]any{"actions": []any{
			map[string]any{"id": "restart", "title": "Restart", "blueprint": "service", "canRun": true, "approval": true, "group": "Ops"},
			map[string]any{"id": "scale", "title": "Scale", "blueprint": []string{"service", "job"}, "canRun": true, "homeShown": map[string]any{"title": "Shop"}},
			map[string]any{"id": "wipe", "title": "Wipe", "canRun": false},
		}}),
		"GET /v1/entities/service/shop%2Fcheckout": always(200, map[string]any{"id": "service:shop/checkout", "actions": []string{"scale"}}),
	}
	b := signedInBench(t, routes)
	if err := b.run("actions"); err != nil {
		t.Fatal(err)
	}
	out := b.out.String()
	if !strings.Contains(out, "restart  Restart  service       yes       Ops") || !strings.Contains(out, "scale    Scale    service, job            Shop") || strings.Contains(out, "wipe") {
		t.Fatalf("listed\n%s", out)
	}
	b = signedInBench(t, routes)
	if err := b.run("actions", "--entity", "service:shop/checkout", "-o", "json"); err != nil {
		t.Fatal(err)
	}
	var listed struct {
		Actions []struct{ ID string } `json:"actions"`
	}
	if json.Unmarshal(b.out.Bytes(), &listed) != nil || len(listed.Actions) != 1 || listed.Actions[0].ID != "scale" {
		t.Fatalf("on one entity it listed %s", b.out.String())
	}
}

func TestActionShowsItsInputsInTheOrderTheyAreAsked(t *testing.T) {
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/actions/grant": always(200, json.RawMessage(`{"id":"grant","title":"Grant access","canRun":true,"backend":{"type":"webhook","finish":"reveal"},"inputs":{"zone":{"type":"enum","values":["a","b"],"required":true},"days":{"type":"number","default":30},"until":{"type":"date","value":"today + days"}}}`))})
	if err := b.run("action", "grant"); err != nil {
		t.Fatal(err)
	}
	out := b.out.String()
	zone, days, until := strings.Index(out, "zone "), strings.Index(out, "days "), strings.Index(out, "until ")
	if zone < 0 || !(zone < days && days < until) {
		t.Fatalf("the inputs are out of order:\n%s", out)
	}
	for _, want := range []string{"one of: a, b", "default: 30", "never sent", "shown once, to a terminal only", "it takes no --entity"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the output lacks %q:\n%s", want, out)
		}
	}
}

func TestSearchSendsTheTextAndTheFilterTogether(t *testing.T) {
	var query map[string][]string
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/entities": func(r *http.Request) (int, any) {
		query = r.URL.Query()
		return 200, map[string]any{"total": 9, "next": "c2", "entities": []any{map[string]any{"id": "service:checkout", "title": "Checkout", "status": map[string]any{"level": "red"}, "fields": map[string]any{"tier": "gold", "langs": []string{"go", "ts"}}}}}
	}})
	if err := b.run("search", "check", "--blueprint", "service", "--filter", `{"field":"tier","op":"eq","value":"gold"}`, "--fields", "tier,langs", "--limit", "1"); err != nil {
		t.Fatal(err)
	}
	if got := query["filter"][0]; got != `{"and":[{"search":"check"},{"field":"tier","op":"eq","value":"gold"}]}` {
		t.Fatalf("the filter sent is %s", got)
	}
	if query["blueprint"][0] != "service" || query["limit"][0] != "1" {
		t.Fatalf("asked %v", query)
	}
	if out := b.out.String(); !strings.Contains(out, "service:checkout  Checkout  red     gold  go, ts") {
		t.Fatalf("printed\n%s", out)
	}
	if !strings.Contains(b.err.String(), "1 of 9 shown; the next page: --after c2") {
		t.Fatalf("it did not say there is more: %q", b.err.String())
	}
	if _, err := searchFilter("", "{not json"); err == nil {
		t.Fatal("a filter that is not JSON was sent")
	}
}

func TestGetPrintsAnEntityAndTheActionsOnIt(t *testing.T) {
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/entities/service/shop%2Fcheckout": always(200, map[string]any{
		"id": "service:shop/checkout", "title": "Checkout", "state": "active", "owner": "k8s", "status": map[string]any{"level": "amber", "reasons": []string{"1 replica down"}},
		"fields":   map[string]any{"tier": "gold", "empty": nil},
		"outgoing": []any{map[string]any{"relation": "team", "target": map[string]any{"blueprint": "team", "key": "shop"}, "targetTitle": "Shop team"}},
		"incoming": []any{map[string]any{"relation": "service", "target": map[string]any{"blueprint": "deploy", "key": "d9"}, "targetTitle": "Deploy 9"}},
		"actions":  []string{"restart", "scale"},
	})})
	if err := b.run("get", "service:shop/checkout"); err != nil {
		t.Fatal(err)
	}
	out := b.out.String()
	for _, want := range []string{"entity      service:shop/checkout", "status      amber (1 replica down)", "  tier  gold", "  team  -> team:shop  Shop team", "  service  <- deploy:d9  Deploy 9", "Actions you may run on it: restart, scale"} {
		if !strings.Contains(out, want) {
			t.Fatalf("the output lacks %q:\n%s", want, out)
		}
	}
	if strings.Contains(out, "empty") {
		t.Fatalf("a field with no value was printed:\n%s", out)
	}
	if err := b.run("get", "no-colon"); err == nil {
		t.Fatal("an id with no blueprint was asked for")
	}
}

func TestQueryAsksTheHubToShapeTheAnswer(t *testing.T) {
	answer := map[string]any{"counts": map[string]int{"service": 3}, "kept": 2, "shown": 1, "truncated": false, "totals": map[string]any{"cost": 700},
		"groups": []any{map[string]any{"column": "title", "value": "A", "count": 2, "totals": map[string]any{"cost": 700},
			"groups": []any{map[string]any{"column": "cost", "value": nil, "count": 1, "totals": map[string]any{}}}}},
		"columns": []any{map[string]any{"id": "title", "title": "Title"}, map[string]any{"id": "cost", "title": "Cost", "format": map[string]any{"kind": "currency", "minor": true}}},
		"rows":    []any{map[string]any{"blueprint": "service", "key": "a", "values": []any{"A", 500}}}}
	var query map[string][]string
	shaped := func(r *http.Request) (int, any) { query = r.URL.Query(); return 200, answer }
	b := signedInBench(t, map[string]func(*http.Request) (int, any){"GET /v1/queries/q1/run": shaped, "POST /v1/query": shaped})
	if err := b.run("query", "q1", "--limit", "1"); err != nil {
		t.Fatal(err)
	}
	if query["shaped"][0] != "true" || query["limit"][0] != "1" {
		t.Fatalf("asked %v", query)
	}
	if out := b.out.String(); !strings.Contains(out, "TITLE  COST (MINOR UNITS)\nA      500\n") {
		t.Fatalf("printed\n%s", out)
	}
	if notes := b.err.String(); !strings.Contains(notes, "1 of 2 rows shown") || !strings.Contains(notes, `totals: {"cost":700}`) ||
		!strings.Contains(notes, "groups:\n  Title A: 2 {\"cost\":700}\n    Cost (none): 1\n") {
		t.Fatalf("noted %q", notes)
	}
	spec := `{"sources":[{"blueprint":"service"}],"columns":["title"]}`
	b.cli.in = strings.NewReader(spec)
	if err := b.run("query", "--file", "-", "-o", "json"); err != nil {
		t.Fatal(err)
	}
	if b.hub.bodies["POST /v1/query"] != spec {
		t.Fatalf("sent %s", b.hub.bodies["POST /v1/query"])
	}
	if err := b.run("query"); err == nil {
		t.Fatal("a query with neither an id nor a file was run")
	}
}

func TestACommandWithNoSignInSaysHowToSignIn(t *testing.T) {
	b := signedInBench(t, nil)
	_ = os.Remove(b.tokens)
	if err := b.run("actions"); err == nil || !strings.Contains(err.Error(), "orrery login --hub") {
		t.Fatalf("got %v", err)
	}
	if err := b.run("actions", "--hub", b.url); err == nil || !strings.Contains(err.Error(), "not signed in to "+b.url) {
		t.Fatalf("got %v", err)
	}
	if err := run([]string{"frobnicate"}); err == nil || !strings.Contains(err.Error(), `no command "frobnicate"`) {
		t.Fatalf("an unknown command read %v", err)
	}
}
