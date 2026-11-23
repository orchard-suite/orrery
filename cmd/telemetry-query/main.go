// Command telemetry-query reads logs and metrics for a tool a runner carries
// out: log lines from Loki, and series from Prometheus. It only reads. The
// two addresses come from the environment, never from an argument, and the
// only paths it asks are the query ones, so nothing a caller types reaches a
// write, a delete, or an admin endpoint.
//
// Usage:
//
//	telemetry-query logs --query '<LogQL>' [--since 1h] [--limit 200]
//	telemetry-query metrics --query '<PromQL>' [--since 1h] [--step 1m]
//
// logs prints one line per log entry, newest first: the time in UTC, a few
// of the stream's labels, then the line. metrics without --since asks for
// the value now and prints one line per series; with --since it asks for the
// range and prints each series' min, max, last, and points count, then up to
// 30 of its points, evenly sampled. Both end with a count line. A time span
// is a Go duration, or whole days or weeks: 30m, 6h, 2d, 1w. An empty
// --since, --limit, or --step is the same as leaving it out, and --step is
// read only with --since, so a tool may pass every flag on every call.
//
// Environment:
//
//	LOKI_URL          Loki's address; logs needs it.
//	LOKI_TOKEN        sent to Loki as a bearer token, when set.
//	LOKI_TENANT       sent to Loki as X-Scope-OrgID, when set.
//	PROMETHEUS_URL    Prometheus' address; metrics needs it.
//	PROMETHEUS_TOKEN  sent to Prometheus as a bearer token, when set.
//
// An answer stays small enough for a tool call to carry: --limit is at most
// 1000, --since at most 7d, a log line is cut at 2000 bytes, and printing
// stops near 60 KB with a last line that says so.
//
// It writes plain text to stdout, and what went wrong to stderr. It exits 0
// when the backend answered, 1 when it did not or refused the query, and 2
// when it was asked wrongly.
package main

import (
	"context"
	"flag"
	"fmt"
	"io"
	"net/http"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

// The bounds that keep an answer small.
const (
	maxLimit    = 1000
	maxSince    = 7 * 24 * time.Hour
	maxLine     = 2000
	maxOutput   = 60 * 1024
	maxSamples  = 30
	maxPoints   = 1000
	requestWait = 25 * time.Second
)

const usage = `Usage:
  telemetry-query logs --query '<LogQL>' [--since 1h] [--limit 200]
  telemetry-query metrics --query '<PromQL>' [--since 1h] [--step 1m]`

// settings is what the environment says of the two backends.
type settings struct {
	LokiURL, LokiToken, LokiTenant string
	PrometheusURL, PrometheusToken string
}

func fromEnv() settings {
	return settings{
		LokiURL:         os.Getenv("LOKI_URL"),
		LokiToken:       os.Getenv("LOKI_TOKEN"),
		LokiTenant:      os.Getenv("LOKI_TENANT"),
		PrometheusURL:   os.Getenv("PROMETHEUS_URL"),
		PrometheusToken: os.Getenv("PROMETHEUS_TOKEN"),
	}
}

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	os.Exit(run(ctx, os.Args[1:], fromEnv(), os.Stdout, os.Stderr, time.Now))
}

