package main

import (
	"bytes"
	"encoding/json"
	"fmt"
	"io"
	"sort"
	"strings"
	"text/tabwriter"
)

// How an answer is laid out for a person. A script asks for -o json and gets
// the hub's answer as it came.

// cellMax is the most characters a table cell shows; -o json has the whole value.
const cellMax = 80

func printJSON(out io.Writer, raw json.RawMessage) error {
	var buf bytes.Buffer
	if err := json.Indent(&buf, raw, "", "  "); err != nil {
		return err
	}
	_, err := fmt.Fprintln(out, buf.String())
	return err
}

func table(out io.Writer, header []string, rows [][]string) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	fmt.Fprintln(w, strings.Join(header, "\t"))
	for _, row := range rows {
		for i, cell := range row {
			row[i] = clip(cell)
		}
		fmt.Fprintln(w, strings.Join(row, "\t"))
	}
	return w.Flush()
}

func printPairs(out io.Writer, pairs [][2]string) error {
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	for _, pair := range pairs {
		if pair[1] != "" {
			fmt.Fprintf(w, "%s\t%s\n", pair[0], pair[1])
		}
	}
	return w.Flush()
}

// clip keeps a cell to one line of a table.
func clip(text string) string {
	text = strings.Join(strings.Fields(text), " ")
	if r := []rune(text); len(r) > cellMax {
		return string(r[:cellMax-1]) + "…"
	}
	return text
}

// cell reads any value as the text of a table cell: a list as its values, nothing as nothing.
func cell(value any) string {
	switch v := value.(type) {
	case nil:
		return ""
	case string:
		return v
	case bool:
		if v {
			return "yes"
		}
		return "no"
	case float64:
		return strings.TrimSuffix(strings.TrimRight(fmt.Sprintf("%.6f", v), "0"), ".")
	case []any:
		parts := make([]string, len(v))
		for i, item := range v {
			parts[i] = cell(item)
		}
		return strings.Join(parts, ", ")
	case map[string]any:
		// What names an entity reads as its id.
		if blueprint, ok := v["blueprint"].(string); ok {
			if key, ok := v["key"].(string); ok {
				return blueprint + ":" + key
			}
		}
	}
	text, _ := json.Marshal(value)
	return string(text)
}

// keysInOrder are the names of a JSON object in the order it was written: an action's inputs are asked in that order.
func keysInOrder(raw json.RawMessage) []string {
	dec := json.NewDecoder(bytes.NewReader(raw))
	if tok, err := dec.Token(); err != nil || tok != json.Delim('{') {
		return nil
	}
	var keys []string
	for dec.More() {
		tok, err := dec.Token()
		if err != nil {
			return keys
		}
		key, _ := tok.(string)
		keys = append(keys, key)
		var skip json.RawMessage
		if err := dec.Decode(&skip); err != nil {
			return keys
		}
	}
	return keys
}

// actionShown is what a table shows of an action.
type actionShown struct {
	ID          string          `json:"id"`
	Title       string          `json:"title"`
	Description string          `json:"description"`
	Group       string          `json:"group"`
	Blueprint   any             `json:"blueprint"`
	Approval    bool            `json:"approval"`
	Inputs      json.RawMessage `json:"inputs"`
	Backend     struct {
		Type   string `json:"type"`
		Finish string `json:"finish"`
	} `json:"backend"`
	HomeShown *struct {
		Title string `json:"title"`
	} `json:"homeShown"`
}

// place is where an action is listed: its home, else its group.
func (a actionShown) place() string {
	if a.HomeShown != nil && a.HomeShown.Title != "" {
		return a.HomeShown.Title
	}
	return a.Group
}

func printActions(out io.Writer, raws []json.RawMessage) error {
	rows := make([][]string, 0, len(raws))
	for _, raw := range raws {
		var a actionShown
		if err := json.Unmarshal(raw, &a); err != nil {
			return err
		}
		rows = append(rows, []string{a.ID, a.Title, cell(a.Blueprint), yes(a.Approval), a.place()})
	}
	sort.SliceStable(rows, func(i, j int) bool { return rows[i][0] < rows[j][0] })
	return table(out, []string{"ID", "TITLE", "RUNS ON", "APPROVAL", "LISTED UNDER"}, rows)
}

func yes(b bool) string {
	if b {
		return "yes"
	}
	return ""
}

