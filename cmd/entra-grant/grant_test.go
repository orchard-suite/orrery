package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/http/httptest"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/graph"
)

// fakeGraph holds one app with one role, one user, a group, and a dynamic
// group, and records what was written.
type fakeGraph struct {
	assigned []map[string]string
	members  map[string]bool
	deleted  []string
}

func (f *fakeGraph) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	send := func(v any) { json.NewEncoder(w).Encode(v) }
	switch {
	case r.Method == http.MethodGet && r.URL.Path == "/servicePrincipals(appId='app-crm')":
		send(map[string]any{"id": "sp-crm", "displayName": "CRM", "appRoles": []map[string]any{
			{"id": "role-reader", "value": "Reader", "allowedMemberTypes": []string{"User"}, "isEnabled": true},
			{"id": "role-sync", "value": "Sync", "allowedMemberTypes": []string{"Application"}, "isEnabled": true},
		}})
	case r.Method == http.MethodGet && r.URL.Path == "/servicePrincipals(appId='app-none')":
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"Request_ResourceNotFound","message":"gone"}}`))
	case r.Method == http.MethodGet && r.URL.Path == "/users/user-1":
		send(map[string]any{"id": "user-1", "displayName": "One", "accountEnabled": true})
	case r.Method == http.MethodGet && r.URL.Path == "/users/user-off":
		send(map[string]any{"id": "user-off", "displayName": "Off", "accountEnabled": false})
	case r.Method == http.MethodGet && r.URL.Path == "/users":
		if strings.Contains(r.URL.Query().Get("$filter"), "'user@example.com'") {
			send(map[string]any{"value": []map[string]any{{"id": "user-1", "displayName": "One", "accountEnabled": true}}})
			return
		}
		send(map[string]any{"value": []any{}})
	case r.Method == http.MethodGet && r.URL.Path == "/servicePrincipals/sp-crm/appRoleAssignedTo":
		send(map[string]any{"value": f.assigned})
	case r.Method == http.MethodPost && r.URL.Path == "/servicePrincipals/sp-crm/appRoleAssignedTo":
		var body map[string]string
		json.NewDecoder(r.Body).Decode(&body)
		body["id"] = fmt.Sprintf("as-%d", len(f.assigned)+1)
		body["principalType"] = "User"
		f.assigned = append(f.assigned, body)
		w.WriteHeader(201)
		send(body)
	case r.Method == http.MethodDelete && strings.HasPrefix(r.URL.Path, "/servicePrincipals/sp-crm/appRoleAssignedTo/"):
		id := strings.TrimPrefix(r.URL.Path, "/servicePrincipals/sp-crm/appRoleAssignedTo/")
		for i, a := range f.assigned {
			if a["id"] == id {
				f.assigned = append(f.assigned[:i], f.assigned[i+1:]...)
				f.deleted = append(f.deleted, id)
				w.WriteHeader(204)
				return
			}
		}
		w.WriteHeader(404)
		w.Write([]byte(`{"error":{"code":"Request_ResourceNotFound","message":"gone"}}`))
	case r.Method == http.MethodDelete && r.URL.Path == "/groups/group-payments/members/user-1/$ref":
		ref := `{"@odata.id":"` + graph.Root + `/directoryObjects/user-1"}`
		if !f.members[ref] {
			w.WriteHeader(404)
			w.Write([]byte(`{"error":{"code":"Request_ResourceNotFound","message":"not a member"}}`))
			return
		}
		delete(f.members, ref)
		w.WriteHeader(204)
	case r.Method == http.MethodGet && r.URL.Path == "/groups/group-payments":
		send(map[string]any{"id": "group-payments", "displayName": "Payments", "groupTypes": []string{}})
	case r.Method == http.MethodGet && r.URL.Path == "/groups/group-dyn":
		send(map[string]any{"id": "group-dyn", "displayName": "Everyone", "groupTypes": []string{"DynamicMembership"}})
	case r.Method == http.MethodPost && r.URL.Path == "/groups/group-payments/members/$ref":
		raw, _ := io.ReadAll(r.Body)
		ref := string(raw)
		if f.members[ref] {
			w.WriteHeader(400)
			w.Write([]byte(`{"error":{"code":"Request_BadRequest","message":"One or more added object references already exist for the following modified properties: 'members'."}}`))
			return
		}
		f.members[ref] = true
		w.WriteHeader(204)
	default:
		w.WriteHeader(418)
		w.Write([]byte(`{"error":{"code":"Unexpected","message":"` + r.Method + ` ` + r.URL.String() + `"}}`))
	}
}

func granter(t *testing.T) (Granter, *fakeGraph) {
	t.Helper()
	f := &fakeGraph{members: map[string]bool{}}
	srv := httptest.NewServer(f)
	t.Cleanup(srv.Close)
	return Granter{g: graph.New(srv.URL, "tok")}, f
}

func TestAssignGivesTheRoleOnceAndIsIdempotent(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	outcome, what, err := gr.Assign(ctx, "tenant-1/app-crm", "user@example.com", "reader")
	if err != nil || outcome != Granted || what != "One as reader on CRM" {
		t.Fatalf("%v %q %v", outcome, what, err)
	}
	if len(f.assigned) != 1 || f.assigned[0]["principalId"] != "user-1" || f.assigned[0]["resourceId"] != "sp-crm" || f.assigned[0]["appRoleId"] != "role-reader" {
		t.Fatalf("wrote %v", f.assigned)
	}
	if outcome, _, err := gr.Assign(ctx, "app-crm", "tenant-1/user-1", "Reader"); err != nil || outcome != Already || len(f.assigned) != 1 {
		t.Fatalf("a role already held changes nothing: %v %v %v", outcome, err, f.assigned)
	}
}

func TestAssignRefusesWhatItCannotGive(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	for name, c := range map[string]struct{ app, user, role, want string }{
		"a role for apps only":         {"app-crm", "user-1", "Sync", "its roles are Reader"},
		"default on an app with roles": {"app-crm", "user-1", "default", "its roles are Reader"},
		"a disabled user":              {"app-crm", "user-off", "Reader", "disabled"},
		"nobody by that email":         {"app-crm", "nobody@example.com", "Reader", "0 people answer"},
		"an app Entra lacks":           {"app-none", "user-1", "Reader", "404 Request_ResourceNotFound"},
	} {
		if _, _, err := gr.Assign(ctx, c.app, c.user, c.role); err == nil || !strings.Contains(err.Error(), c.want) {
			t.Errorf("%s: got %v, want it to say %q", name, err, c.want)
		}
	}
	if len(f.assigned) != 0 {
		t.Fatalf("a refused grant wrote %v", f.assigned)
	}
}

func TestAddToGroupIsIdempotentAndRefusesADynamicGroup(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	if outcome, what, err := gr.AddToGroup(ctx, "tenant-1/group-payments", "user-1"); err != nil || outcome != Granted || what != "One in Payments" {
		t.Fatalf("%v %q %v", outcome, what, err)
	}
	if outcome, _, err := gr.AddToGroup(ctx, "group-payments", "user@example.com"); err != nil || outcome != Already {
		t.Fatalf("a member already is success: %v %v", outcome, err)
	}
	if len(f.members) != 1 {
		t.Fatalf("members %v", f.members)
	}
	if _, _, err := gr.AddToGroup(ctx, "group-dyn", "user-1"); !errors.Is(err, ErrDynamic) {
		t.Fatalf("got %v", err)
	}
}

func TestRoleID(t *testing.T) {
	if id, err := RoleID(nil, "default"); err != nil || id != DefaultRoleID {
		t.Fatalf("an app with no roles gives default access: %q %v", id, err)
	}
	if _, err := RoleID(nil, "Admin"); err == nil || !strings.Contains(err.Error(), "default access only") {
		t.Fatalf("got %v", err)
	}
}

func TestParseArgs(t *testing.T) {
	r, err := ParseArgs([]string{"assign", "--app", "t/app", "--user", "user@example.com", "--role", "default", "--approval", "t/req", "--by", "desk@example.com"}, io.Discard)
	if err != nil || !reflect.DeepEqual(r, Request{Command: "assign", App: "t/app", User: "user@example.com", Role: "default", Approval: "t/req", By: "desk@example.com"}) {
		t.Fatalf("%+v %v", r, err)
	}
	r, err = ParseArgs([]string{"unassign", "--app", "t/app", "--group", "t/g", "--role", "Reader"}, io.Discard)
	if err != nil || !reflect.DeepEqual(r, Request{Command: "unassign", App: "t/app", Group: "t/g", Role: "Reader"}) {
		t.Fatalf("%+v %v", r, err)
	}
	// A review's assignments follow its flags, one argument each; an empty one is a list with nothing in it.
	r, err = ParseArgs([]string{"review", "--application", "crm", "--app", "t/app-crm", "--app", "t/app-crm-old", "--key", "orrery/run-1", "--by", "desk@example.com", "--note", "", "t/as-1", "", "t/as-2"}, io.Discard)
	if err != nil || !reflect.DeepEqual(r, Request{Command: "review", Application: "crm", Apps: []string{"t/app-crm", "t/app-crm-old"}, Key: "orrery/run-1", By: "desk@example.com", Remove: []string{"t/as-1", "t/as-2"}}) {
		t.Fatalf("%+v %v", r, err)
	}
	if r, err := ParseArgs([]string{"review", "--application", "crm", "--app", "t/app-crm", "--key", "k", "--by", "desk@example.com", ""}, io.Discard); err != nil || len(r.Remove) != 0 {
		t.Fatalf("a review that removes nothing: %+v %v", r, err)
	}
	for _, bad := range [][]string{
		{}, {"remove"},
		{"assign", "--app", "a", "--user", "u"},
		{"add-to-group", "--user", "u"},
		{"assign", "--app", "a", "--user", "u", "--role", "r", "extra"},
		{"unassign", "--app", "a", "--role", "r"},
		{"unassign", "--app", "a", "--user", "u", "--group", "g", "--role", "r"},
		{"remove-from-group", "--group", "g"},
		{"review", "--application", "crm", "--key", "k", "--by", "b", "t/as-1"},
		{"review", "--app", "a", "--key", "k", "--by", "b"},
		{"review", "--application", "crm", "--app", "a", "--by", "b"},
		{"review", "--application", "crm", "--app", "a", "--key", "k"},
		{"review", "--application", "crm", "--app", "a", "--key", "k", "--by", "b", "--approval", "x"},
	} {
		if _, err := ParseArgs(bad, io.Discard); err == nil {
			t.Errorf("%v should be refused", bad)
		}
	}
}

func TestApprovedClosesTheApproval(t *testing.T) {
	e := Approved(Request{Approval: "t/req", By: "desk@example.com"}, "One in Payments", time.Date(2026, 11, 4, 12, 0, 0, 0, time.UTC))
	if e.Blueprint != "it_approval" || e.Key != "t/req" || e.Fields["decision"] != "approved" || e.Fields["decided_by"] != "desk@example.com" || e.Fields["decided_at"] != "2026-11-04T12:00:00Z" || e.Fields["decision_note"] != "Granted: One in Payments." {
		t.Fatalf("%+v", e)
	}
}

func TestUnassignTakesTheRoleAwayAndIsIdempotent(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	f.assigned = []map[string]string{
		{"id": "as-1", "principalId": "user-off", "principalType": "User", "appRoleId": "role-reader"},
		{"id": "as-2", "principalId": "group-payments", "principalType": "Group", "appRoleId": "role-reader"},
	}
	// A disabled user still loses what they hold.
	outcome, what, err := gr.Unassign(ctx, "tenant-1/app-crm", Holder{Kind: "user", Key: "tenant-1/user-off"}, "reader")
	if err != nil || outcome != Removed || what != "Off as reader on CRM" {
		t.Fatalf("%v %q %v", outcome, what, err)
	}
	if outcome, _, err := gr.Unassign(ctx, "app-crm", Holder{Kind: "user", Key: "user-off"}, "Reader"); err != nil || outcome != Gone {
		t.Fatalf("access already gone is success: %v %v", outcome, err)
	}
	if outcome, what, err := gr.Unassign(ctx, "app-crm", Holder{Kind: "group", Key: "tenant-1/group-payments"}, "Reader"); err != nil || outcome != Removed || what != "Payments as Reader on CRM" {
		t.Fatalf("group: %v %q %v", outcome, what, err)
	}
	if !reflect.DeepEqual(f.deleted, []string{"as-1", "as-2"}) || len(f.assigned) != 0 {
		t.Fatalf("deleted %v, left %v", f.deleted, f.assigned)
	}
	if _, _, err := gr.Unassign(ctx, "app-crm", Holder{Kind: "user", Key: "user-1"}, "Owner"); err == nil || !strings.Contains(err.Error(), `no role "Owner"`) {
		t.Fatalf("a role the app lacks: %v", err)
	}
}

func TestRemoveFromGroupIsIdempotentAndRefusesADynamicGroup(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	if _, _, err := gr.AddToGroup(ctx, "group-payments", "user-1"); err != nil {
		t.Fatal(err)
	}
	if outcome, what, err := gr.RemoveFromGroup(ctx, "tenant-1/group-payments", "user@example.com"); err != nil || outcome != Removed || what != "One in Payments" {
		t.Fatalf("%v %q %v", outcome, what, err)
	}
	if outcome, _, err := gr.RemoveFromGroup(ctx, "group-payments", "user-1"); err != nil || outcome != Gone {
		t.Fatalf("someone already out is success: %v %v", outcome, err)
	}
	if len(f.members) != 0 {
		t.Fatalf("members %v", f.members)
	}
	if _, _, err := gr.RemoveFromGroup(ctx, "group-dyn", "user-1"); !errors.Is(err, ErrDynamic) {
		t.Fatalf("got %v", err)
	}
}

func TestReviewRemovesWhatWasPickedAndCountsWhatIsLeft(t *testing.T) {
	gr, f := granter(t)
	ctx := context.Background()
	f.assigned = []map[string]string{
		{"id": "as-1", "principalId": "user-1", "principalType": "User", "principalDisplayName": "One", "appRoleId": "role-reader"},
		{"id": "as-2", "principalId": "group-payments", "principalType": "Group", "principalDisplayName": "Payments", "appRoleId": "role-reader"},
		{"id": "as-3", "principalId": "user-2", "principalType": "User", "principalDisplayName": "Two", "appRoleId": DefaultRoleID},
		{"id": "as-4", "principalId": "sp-sync", "principalType": "ServicePrincipal", "principalDisplayName": "Sync", "appRoleId": "role-sync"},
	}
	r, err := gr.Review(ctx, []string{"tenant-1/app-crm"}, []string{"tenant-1/as-1", "tenant-1/as-3", "tenant-1/as-9"})
	if err != nil {
		t.Fatal(err)
	}
	want := []Removal{
		{Key: "tenant-1/as-1", Outcome: Removed, What: "One as Reader on CRM"},
		{Key: "tenant-1/as-3", Outcome: Removed, What: "Two as default on CRM"},
		{Key: "tenant-1/as-9", Outcome: Gone, What: "not held on CRM"},
	}
	// An app holding an app is not a person's access, so it is not counted as kept.
	if !reflect.DeepEqual(r.Removed, want) || r.Kept != 1 {
		t.Fatalf("%+v", r)
	}
	if !reflect.DeepEqual(f.deleted, []string{"as-1", "as-3"}) {
		t.Fatalf("deleted %v", f.deleted)
	}
	again, err := gr.Review(ctx, []string{"app-crm"}, []string{"tenant-1/as-1"})
	if err != nil || again.Removed[0].Outcome != Gone || again.Kept != 1 {
		t.Fatalf("a review run again changes nothing: %+v %v", again, err)
	}
	if _, err := gr.Review(ctx, []string{"app-none"}, nil); err == nil || !strings.Contains(err.Error(), "404") {
		t.Fatalf("an app Entra lacks: %v", err)
	}
}

func TestReviewedRecordsTheSignOff(t *testing.T) {
	req := Request{Command: "review", Application: "crm", Key: "orrery/run-1", By: "desk@example.com", Note: "Left the team."}
	r := Review{Removed: []Removal{{Key: "t/as-1", Outcome: Removed}, {Key: "t/as-9", Outcome: Gone}}, Kept: 4}
	e := Reviewed(req, r, time.Date(2026, 11, 7, 9, 30, 0, 0, time.UTC))
	want := map[string]any{"reviewed_at": "2026-11-07T09:30:00Z", "reviewed_by": "desk@example.com", "system": "entra", "kept_count": 4, "removed_count": 2, "removed": []string{"t/as-1", "t/as-9"}, "notes": "Left the team."}
	if e.Blueprint != "it_access_review" || e.Key != "orrery/run-1" || !reflect.DeepEqual(e.Fields, want) || !reflect.DeepEqual(e.Relations, map[string]any{"application": "crm"}) || e.Title != "Access review by desk@example.com" {
		t.Fatalf("%+v", e)
	}
	if _, ok := Reviewed(Request{By: "b"}, Review{}, time.Now()).Fields["notes"]; ok {
		t.Fatal("no note writes no notes")
	}
}

// steps is every step the log lines started, in order.
func steps(out *bytes.Buffer) string {
	var named []string
	for _, line := range strings.Split(strings.TrimSpace(out.String()), "\n") {
		var l struct {
			Step string `json:"step"`
		}
		if json.Unmarshal([]byte(line), &l) == nil && l.Step != "" && (len(named) == 0 || named[len(named)-1] != l.Step) {
			named = append(named, l.Step)
		}
	}
	return strings.Join(named, ",")
}

func TestEachChangeNamesItsSteps(t *testing.T) {
	gr, _ := granter(t)
	ctx := context.Background()
	var out bytes.Buffer
	log := slog.New(slog.NewJSONHandler(&out, nil))
	if code := grant(ctx, log, gr, nil, Request{Command: "add-to-group", Group: "group-payments", User: "user-1"}); code != 0 || steps(&out) != "Give access" {
		t.Fatalf("exit %d, steps %q", code, steps(&out))
	}
	out.Reset()
	if code := remove(ctx, log, gr, Request{Command: "remove-from-group", Group: "group-payments", User: "user-1"}); code != 0 || steps(&out) != "Remove access" {
		t.Fatalf("exit %d, steps %q", code, steps(&out))
	}
	out.Reset()
	// A change that fails says so under the step it failed in.
	if code := grant(ctx, log, gr, nil, Request{Command: "add-to-group", Group: "group-dyn", User: "user-1"}); code != 1 || steps(&out) != "Give access" {
		t.Fatalf("exit %d, steps %q", code, steps(&out))
	}
}
