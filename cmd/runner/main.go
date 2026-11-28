// Command runner is a small agent for one network segment: it pulls the
// health checks assigned to it from the hub, runs them, and pushes the
// results back. It also holds a claim open for the action jobs that name it,
// runs each command as it is asked for, and streams the output back as the
// run's log. Outbound only. Several runners on one check give a reachability
// matrix.
//
//	ORRERY_URL      the hub's ingest host
//	ORRERY_TOKEN    a source token for this runner's source (class runner)
//	SEGMENT         a label for the network this runner sits in, e.g. home-lan
//	INTERVAL        time between passes of the checks, default 2m
//	JOBS            how many jobs run at once, default 4; 0 takes no jobs
package main

import (
	"context"
	"crypto/tls"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
)

var version = "dev"

type check struct {
	Entity struct {
		Blueprint string `json:"blueprint"`
		Key       string `json:"key"`
	} `json:"entity"`
	Field string `json:"field"`
	Check struct {
		URL          string `json:"url"`
		Method       string `json:"method"`
		ExpectStatus any    `json:"expectStatus"`
		ExpectBody   string `json:"expectBody"`
		TimeoutMs    int    `json:"timeoutMs"`
		Insecure     bool   `json:"insecure"`
		Auth         *struct {
			Type   string `json:"type"`
			Header string `json:"header"`
		} `json:"auth"`
	} `json:"check"`
	Secret string `json:"secret"`
}

type result struct {
	Blueprint string  `json:"blueprint"`
	Key       string  `json:"key"`
	Field     string  `json:"field"`
	OK        bool    `json:"ok"`
	Status    *int    `json:"status"`
	LatencyMs int     `json:"latencyMs"`
	Error     *string `json:"error"`
	CheckedAt string  `json:"checkedAt"`
}

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "runner", "version", version)
	client, err := sdk.FromEnv(sdk.WithLogger(log))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	segment := os.Getenv("SEGMENT")
	interval := 2 * time.Minute
	if v := os.Getenv("INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil {
			interval = d
		}
	}
	slots := 4
	if v := os.Getenv("JOBS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 0 {
			log.Error("config", "error", "JOBS must be a whole number, 0 or more")
			os.Exit(2)
		}
		slots = n
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	jobs := make(chan struct{})
	go func() {
		defer close(jobs)
		if slots == 0 {
			log.Info("taking no jobs")
			return
		}
		jobsLoop(ctx, client, slots, log)
	}()
	// A stopping runner leaves only once every job it started has told the hub how it ended.
	defer func() { <-jobs }()
	for {
		if err := pass(ctx, client, segment, log); err != nil {
			log.Error("pass failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

func pass(ctx context.Context, client *sdk.Client, segment string, log *slog.Logger) error {
	if err := client.Call(ctx, http.MethodPost, "/v1/ingest/heartbeat", map[string]string{"version": version, "segment": segment}, nil); err != nil {
		return fmt.Errorf("heartbeat: %w", err)
	}
	var assigned struct {
		Checks []check `json:"checks"`
	}
	if err := client.Call(ctx, http.MethodGet, "/v1/ingest/runner/checks", nil, &assigned); err != nil {
		return fmt.Errorf("checks: %w", err)
	}
	if len(assigned.Checks) == 0 {
		log.Info("no checks assigned")
		return nil
	}
	results := make([]result, 0, len(assigned.Checks))
	for _, c := range assigned.Checks {
		r := run(ctx, c)
		log.Info("check", "entity", c.Entity.Blueprint+":"+c.Entity.Key, "field", c.Field, "ok", r.OK, "status", r.Status, "latencyMs", r.LatencyMs, "error", r.Error)
		results = append(results, r)
	}
	if err := client.Call(ctx, http.MethodPost, "/v1/ingest/runner/results", map[string]any{"results": results}, nil); err != nil {
		return fmt.Errorf("results: %w", err)
	}
	log.Info("pass done", "checks", len(results))
	return nil
}

func run(ctx context.Context, c check) result {
	r := result{Blueprint: c.Entity.Blueprint, Key: c.Entity.Key, Field: c.Field, CheckedAt: time.Now().UTC().Format(time.RFC3339)}
	timeout := time.Duration(c.Check.TimeoutMs) * time.Millisecond
	if timeout == 0 {
		timeout = 5 * time.Second
	}
	ctx, cancel := context.WithTimeout(ctx, timeout)
	defer cancel()
	method := c.Check.Method
	if method == "" {
		method = http.MethodGet
	}
	req, err := http.NewRequestWithContext(ctx, method, c.Check.URL, nil)
	if err != nil {
		return fail(r, err.Error())
	}
	req.Header.Set("User-Agent", "orrery-runner/"+version)
	if c.Check.Auth != nil && c.Secret != "" {
		switch c.Check.Auth.Type {
		case "bearer":
			req.Header.Set("Authorization", "Bearer "+c.Secret)
		case "basic":
			req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(c.Secret)))
		default:
			h := c.Check.Auth.Header
			if h == "" {
				h = "X-Api-Key"
			}
			req.Header.Set(h, c.Secret)
		}
	}
	transport := &http.Transport{TLSClientConfig: &tls.Config{InsecureSkipVerify: c.Check.Insecure}}
	hc := &http.Client{Transport: transport, CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse }}
	started := time.Now()
	res, err := hc.Do(req)
	r.LatencyMs = int(time.Since(started).Milliseconds())
	if err != nil {
		return fail(r, err.Error())
	}
	defer res.Body.Close()
	status := res.StatusCode
	r.Status = &status
	body, _ := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if !statusOK(c.Check.ExpectStatus, status) {
		return fail(r, fmt.Sprintf("expected %v, got %d", c.Check.ExpectStatus, status))
	}
	if c.Check.ExpectBody != "" && !strings.Contains(string(body), c.Check.ExpectBody) {
		return fail(r, "body did not contain the expected text")
	}
	r.OK = true
	return r
}

func fail(r result, msg string) result {
	r.OK = false
	r.Error = &msg
	return r
}

func statusOK(expect any, status int) bool {
	switch e := expect.(type) {
	case float64:
		return int(e) == status
	case string:
		if e == "" {
			return status/100 == 2
		}
		if e == "ok" {
			return status < 500
		}
		return fmt.Sprintf("%d", status)[0] == e[0]
	default:
		return status/100 == 2
	}
}

var _ = json.Marshal
