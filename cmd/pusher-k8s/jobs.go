package main

import (
	"fmt"
	"math"
	"sort"
	"strings"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
)

// A run of a job is a fact about the job, not an entity of its own: a pod of
// a Job is never pushed, and what the Jobs the cluster still holds say of
// their runs lands on the workload that runs them, a CronJob or a Job no
// CronJob owns.

// run is one Job's run, read from the Job and its pods.
type run struct {
	status   string // running, succeeded, or failed
	started  time.Time
	finished time.Time // zero while it runs
	reason   string    // why a failed run failed
}

func (r run) done() bool { return r.status != "running" }

func (r run) seconds() float64 { return math.Round(r.finished.Sub(r.started).Seconds()) }

// runOf reads a Job's run: finished when its Complete or Failed condition
// holds, running until then.
func runOf(j batchv1.Job, pods []corev1.Pod) run {
	r := run{status: "running", started: j.CreationTimestamp.Time}
	if j.Status.StartTime != nil {
		r.started = j.Status.StartTime.Time
	}
	for _, c := range j.Status.Conditions {
		if c.Status != corev1.ConditionTrue {
			continue
		}
		switch c.Type {
		case batchv1.JobComplete:
			r.status, r.finished = "succeeded", c.LastTransitionTime.Time
			if j.Status.CompletionTime != nil {
				r.finished = j.Status.CompletionTime.Time
			}
		case batchv1.JobFailed:
			r.status, r.finished, r.reason = "failed", c.LastTransitionTime.Time, c.Reason
		}
	}
	if r.status == "failed" {
		why := podFailure(pods)
		switch {
		case r.reason == "":
			r.reason = why
		case why != "":
			r.reason += " (" + why + ")"
		}
		if r.reason == "" {
			r.reason = "failed"
		}
	}
	return r
}

// podFailure is what the newest failed container of a Job's pods said as it
// ended: its termination message, or its reason, and its exit code.
func podFailure(pods []corev1.Pod) string {
	var newest time.Time
	out := ""
	for _, p := range pods {
		for _, cs := range p.Status.ContainerStatuses {
			t := cs.State.Terminated
			if t == nil || t.ExitCode == 0 || t.FinishedAt.Time.Before(newest) {
				continue
			}
			said := firstLine(t.Message)
			if said == "" {
				said = t.Reason
			}
			newest = t.FinishedAt.Time
			out = fmt.Sprintf("%s: %s, exit code %d", cs.Name, said, t.ExitCode)
		}
	}
	return out
}

func firstLine(s string) string {
	s = strings.TrimSpace(s)
	if i := strings.IndexByte(s, '\n'); i >= 0 {
		s = strings.TrimSpace(s[:i])
	}
	if r := []rune(s); len(r) > 160 {
		s = string(r[:160]) + "…"
	}
	return s
}

// runRecord writes what the runs say onto a workload's fields, and returns
// its health: red when the newest finished run failed, grey when suspended,
// green otherwise. lastSuccess is the CronJob's own last success, which
// outlives the Jobs the cluster keeps.
func runRecord(fields map[string]any, runs []run, suspended bool, lastSuccess time.Time) (health, reason string) {
	sort.SliceStable(runs, func(a, b int) bool { return runs[a].started.Before(runs[b].started) })
	running := 0
	var finished []run
	var lastFailure run
	for _, r := range runs {
		if !r.done() {
			running++
			continue
		}
		finished = append(finished, r)
		if r.status == "succeeded" && r.finished.After(lastSuccess) {
			lastSuccess = r.finished
		}
		if r.status == "failed" && r.finished.After(lastFailure.finished) {
			lastFailure = r
		}
	}
	sort.SliceStable(finished, func(a, b int) bool { return finished[a].finished.Before(finished[b].finished) })
	fields["running_count"] = running
	if len(runs) > 0 {
		last := runs[len(runs)-1]
		fields["last_run_status"] = last.status
		fields["last_run_started_at"] = stamp(last.started)
		if last.done() {
			fields["last_run_finished_at"] = stamp(last.finished)
			fields["last_run_seconds"] = last.seconds()
		}
	}
	if !lastSuccess.IsZero() {
		fields["last_success_at"] = stamp(lastSuccess)
	}
	if !lastFailure.finished.IsZero() {
		fields["last_failure_at"] = stamp(lastFailure.finished)
		fields["last_failure_reason"] = lastFailure.reason
	}
	if len(finished) > 0 {
		times := make([]map[string]any, len(finished))
		results := make([]map[string]any, len(finished))
		for i, r := range finished {
			times[i] = map[string]any{"at": stamp(r.finished), "value": r.seconds()}
			ok := 0.0
			if r.status == "succeeded" {
				ok = 1
			}
			results[i] = map[string]any{"at": stamp(r.finished), "value": ok}
		}
		fields["run_seconds"] = map[string]any{"points": times, "unit": "s", "min": 0}
		fields["run_results"] = map[string]any{"points": results, "step": true, "min": 0, "max": 1, "labels": map[string]string{"0": "failed", "1": "succeeded"}}
		if newest := finished[len(finished)-1]; newest.status == "failed" {
			return "red", "last run failed " + stamp(newest.finished) + ": " + newest.reason
		}
	}
	if suspended {
		return "grey", "suspended"
	}
	return "green", ""
}

func stamp(t time.Time) string { return t.UTC().Format(time.RFC3339) }
