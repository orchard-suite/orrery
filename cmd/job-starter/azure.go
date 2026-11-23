package main

import (
	"context"
	"errors"
	"fmt"
	"sort"
	"strconv"
	"strings"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/containerapps"
)

// ContainerApps starts each run as one execution of an Azure Container Apps
// job the estate owns: the job's own template, with the run's image, command,
// arguments, and environment on its container. An execution carries no
// label, so the run it is for is read back from its environment.
//
// An execution's environment is all it can be handed, so the run's
// credential is a value there, readable by whoever may read the job's
// executions. It reaches that one run, and ends with it.
type ContainerApps struct {
	Client  containerapps.Client
	Config  Config
	Starter string
	// HubURL is the hub's address as a job reaches it.
	HubURL string
}

// Build is the template one execution runs: the job's own containers, with
// the run's on the one the template names.
func (a ContainerApps) Build(t Template, own containerapps.Template, j Job) (containerapps.Template, error) {
	if len(own.Containers) == 0 {
		return own, fmt.Errorf("template %s: its job has no container", t.Name)
	}
	at := 0
	if t.Container != "" {
		at = -1
		for i, c := range own.Containers {
			if c.Name == t.Container {
				at = i
			}
		}
		if at < 0 {
			return own, fmt.Errorf("template %s: its job has no container %q", t.Name, t.Container)
		}
	}
	out := containerapps.Template{Containers: append([]containerapps.Container(nil), own.Containers...), InitContainers: own.InitContainers}
	c := out.Containers[at]
	c.Image = j.Image
	if len(j.Command) > 0 {
		c.Command = j.Command
	}
	if len(j.Args) > 0 {
		c.Args = j.Args
	}
	env := append([]containerapps.EnvVar(nil), c.Env...)
	set := func(name, value string) {
		for i := range env {
			if env[i].Name == name {
				env[i] = containerapps.EnvVar{Name: name, Value: value}
				return
			}
		}
		env = append(env, containerapps.EnvVar{Name: name, Value: value})
	}
	names := make([]string, 0, len(j.Env))
	for name := range j.Env {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		set(name, j.Env[name])
	}
	set(EnvURL, a.HubURL)
	set(EnvRun, j.Run)
	set(EnvAction, j.Action)
	set(EnvTry, strconv.Itoa(j.Try))
	set(EnvStarter, a.Starter)
	set(EnvToken, j.Token)
	c.Env = env
	out.Containers[at] = c
	return out, nil
}

// Start starts one execution for a try of a run, unless one of that try is
// there already.
func (a ContainerApps) Start(ctx context.Context, t Template, j Job) (string, error) {
	job, err := containerapps.ParseJob(t.Job)
	if err != nil {
		return "", err
	}
	_, token, err := a.Client.SignIn(ctx, job)
	if err != nil {
		return "", err
	}
	executions, err := a.Client.Executions(ctx, job, token)
	if err != nil {
		return "", fmt.Errorf("reading the executions of %s: %w", job.Name, err)
	}
	for _, e := range executions {
		if run, try, mine := a.runOf(e); mine && run == j.Run && try == j.Try {
			return job.ID + "/executions/" + e.Name, nil
		}
	}
	own, err := a.Client.Definition(ctx, job, token)
	if err != nil {
		return "", fmt.Errorf("reading the job %s: %w", job.Name, err)
	}
	with, err := a.Build(t, own, j)
	if err != nil {
		return "", err
	}
	name, err := a.Client.Start(ctx, job, token, &with)
	if err != nil {
		return "", err
	}
	return job.ID + "/executions/" + name, nil
}

// runOf reads which run and try an execution is for, and whether this
// starter started it.
func (a ContainerApps) runOf(e containerapps.Execution) (run string, try int, mine bool) {
	for _, c := range e.Properties.Template.Containers {
		var starter string
		for _, v := range c.Env {
			switch v.Name {
			case EnvRun:
				run = v.Value
			case EnvTry:
				try, _ = strconv.Atoi(v.Value)
			case EnvStarter:
				starter = v.Value
			}
		}
		if run != "" && starter == a.Starter {
			return run, try, true
		}
	}
	return "", 0, false
}

// Seen lists the executions this starter started, of every job its templates name.
func (a ContainerApps) Seen(ctx context.Context) ([]Seen, error) {
	// Two templates may start the same job: it is read once, by its id as the config wrote it.
	read := map[string]bool{}
	var out []Seen
	for _, t := range a.Config.Templates {
		job, err := containerapps.ParseJob(t.Job)
		if err != nil {
			return nil, err
		}
		if read[strings.ToLower(job.ID)] {
			continue
		}
		read[strings.ToLower(job.ID)] = true
		template := t.Name
		_, token, err := a.Client.SignIn(ctx, job)
		if err != nil {
			return nil, err
		}
		executions, err := a.Client.Executions(ctx, job, token)
		if err != nil {
			return nil, fmt.Errorf("executions of %s: %w", job.Name, err)
		}
		for _, e := range executions {
			run, try, mine := a.runOf(e)
			if !mine {
				continue
			}
			// Azure does not say whether a container has started: an execution that cannot start, it fails itself.
			s := Seen{Run: run, Try: try, Ref: job.ID + "/executions/" + e.Name, Template: template, Started: true}
			s.Created, _ = time.Parse(time.RFC3339Nano, e.Properties.StartTime)
			switch strings.ToLower(e.Properties.Status) {
			case "succeeded":
				s.Phase = Succeeded
			case "failed", "stopped", "degraded":
				s.Phase = Failed
				s.Why = "the execution ended " + strings.ToLower(e.Properties.Status)
			}
			if s.Phase != Active {
				s.Ended, _ = time.Parse(time.RFC3339Nano, e.Properties.EndTime)
			}
			out = append(out, s)
		}
	}
	return out, nil
}

// Stop stops one execution.
func (a ContainerApps) Stop(ctx context.Context, s Seen) error {
	id, name, ok := strings.Cut(s.Ref, "/executions/")
	if !ok {
		return fmt.Errorf("%q is not an execution of this platform", s.Ref)
	}
	job, err := containerapps.ParseJob(id)
	if err != nil {
		return err
	}
	_, token, err := a.Client.SignIn(ctx, job)
	if err != nil {
		return err
	}
	err = a.Client.Stop(ctx, job, token, name)
	var refused containerapps.Refused
	if errors.As(err, &refused) && refused.Status == 404 {
		return nil
	}
	return err
}
