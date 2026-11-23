package main

import (
	"context"
	"errors"
	"fmt"
	"net/http"
	"strings"
	"time"

	"github.com/orchard-suite/orrery/cmd/internal/containerapps"
)

// apiVersion is the Container Apps API it speaks.
const apiVersion = containerapps.APIVersion

// Job is a Container Apps job's resource id read as what it is.
type Job = containerapps.Job

// ParseJob takes the resource id of a Container Apps job, or says why not.
func ParseJob(id string) (Job, error) { return containerapps.ParseJob(id) }

// Tokens gives an ARM token in a tenant.
type Tokens = containerapps.Tokens

// Starter starts jobs through ARM at Root, signing in to the tenant each
// job's subscription belongs to.
type Starter struct {
	Root   string
	Tokens Tokens
	HTTP   *http.Client
	// How often a started execution is asked after.
	Every time.Duration
	Log   func(msg string, args ...any)
}

// arm is the client the starter's calls go through.
func (s Starter) arm() containerapps.Client {
	return containerapps.Client{Root: s.Root, Tokens: s.Tokens, HTTP: s.HTTP}
}

// ErrWaitRanOut marks an execution still going when the wait ended.
var ErrWaitRanOut = errors.New("the wait ran out")

// The steps of a start, as the run's page shows them. A line that carries
// `step` starts it, and the lines after it are its own. Run is the execution
// itself, followed to its end: nothing is looked at after it, so there is no
// Verify.
const (
	StepSignIn = "Sign in"
	StepStart  = "Start"
	StepRun    = "Run"
)

// Outcome is how one execution ended: its name, its last status, and how
// long it ran by Azure's own clock when Azure says, else by this one.
type Outcome struct {
	Execution, Status string
	Took              time.Duration
}

// Succeeded says whether the execution ended well.
func (o Outcome) Succeeded() bool { return strings.EqualFold(o.Status, "Succeeded") }

// terminal is every status an execution does not leave.
var terminal = map[string]bool{"succeeded": true, "failed": true, "stopped": true, "degraded": true}

// execution is what Azure says of one execution of a job.
type execution = containerapps.Execution

// TenantOf asks ARM which tenant a subscription belongs to.
func (s Starter) TenantOf(ctx context.Context, subscription string) (string, error) {
	return s.arm().TenantOf(ctx, subscription)
}

// Start starts one execution of the job and follows it until it ends or ctx
// does. An execution that ends badly is an Outcome, not an error: the error
// is for a start Azure refused or an execution that could not be followed.
func (s Starter) Start(ctx context.Context, j Job) (Outcome, error) {
	tenant, err := s.TenantOf(ctx, j.Subscription)
	if err != nil {
		return Outcome{}, err
	}
	s.Log(fmt.Sprintf("Signing in to tenant %s, which holds subscription %s", tenant, j.Subscription), "step", StepSignIn)
	token, err := s.Tokens(ctx, tenant)
	if err != nil {
		return Outcome{}, fmt.Errorf("sign-in to tenant %s: %w", tenant, err)
	}
	asked := time.Now()
	s.Log(fmt.Sprintf("Asking Azure to start %s", j.Name), "step", StepStart)
	name, err := s.arm().Start(ctx, j, token, nil)
	if err != nil {
		return Outcome{}, err
	}
	if name == "" {
		// Azure took the start without naming the execution: it is the newest one that started since.
		if name, err = s.newest(ctx, j, token, asked); err != nil {
			return Outcome{}, err
		}
	}
	s.Log(fmt.Sprintf("Azure started %s as %s; following it", j.Name, name), "execution", name, "step", StepRun)
	last := ""
	misses := 0
	for {
		var e execution
		if err := s.get(ctx, j.ID+"/executions/"+name+"?api-version="+apiVersion, token, &e); err != nil {
			if ctx.Err() != nil {
				return s.ranOut(name, last, asked)
			}
			if !passing(err) {
				return Outcome{Execution: name, Status: last, Took: time.Since(asked)}, fmt.Errorf("following %s: %w", name, err)
			}
			if misses++; misses >= followTries {
				return Outcome{Execution: name, Status: last, Took: time.Since(asked)}, fmt.Errorf("following %s after %d tries: %w", name, misses, err)
			}
			s.Log(fmt.Sprintf("Lost sight of %s for a moment (%v); asking again", name, err))
			select {
			case <-ctx.Done():
				return s.ranOut(name, last, asked)
			case <-time.After(s.Every * time.Duration(misses)):
			}
			continue
		}
		misses = 0
		status := e.Properties.Status
		if status != last {
			s.Log(fmt.Sprintf("%s is %s", name, strings.ToLower(status)), "status", status)
			last = status
		}
		if terminal[strings.ToLower(status)] {
			return Outcome{Execution: name, Status: status, Took: took(e, asked)}, nil
		}
		select {
		case <-ctx.Done():
			return s.ranOut(name, status, asked)
		case <-time.After(s.Every):
		}
	}
}

// ranOut is an execution the wait ended on, in the status it was last seen in.
func (s Starter) ranOut(name, status string, asked time.Time) (Outcome, error) {
	seen := "running"
	if status != "" {
		seen = strings.ToLower(status)
	}
	return Outcome{Execution: name, Status: status, Took: time.Since(asked)}, fmt.Errorf("%w: %s was still %s", ErrWaitRanOut, name, seen)
}

// newest finds the execution that started at or after asked, waiting for it to show.
func (s Starter) newest(ctx context.Context, j Job, token string, asked time.Time) (string, error) {
	for {
		var list struct {
			Value []execution `json:"value"`
		}
		if err := s.get(ctx, j.ID+"/executions?api-version="+apiVersion, token, &list); err != nil {
			return "", fmt.Errorf("finding the execution: %w", err)
		}
		var best string
		var at time.Time
		for _, e := range list.Value {
			t, err := time.Parse(time.RFC3339Nano, e.Properties.StartTime)
			// A second of slack: Azure's clock and this one differ.
			if err == nil && !t.Before(asked.Add(-time.Second)) && t.After(at) {
				best, at = e.Name, t
			}
		}
		if best != "" {
			return best, nil
		}
		select {
		case <-ctx.Done():
			return "", fmt.Errorf("Azure took the start of %s, but no execution of it showed", j.Name)
		case <-time.After(s.Every):
		}
	}
}

// took is how long an ended execution ran by Azure's clock, else since it was asked.
func took(e execution, asked time.Time) time.Duration {
	start, err1 := time.Parse(time.RFC3339Nano, e.Properties.StartTime)
	end, err2 := time.Parse(time.RFC3339Nano, e.Properties.EndTime)
	if err1 == nil && err2 == nil && end.After(start) {
		return end.Sub(start)
	}
	return time.Since(asked)
}

// get reads one ARM path into out, or says why not.
func (s Starter) get(ctx context.Context, path, token string, out any) error {
	return s.arm().Get(ctx, path, token, out)
}

// followTries is how many reads of an execution in a row may fail in passing
// before it is given up on.
const followTries = 5

// passing says whether a failed read may succeed if asked again.
func passing(err error) bool { return containerapps.Passing(err) }
