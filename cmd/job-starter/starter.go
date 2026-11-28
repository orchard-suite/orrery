package main

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"sort"
	"sync"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
)

// Job is a run the hub handed over to be started: what it rendered, and the
// credential made for that run alone.
type Job struct {
	Run       string            `json:"run"`
	Action    string            `json:"action"`
	Try       int               `json:"try"`
	Template  string            `json:"template"`
	Image     string            `json:"image"`
	Command   []string          `json:"command"`
	Args      []string          `json:"args"`
	Env       map[string]string `json:"env"`
	Token     string            `json:"token"`
	CeilingMs int64             `json:"ceilingMs"`
}

// Run is a run this starter claimed, as the hub holds it now.
type Run struct {
	Run       string `json:"run"`
	Try       int    `json:"try"`
	State     string `json:"state"`
	StartedAt string `json:"startedAt"`
	CeilingMs int64  `json:"ceilingMs"`
	// Summary is what the run's own job said of it, when it said anything.
	Summary string `json:"summary"`
}

// Phase is where a job is on its platform.
type Phase int

const (
	Active Phase = iota
	Succeeded
	Failed
)

// Seen is one job this starter started that its platform still shows.
type Seen struct {
	Run string
	Try int
	// Ref is the platform's own name for it, for a person to find it by.
	Ref      string
	Template string
	Phase    Phase
	// Started says its container has started. A platform that cannot tell says true.
	Started bool
	// Why is why it failed, or what it waits for while it has not started.
	Why     string
	Created time.Time
	// Ended is when it ended, when the platform says.
	Ended time.Time
}

// Platform is where jobs run. The starter holds one right on it: to start a
// job from a template the estate owns, see it, and stop it.
type Platform interface {
	// Start starts the job of one try of a run. Asked again for the same
	// try, it starts nothing more. It answers the platform's name for the job.
	Start(ctx context.Context, t Template, j Job) (string, error)
	// Seen is every job this starter started that the platform still shows.
	Seen(ctx context.Context) ([]Seen, error)
	// Stop ends a job. One already gone is no error.
	Stop(ctx context.Context, s Seen) error
}

// Hub is what the starter asks of the hub: the runs to start, how the runs
// it claimed stand, and a report on one.
type Hub interface {
	Claim(ctx context.Context, max int) ([]Job, error)
	Runs(ctx context.Context, seen []string) ([]Run, error)
	Report(ctx context.Context, run string, r sdk.ActionReport) error
}

// What a job is handed, beside the action's own environment.
const (
	EnvURL    = "ORRERY_URL"
	EnvToken  = "ORRERY_TOKEN"
	EnvRun    = "ORRERY_RUN"
	EnvAction = "ORRERY_ACTION"
	// On a platform with no labels, these two are how a job is found again.
	EnvTry     = "ORRERY_TRY"
	EnvStarter = "ORRERY_STARTER"
)

// How the starter judges what it sees.
const (
	// A run claimed this recently may not show on the platform yet.
	settleFor = 2 * time.Minute
	// A job that ended longer ago than this is no longer asked about.
	seenFor = 24 * time.Hour
	// The most runs one ask of the hub names (STARTER_SEEN_MAX in the hub).
	seenMax = 1000
)

// Starter starts one job for each run the hub hands it, and keeps the hub
// told about every job it started. It keeps nothing between passes: what it
// holds is what the hub says it claimed and what the platform shows, so a
// starter that restarts carries on where the last one stopped.
type Starter struct {
	Hub      Hub
	Platform Platform
	Config   Config
	Log      *slog.Logger
	Now      func() time.Time

	mu       sync.Mutex
	starting map[string]bool
}

func (s *Starter) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Starter) mark(run string, on bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.starting == nil {
		s.starting = map[string]bool{}
	}
	if on {
		s.starting[run] = true
	} else {
		delete(s.starting, run)
	}
}

func (s *Starter) isStarting(run string) bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.starting[run]
}