func printAction(out io.Writer, raw json.RawMessage) error {
	var a actionShown
	if err := json.Unmarshal(raw, &a); err != nil {
		return err
	}
	var whole struct {
		CanRun bool `json:"canRun"`
	}
	_ = json.Unmarshal(raw, &whole)
	runsOn := cell(a.Blueprint)
	if runsOn == "" {
		runsOn = "nothing: it takes no --entity"
	}
	ends := a.Backend.Type
	if a.Backend.Finish == "reveal" {
		ends += ", and answers with something shown once, to a terminal only"
	}
	if err := printPairs(out, [][2]string{{"action", a.ID}, {"title", a.Title}, {"what it does", a.Description}, {"runs on", runsOn}, {"needs approval", yesNo(a.Approval)}, {"you may run it", yesNo(whole.CanRun)}, {"handed to", ends}}); err != nil {
		return err
	}
	var inputs map[string]struct {
		Type        string `json:"type"`
		Title       string `json:"title"`
		Description string `json:"description"`
		Required    bool   `json:"required"`
		Many        bool   `json:"many"`
		Default     any    `json:"default"`
		Values      any    `json:"values"`
		Blueprint   any    `json:"blueprint"`
		Narrows     string `json:"narrows"`
		When        any    `json:"when"`
		Value       string `json:"value"`
	}
	if len(a.Inputs) > 0 {
		if err := json.Unmarshal(a.Inputs, &inputs); err != nil {
			return err
		}
	}
	if len(inputs) == 0 {
		_, err := fmt.Fprintln(out, "\nIt takes no inputs.")
		return err
	}
	fmt.Fprintln(out, "\nInputs, each sent as --input name=value:")
	var rows [][]string
	for _, name := range keysInOrder(a.Inputs) {
		in := inputs[name]
		kind := in.Type
		if in.Many {
			kind += ", many"
		}
		var notes []string
		for _, text := range []string{in.Title, in.Description} {
			if text != "" {
				notes = append(notes, text)
			}
		}
		if in.Values != nil {
			notes = append(notes, "one of: "+cell(in.Values))
		}
		if in.Blueprint != nil {
			notes = append(notes, "picks from: "+cell(in.Blueprint))
		}
		if in.Default != nil {
			notes = append(notes, "default: "+cell(in.Default))
		}
		if in.Narrows != "" {
			notes = append(notes, "filled from the entity it runs on")
		}
		if in.When != nil {
			notes = append(notes, "asked only when: "+cell(in.When))
		}
		required := yes(in.Required)
		if in.Value != "" {
			required = "never sent"
			notes = append(notes, "worked out by the hub: "+in.Value)
		}
		rows = append(rows, []string{name, kind, required, strings.Join(notes, "; ")})
	}
	return table(out, []string{"NAME", "TYPE", "REQUIRED", "ABOUT"}, rows)
}

func yesNo(b bool) string {
	if b {
		return "yes"
	}
	return "no"
}

