// Command azure-restart restarts one Azure resource for a self-service action
// a runner carries out: a web app, a function app, a slot, or a virtual
// machine, named by its resource id. It signs in as its own workload identity,
// never with a secret, to the tenant the resource's subscription belongs to,
// so one identity serves every tenant whose admin consented to its app. The
// identity needs only the restart actions (docs/actions.md, Restarting Azure
// resources); the hub decides who may restart what.
//
// Usage:
//
//	azure-restart [--url <app address>] [--health <health check path>] [--wait 10m] <resource id>
//
// An app's restart waits until Azure has restarted it. With --url it then
// asks the app until it answers, at its health check path when --health
// names one, for up to --wait. Without --url, or for a virtual machine, the
// restart is done when Azure says so.
//
// Environment:
//
//	AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE, AZURE_AUTHORITY_HOST
//	                the identity it signs in as. AZURE_CLIENT_ID is a
//	                multi-tenant app when a resource lives in another tenant.
//	ARM_URL         Azure Resource Manager; https://management.azure.com when unset.
//
// It writes JSON lines to stdout, which the runner streams into the run's
// log; the last carries `summary`, which the runner makes the run's summary.
// The line that starts a step carries `step`: Sign in, Restart, and, for an
// app, Verify.
// It exits 0 when the resource restarted and, when asked, answered; 1 when it
// failed; and 2 when it was asked wrongly.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/workload"
)

var version = "dev"

// How often a restarted app is asked whether it is back.
var answerEvery = 5 * time.Second

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "azure-restart", "version", version)
	os.Exit(run(context.Background(), os.Args[1:], log, workload.FromEnv, os.Getenv("ARM_URL")))
}

// run restarts what args name and says how it went, returning the exit code.
func run(ctx context.Context, args []string, log *slog.Logger, identity func() (workload.Identity, error), arm string) int {
	fs := flag.NewFlagSet("azure-restart", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	address := fs.String("url", "", "the app's address, to ask once it restarted")
	health := fs.String("health", "", "the app's health check path, which must answer 2xx")
	wait := fs.Duration("wait", 10*time.Minute, "how long the app may take to answer")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		log.Error("Usage: azure-restart [--url <address>] [--health <path>] [--wait 10m] <resource id>", "summary", "The restart was asked for wrongly")
		return 2
	}
	target, err := ParseTarget(fs.Arg(0))
	if err != nil {
		log.Error(err.Error(), "summary", "The restart was asked for wrongly: "+err.Error())
		return 2
	}
	id, err := identity()
	if err != nil {
		log.Error(err.Error(), "summary", "The runner has no Azure identity to restart with")
		return 2
	}
	root := strings.TrimRight(arm, "/")
	if root == "" {
		root = "https://management.azure.com"
	}
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	probe, asked := ProbeFor(*address, *health)
	where := "its address"
	if probe.Health {
		where = "its health check"
	}
	r := Restarter{
		Root: root,
		Tokens: func(ctx context.Context, tenant string) (string, error) {
			return id.Token(ctx, tenant, root+"/.default")
		},
		// One call waits no longer than the run may.
		HTTP:  &http.Client{Timeout: 15 * time.Minute},
		Every: answerEvery,
		Log:   func(msg string, args ...any) { log.Info(msg, args...) },
	}
	if asked && target.Kind == "app" {
		// A restarted app starts a worker on its first request. One ask is enough; it is not waited for long.
		wake := &http.Client{Timeout: 30 * time.Second}
		r.Wake = func(ctx context.Context) {
			if req, err := http.NewRequestWithContext(ctx, http.MethodGet, probe.URL, nil); err == nil {
				if res, err := wake.Do(req); err == nil {
					res.Body.Close()
				}
			}
		}
	}
	// The restart and the app's answer share one wait, inside the run's own timeout.
	ctx, cancel := context.WithTimeout(ctx, *wait)
	defer cancel()
	started := time.Now()
	out, err := r.Restart(ctx, target)
	if err != nil {
		log.Error(fmt.Sprintf("The restart of %s failed: %v", target.Name, err), "summary", fmt.Sprintf("%s did not restart: %v", target.Name, err))
		return 1
	}
	restarted := time.Since(started).Round(time.Second)
	said := upper(out.Said)
	if out.Sure {
		log.Info(said)
	} else {
		log.Warn(fmt.Sprintf("Azure %s, so it is not known to have restarted", out.Said))
	}
	if target.Kind != "app" || !asked {
		log.Info("Done", "summary", summarize(out, restarted, ""))
		return 0
	}
	log.Info(fmt.Sprintf("Asking %s at %s until it answers", target.Name, probe.URL), "step", StepVerify)
	answer, err := r.WaitForAnswer(ctx, probe)
	total := time.Since(started).Round(time.Second)
	switch {
	case err != nil:
		log.Error(fmt.Sprintf("%s did not answer: %v", target.Name, err), "summary", fmt.Sprintf("%s, but %s did not answer within %s: %v", said, where, *wait, err))
		return 1
	case answer.Closed:
		log.Warn(fmt.Sprintf("%s answered %d: the runner may not reach it, so this does not show the app is back", probe.URL, answer.Status), "summary", summarize(out, total, fmt.Sprintf("%s answered %d, which does not show it is back", where, answer.Status)))
	default:
		log.Info(fmt.Sprintf("%s answered %d", probe.URL, answer.Status), "summary", summarize(out, total, fmt.Sprintf("%s answered %d", where, answer.Status)))
	}
	return 0
}

// summarize is the run's summary: what came of the restart, what the app answered, and how long it all took.
func summarize(out Outcome, took time.Duration, answered string) string {
	s := upper(out.Said)
	if answered != "" {
		if out.Sure {
			s += ", and " + answered
		} else {
			s += "; " + answered + ", which may be the worker that ran before"
		}
	}
	return fmt.Sprintf("%s. %s in all.", s, took)
}

func upper(s string) string {
	if s == "" {
		return s
	}
	return strings.ToUpper(s[:1]) + s[1:]
}