// report tells the hub about a run. A run that ended meanwhile refuses it,
// which is no failure of the starter's.
func (s *Starter) report(ctx context.Context, run string, r sdk.ActionReport) {
	err := s.Hub.Report(ctx, run, r)
	var refused *sdk.APIError
	switch {
	case err == nil:
	case errors.As(err, &refused) && refused.Status == 409:
		s.Log.Info("report not taken: the run had ended", "run", run, "state", r.State, "answer", refused.Message)
	default:
		s.Log.Error("report failed", "run", run, "state", r.State, "error", err)
	}
}

// Take starts the job of one run the hub handed over, or fails the run with
// why it could not. The estate's config decides: a template the starter does
// not have, or an image the template does not allow, starts nothing, and is
// final, since asking again changes nothing.
func (s *Starter) Take(ctx context.Context, j Job) {
	s.mark(j.Run, true)
	defer s.mark(j.Run, false)
	t, ok := s.Config.Templates[j.Template]
	if !ok {
		s.Log.Warn("job refused: no such template", "run", j.Run, "action", j.Action, "template", j.Template)
		s.report(ctx, j.Run, sdk.ActionReport{State: "failed", Summary: fmt.Sprintf("the starter has no job template %q", j.Template), Log: []string{"::final::", fmt.Sprintf("its templates are: %s", s.Config.names())}})
		return
	}
	if !t.Allows(j.Image) {
		s.Log.Warn("job refused: image not allowed", "run", j.Run, "action", j.Action, "template", j.Template, "image", j.Image)
		s.report(ctx, j.Run, sdk.ActionReport{State: "failed", Summary: fmt.Sprintf("template %q does not allow the image %q", j.Template, j.Image), Log: []string{"::final::", "the estate's starter config names the images each template may run"}})
		return
	}
	ref, err := s.Platform.Start(ctx, t, j)
	if err != nil {
		s.Log.Error("job not started", "run", j.Run, "action", j.Action, "template", j.Template, "error", err)
		s.report(ctx, j.Run, sdk.ActionReport{State: "failed", Summary: "its job could not be started: " + err.Error()})
		return
	}
	s.Log.Info("job started", "run", j.Run, "action", j.Action, "try", j.Try, "template", j.Template, "image", j.Image, "job", ref)
	s.report(ctx, j.Run, sdk.ActionReport{Label: "job " + ref, Log: []string{fmt.Sprintf("started job %s from template %s, image %s", ref, j.Template, j.Image)}})
}

// Pass looks at every job the platform shows and every run the hub says this
// starter holds, once. A running run whose job is alive is said to be alive;
// one whose job ended is ended as the job did; one whose job is gone ends
// unknown; and the job of a run that was cancelled, or ran past its ceiling,
// or never started, is stopped. A platform or a hub that cannot be read
// judges nothing: the pass is given up and the next one looks again.
func (s *Starter) Pass(ctx context.Context) error {
	all, err := s.Platform.Seen(ctx)
	if err != nil {
		return fmt.Errorf("reading the platform: %w", err)
	}
	now := s.now()
	seen := make([]Seen, 0, len(all))
	for _, j := range all {
		if j.Phase == Active || j.Ended.IsZero() || now.Sub(j.Ended) < seenFor {
			seen = append(seen, j)
		}
	}
	// The jobs still going are asked about first, should there be more than one ask names.
	sort.SliceStable(seen, func(a, b int) bool { return seen[a].Phase == Active && seen[b].Phase != Active })
	ids := make([]string, 0, len(seen))
	named := map[string]bool{}
	for _, j := range seen {
		if !named[j.Run] && len(ids) < seenMax {
			named[j.Run] = true
			ids = append(ids, j.Run)
		}
	}
	runs, err := s.Hub.Runs(ctx, ids)
	if err != nil {
		return fmt.Errorf("asking the hub how the runs stand: %w", err)
	}
	held := map[string]Run{}
	for _, r := range runs {
		held[r.Run] = r
	}
	carried := map[string]bool{}
	for _, j := range seen {
		r, ok := held[j.Run]
		if !ok {
			s.Log.Debug("job left alone: the hub does not say its run is this starter's", "run", j.Run, "job", j.Ref)
			continue
		}
		if j.Try != r.Try {
			// A try the run has moved on from: its job ended when the try did.
			if j.Try < r.Try && j.Phase == Active {
				s.stop(ctx, j, "the run moved on to another try")
			}
			continue
		}
		carried[j.Run] = true
		s.settle(ctx, r, j)
	}
	for _, r := range runs {
		if r.State != "running" || carried[r.Run] || s.isStarting(r.Run) {
			continue
		}
		if started, err := time.Parse(time.RFC3339Nano, r.StartedAt); err != nil || now.Sub(started) < settleFor {
			s.Log.Debug("run kept: it was claimed a moment ago, and its job may not show yet", "run", r.Run)
			continue
		}
		s.Log.Warn("run ended unknown: its job is gone", "run", r.Run, "try", r.Try)
		s.report(ctx, r.Run, sdk.ActionReport{State: "unknown", Summary: "its job is gone: nothing on the platform carries this run, so nobody saw how it ended"})
	}
	return nil
}

