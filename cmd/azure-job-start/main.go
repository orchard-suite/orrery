// Command azure-job-start starts one Azure Container Apps job for a
// self-service action a runner carries out, named by its resource id, and
// follows the execution it started until it ends. Use it to run a scheduled
// job now, such as a pusher, instead of waiting for its schedule. It signs in
// as its own workload identity, never with a secret, to the tenant the job's
// subscription belongs to. The identity needs only the job actions
// (docs/actions.md, Starting Azure Container Apps jobs); the hub decides who
// may start what.
//
// Usage:
//
//	azure-job-start [--wait 20m] <job resource id>
//
// Environment:
//
//	AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE, AZURE_AUTHORITY_HOST
//	                the identity it signs in as. AZURE_CLIENT_ID is a
//	                multi-tenant app when a job lives in another tenant.
//	ARM_URL         Azure Resource Manager; https://management.azure.com when unset.
//
// It writes JSON lines to stdout, which the runner streams into the run's
// log; the last carries `summary`, which the runner makes the run's summary.
// The line that starts a step carries `step`: Sign in, Start, and Run.
// It exits 0 when the execution succeeded; 1 when it failed, stopped, was
// degraded, did not end within --wait, or could not be started; and 2 when
// it was asked wrongly.
package main

import (
	"context"
	"errors"
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

	"github.com/orchard-suite/orrery/v3/cmd/internal/workload"
)

var version = "dev"

// How often a started execution is asked after.
var pollEvery = 10 * time.Second

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "azure-job-start", "version", version)
	os.Exit(run(context.Background(), os.Args[1:], log, workload.FromEnv, os.Getenv("ARM_URL")))
}

// run starts the job args name, follows it, and says how it went, returning the exit code.
func run(ctx context.Context, args []string, log *slog.Logger, identity func() (workload.Identity, error), arm string) int {
	fs := flag.NewFlagSet("azure-job-start", flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	wait := fs.Duration("wait", 20*time.Minute, "how long the execution may take to end")
	if err := fs.Parse(args); err != nil || fs.NArg() != 1 {
		log.Error("Usage: azure-job-start [--wait 20m] <job resource id>", "summary", "The job was asked for wrongly")
		return 2
	}
	job, err := ParseJob(fs.Arg(0))
	if err != nil {
		log.Error(err.Error(), "summary", "The job was asked for wrongly: "+err.Error())
		return 2
	}
	id, err := identity()
	if err != nil {
		log.Error(err.Error(), "summary", "The runner has no Azure identity to start the job with")
		return 2
	}
	root := strings.TrimRight(arm, "/")
	if root == "" {
		root = "https://management.azure.com"
	}
	ctx, stop := signal.NotifyContext(ctx, syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	s := Starter{
		Root: root,
		Tokens: func(ctx context.Context, tenant string) (string, error) {
			return id.Token(ctx, tenant, root+"/.default")
		},
		HTTP:  &http.Client{Timeout: time.Minute},
		Every: pollEvery,
		Log:   func(msg string, args ...any) { log.Info(msg, args...) },
	}
	ctx, cancel := context.WithTimeout(ctx, *wait)
	defer cancel()
	out, err := s.Start(ctx, job)
	took := out.Took.Round(time.Second)
	switch {
	case errors.Is(err, ErrWaitRanOut):
		log.Error(err.Error(), "summary", fmt.Sprintf("%s did not end within %s: %s", job.Name, *wait, err))
		return 1
	case err != nil && out.Execution != "":
		log.Error(err.Error(), "summary", fmt.Sprintf("%s started as %s, but could not be followed: %v", job.Name, out.Execution, err))
		return 1
	case err != nil:
		log.Error(fmt.Sprintf("Starting %s failed: %v", job.Name, err), "summary", fmt.Sprintf("%s did not start: %v", job.Name, err))
		return 1
	case !out.Succeeded():
		log.Error(fmt.Sprintf("%s ended %s", out.Execution, strings.ToLower(out.Status)), "summary", fmt.Sprintf("%s ran for %s and ended %s.", job.Name, took, strings.ToLower(out.Status)))
		return 1
	}
	log.Info("Done", "summary", fmt.Sprintf("%s ran for %s and succeeded.", job.Name, took))
	return 0
}
