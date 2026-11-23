package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"math"
	"net/http"
	"net/url"
	"sort"
	"strconv"
	"strings"
	"time"
	"unicode/utf8"
)

// backend is one store this command reads: where it is and how to sign in.
type backend struct {
	Name   string
	Root   string
	Token  string
	Tenant string
	HTTP   *http.Client
}

// get asks the backend one query path and decodes the `data` of its answer
// into into. An answer that is not 2xx is an error carrying what the backend
// said.
func (b backend) get(ctx context.Context, path string, params url.Values, into any) error {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, strings.TrimRight(b.Root, "/")+path+"?"+params.Encode(), nil)
	if err != nil {
		return fmt.Errorf("%s's address is not usable: %v", b.Name, err)
	}
	if b.Token != "" {
		req.Header.Set("Authorization", "Bearer "+b.Token)
	}
	if b.Tenant != "" {
		req.Header.Set("X-Scope-OrgID", b.Tenant)
	}
	res, err := b.HTTP.Do(req)
	if err != nil {
		// The error names the address but never the query's parameters.
		if u, ok := err.(*url.Error); ok {
			err = u.Err
		}
		return fmt.Errorf("%s did not answer: %v", b.Name, err)
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 64<<20))
	if err != nil {
		return fmt.Errorf("%s's answer could not be read: %v", b.Name, err)
	}
	if res.StatusCode < 200 || res.StatusCode > 299 {
		return fmt.Errorf("%s answered %d: %s", b.Name, res.StatusCode, said(body))
	}
	var answer struct {
		Status string          `json:"status"`
		Error  string          `json:"error"`
		Data   json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(body, &answer); err != nil {
		return fmt.Errorf("%s's answer is not JSON: %v", b.Name, err)
	}
	if answer.Status != "success" {
		return fmt.Errorf("%s refused the query: %s", b.Name, orElse(answer.Error, "status "+answer.Status))
	}
	if err := json.Unmarshal(answer.Data, into); err != nil {
		return fmt.Errorf("%s's answer has a shape this command does not read: %v", b.Name, err)
	}
	return nil
}

// said is the message in a backend's error body: its `error` or `message`
// when it is JSON, else the text itself, cut short.
func said(body []byte) string {
	var e struct {
		Error   string `json:"error"`
		Message string `json:"message"`
	}
	if json.Unmarshal(body, &e) == nil && (e.Error != "" || e.Message != "") {
		return clip(orElse(e.Error, e.Message), maxLine)
	}
	return clip(orElse(strings.TrimSpace(string(body)), "no message"), maxLine)
}

func orElse(s, fallback string) string {
	if s != "" {
		return s
	}
	return fallback
}

// clip keeps a text on one line and cuts it at max bytes, on a whole
// character, saying how long it was.
func clip(s string, max int) string {
	s = strings.NewReplacer("\r\n", `\n`, "\n", `\n`, "\r", `\n`).Replace(strings.TrimRight(s, "\r\n"))
	if len(s) <= max {
		return s
	}
	cut := max
	for cut > 0 && !utf8.RuneStart(s[cut]) {
		cut--
	}
	return fmt.Sprintf("%s ... (cut, %d bytes in all)", s[:cut], len(s))
}

// result is a Loki or Prometheus answer's data.
type result struct {
	ResultType string          `json:"resultType"`
	Result     json.RawMessage `json:"result"`
}

// series is one series of a vector or a matrix.
type series struct {
	Metric map[string]string `json:"metric"`
	Value  *point            `json:"value"`
	Values []point           `json:"values"`
}

// point is one [time, "value"] pair, the time in seconds.
type point struct {
	At    time.Time
	Value string
}

func (p *point) UnmarshalJSON(b []byte) error {
	var pair []json.RawMessage
	if err := json.Unmarshal(b, &pair); err != nil || len(pair) != 2 {
		return fmt.Errorf("a point is not a [time, value] pair")
	}
	var at float64
	if err := json.Unmarshal(pair[0], &at); err != nil {
		return err
	}
	p.At = time.Unix(0, int64(at*float64(time.Second))).UTC()
	return json.Unmarshal(pair[1], &p.Value)
}

// The labels of a log's stream worth a place on every line, in this order.
var logLabels = []string{"namespace", "pod", "container", "app", "service_name", "job", "level", "detected_level"}