// settle does what one job of a run's current try asks for.
func (s *Starter) settle(ctx context.Context, r Run, j Seen) {
	if r.State != "running" && r.State != "unknown" {
		// The run ended without this job's word: cancelled, most often. Its job is stopped.
		if j.Phase == Active {
			s.stop(ctx, j, "its run is "+r.State)
		}
		return
	}
	switch j.Phase {
	case Succeeded:
		s.Log.Info("job ended", "run", r.Run, "job", j.Ref, "state", "succeeded")
		s.report(ctx, r.Run, sdk.ActionReport{State: "succeeded", Log: []string{fmt.Sprintf("job %s ended: succeeded", j.Ref)}})
	case Failed:
		why := j.Why
		if why == "" {
			why = "its container did not end well"
		}
		s.Log.Info("job ended", "run", r.Run, "job", j.Ref, "state", "failed", "why", why)
		s.report(ctx, r.Run, sdk.ActionReport{State: "failed", Summary: orSaid(r.Summary, why), Log: []string{fmt.Sprintf("job %s ended: failed: %s", j.Ref, why)}})
	case Active:
		now := s.now()
		ceiling := time.Duration(r.CeilingMs) * time.Millisecond
		started, err := time.Parse(time.RFC3339Nano, r.StartedAt)
		switch {
		case err == nil && ceiling > 0 && now.Sub(started) > ceiling:
			why := fmt.Sprintf("it ran past its ceiling of %s", ceiling)
			s.stop(ctx, j, why)
			s.report(ctx, r.Run, sdk.ActionReport{State: "failed", Summary: "stopped: " + why, Log: []string{"::final::", fmt.Sprintf("job %s stopped: %s", j.Ref, why)}})
		case !j.Started && !j.Created.IsZero() && now.Sub(j.Created) > s.Config.StartWithin:
			why := fmt.Sprintf("its container did not start within %s", s.Config.StartWithin)
			if j.Why != "" {
				why += ": " + j.Why
			}
			s.stop(ctx, j, why)
			s.report(ctx, r.Run, sdk.ActionReport{State: "failed", Summary: why, Log: []string{fmt.Sprintf("job %s stopped: %s", j.Ref, why)}})
		case r.State == "running":
			// A report that carries nothing says the run is alive.
			s.report(ctx, r.Run, sdk.ActionReport{})
		}
	}
}

func (s *Starter) stop(ctx context.Context, j Seen, why string) {
	if err := s.Platform.Stop(ctx, j); err != nil {
		s.Log.Error("job not stopped", "run", j.Run, "job", j.Ref, "why", why, "error", err)
		return
	}
	s.Log.Info("job stopped", "run", j.Run, "job", j.Ref, "why", why)
}

// orSaid is what the job said of its run, or else what the platform says.
func orSaid(said, fallback string) string {
	if said != "" {
		return said
	}
	return fallback
}
