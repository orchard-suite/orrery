// Command entra-grant gives and takes away access in Entra, for a
// self-service action a runner carries out: it assigns a user a role on an
// enterprise app or takes an assignment away, adds a user to a group or
// removes them, and carries out an access review. It signs in as its own
// workload identity, never with a secret, and is idempotent: access already
// held is success when giving, and access already gone is success when
// taking away.
//
// Usage:
//
//	entra-grant assign --app <entra_app key or client id> --user <entra_user key, object id, or email> --role <value or default> [--approval <it_approval key> --by <email>]
//	entra-grant add-to-group --group <entra_group key or object id> --user <...> [--approval <it_approval key> --by <email>]
//	entra-grant unassign --app <...> (--user <...> | --group <...>) --role <value or default>
//	entra-grant remove-from-group --group <...> --user <...>
//	entra-grant review --application <it_application key> --app <entra_app key>... --key <it_access_review key> --by <email> [--note <text>] [<entra_app_role_assignment key>...]
//
// A review takes away each assignment listed after the flags, then writes one
// it_access_review: who reviewed, when, how many assignments the apps kept and
// lost, and which. --app may be given once per app the application signs in
// through.
//
// Environment:
//
//	AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE, AZURE_AUTHORITY_HOST
//	                the identity it signs in as. It needs leave to change the app's
//	                assignments or the group's members: docs/actions.md, Granting access in Entra.
//	ORRERY_URL, ORRERY_TOKEN
//	                with --approval or review: the hub, and a source token registered
//	                for it_approval to mark the approval approved once access is given,
//	                or for it_access_review to record the review.
//
// It writes JSON lines to stdout, which the runner streams into the run's log,
// and exits 0 when it did what was asked, 1 when it failed, and 2 when it was
// asked wrongly. The line that starts a step carries `step`: Sign in, then
// Give access and Close the approval, or Remove access, or Review and Record
// the review.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	"github.com/orchard-suite/orrery/v3/cmd/internal/graph"
	"github.com/orchard-suite/orrery/v3/cmd/internal/workload"
	"github.com/orchard-suite/orrery/v3/sdk"
)

var version = "dev"

// Request is one change asked for on the command line.
type Request struct {
	Command, App, Group, User, Role, Approval, By string
	// Application, Key, Note, Apps, and Remove are a review's.
	Application, Key, Note string
	Apps, Remove           []string
}

const commands = "assign, add-to-group, unassign, remove-from-group, or review"

// ParseArgs reads a change from the command line.
func ParseArgs(args []string, stderr io.Writer) (Request, error) {
	if len(args) == 0 {
		return Request{}, fmt.Errorf("say %s", commands)
	}
	r := Request{Command: args[0]}
	fs := flag.NewFlagSet("entra-grant "+r.Command, flag.ContinueOnError)
	fs.SetOutput(stderr)
	required := map[string]*string{}
	str := func(p *string, name, usage string, need bool) {
		fs.StringVar(p, name, "", usage)
		if need {
			required[name] = p
		}
	}
	switch r.Command {
	case "assign":
		str(&r.App, "app", "the app: an entra_app key or its client id", true)
		str(&r.User, "user", "the user: an entra_user key, an object id, or an email", true)
		str(&r.Role, "role", "the role's value, or default for default access", true)
	case "add-to-group":
		str(&r.Group, "group", "the group: an entra_group key or its object id", true)
		str(&r.User, "user", "the user: an entra_user key, an object id, or an email", true)
	case "unassign":
		str(&r.App, "app", "the app: an entra_app key or its client id", true)
		str(&r.User, "user", "the user who holds the role: an entra_user key, an object id, or an email", false)
		str(&r.Group, "group", "the group that holds the role: an entra_group key or its object id", false)
		str(&r.Role, "role", "the role's value, or default for default access", true)
	case "remove-from-group":
		str(&r.Group, "group", "the group: an entra_group key or its object id", true)
		str(&r.User, "user", "the user: an entra_user key, an object id, or an email", true)
	case "review":
		str(&r.Application, "application", "the it_application key the review is of", true)
		str(&r.Key, "key", "the key of the it_access_review to write", true)
		str(&r.By, "by", "who reviewed", true)
		str(&r.Note, "note", "what the reviewer said, for the review", false)
		fs.Func("app", "an entra_app key or client id the application signs in through; once per app", func(v string) error {
			if v != "" {
				r.Apps = append(r.Apps, v)
			}
			return nil
		})
	default:
		return r, fmt.Errorf("%q is not %s", r.Command, commands)
	}
	if r.Command == "assign" || r.Command == "add-to-group" {
		str(&r.Approval, "approval", "the it_approval key to mark approved once access is given", false)
		str(&r.By, "by", "who approved, for the approval", false)
	}
	if err := fs.Parse(args[1:]); err != nil {
		return r, err
	}
	for name, v := range required {
		if *v == "" {
			return r, fmt.Errorf("--%s is required", name)
		}
	}
	rest := fs.Args()
	switch r.Command {
	case "review":
		if len(r.Apps) == 0 {
			return r, fmt.Errorf("--app is required")
		}
		// An empty argument is a list the action rendered with nothing in it.
		for _, key := range rest {
			if key != "" {
				r.Remove = append(r.Remove, key)
			}
		}
	case "unassign":
		if (r.User == "") == (r.Group == "") {
			return r, fmt.Errorf("give one of --user or --group")
		}
		fallthrough
	default:
		if len(rest) > 0 {
			return r, fmt.Errorf("unexpected %q", rest[0])
		}
	}
	return r, nil
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "entra-grant", "version", version)
	req, err := ParseArgs(os.Args[1:], os.Stderr)
	if err != nil {
		log.Error("usage", "error", err)
		os.Exit(2)
	}
	id, err := workload.FromEnv()
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	var hub *sdk.Client
	if req.Approval != "" || req.Command == "review" {
		if hub, err = sdk.FromEnv(sdk.WithLogger(log)); err != nil {
			log.Error("config: the hub is needed to record the outcome", "error", err)
			os.Exit(2)
		}
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	log.Info("signing in to Entra", "step", StepSignIn)
	g, err := graph.SignIn(ctx, id)
	if err != nil {
		log.Error("sign-in failed", "error", err)
		os.Exit(1)
	}
	gr := Granter{g: g}
	switch req.Command {
	case "assign", "add-to-group":
		os.Exit(grant(ctx, log, gr, hub, req))
	case "unassign", "remove-from-group":
		os.Exit(remove(ctx, log, gr, req))
	case "review":
		os.Exit(review(ctx, log, gr, hub, req))
	}
}