// entry is one log line and the stream it came from.
type entry struct {
	at     int64
	labels string
	line   string
}

// logs prints the lines a LogQL query finds in the last span, newest first.
func logs(ctx context.Context, b backend, w *budget, query string, span time.Duration, limit int, capped bool, now time.Time) error {
	params := url.Values{
		"query":     {query},
		"start":     {strconv.FormatInt(now.Add(-span).UnixNano(), 10)},
		"end":       {strconv.FormatInt(now.UnixNano(), 10)},
		"limit":     {strconv.Itoa(limit)},
		"direction": {"backward"},
	}
	var data result
	if err := b.get(ctx, "/loki/api/v1/query_range", params, &data); err != nil {
		return err
	}
	window := "the last " + spanText(span) + capNote(capped)
	if data.ResultType != "streams" {
		// A LogQL query that counts or rates gives series, as a metric query does.
		var found []series
		if err := json.Unmarshal(data.Result, &found); err != nil {
			return fmt.Errorf("Loki's answer has a shape this command does not read: %v", err)
		}
		printSeries(w, found, true, window)
		return nil
	}
	var streams []struct {
		Stream map[string]string `json:"stream"`
		Values [][2]string       `json:"values"`
	}
	if err := json.Unmarshal(data.Result, &streams); err != nil {
		return fmt.Errorf("Loki's answer has a shape this command does not read: %v", err)
	}
	var entries []entry
	for _, s := range streams {
		labels := compact(s.Stream)
		for _, v := range s.Values {
			at, _ := strconv.ParseInt(v[0], 10, 64)
			entries = append(entries, entry{at: at, labels: labels, line: v[1]})
		}
	}
	sort.SliceStable(entries, func(i, j int) bool { return entries[i].at > entries[j].at })
	if len(entries) > limit {
		entries = entries[:limit]
	}
	shown := 0
	for _, e := range entries {
		if !w.line(time.Unix(0, e.at).UTC().Format("2006-01-02T15:04:05.000Z") + " " + e.labels + " " + clip(e.line, maxLine)) {
			break
		}
		shown++
	}
	switch {
	case w.cut:
		w.last(fmt.Sprintf("Output cut at %d KB: %d of %d log lines shown, from %s. Narrow the query, shorten --since, or lower --limit.", maxOutput/1024, shown, len(entries), window))
	case len(entries) == limit:
		w.last(fmt.Sprintf("%d log lines from %s, newest first. That is the limit, so older lines may exist.", shown, window))
	default:
		w.last(fmt.Sprintf("%s from %s, newest first.", count(shown, "log line"), window))
	}
	return nil
}

// compact is the few labels of a stream worth reading on every line.
func compact(stream map[string]string) string {
	var parts []string
	for _, name := range logLabels {
		v := stream[name]
		if v == "" || (name == "detected_level" && stream["level"] != "") {
			continue
		}
		if name == "detected_level" {
			name = "level"
		}
		parts = append(parts, name+"="+v)
	}
	return "{" + strings.Join(parts, " ") + "}"
}

// metrics prints what a PromQL query gives: its value now, or with a span
// its series over the last span.
func metrics(ctx context.Context, b backend, w *budget, query string, span, step time.Duration, capped bool, now time.Time) error {
	var data result
	if span == 0 {
		params := url.Values{"query": {query}, "time": {strconv.FormatInt(now.Unix(), 10)}}
		if err := b.get(ctx, "/api/v1/query", params, &data); err != nil {
			return err
		}
	} else {
		if step == 0 {
			step = time.Minute
		}
		// A range never holds more points than a series is read for.
		if least := span / maxPoints; step < least {
			step = least.Round(time.Second)
		}
		if step < time.Second {
			step = time.Second
		}
		params := url.Values{
			"query": {query},
			"start": {strconv.FormatInt(now.Add(-span).Unix(), 10)},
			"end":   {strconv.FormatInt(now.Unix(), 10)},
			"step":  {strconv.FormatInt(int64(step/time.Second), 10)},
		}
		if err := b.get(ctx, "/api/v1/query_range", params, &data); err != nil {
			return err
		}
	}
	switch data.ResultType {
	case "scalar", "string":
		var p point
		if err := json.Unmarshal(data.Result, &p); err != nil {
			return fmt.Errorf("Prometheus' answer has a shape this command does not read: %v", err)
		}
		w.line(p.Value)
		w.last("1 " + data.ResultType + ", at " + p.At.Format(time.RFC3339) + ".")
		return nil
	}
	var found []series
	if err := json.Unmarshal(data.Result, &found); err != nil {
		return fmt.Errorf("Prometheus' answer has a shape this command does not read: %v", err)
	}
	if span == 0 {
		printSeries(w, found, false, "now, "+now.UTC().Format(time.RFC3339))
	} else {
		printSeries(w, found, true, "the last "+spanText(span)+capNote(capped)+", a point every "+spanText(step))
	}
	return nil
}