// run answers what args ask and returns the exit code.
func run(ctx context.Context, args []string, env settings, out, errOut io.Writer, now func() time.Time) int {
	if len(args) == 0 {
		fmt.Fprintf(errOut, "telemetry-query %s\n%s\n", version, usage)
		return 2
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	query := fs.String("query", "", "the query")
	since := fs.String("since", "", "how far back to read")
	limit := fs.String("limit", "", "the most log lines to print")
	step := fs.String("step", "", "the time between a range's points")
	wrong := func(why string) int {
		fmt.Fprintf(errOut, "%s\ntelemetry-query %s\n%s\n", why, version, usage)
		return 2
	}
	if args[0] != "logs" && args[0] != "metrics" {
		return wrong(fmt.Sprintf("%q is not a command", args[0]))
	}
	if err := fs.Parse(args[1:]); err != nil {
		return wrong(err.Error())
	}
	if fs.NArg() != 0 {
		return wrong(fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	q := strings.TrimSpace(*query)
	if q == "" {
		return wrong("--query is required and may not be empty")
	}
	span, err := parseSpan(*since)
	if err != nil {
		return wrong("--since: " + err.Error())
	}
	capped := span > maxSince
	if capped {
		span = maxSince
	}
	client := &http.Client{Timeout: requestWait}
	w := &budget{w: out, left: maxOutput}
	var failed error
	switch args[0] {
	case "logs":
		if strings.TrimSpace(*step) != "" {
			return wrong("--step belongs to metrics")
		}
		n, err := parseLimit(*limit)
		if err != nil {
			return wrong("--limit: " + err.Error())
		}
		if span == 0 {
			span = time.Hour
		}
		if env.LokiURL == "" {
			return wrong("LOKI_URL is not set: this runner has no log store to read")
		}
		b := backend{Name: "Loki", Root: env.LokiURL, Token: env.LokiToken, Tenant: env.LokiTenant, HTTP: client}
		failed = logs(ctx, b, w, q, span, n, capped, now())
	default:
		if strings.TrimSpace(*limit) != "" {
			return wrong("--limit belongs to logs")
		}
		every, err := parseSpan(*step)
		if err != nil {
			return wrong("--step: " + err.Error())
		}
		if env.PrometheusURL == "" {
			return wrong("PROMETHEUS_URL is not set: this runner has no metric store to read")
		}
		b := backend{Name: "Prometheus", Root: env.PrometheusURL, Token: env.PrometheusToken, HTTP: client}
		failed = metrics(ctx, b, w, q, span, every, capped, now())
	}
	if failed != nil {
		fmt.Fprintln(errOut, failed.Error())
		return 1
	}
	return 0
}

// parseSpan reads a time span: a Go duration, or whole days (2d) or weeks
// (1w). Nothing is no span.
func parseSpan(s string) (time.Duration, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 0, nil
	}
	var d time.Duration
	if unit := s[len(s)-1]; unit == 'd' || unit == 'w' {
		n, err := strconv.ParseFloat(s[:len(s)-1], 64)
		if err != nil {
			return 0, fmt.Errorf("%q is not a time span such as 30m, 6h, or 2d", s)
		}
		day := 24 * time.Hour
		if unit == 'w' {
			day *= 7
		}
		d = time.Duration(n * float64(day))
	} else {
		var err error
		if d, err = time.ParseDuration(s); err != nil {
			return 0, fmt.Errorf("%q is not a time span such as 30m, 6h, or 2d", s)
		}
	}
	if d <= 0 {
		return 0, fmt.Errorf("%q is not more than nothing", s)
	}
	return d, nil
}

// parseLimit reads how many log lines to print: 200 when nothing is said,
// and never more than maxLimit.
func parseLimit(s string) (int, error) {
	s = strings.TrimSpace(s)
	if s == "" {
		return 200, nil
	}
	f, err := strconv.ParseFloat(s, 64)
	if err != nil || f < 1 || f != float64(int64(f)) {
		return 0, fmt.Errorf("%q is not a whole number above zero", s)
	}
	if f > maxLimit {
		return maxLimit, nil
	}
	return int(f), nil
}

// budget writes whole lines until the answer is as large as it may be.
type budget struct {
	w    io.Writer
	left int
	cut  bool
}

// line writes one line, or says false once the answer is full.
func (b *budget) line(s string) bool {
	if b.cut || len(s)+1 > b.left {
		b.cut = true
		return false
	}
	b.left -= len(s) + 1
	fmt.Fprintln(b.w, s)
	return true
}

// last writes the closing line, which always fits.
func (b *budget) last(s string) {
	fmt.Fprintln(b.w, s)
}
