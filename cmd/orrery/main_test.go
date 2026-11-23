package main

import (
	"encoding/json"
	"testing"
)

func TestReportOfReadsTheStepAndTheOutputs(t *testing.T) {
	id, report, err := reportOf([]string{"r1", "--state", "running", "--step", "Verify", "--output", "url=https://example.org/a?b=c", "--output", "replicas=3", "--log", "seen"})
	if err != nil || id != "r1" {
		t.Fatalf("got %q, %v", id, err)
	}
	sent, _ := json.Marshal(report)
	if want := `{"state":"running","log":["seen"],"step":"Verify","outputs":{"replicas":"3","url":"https://example.org/a?b=c"}}`; string(sent) != want {
		t.Fatalf("sent %s, want %s", sent, want)
	}
	// A report that names neither sends neither, so an older hub reads it as before.
	_, report, _ = reportOf([]string{"r1", "--log", "one"})
	if sent, _ := json.Marshal(report); string(sent) != `{"log":["one"]}` {
		t.Fatalf("sent %s", sent)
	}
	if _, _, err := reportOf([]string{"r1", "--output", "novalue"}); err == nil {
		t.Fatal("an output with no value was taken")
	}
	if _, _, err := reportOf([]string{"--step", "Verify"}); err == nil {
		t.Fatal("a report on no run was taken")
	}
}