// printSeries prints one line per series, by its labels: its value, or for
// a range its min, max, last, and points count, then some of its points.
func printSeries(w *budget, found []series, ranged bool, window string) {
	sort.SliceStable(found, func(i, j int) bool { return labelText(found[i].Metric) < labelText(found[j].Metric) })
	shown := 0
	for _, s := range found {
		name := labelText(s.Metric)
		if !ranged {
			value := "no value"
			if s.Value != nil {
				value = s.Value.Value
			}
			if !w.line(name + " " + value) {
				break
			}
			shown++
			continue
		}
		head := name + " no points"
		if n := len(s.Values); n > 0 {
			min, max := math.Inf(1), math.Inf(-1)
			for _, p := range s.Values {
				if v, err := strconv.ParseFloat(p.Value, 64); err == nil && !math.IsNaN(v) {
					min, max = math.Min(min, v), math.Max(max, v)
				}
			}
			head = fmt.Sprintf("%s min=%s max=%s last=%s points=%d", name, number(min), number(max), s.Values[n-1].Value, n)
		}
		if !w.line(head) {
			break
		}
		shown++
		if picked := sample(s.Values, maxSamples); len(picked) > 0 {
			parts := make([]string, len(picked))
			for i, p := range picked {
				parts[i] = p.At.Format(time.RFC3339) + "=" + p.Value
			}
			if !w.line("  " + strings.Join(parts, " ")) {
				break
			}
		}
	}
	if w.cut {
		w.last(fmt.Sprintf("Output cut at %d KB: %d of %d series shown, for %s. Narrow the query, or sum it by fewer labels.", maxOutput/1024, shown, len(found), window))
		return
	}
	w.last(fmt.Sprintf("%s, for %s.", count(shown, "series"), window))
}

// sample is at most max of the points, evenly spread, the first and the last
// among them.
func sample(points []point, max int) []point {
	if len(points) <= max {
		return points
	}
	picked := make([]point, max)
	for i := range picked {
		picked[i] = points[i*(len(points)-1)/(max-1)]
	}
	return picked
}

// labelText is a series' name and labels as PromQL writes them, the labels
// in order.
func labelText(metric map[string]string) string {
	names := make([]string, 0, len(metric))
	for name := range metric {
		if name != "__name__" {
			names = append(names, name)
		}
	}
	sort.Strings(names)
	parts := make([]string, len(names))
	for i, name := range names {
		parts[i] = name + "=" + strconv.Quote(metric[name])
	}
	return metric["__name__"] + "{" + strings.Join(parts, ",") + "}"
}

// number writes a worked-out value briefly; a series with no number in it
// has none.
func number(v float64) string {
	if math.IsInf(v, 0) {
		return "none"
	}
	return strconv.FormatFloat(v, 'g', 6, 64)
}

// count is "1 log line" or "3 log lines"; "series" is its own plural.
func count(n int, what string) string {
	if n == 1 || strings.HasSuffix(what, "s") {
		return fmt.Sprintf("%d %s", n, what)
	}
	return fmt.Sprintf("%d %ss", n, what)
}

// spanText writes a span the way it is asked for: 7d, 1h30m, 45s.
func spanText(d time.Duration) string {
	if day := 24 * time.Hour; d >= day && d%day == 0 {
		return fmt.Sprintf("%dd", d/day)
	}
	s := d.Round(time.Second).String()
	if strings.HasSuffix(s, "m0s") {
		s = strings.TrimSuffix(s, "0s")
	}
	if strings.HasSuffix(s, "h0m") {
		s = strings.TrimSuffix(s, "0m")
	}
	return s
}

func capNote(capped bool) string {
	if capped {
		return " (the most --since reads)"
	}
	return ""
}
