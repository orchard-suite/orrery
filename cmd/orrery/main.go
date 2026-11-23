// Command orrery is the command line of an Orrery hub, with two sets of
// commands. A person signs in and reads the catalog and runs self-service
// actions, as the web app and the agent tools let them. A machine (a shell
// job, a Terraform post-apply hook, an event handler) pushes a catalog file,
// writes or deletes one entity, sends a heartbeat, or reports on a run.
//
//	orrery login --hub https://orrery-ingest.example.org && orrery actions
//	ORRERY_URL=https://orrery-ingest.example.org ORRERY_TOKEN=orr_src_... orrery push catalog.yaml
package main

import (
	"bufio"
	"context"
	"errors"
	"flag"
	"fmt"
	"log/slog"
	"net/http"
	"os"
	"strconv"
	"strings"
	"time"

	"golang.org/x/term"

	"github.com/orchard-suite/orrery/sdk"
)

var version = "dev"

func main() {
	err := run(os.Args[1:])
	if err == nil {
		return
	}
	fmt.Fprintln(os.Stderr, "orrery:", err)
	var ended *exit
	if errors.As(err, &ended) {
		os.Exit(ended.code)
	}
	os.Exit(1)
}

// machineCommands are the commands a machine runs, with ORRERY_URL and ORRERY_TOKEN.
var machineCommands = map[string]bool{"push": true, "put": true, "patch": true, "delete": true, "heartbeat": true, "refresh-git": true, "report": true}

func usage() error {
	return errors.New(overview)
}

// machine is what a person command reads and writes when it is run for real.
func machine() *cli {
	return &cli{in: os.Stdin, out: os.Stdout, err: os.Stderr, getenv: os.Getenv, secret: askSecret, tty: terminal, keys: systemKeyring(), http: &http.Client{Timeout: 90 * time.Second}, poll: 2 * time.Second}
}

// askSecret asks for a key at the terminal without showing it, or reads one line when the input is piped.
func askSecret(prompt string) (string, error) {
	if fd := int(os.Stdin.Fd()); term.IsTerminal(fd) {
		fmt.Fprint(os.Stderr, prompt)
		key, err := term.ReadPassword(fd)
		fmt.Fprintln(os.Stderr)
		return string(key), err
	}
	line, err := bufio.NewReader(os.Stdin).ReadString('\n')
	if err != nil && line == "" {
		return "", errors.New("no key on standard input")
	}
	return line, nil
}

func run(args []string) error {
	if len(args) == 0 {
		return usage()
	}
	switch {
	case args[0] == "version":
		fmt.Println(version)
		return nil
	case args[0] == "help" || args[0] == "-h" || args[0] == "--help":
		if len(args) > 1 {
			fmt.Println(helpFor(args[1]))
		} else {
			fmt.Println(overview)
		}
		return nil
	case personCommands[args[0]]:
		return machine().person(args)
	}
	if !machineCommands[args[0]] {
		return fmt.Errorf("no command %q\n\n%s", args[0], overview)
	}
	log := slog.New(slog.NewJSONHandler(os.Stderr, nil))
	client, err := sdk.FromEnv(sdk.WithLogger(log))
	if err != nil {
		return err
	}
	ctx, cancel := context.WithTimeout(context.Background(), 10*time.Minute)
	defer cancel()
	switch args[0] {
	case "push":
		fs := flag.NewFlagSet("push", flag.ContinueOnError)
		scope := fs.String("scope", "", "scope of the run (defaults to the file name)")
		snapshot := fs.Bool("snapshot", false, "commit as a snapshot: entities in the scope the file no longer lists go missing")
		enrich := fs.Bool("enrich", false, "only add fields to entities that already exist")
		if err := fs.Parse(reorder(args[1:], "scope")); err != nil {
			return err
		}
		if fs.NArg() != 1 {
			return usage()
		}
		file, err := sdk.ReadCatalog(fs.Arg(0))
		if err != nil {
			return err
		}
		if len(file.Blueprints) > 0 {
			if _, err := client.OfferBlueprints(ctx, file.Blueprints); err != nil {
				return err
			}
		}
		if *scope == "" {
			*scope = strings.TrimSuffix(fs.Arg(0), ".yaml")
		}
		mode := sdk.Incremental
		if *snapshot {
			mode = sdk.Snapshot
		}
		var opts []sdk.RunOption
		if *enrich {
			opts = append(opts, sdk.EnrichOnly())
		}
		r, err := client.OpenRun(ctx, mode, *scope, opts...)
		if err != nil {
			return err
		}
		for _, e := range file.Entities {
			if err := r.Add(ctx, e); err != nil {
				_ = r.Fail(ctx, err.Error())
				return err
			}
		}
		res, err := r.Commit(ctx)
		if err != nil {
			return err
		}
		fmt.Printf("run %s %s: %d created, %d updated, %d unchanged, %d rejected, %d missing\n", res.ID, res.State, res.Counts.Created, res.Counts.Updated, res.Counts.Unchanged, res.Counts.Rejected, res.Counts.Missing)
		for _, e := range r.Rejected() {
			fmt.Fprintln(os.Stderr, "rejected:", e)
		}
		if len(r.Rejected()) > 0 {
			return fmt.Errorf("%d entities rejected", len(r.Rejected()))
		}
		return nil
	case "put", "patch":
		fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
		title := fs.String("title", "", "title")
		icon := fs.String("icon", "", "icon name, for this entity alone")
		var fields, relations multi
		fs.Var(&fields, "field", "k=v (repeatable)")
		fs.Var(&relations, "relation", "r=target (repeatable; comma-separate several targets)")
		enrich := fs.Bool("enrich", false, "only add fields to an entity that already exists")
		if err := fs.Parse(reorder(args[1:], "title", "icon", "field", "relation")); err != nil {
			return err
		}
		if fs.NArg() != 2 {
			return usage()
		}
		e := sdk.Entity{Blueprint: fs.Arg(0), Key: fs.Arg(1), Title: *title, Icon: *icon, Fields: map[string]any{}, Relations: map[string]any{}}
		for _, kv := range fields {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				return fmt.Errorf("--field wants k=v, got %q", kv)
			}
			e.Fields[k] = parseValue(v)
		}
		for _, kv := range relations {
			k, v, ok := strings.Cut(kv, "=")
			if !ok {
				return fmt.Errorf("--relation wants r=target, got %q", kv)
			}
			if strings.Contains(v, ",") {
				e.Relations[k] = strings.Split(v, ",")
			} else {
				e.Relations[k] = v
			}
		}
		var opts []sdk.WriteOption
		if *enrich {
			opts = append(opts, sdk.Enrich())
		}
		if args[0] == "put" {
			return client.Put(ctx, e, opts...)
		}
		return client.Patch(ctx, e, opts...)
	case "delete":
		if len(args) != 3 {
			return usage()
		}
		return client.Delete(ctx, args[1], args[2])
	case "heartbeat":
		return client.Heartbeat(ctx)
	case "refresh-git":
		if len(args) != 2 {
			return usage()
		}
		return client.RefreshGitSource(ctx, args[1])
	case "report":
		id, report, err := reportOf(args[1:])
		if err != nil {
			return err
		}
		return client.ReportActionRun(ctx, id, report)
	default:
		return usage()
	}
}

