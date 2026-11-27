// The change statement's schema, the change event's schema, the base effect
// kinds, and the worked examples here are copies of the platform kit's, at the version go.mod requires. This test holds each copy
// to the file in that module, byte for byte, so the copy moves only when the
// requirement does.
package change_test

import (
	"bytes"
	"encoding/json"
	"os"
	"os/exec"
	"path/filepath"
	"strings"
	"testing"

	"github.com/orchard-suite/platformkit/v3/change"
)

const module = "github.com/orchard-suite/platformkit/v3"

// moduleDir is where the go command keeps the required platform kit.
func moduleDir(t *testing.T) string {
	t.Helper()
	out, err := exec.Command("go", "list", "-m", "-f", "{{.Dir}}", module).Output()
	if err != nil {
		t.Fatalf("go list %s: %v", module, err)
	}
	dir := strings.TrimSpace(string(out))
	if dir == "" {
		t.Fatalf("go list %s named no directory: run go mod download", module)
	}
	return dir
}

func TestCopiesMatchThePlatformKit(t *testing.T) {
	kit := filepath.Join(moduleDir(t), "change", "schema")
	copies := map[string]string{"statement.json": "statement.json", "event.json": "event.json", "base-kinds.json": filepath.Join("..", "base-kinds.json")}
	examples, err := filepath.Glob(filepath.Join("examples", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	bad, err := filepath.Glob(filepath.Join("examples", "bad", "*.json"))
	if err != nil {
		t.Fatal(err)
	}
	for _, f := range append(examples, bad...) {
		copies[f] = f
	}
	if len(copies) < 2 {
		t.Fatal("no worked examples are copied")
	}
	for here, there := range copies {
		mine, err := os.ReadFile(here)
		if err != nil {
			t.Fatal(err)
		}
		theirs, err := os.ReadFile(filepath.Join(kit, there))
		if err != nil {
			t.Fatalf("%s is not in the platform kit: %v", there, err)
		}
		if !bytes.Equal(mine, theirs) {
			t.Errorf("%s differs from the platform kit's %s: copy it again from the version go.mod requires", here, there)
		}
	}
}

// The worked example's digest is the platform kit's own reading of its
// statement, which the hub's TypeScript digest is held to.
func TestTheExampleDigestIsThePlatformKits(t *testing.T) {
	b, err := os.ReadFile(filepath.Join("examples", "event-stated.json"))
	if err != nil {
		t.Fatal(err)
	}
	var e change.Stated
	if err := json.Unmarshal(b, &e); err != nil {
		t.Fatal(err)
	}
	if err := e.Validate(nil); err != nil {
		t.Fatalf("the worked example is not a valid change.stated event: %v", err)
	}
	got, err := e.Statement.Digest()
	if err != nil {
		t.Fatal(err)
	}
	if got != e.Digest {
		t.Errorf("digest %s, the example says %s", got, e.Digest)
	}
}