func printRuns(out io.Writer, raw json.RawMessage) error {
	var listed struct {
		Runs []struct {
			ID        string     `json:"id"`
			Action    string     `json:"action"`
			Entity    *entityRef `json:"entity"`
			State     string     `json:"state"`
			Summary   string     `json:"summary"`
			By        string     `json:"by"`
			CreatedAt string     `json:"createdAt"`
		} `json:"runs"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		return err
	}
	rows := make([][]string, 0, len(listed.Runs))
	for _, r := range listed.Runs {
		on := ""
		if r.Entity != nil {
			on = r.Entity.Blueprint + ":" + r.Entity.Key
		}
		rows = append(rows, []string{r.ID, r.Action, on, r.State, r.By, r.CreatedAt, r.Summary})
	}
	return table(out, []string{"RUN", "ACTION", "ON", "STATE", "BY", "ASKED", "SUMMARY"}, rows)
}

// printRunEnd says what came of a run once its log is printed.
func printRunEnd(out io.Writer, run actionRun) error {
	var steps []string
	for _, s := range run.Steps {
		steps = append(steps, s.Name)
	}
	if err := printPairs(out, [][2]string{{"state", run.State}, {"summary", run.Summary}, {"note", run.Note}, {"steps", strings.Join(steps, ", ")}, {"link", run.Link}}); err != nil {
		return err
	}
	if len(run.Outputs) == 0 {
		return nil
	}
	fmt.Fprintln(out, "outputs:")
	names := make([]string, 0, len(run.Outputs))
	for name := range run.Outputs {
		names = append(names, name)
	}
	sort.Strings(names)
	w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
	for _, name := range names {
		fmt.Fprintf(w, "  %s\t%s\n", name, cell(run.Outputs[name]))
	}
	return w.Flush()
}

// entityShown is what a table shows of an entity.
type entityShown struct {
	ID     string `json:"id"`
	Title  string `json:"title"`
	State  string `json:"state"`
	Owner  string `json:"owner"`
	Status struct {
		Level   string   `json:"level"`
		Reasons []string `json:"reasons"`
	} `json:"status"`
	Fields map[string]any `json:"fields"`
}

func printEntities(out, note io.Writer, raw json.RawMessage, fields []string) error {
	var listed struct {
		Entities []entityShown `json:"entities"`
		Total    int           `json:"total"`
		Next     string        `json:"next"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		return err
	}
	header := []string{"ID", "TITLE", "STATUS"}
	for _, f := range fields {
		header = append(header, strings.ToUpper(f))
	}
	rows := make([][]string, 0, len(listed.Entities))
	for _, e := range listed.Entities {
		row := []string{e.ID, e.Title, e.Status.Level}
		for _, f := range fields {
			row = append(row, cell(e.Fields[f]))
		}
		rows = append(rows, row)
	}
	if err := table(out, header, rows); err != nil {
		return err
	}
	if listed.Next != "" {
		fmt.Fprintf(note, "%d of %d shown; the next page: --after %s\n", len(listed.Entities), listed.Total, listed.Next)
	}
	return nil
}

func printEntity(out io.Writer, raw json.RawMessage) error {
	var e struct {
		entityShown
		Outgoing      []link         `json:"outgoing"`
		Incoming      []link         `json:"incoming"`
		IncomingCount map[string]int `json:"incomingCount"`
		Actions       []string       `json:"actions"`
	}
	if err := json.Unmarshal(raw, &e); err != nil {
		return err
	}
	status := e.Status.Level
	if len(e.Status.Reasons) > 0 {
		status += " (" + strings.Join(e.Status.Reasons, "; ") + ")"
	}
	if err := printPairs(out, [][2]string{{"entity", e.ID}, {"title", e.Title}, {"status", status}, {"state", e.State}, {"written by", e.Owner}}); err != nil {
		return err
	}
	if len(e.Fields) > 0 {
		fmt.Fprintln(out, "\nFields:")
		names := make([]string, 0, len(e.Fields))
		for name := range e.Fields {
			names = append(names, name)
		}
		sort.Strings(names)
		w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		for _, name := range names {
			if text := cell(e.Fields[name]); text != "" {
				fmt.Fprintf(w, "  %s\t%s\n", name, clip(text))
			}
		}
		if err := w.Flush(); err != nil {
			return err
		}
	}
	for _, side := range []struct {
		title string
		arrow string
		links []link
	}{{"Points at:", "->", e.Outgoing}, {"Pointed at by:", "<-", e.Incoming}} {
		if len(side.links) == 0 {
			continue
		}
		fmt.Fprintln(out, "\n"+side.title)
		w := tabwriter.NewWriter(out, 0, 4, 2, ' ', 0)
		for _, l := range side.links {
			fmt.Fprintf(w, "  %s\t%s %s:%s\t%s\n", l.Relation, side.arrow, l.Target.Blueprint, l.Target.Key, clip(l.TargetTitle))
		}
		if err := w.Flush(); err != nil {
			return err
		}
	}
	// The hub sends the first few of each kind that points here, and how many there are: say the rest and how to read it.
	shown := map[string]int{}
	for _, l := range e.Incoming {
		shown[l.DeclaredOn+"."+l.Relation]++
	}
	kinds := make([]string, 0, len(e.IncomingCount))
	for k := range e.IncomingCount {
		kinds = append(kinds, k)
	}
	sort.Strings(kinds)
	for _, k := range kinds {
		if left := e.IncomingCount[k] - shown[k]; left > 0 {
			bp, relation, _ := strings.Cut(k, ".")
			fmt.Fprintf(out, "  %d more %s by %s: orrery search --blueprint %s --filter '{\"relation\":\"%s\",\"target\":\"%s\"}'\n", left, bp, relation, bp, relation, e.ID)
		}
	}
	if len(e.Actions) > 0 {
		fmt.Fprintf(out, "\nActions you may run on it: %s\n", strings.Join(e.Actions, ", "))
	}
	return nil
}