// reorder moves positional arguments after the flags, so flags may follow
// them on the command line. valueFlags name the flags that take a value.
func reorder(args []string, valueFlags ...string) []string {
	takesValue := map[string]bool{}
	for _, f := range valueFlags {
		takesValue[f] = true
	}
	var flags, positional []string
	for i := 0; i < len(args); i++ {
		a := args[i]
		if !strings.HasPrefix(a, "-") {
			positional = append(positional, a)
			continue
		}
		flags = append(flags, a)
		name := strings.TrimLeft(a, "-")
		if !strings.Contains(name, "=") && takesValue[name] && i+1 < len(args) {
			i++
			flags = append(flags, args[i])
		}
	}
	return append(flags, positional...)
}

// reportOf reads the report subcommand's arguments into the run it is about and what to say of it.
func reportOf(args []string) (string, sdk.ActionReport, error) {
	fs := flag.NewFlagSet("report", flag.ContinueOnError)
	state := fs.String("state", "", "running, succeeded, or failed; a terminal state closes the run")
	label := fs.String("label", "", "what the backend is doing, in a few words")
	link := fs.String("link", "", "where to watch the run")
	summary := fs.String("summary", "", "what came of it")
	step := fs.String("step", "", "the step the run is in from here on; the last is named Verify")
	var lines, outputs multi
	fs.Var(&lines, "log", "a log line (repeatable)")
	fs.Var(&outputs, "output", "name=value, a value the run ends with, sent as text (repeatable)")
	if err := fs.Parse(reorder(args, "state", "label", "link", "summary", "step", "output", "log")); err != nil {
		return "", sdk.ActionReport{}, err
	}
	if fs.NArg() != 1 {
		return "", sdk.ActionReport{}, usage()
	}
	report := sdk.ActionReport{State: *state, Label: *label, Link: *link, Summary: *summary, Step: *step, Log: lines}
	for _, kv := range outputs {
		k, v, ok := strings.Cut(kv, "=")
		if !ok || k == "" {
			return "", sdk.ActionReport{}, fmt.Errorf("--output wants name=value, got %q", kv)
		}
		if report.Outputs == nil {
			report.Outputs = map[string]any{}
		}
		report.Outputs[k] = v
	}
	return fs.Arg(0), report, nil
}

type multi []string

func (m *multi) String() string     { return strings.Join(*m, ",") }
func (m *multi) Set(v string) error { *m = append(*m, v); return nil }

// parseValue turns "3" into 3, "true" into true, "{...}" into an object, and
// leaves everything else a string.
func parseValue(v string) any {
	if n, err := strconv.ParseFloat(v, 64); err == nil {
		return n
	}
	if b, err := strconv.ParseBool(v); err == nil {
		return b
	}
	if strings.HasPrefix(v, "{") || strings.HasPrefix(v, "[") {
		var out any
		if err := jsonUnmarshal(v, &out); err == nil {
			return out
		}
	}
	if v == "null" {
		return nil
	}
	return v
}
