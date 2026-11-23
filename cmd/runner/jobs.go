package main

import (
	"bufio"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"strings"
	"sync"
	"time"

	"github.com/orchard-suite/orrery/v2/sdk"
)

// job is a queued action run the hub rendered for this runner.
type job struct {
	Run       string            `json:"run"`
	Action    string            `json:"action"`
	Command   []string          `json:"command"`
	Env       map[string]string `json:"env"`
	TimeoutMs int               `json:"timeoutMs"`
}

// How many log lines travel in one report, and how long a partial batch waits.
const (
	batchLines = 50
	batchWait  = time.Second
)

// How long a command may print nothing before the runner says, with a report
// that carries nothing, that it still holds it: the hub gives up a run it
// does not hear from, and a quiet command is not a dead one.
var heartbeat = 30 * time.Second

// How the jobs loop paces itself: how long one claim asks the hub to wait,
// how long a report may take, and how long the loop rests after a claim that
// failed or came back empty at once.
const (
	claimWait   = 25 * time.Second
	reportWait  = 30 * time.Second
	claimRest   = 5 * time.Second
	claimPrompt = 2 * time.Second
)

// jobsLoop holds a claim open to the hub so a job starts as it is asked for,
// and runs up to slots jobs at once. It asks only for as many jobs as it has
// room to run. It returns once ctx is done and every job it started has
// reported its outcome.
func jobsLoop(ctx context.Context, client *sdk.Client, slots int, log *slog.Logger) {
	free := make(chan struct{}, slots)
	for i := 0; i < slots; i++ {
		free <- struct{}{}
	}
	var running sync.WaitGroup
	defer running.Wait()
	for {
		select {
		case <-ctx.Done():
			return
		case <-free:
		}
		room := 1
		for more := true; more; {
			select {
			case <-free:
				room++
			default:
				more = false
			}
		}
		asked := time.Now()
		jobs, err := claimJobs(ctx, client, room, slots)
		if ctx.Err() != nil && len(jobs) == 0 {
			return
		}
		if err != nil {
			log.Error("jobs claim failed", "error", err)
		}
		for _, j := range jobs {
			room--
			running.Add(1)
			go func() {
				defer running.Done()
				work(ctx, client, j, log)
				free <- struct{}{}
			}()
		}
		for ; room > 0; room-- {
			free <- struct{}{}
		}
		// A hub that answers empty at once is not holding the claim open: ask again at a walk, not a run.
		if err != nil || (len(jobs) == 0 && time.Since(asked) < claimPrompt) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(claimRest):
			}
		}
	}
}

// claimJobs asks the hub for up to max of this runner's queued jobs, waiting
// for one to arrive. It says the runner's width, how many it runs at once, so
// the hub can tell how long a batch of them takes.
func claimJobs(ctx context.Context, client *sdk.Client, max, width int) ([]job, error) {
	var claimed struct {
		Jobs []job `json:"jobs"`
	}
	path := fmt.Sprintf("/v1/ingest/runner/jobs?wait=%d&max=%d&width=%d", int(claimWait.Seconds()), max, width)
	if err := client.Call(ctx, http.MethodGet, path, nil, &claimed); err != nil {
		return nil, err
	}
	return claimed.Jobs, nil
}

// work runs one job, reporting the output as it comes and the outcome at the
// end. Reports outlive ctx, so a job cut short by a stopping runner still
// tells the hub how it ended.
func work(ctx context.Context, client *sdk.Client, j job, log *slog.Logger) {
	report := func(r sdk.ActionReport) {
		sending, cancel := context.WithTimeout(context.WithoutCancel(ctx), reportWait)
		defer cancel()
		if err := client.Call(sending, http.MethodPost, "/v1/ingest/runner/jobs/"+url.PathEscape(j.Run)+"/report", r, nil); err != nil {
			log.Error("job report failed", "run", j.Run, "error", err)
		}
	}
	log.Info("job started", "run", j.Run, "action", j.Action)
	state, summary := runJob(ctx, j, report)
	log.Info("job done", "run", j.Run, "action", j.Action, "state", state, "summary", summary)
	report(sdk.ActionReport{State: state, Summary: summary})
}

// runJob runs one job's command with its env on top of the runner's own,
// streaming stdout and stderr lines through report in batches, and saying
// that it still holds a command that prints nothing. It returns
// the terminal state and a one-line summary: the `summary` of the last JSON
// line that carries one, else how the command ended. A command still running
// when ctx is done is killed.
func runJob(ctx context.Context, j job, report func(sdk.ActionReport)) (string, string) {
	if len(j.Command) == 0 {
		return "failed", "no command"
	}
	timeout := time.Duration(j.TimeoutMs) * time.Millisecond
	if timeout <= 0 {
		timeout = 10 * time.Minute
	}
	stopping := ctx
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	cmd := exec.CommandContext(ctx, j.Command[0], j.Command[1:]...)
	cmd.Env = os.Environ()
	for k, v := range j.Env {
		cmd.Env = append(cmd.Env, k+"="+v)
	}
	out, err := cmd.StdoutPipe()
	if err != nil {
		return "failed", err.Error()
	}
	errOut, err := cmd.StderrPipe()
	if err != nil {
		return "failed", err.Error()
	}
	if err := cmd.Start(); err != nil {
		return "failed", "cannot start: " + err.Error()
	}
	lines := make(chan string, 256)
	var readers sync.WaitGroup
	for _, r := range []io.Reader{out, errOut} {
		readers.Add(1)
		go func(r io.Reader) {
			defer readers.Done()
			sc := bufio.NewScanner(r)
			sc.Buffer(make([]byte, 0, 64*1024), 1<<20)
			for sc.Scan() {
				lines <- sc.Text()
			}
		}(r)
	}
	go func() {
		readers.Wait()
		close(lines)
	}()
	said := ""
	batch := make([]string, 0, batchLines)
	spoke := time.Now()
	flush := func() {
		if len(batch) == 0 {
			if time.Since(spoke) >= heartbeat {
				report(sdk.ActionReport{})
				spoke = time.Now()
			}
			return
		}
		report(sdk.ActionReport{Log: batch})
		spoke = time.Now()
		batch = make([]string, 0, batchLines)
	}
	ticker := time.NewTicker(batchWait)
	defer ticker.Stop()
	for open := true; open; {
		select {
		case line, more := <-lines:
			if !more {
				open = false
				break
			}
			if s := summaryOf(line); s != "" {
				said = s
			}
			batch = append(batch, line)
			if len(batch) >= batchLines {
				flush()
			}
		case <-ticker.C:
			flush()
		}
	}
	flush()
	err = cmd.Wait()
	switch {
	case stopping.Err() != nil:
		return "failed", "the runner stopped before the command ended"
	case ctx.Err() == context.DeadlineExceeded:
		return "failed", fmt.Sprintf("timed out after %s", timeout)
	case err != nil:
		if exit, ok := err.(*exec.ExitError); ok {
			return "failed", orElse(said, fmt.Sprintf("exit %d", exit.ExitCode()))
		}
		return "failed", err.Error()
	}
	return "succeeded", orElse(said, "exit 0")
}

// summaryOf is the `summary` a JSON log line carries, or nothing.
func summaryOf(line string) string {
	if !strings.HasPrefix(line, "{") || !strings.Contains(line, `"summary"`) {
		return ""
	}
	var l struct {
		Summary string `json:"summary"`
	}
	if json.Unmarshal([]byte(line), &l) != nil {
		return ""
	}
	return l.Summary
}

func orElse(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}
