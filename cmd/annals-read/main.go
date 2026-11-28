// Command annals-read reads one of the tables Annals publishes, for a tool
// a runner carries out, and prints it as the table a dataset or a report
// reads. It only reads. Annals' address and token come from the
// environment, never from an argument, and each command asks one fixed
// path, so nothing a caller types reaches another route.
//
// Usage:
//
//	annals-read gate-families [--weeks 12]
//	annals-read gate-drafts [--weeks 12]
//
// gate-families is the change gate's four numbers by week and effect
// family, each with its coverage: needless asks, misses, unknowns, and the
// wait. gate-drafts is each draft gate pack's replay by week: how many asks
// it would have sent to no one, and how many of those did harm. --weeks is
// how many weeks, the current one counted, from 1 to 52; empty is the same
// as leaving it out, which is Annals' own default.
//
// Environment:
//
//	ANNALS_URL    Annals' API port, such as http://annals.example.org:8081.
//	ANNALS_TOKEN  a token Annals issued, sent as a bearer token.
//
// It prints {columns, rows} as JSON to stdout, and what went wrong to
// stderr. It exits 0 when Annals answered a table, 1 when it did not, or
// answered more than a tool call carries, and 2 when it was asked wrongly.
package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"flag"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"
)

var version = "dev"

const (
	// maxOutput keeps the answer within what one tool call carries.
	maxOutput   = 60 * 1024
	maxWeeks    = 52
	requestWait = 25 * time.Second
)

const usage = `Usage:
  annals-read gate-families [--weeks 12]
  annals-read gate-drafts [--weeks 12]`

// tables is each command and the one path it reads.
var tables = map[string]string{
	"gate-families": "/v1/gate/families",
	"gate-drafts":   "/v1/gate/drafts",
}

type settings struct{ URL, Token string }

func main() {
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	env := settings{URL: os.Getenv("ANNALS_URL"), Token: os.Getenv("ANNALS_TOKEN")}
	os.Exit(run(ctx, os.Args[1:], env, &http.Client{Timeout: requestWait}, os.Stdout, os.Stderr))
}

// table is what a tool prints for a dataset or a report to read.
type table struct {
	Columns []json.RawMessage `json:"columns"`
	Rows    []json.RawMessage `json:"rows"`
}

// run answers what args ask and returns the exit code.
func run(ctx context.Context, args []string, env settings, client *http.Client, out, errOut io.Writer) int {
	wrong := func(why string) int {
		fmt.Fprintf(errOut, "%s\nannals-read %s\n%s\n", why, version, usage)
		return 2
	}
	if len(args) == 0 {
		return wrong("a command is required")
	}
	path, ok := tables[args[0]]
	if !ok {
		return wrong(fmt.Sprintf("%q is not a command", args[0]))
	}
	fs := flag.NewFlagSet(args[0], flag.ContinueOnError)
	fs.SetOutput(io.Discard)
	weeks := fs.String("weeks", "", "how many weeks")
	if err := fs.Parse(args[1:]); err != nil {
		return wrong(err.Error())
	}
	if fs.NArg() != 0 {
		return wrong(fmt.Sprintf("unexpected argument %q", fs.Arg(0)))
	}
	params := url.Values{}
	if w := strings.TrimSpace(*weeks); w != "" {
		n, err := strconv.Atoi(w)
		if err != nil || n < 1 || n > maxWeeks {
			return wrong(fmt.Sprintf("--weeks: %q is not a whole number from 1 to %d", w, maxWeeks))
		}
		params.Set("weeks", strconv.Itoa(n))
	}
	if env.URL == "" {
		return wrong("ANNALS_URL is not set: this runner has no Annals to read")
	}
	if env.Token == "" {
		return wrong("ANNALS_TOKEN is not set: Annals reads only with a token it issued")
	}
	body, err := get(ctx, client, env, path, params)
	if err != nil {
		fmt.Fprintln(errOut, err.Error())
		return 1
	}
	var t table
	dec := json.NewDecoder(bytes.NewReader(body))
	dec.DisallowUnknownFields()
	if err := dec.Decode(&t); err != nil || t.Columns == nil || t.Rows == nil {
		fmt.Fprintln(errOut, "Annals did not answer a table of columns and rows")
		return 1
	}
	printed, err := json.Marshal(t)
	if err != nil {
		fmt.Fprintln(errOut, err.Error())
		return 1
	}
	if len(printed) > maxOutput {
		fmt.Fprintf(errOut, "Annals answered %d bytes, more than a tool call carries; ask fewer --weeks\n", len(printed))
		return 1
	}
	fmt.Fprintln(out, string(printed))
	return 0
}

// get reads one path of Annals' API port.
func get(ctx context.Context, client *http.Client, env settings, path string, params url.Values) ([]byte, error) {
	u, err := url.Parse(strings.TrimRight(env.URL, "/") + path)
	if err != nil || u.Scheme == "" || u.Host == "" {
		return nil, errors.New("ANNALS_URL is not an absolute address")
	}
	u.RawQuery = params.Encode()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.String(), nil)
	if err != nil {
		return nil, err
	}
	req.Header.Set("Authorization", "Bearer "+env.Token)
	req.Header.Set("Accept", "application/json")
	req.Header.Set("User-Agent", "annals-read/"+version)
	resp, err := client.Do(req)
	if err != nil {
		return nil, fmt.Errorf("Annals did not answer: %w", err)
	}
	defer resp.Body.Close()
	body, err := io.ReadAll(io.LimitReader(resp.Body, 4*maxOutput))
	if err != nil {
		return nil, fmt.Errorf("Annals' answer could not be read: %w", err)
	}
	if resp.StatusCode != http.StatusOK {
		var e struct{ Error, Reason string }
		said := strings.TrimSpace(string(body))
		if json.Unmarshal(body, &e) == nil && e.Error != "" {
			said = e.Error
		}
		if len(said) > 300 {
			said = said[:300]
		}
		return nil, fmt.Errorf("Annals answered %d: %s", resp.StatusCode, said)
	}
	return body, nil
}