// link is one relation of an entity, to or from another.
type link struct {
	Relation    string    `json:"relation"`
	DeclaredOn  string    `json:"declaredOn"`
	Target      entityRef `json:"target"`
	TargetTitle string    `json:"targetTitle"`
}

func printQueries(out io.Writer, raw json.RawMessage) error {
	var listed struct {
		Queries []struct {
			ID          string `json:"id"`
			Title       string `json:"title"`
			Description string `json:"description"`
			Owner       string `json:"owner"`
		} `json:"queries"`
	}
	if err := json.Unmarshal(raw, &listed); err != nil {
		return err
	}
	rows := make([][]string, 0, len(listed.Queries))
	for _, q := range listed.Queries {
		rows = append(rows, []string{q.ID, q.Title, q.Owner, q.Description})
	}
	return table(out, []string{"ID", "TITLE", "SAVED BY", "ABOUT"}, rows)
}

// printAnswer lays a query's answer out as its columns.
func printAnswer(out, note io.Writer, raw json.RawMessage) error {
	var answer struct {
		Columns []struct {
			ID     string `json:"id"`
			Title  string `json:"title"`
			Format *struct {
				Minor bool `json:"minor"`
			} `json:"format"`
		} `json:"columns"`
		Rows []struct {
			Values []any `json:"values"`
		} `json:"rows"`
		Kept      *int           `json:"kept"`
		Truncated bool           `json:"truncated"`
		Totals    map[string]any `json:"totals"`
		Groups    []answerGroup  `json:"groups"`
	}
	if err := json.Unmarshal(raw, &answer); err != nil {
		return err
	}
	header := make([]string, len(answer.Columns))
	titles := map[string]string{}
	for i, c := range answer.Columns {
		titles[c.ID] = c.Title
		header[i] = strings.ToUpper(c.Title)
		if c.Format != nil && c.Format.Minor {
			// Money kept as a whole count of the currency's smallest unit is printed as it is kept.
			header[i] += " (MINOR UNITS)"
		}
	}
	rows := make([][]string, 0, len(answer.Rows))
	for _, r := range answer.Rows {
		row := make([]string, len(header))
		for i := range header {
			if i < len(r.Values) {
				row[i] = cell(r.Values[i])
			}
		}
		rows = append(rows, row)
	}
	if err := table(out, header, rows); err != nil {
		return err
	}
	switch {
	case answer.Kept == nil:
		fmt.Fprintln(note, "this hub is older than this command line: the rows are every row read, not shaped by the query's own conditions and order")
	case *answer.Kept > len(answer.Rows):
		fmt.Fprintf(note, "%d of %d rows shown; raise --limit for more\n", len(answer.Rows), *answer.Kept)
	}
	if len(answer.Totals) > 0 {
		text, _ := json.Marshal(answer.Totals)
		fmt.Fprintf(note, "totals: %s\n", text)
	}
	if len(answer.Groups) > 0 {
		fmt.Fprintln(note, "groups:")
		printGroups(note, answer.Groups, titles, 1)
	}
	if answer.Truncated {
		fmt.Fprintln(note, "more matched than one answer holds: narrow the query")
	}
	return nil
}

// answerGroup is one group of a shaped answer, as the hub sends it.
type answerGroup struct {
	Column string         `json:"column"`
	Value  *string        `json:"value"`
	Count  int            `json:"count"`
	Totals map[string]any `json:"totals"`
	Groups []answerGroup  `json:"groups"`
}

// printGroups writes each group on a line under the one that holds it: its
// column and value, its count, and its totals when it has any.
func printGroups(note io.Writer, groups []answerGroup, titles map[string]string, depth int) {
	for _, g := range groups {
		name, value := g.Column, "(none)"
		if title := titles[g.Column]; title != "" {
			name = title
		}
		if g.Value != nil {
			value = *g.Value
		}
		line := fmt.Sprintf("%s%s %s: %d", strings.Repeat("  ", depth), name, value, g.Count)
		if len(g.Totals) > 0 {
			text, _ := json.Marshal(g.Totals)
			line += " " + string(text)
		}
		fmt.Fprintln(note, line)
		printGroups(note, g.Groups, titles, depth+1)
	}
}