// The steps of a change, as the run's page shows them. A line that carries
// `step` starts it, and the lines after it are its own. None is a Verify:
// Entra's answer to the change is all that is read, and nothing is looked up
// again after it.
const (
	StepSignIn = "Sign in"
	StepGrant  = "Give access"
	StepClose  = "Close the approval"
	StepRemove = "Remove access"
	StepReview = "Review"
	StepRecord = "Record the review"
)

func grant(ctx context.Context, log *slog.Logger, gr Granter, hub *sdk.Client, req Request) int {
	var outcome Outcome
	var what string
	var err error
	log.Info("giving access", "command", req.Command, "step", StepGrant)
	if req.Command == "assign" {
		outcome, what, err = gr.Assign(ctx, req.App, req.User, req.Role)
	} else {
		outcome, what, err = gr.AddToGroup(ctx, req.Group, req.User)
	}
	if err != nil {
		log.Error("grant failed", "command", req.Command, "error", err)
		return 1
	}
	log.Info("access given", "command", req.Command, "outcome", string(outcome), "what", what)
	if hub == nil {
		return 0
	}
	log.Info("closing the approval", "approval", req.Approval, "step", StepClose)
	if err := hub.Patch(ctx, Approved(req, what, time.Now()), sdk.Enrich()); err != nil {
		log.Error("access given, but the approval could not be closed", "approval", req.Approval, "error", err)
		return 1
	}
	log.Info("approval closed", "approval", req.Approval)
	return 0
}

func remove(ctx context.Context, log *slog.Logger, gr Granter, req Request) int {
	var outcome Outcome
	var what string
	var err error
	log.Info("removing access", "command", req.Command, "step", StepRemove)
	if req.Command == "unassign" {
		holder := Holder{Kind: "user", Key: req.User}
		if req.Group != "" {
			holder = Holder{Kind: "group", Key: req.Group}
		}
		outcome, what, err = gr.Unassign(ctx, req.App, holder, req.Role)
	} else {
		outcome, what, err = gr.RemoveFromGroup(ctx, req.Group, req.User)
	}
	if err != nil {
		log.Error("removal failed", "command", req.Command, "error", err)
		return 1
	}
	log.Info("access removed", "command", req.Command, "outcome", string(outcome), "what", what, "summary", "Removed: "+what+".")
	return 0
}

func review(ctx context.Context, log *slog.Logger, gr Granter, hub *sdk.Client, req Request) int {
	log.Info("removing what the review took away", "application", req.Application, "picked", len(req.Remove), "step", StepReview)
	r, err := gr.Review(ctx, req.Apps, req.Remove)
	for _, rm := range r.Removed {
		log.Info("access removed", "command", req.Command, "outcome", string(rm.Outcome), "assignment", rm.Key, "what", rm.What)
	}
	if err != nil {
		log.Error("review failed before it was recorded; run it again to finish", "application", req.Application, "error", err)
		return 1
	}
	rec := Reviewed(req, r, time.Now())
	log.Info("recording the review", "review", rec.Key, "step", StepRecord)
	if err := hub.Put(ctx, rec); err != nil {
		log.Error("access removed, but the review could not be recorded", "application", req.Application, "error", err)
		return 1
	}
	log.Info("review recorded", "review", rec.Key, "application", req.Application, "kept", r.Kept, "removed", len(r.Removed),
		"summary", fmt.Sprintf("Reviewed: %d kept, %d removed.", r.Kept, len(r.Removed)))
	return 0
}

// Approved is the write that closes an approval once access is given.
func Approved(req Request, what string, at time.Time) sdk.Entity {
	fields := map[string]any{"decision": "approved", "decided_at": at.UTC().Format(time.RFC3339), "decision_note": "Granted: " + what + "."}
	if req.By != "" {
		fields["decided_by"] = req.By
	}
	return sdk.Entity{Blueprint: "it_approval", Key: req.Approval, Fields: fields}
}

// Reviewed is the it_access_review a review writes once its removals are done.
func Reviewed(req Request, r Review, at time.Time) sdk.Entity {
	removed := make([]string, len(r.Removed))
	for i, rm := range r.Removed {
		removed[i] = rm.Key
	}
	stamp := at.UTC().Format(time.RFC3339)
	fields := map[string]any{
		"reviewed_at":   stamp,
		"reviewed_by":   req.By,
		"system":        "entra",
		"kept_count":    r.Kept,
		"removed_count": len(r.Removed),
		"removed":       removed,
	}
	if req.Note != "" {
		fields["notes"] = req.Note
	}
	return sdk.Entity{
		Blueprint: "it_access_review",
		Key:       req.Key,
		Title:     "Access review by " + req.By,
		Fields:    fields,
		Relations: map[string]any{"application": req.Application},
	}
}
