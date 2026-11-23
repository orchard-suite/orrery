package main

import (
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"strconv"
	"strings"
	"time"
)

// personCommands are the commands run as a person. Every other command is a machine's, with a source or access token.
var personCommands = map[string]bool{"login": true, "logout": true, "whoami": true, "actions": true, "action": true, "run": true, "runs": true, "watch": true, "get": true, "search": true, "queries": true, "query": true}

// shared are the flags every person command takes.
type shared struct {
	hub    string
	format string
}

func (s *shared) add(fs *flag.FlagSet) {
	fs.StringVar(&s.hub, "hub", "", "the hub's machine address, such as https://orrery-ingest.example.org")
	fs.StringVar(&s.format, "o", "table", "output: table, for a person, or json, for a script")
}

func (s *shared) json() bool { return s.format == "json" }

func (s *shared) check() error {
	if s.format != "table" && s.format != "json" {
		return fmt.Errorf("-o takes table or json, not %q", s.format)
	}
	return nil
}

// person runs one person command.
func (c *cli) person(args []string) error {
	name, rest := args[0], args[1:]
	fs := flag.NewFlagSet(name, flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	var s shared
	s.add(fs)
	// The flags that take a value, so they may follow the positional arguments.
	valued := []string{"hub", "o"}
	parse := func(more ...string) error {
		for _, a := range rest {
			if a == "-h" || a == "--help" || a == "-help" {
				fmt.Fprintln(c.out, helpFor(name))
				return flag.ErrHelp
			}
		}
		if err := fs.Parse(reorder(rest, append(valued, more...)...)); err != nil {
			return fmt.Errorf("%w\n\n%s", err, helpFor(name))
		}
		return s.check()
	}
	wrong := func() error { return errors.New(helpFor(name)) }
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()

	switch name {
	case "login":
		command := fs.String("command", "", "a command that prints a token for the hub, in place of a personal key in the keychain")
		if err := parse("command"); err != nil {
			return helped(err)
		}
		return c.login(ctx, s.hub, *command)
	case "logout":
		if err := parse(); err != nil {
			return helped(err)
		}
		return c.logout(s.hub)
	}

	// Everything below reads or asks as the person signed in.
	var follow followFlags
	var inputs multi
	entity := fs.String("entity", "", "blueprint:key")
	switch name {
	case "run":
		fs.Var(&inputs, "input", "name=value (repeatable)")
		follow.add(fs)
		fs.BoolVar(&follow.noWait, "no-wait", false, "ask for the run and return at once")
		if err := parse("entity", "input", "timeout"); err != nil {
			return helped(err)
		}
		if fs.NArg() != 1 {
			return wrong()
		}
		p, err := c.signedIn(s.hub)
		if err != nil {
			return err
		}
		return c.runAction(p, fs.Arg(0), *entity, inputs, follow, s)
	case "watch":
		follow.add(fs)
		fs.BoolVar(&follow.once, "once", false, "read the run as it stands and return at once")
		if err := parse("timeout"); err != nil {
			return helped(err)
		}
		if fs.NArg() != 1 {
			return wrong()
		}
		p, err := c.signedIn(s.hub)
		if err != nil {
			return err
		}
		var run actionRun
		if err := p.call(ctx, http.MethodGet, "/v1/action-runs/"+url.PathEscape(fs.Arg(0)), nil, nil, &run); err != nil {
			return err
		}
		if follow.once {
			return c.readOnce(run, s)
		}
		return c.follow(p, run, follow, s, 0)
	}

	limit := fs.Int("limit", 0, "the most rows to answer with")
	blueprint := fs.String("blueprint", "", "one blueprint")
	filter := fs.String("filter", "", "a filter, as JSON")
	fields := fs.String("fields", "", "field names to show, comma separated")
	sort := fs.String("sort", "", "a field to order by; -field for descending")
	after := fs.String("after", "", "the next a page answered with")
	action := fs.String("action", "", "one action's runs")
	file := fs.String("file", "", "a query as JSON, or - for standard input")
	if err := parse("entity", "limit", "blueprint", "filter", "fields", "sort", "after", "action", "file"); err != nil {
		return helped(err)
	}
	p, err := c.signedIn(s.hub)
	if err != nil {
		return err
	}
	get := func(path string, query url.Values) (json.RawMessage, error) {
		var raw json.RawMessage
		return raw, p.call(ctx, http.MethodGet, path, query, nil, &raw)
	}
	switch name {
	case "whoami":
		if fs.NArg() != 0 {
			return wrong()
		}
		raw, err := get("/v1/whoami", nil)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		var who whoAmI
		if err := json.Unmarshal(raw, &who); err != nil {
			return err
		}
		return printPairs(c.out, [][2]string{{"hub", p.hub}, {"hub version", who.Version}, {"signed in as", who.Identity.Name}, {"kind", who.Identity.Kind}, {"admin", strconv.FormatBool(who.Identity.Admin)}, {"roles", strings.Join(who.Identity.Roles, ", ")}})
	case "actions":
		if fs.NArg() != 0 {
			return wrong()
		}
		return c.listActions(ctx, p, *entity, s)
	case "action":
		if fs.NArg() != 1 {
			return wrong()
		}
		raw, err := get("/v1/actions/"+url.PathEscape(fs.Arg(0)), nil)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printAction(c.out, raw)
	case "runs":
		if fs.NArg() != 0 {
			return wrong()
		}
		query := url.Values{"limit": {strconv.Itoa(orDefault(*limit, 20))}}
		if *action != "" {
			query.Set("action", *action)
		}
		if *entity != "" {
			query.Set("entity", *entity)
		}
		raw, err := get("/v1/action-runs", query)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printRuns(c.out, raw)
	case "get":
		if fs.NArg() != 1 {
			return wrong()
		}
		ref, err := refOf(fs.Arg(0))
		if err != nil {
			return err
		}
		raw, err := get(ref.path(), nil)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printEntity(c.out, raw)
	case "search":
		if fs.NArg() > 1 {
			return wrong()
		}
		asked, err := searchFilter(fs.Arg(0), *filter)
		if err != nil {
			return err
		}
		query := url.Values{"limit": {strconv.Itoa(orDefault(*limit, 50))}}
		for key, value := range map[string]string{"blueprint": *blueprint, "filter": asked, "sort": *sort, "after": *after} {
			if value != "" {
				query.Set(key, value)
			}
		}
		raw, err := get("/v1/entities", query)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printEntities(c.out, c.err, raw, splitList(*fields))
	case "queries":
		if fs.NArg() != 0 {
			return wrong()
		}
		raw, err := get("/v1/queries", nil)
		if err != nil {
			return err
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printQueries(c.out, raw)
	case "query":
		// The hub shapes the answer by the query's own view, so the rows are the ones its page shows.
		query := url.Values{"shaped": {"true"}, "limit": {strconv.Itoa(orDefault(*limit, 200))}}
		var raw json.RawMessage
		switch {
		case *file != "" && fs.NArg() == 0:
			spec, err := readSpec(*file, c.in)
			if err != nil {
				return err
			}
			if err := p.call(ctx, http.MethodPost, "/v1/query", query, spec, &raw); err != nil {
				return err
			}
		case *file == "" && fs.NArg() == 1:
			if raw, err = get("/v1/queries/"+url.PathEscape(fs.Arg(0))+"/run", query); err != nil {
				return err
			}
		default:
			return wrong()
		}
		if s.json() {
			return printJSON(c.out, raw)
		}
		return printAnswer(c.out, c.err, raw)
	}
	return wrong()
}

// helped turns a request for help into a clean end: the help is already printed.
func helped(err error) error {
	if errors.Is(err, flag.ErrHelp) {
		return nil
	}
	return err
}

func orDefault(n, fallback int) int {
	if n > 0 {
		return n
	}
	return fallback
}

func splitList(text string) []string {
	var out []string
	for _, part := range strings.Split(text, ",") {
		if part = strings.TrimSpace(part); part != "" {
			out = append(out, part)
		}
	}
	return out
}

// entityRef names one entity.
type entityRef struct {
	Blueprint string `json:"blueprint"`
	Key       string `json:"key"`
}

func (r entityRef) path() string {
	return "/v1/entities/" + url.PathEscape(r.Blueprint) + "/" + url.PathEscape(r.Key)
}

// refOf reads blueprint:key. A key may itself hold a colon; a blueprint id never does.
func refOf(id string) (entityRef, error) {
	blueprint, key, ok := strings.Cut(id, ":")
	if !ok || blueprint == "" || key == "" {
		return entityRef{}, fmt.Errorf("%q is not an entity id: write blueprint:key", id)
	}
	return entityRef{Blueprint: blueprint, Key: key}, nil
}

// searchFilter is the filter a search sends: the text to find, the filter given, or both.
func searchFilter(text, filter string) (string, error) {
	var given any
	if filter != "" {
		if err := json.Unmarshal([]byte(filter), &given); err != nil {
			return "", fmt.Errorf("--filter is not JSON: %w", err)
		}
	}
	var asked any
	switch {
	case text != "" && given != nil:
		asked = map[string]any{"and": []any{map[string]any{"search": text}, given}}
	case text != "":
		asked = map[string]any{"search": text}
	case given != nil:
		asked = given
	default:
		return "", nil
	}
	out, err := json.Marshal(asked)
	return string(out), err
}

// readSpec reads a query from a file, or from standard input for "-".
func readSpec(name string, in io.Reader) (json.RawMessage, error) {
	var data []byte
	var err error
	if name == "-" {
		data, err = io.ReadAll(in)
	} else {
		data, err = os.ReadFile(name)
	}
	if err != nil {
		return nil, err
	}
	if !json.Valid(data) {
		return nil, fmt.Errorf("%s is not JSON", name)
	}
	return data, nil
}

// inputsOf reads --input pairs into what a run is asked with. name=value
// sends the value as text, which the hub reads as the input's own kind;
// name:=value sends it as the JSON it is. A name given more than once is a list.
func inputsOf(pairs []string) (map[string]any, error) {
	out := map[string]any{}
	seen := map[string]int{}
	for _, pair := range pairs {
		name, text, ok := strings.Cut(pair, "=")
		if !ok || name == "" || name == ":" {
			return nil, fmt.Errorf("--input wants name=value, got %q", pair)
		}
		var value any = text
		if strings.HasSuffix(name, ":") {
			name = strings.TrimSuffix(name, ":")
			if err := json.Unmarshal([]byte(text), &value); err != nil {
				return nil, fmt.Errorf("--input %s:= wants JSON: %w", name, err)
			}
		}
		switch seen[name] {
		case 0:
			out[name] = value
		case 1:
			out[name] = []any{out[name], value}
		default:
			out[name] = append(out[name].([]any), value)
		}
		seen[name]++
	}
	return out, nil
}

// actionRun is what a command reads of a run. Everything else the hub says of it is passed on as it came.
type actionRun struct {
	ID      string     `json:"id"`
	Action  string     `json:"action"`
	Entity  *entityRef `json:"entity"`
	State   string     `json:"state"`
	Label   string     `json:"label"`
	Link    string     `json:"link"`
	Summary string     `json:"summary"`
	Note    string     `json:"note"`
	Log     []struct {
		At      string `json:"at"`
		Message string `json:"message"`
		Step    string `json:"step"`
	} `json:"log"`
	Steps []struct {
		Name string `json:"name"`
	} `json:"steps"`
	Outputs map[string]any `json:"outputs"`
	// Told is an answer the hub hands over once and keeps nowhere.
	Told *string `json:"told"`
	raw  json.RawMessage
}

func (r *actionRun) UnmarshalJSON(data []byte) error {
	type plain actionRun
	if err := json.Unmarshal(data, (*plain)(r)); err != nil {
		return err
	}
	r.raw = append(r.raw[:0], data...)
	return nil
}

// finished says whether a run has ended, by the states the hub ends one in.
func (r actionRun) finished() bool {
	switch r.State {
	case "succeeded", "failed", "unknown", "declined", "cancelled", "returned":
		return true
	}
	return false
}

// followFlags say how long a run is followed.
type followFlags struct {
	timeout time.Duration
	noWait  bool
	// once reads the run as it stands and ends, whatever its state.
	once bool
}

func (f *followFlags) add(fs *flag.FlagSet) {
	fs.DurationVar(&f.timeout, "timeout", 30*time.Minute, "how long to follow the run before giving up on it")
}

func (c *cli) listActions(ctx context.Context, p *person, entity string, s shared) error {
	var listed struct {
		Actions []json.RawMessage `json:"actions"`
	}
	if err := p.call(ctx, http.MethodGet, "/v1/actions", nil, nil, &listed); err != nil {
		return err
	}
	// On one entity the hub says which actions the person may run there, on the entity's own page.
	var here map[string]bool
	if entity != "" {
		ref, err := refOf(entity)
		if err != nil {
			return err
		}
		var page struct {
			Actions []string `json:"actions"`
		}
		if err := p.call(ctx, http.MethodGet, ref.path(), nil, nil, &page); err != nil {
			return err
		}
		here = map[string]bool{}
		for _, id := range page.Actions {
			here[id] = true
		}
	}
	var may []json.RawMessage
	for _, raw := range listed.Actions {
		var a struct {
			ID     string `json:"id"`
			CanRun bool   `json:"canRun"`
		}
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		if a.CanRun && (here == nil || here[a.ID]) {
			may = append(may, raw)
		}
	}
	if s.json() {
		if may == nil {
			may = []json.RawMessage{}
		}
		out, err := json.Marshal(map[string]any{"actions": may})
		if err != nil {
			return err
		}
		return printJSON(c.out, out)
	}
	return printActions(c.out, may)
}

// runAction asks for a run and follows it to its end.
func (c *cli) runAction(p *person, action, entity string, pairs []string, f followFlags, s shared) error {
	inputs, err := inputsOf(pairs)
	if err != nil {
		return err
	}
	body := map[string]any{"inputs": inputs}
	if entity != "" {
		ref, err := refOf(entity)
		if err != nil {
			return err
		}
		body["entity"] = ref
	}
	ctx, cancel := context.WithTimeout(context.Background(), 2*time.Minute)
	defer cancel()
	var defined struct {
		Backend struct {
			Finish string `json:"finish"`
		} `json:"backend"`
	}
	path := "/v1/actions/" + url.PathEscape(action)
	if err := p.call(ctx, http.MethodGet, path, nil, nil, &defined); err != nil {
		return err
	}
	// An answer the hub reveals is given once, to this request, and kept nowhere. It goes to the terminal itself and
	// nowhere else, so with no terminal the run is not asked for at all.
	var tty io.WriteCloser
	if defined.Backend.Finish == "reveal" {
		if tty, err = c.tty(); err != nil {
			return &exit{code: 1, message: fmt.Sprintf("%s answers with something shown once, to a terminal only, and there is no terminal here: run it from one", action)}
		}
		defer tty.Close()
	}
	var run actionRun
	if err := p.call(ctx, http.MethodPost, path+"/run", nil, body, &run); err != nil {
		return err
	}
	if run.Told != nil {
		if tty == nil {
			// The hub revealed where the definition did not say it would: still never to the output.
			if tty, err = c.tty(); err != nil {
				return &exit{code: 1, message: fmt.Sprintf("run %s answered with something shown once, to a terminal only, and there is no terminal here; it is gone", run.ID)}
			}
			defer tty.Close()
		}
		fmt.Fprintf(tty, "%s\n", *run.Told)
		run.Told = nil
		run.raw = withoutTold(run.raw)
	}
	if !s.json() {
		on := ""
		if run.Entity != nil {
			on = " on " + run.Entity.Blueprint + ":" + run.Entity.Key
		}
		fmt.Fprintf(c.out, "run %s of %s%s\n", run.ID, run.Action, on)
	}
	if f.noWait {
		if s.json() {
			return printJSON(c.out, run.raw)
		}
		fmt.Fprintf(c.out, "state: %s\nfollow it with: orrery watch %s\nor read it later, as it stands then, with: orrery watch %s --once\n", run.State, run.ID, run.ID)
		return ended(run)
	}
	return c.follow(p, run, f, s, 0)
}

// readOnce prints a run as it stands now, its log so far and what it holds, and ends: nothing is followed.
func (c *cli) readOnce(run actionRun, s shared) error {
	if s.json() {
		if err := printJSON(c.out, withoutTold(run.raw)); err != nil {
			return err
		}
		return ended(run)
	}
	step := ""
	for _, line := range run.Log {
		if line.Step != step {
			step = line.Step
			if step != "" {
				fmt.Fprintf(c.out, "== %s ==\n", step)
			}
		}
		fmt.Fprintf(c.out, "%s  %s\n", clock(line.At), line.Message)
	}
	if err := printRunEnd(c.out, run); err != nil {
		return err
	}
	return ended(run)
}

// withoutTold is a run as the hub answered it, without the answer that is shown once.
func withoutTold(raw json.RawMessage) json.RawMessage {
	var whole map[string]json.RawMessage
	if json.Unmarshal(raw, &whole) != nil {
		return json.RawMessage("{}")
	}
	delete(whole, "told")
	out, _ := json.Marshal(whole)
	return out
}

// follow reads a run until it ends, printing each new line of its log as it comes, then what came of it.
func (c *cli) follow(p *person, run actionRun, f followFlags, s shared, printed int) error {
	deadline := time.Now().Add(f.timeout)
	step := ""
	said := ""
	for {
		if !s.json() {
			for ; printed < len(run.Log); printed++ {
				line := run.Log[printed]
				if line.Step != step {
					step = line.Step
					if step != "" {
						fmt.Fprintf(c.out, "== %s ==\n", step)
					}
				}
				fmt.Fprintf(c.out, "%s  %s\n", clock(line.At), line.Message)
			}
			if run.State != said && !run.finished() {
				said = run.State
				fmt.Fprintf(c.err, "%s...\n", waitingWords(run.State))
			}
		}
		if run.finished() {
			break
		}
		if time.Now().After(deadline) {
			if s.json() {
				if err := printJSON(c.out, run.raw); err != nil {
					return err
				}
			}
			return &exit{code: 2, message: fmt.Sprintf("run %s is still %s after %s; follow it with: orrery watch %s", run.ID, run.State, f.timeout, run.ID)}
		}
		time.Sleep(c.poll)
		ctx, cancel := context.WithTimeout(context.Background(), time.Minute)
		var next actionRun
		err := p.call(ctx, http.MethodGet, "/v1/action-runs/"+url.PathEscape(run.ID), nil, nil, &next)
		cancel()
		if err != nil {
			return err
		}
		run = next
	}
	if s.json() {
		if err := printJSON(c.out, withoutTold(run.raw)); err != nil {
			return err
		}
	} else if err := printRunEnd(c.out, run); err != nil {
		return err
	}
	return ended(run)
}

// ended is how a command that asked for a run ends: cleanly unless the run failed or was turned down.
func ended(run actionRun) error {
	if !run.finished() || run.State == "succeeded" {
		return nil
	}
	why := run.Summary
	if why == "" {
		why = run.Note
	}
	if why != "" {
		why = ": " + why
	}
	return &exit{code: 1, message: fmt.Sprintf("run %s %s%s", run.ID, run.State, why)}
}

func waitingWords(state string) string {
	switch state {
	case "awaiting":
		return "waiting for approval"
	case "queued":
		return "queued"
	case "running":
		return "running"
	}
	return state
}

// clock is a moment of a log as the time of day here.
func clock(at string) string {
	t, err := time.Parse(time.RFC3339Nano, at)
	if err != nil {
		return at
	}
	return t.Local().Format("15:04:05")
}
