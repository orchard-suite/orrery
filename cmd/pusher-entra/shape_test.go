package main

import (
	"encoding/json"
	"reflect"
	"testing"

	"github.com/orchard-suite/orrery/sdk"
)

const tenant = "00000000-0000-0000-0000-00000000aaaa"

// principal is a service principal shaped as Graph returns it, owned by the
// test tenant, enabled, with one web redirect.
func principal(name string, edit func(*Principal)) Principal {
	p := Principal{
		ID: "11111111-0000-0000-0000-" + name, AppID: "22222222-0000-0000-0000-" + name, DisplayName: name,
		AccountEnabled: true, ServicePrincipalType: "Application", AppOwnerOrganizationID: tenant,
		ReplyURLs: []string{"https://" + name + ".example.com/auth/callback"},
	}
	if edit != nil {
		edit(&p)
	}
	return p
}

func TestKeepOnlyAppsPeopleSignInTo(t *testing.T) {
	cases := []struct {
		name string
		p    Principal
		want bool
	}{
		{"own app with a web redirect", principal("wiki", nil), true},
		{"own app with a local and a web redirect", principal("portal", func(p *Principal) {
			p.ReplyURLs = []string{"http://localhost:8080/oauth2/callback", "https://portal.example.com/oauth2/callback"}
		}), true},
		{"gallery app with SAML", principal("crm", func(p *Principal) {
			p.AppOwnerOrganizationID, p.Tags, p.ReplyURLs, p.PreferredSingleSignOnMode = "33333333-0000-0000-0000-000000000000", []string{GalleryTag}, nil, "saml"
		}), true},
		{"gallery app with a sign-on url", principal("expenses", func(p *Principal) {
			p.AppOwnerOrganizationID, p.Tags, p.ReplyURLs, p.LoginURL = "33333333-0000-0000-0000-000000000000", []string{GalleryTag, "HideApp"}, nil, "https://expenses.example.com/sso"
		}), true},
		{"disabled", principal("old", func(p *Principal) { p.AccountEnabled = false }), false},
		{"managed identity", principal("mi", func(p *Principal) { p.ServicePrincipalType = "ManagedIdentity" }), false},
		{"Microsoft's own principal", principal("graph", func(p *Principal) { p.AppOwnerOrganizationID = "44444444-0000-0000-0000-000000000000" }), false},
		{"daemon with no redirect", principal("feed", func(p *Principal) { p.ReplyURLs = nil }), false},
		{"local and custom-scheme redirects only", principal("cli", func(p *Principal) {
			p.ReplyURLs = []string{"http://localhost:3000", "https://127.0.0.1/cb", "myapp://auth"}
		}), false},
	}
	for _, c := range cases {
		if got := Keep(c.p, tenant); got != c.want {
			t.Errorf("%s: Keep = %v, want %v", c.name, got, c.want)
		}
	}
}

func TestLaunchURLPrefersTheSignOnURL(t *testing.T) {
	cases := []struct {
		name string
		p    Principal
		want string
	}{
		{"sign-on url", principal("a", func(p *Principal) { p.LoginURL, p.Homepage = "https://a.example.com/sso", "https://a.example.com/" }), "https://a.example.com/sso"},
		{"home page", principal("b", func(p *Principal) { p.Homepage = "https://b.example.com/home" }), "https://b.example.com/home"},
		{"redirect origin, past a local one", principal("c", func(p *Principal) {
			p.ReplyURLs = []string{"http://localhost/cb", "https://c.example.com:8443/auth/callback"}
		}), "https://c.example.com:8443"},
		{"launcher", principal("d", func(p *Principal) { p.ReplyURLs = nil; p.PreferredSingleSignOnMode = "saml" }),
			"https://launcher.myapps.microsoft.com/api/signin/22222222-0000-0000-0000-d?tenantId=" + tenant},
	}
	for _, c := range cases {
		if got := LaunchURL(c.p, tenant); got != c.want {
			t.Errorf("%s: LaunchURL = %q, want %q", c.name, got, c.want)
		}
	}
}

func TestShapeWritesWhoMaySignIn(t *testing.T) {
	crm := principal("crm", func(p *Principal) {
		p.AppOwnerOrganizationID, p.Tags, p.PreferredSingleSignOnMode, p.AppRoleAssignmentRequired = "33333333-0000-0000-0000-000000000000", []string{GalleryTag}, "saml", true
		p.AppRoles = []AppRole{
			{ID: "role-admin", Value: "Admin", DisplayName: "Administrator", AllowedMemberTypes: []string{"User"}, IsEnabled: true},
			{ID: "role-app", Value: "Sync", AllowedMemberTypes: []string{"Application"}, IsEnabled: true},
			{ID: "role-old", Value: "Old", AllowedMemberTypes: []string{"User"}, IsEnabled: false},
		}
	})
	tenantRead := Tenant{
		Apps: []App{{
			Principal: crm,
			Icon:      "entra_22222222000000000000crm",
			Assignments: []Assignment{
				{ID: "as-1", PrincipalID: "group-b", PrincipalType: "Group", AppRoleID: "role-admin"},
				{ID: "as-2", PrincipalID: "user-1", PrincipalType: "User", AppRoleID: DefaultRoleID},
				{ID: "as-3", PrincipalID: "group-a", PrincipalType: "Group", AppRoleID: "role-gone"},
				{ID: "as-4", PrincipalID: "robot", PrincipalType: "ServicePrincipal"},
				{ID: "as-5", PrincipalID: "user-off", PrincipalType: "User"},
			},
		}, {Principal: principal("wiki", nil)}},
		Groups: []Group{{ID: "group-a", DisplayName: "Sales", GroupTypes: []string{"Unified", "DynamicMembership"}, Members: []string{"user-2", "user-off", "user-2"}}, {ID: "group-b", DisplayName: "Admins"}},
		Users:  []User{{ID: "user-1", DisplayName: "One", Mail: "User@Example.com", AccountEnabled: true}, {ID: "user-2", UserPrincipalName: "two@example.com", UserType: "Guest", AccountEnabled: true}},
	}
	got := map[string]sdk.Entity{}
	for _, e := range Shape(tenantRead, tenant) {
		got[e.Blueprint+":"+e.Key] = e
	}
	e := got["entra_app:"+tenant+"/"+crm.AppID]
	if e.Title != "crm" || e.Icon != "entra_22222222000000000000crm" {
		t.Fatalf("entity %+v", e)
	}
	want := map[string]any{
		"app_id": crm.AppID, "object_id": crm.ID, "tenant_id": tenant,
		"assignment_required": true,
		"assigned_groups":     []string{"group-a", "group-b"},
		"assigned_users":      []string{"user-1", "user-off"},
		"roles":               []string{"Admin"},
		"role_titles":         []string{"Administrator"},
		"launch_url":          "https://crm.example.com",
		"sign_in":             "saml",
		"publisher":           "gallery",
		"portal":              "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/" + crm.ID + "/appId/" + crm.AppID,
	}
	if !reflect.DeepEqual(e.Fields, want) {
		t.Fatalf("fields\n got %v\nwant %v", e.Fields, want)
	}
	wiki := got["entra_app:"+tenant+"/"+principal("wiki", nil).AppID].Fields
	if wiki["publisher"] != "tenant" || wiki["sign_in"] != "oidc" || wiki["assignment_required"] != false || !reflect.DeepEqual(wiki["roles"], []string{"default"}) {
		t.Fatalf("wiki fields %v", wiki)
	}

	// One assignment per user or group the pusher keeps, named by its role's value.
	admins := got["entra_app_role_assignment:"+tenant+"/as-1"]
	if admins.Fields["role"] != "Admin" || admins.Fields["principal_type"] != "group" || admins.Relations["group"] != tenant+"/group-b" || admins.Relations["app"] != tenant+"/"+crm.AppID {
		t.Fatalf("group assignment %+v", admins)
	}
	if one := got["entra_app_role_assignment:"+tenant+"/as-2"]; one.Fields["role"] != "default" || one.Relations["user"] != tenant+"/user-1" {
		t.Fatalf("user assignment %+v", one)
	}
	if gone := got["entra_app_role_assignment:"+tenant+"/as-3"]; gone.Fields["role"] != "role-gone" {
		t.Fatalf("a role the app no longer defines keeps its id, got %+v", gone)
	}
	for _, skipped := range []string{"as-4", "as-5"} {
		if _, ok := got["entra_app_role_assignment:"+tenant+"/"+skipped]; ok {
			t.Fatalf("%s names an app or a disabled user, and is not pushed", skipped)
		}
	}

	sales := got["entra_group:"+tenant+"/group-a"]
	if sales.Fields["kind"] != "microsoft365" || sales.Fields["dynamic"] != true || !reflect.DeepEqual(sales.Relations["members"], []string{tenant + "/user-2"}) {
		t.Fatalf("group %+v", sales)
	}
	if b := got["entra_group:"+tenant+"/group-b"]; b.Fields["kind"] != "security" || b.Fields["dynamic"] != false || len(b.Relations["members"].([]string)) != 0 {
		t.Fatalf("group %+v", b)
	}
	if u := got["entra_user:"+tenant+"/user-1"]; u.Title != "One" || u.Fields["email"] != "user@example.com" || u.Fields["user_type"] != "member" {
		t.Fatalf("user %+v", u)
	}
	if u := got["entra_user:"+tenant+"/user-2"]; u.Title != "two@example.com" || u.Fields["email"] != "two@example.com" || u.Fields["user_type"] != "guest" {
		t.Fatalf("guest %+v", u)
	}
}

func TestWantedAndPickReadOnlyWhoIsAssigned(t *testing.T) {
	groups, users := Wanted([]App{{Assignments: []Assignment{{PrincipalID: "g2", PrincipalType: "Group"}, {PrincipalID: "u1", PrincipalType: "User"}, {PrincipalID: "g1", PrincipalType: "Group"}, {PrincipalID: "g2", PrincipalType: "Group"}, {PrincipalID: "sp", PrincipalType: "ServicePrincipal"}}}})
	if !reflect.DeepEqual(groups, []string{"g1", "g2"}) || !reflect.DeepEqual(users, []string{"u1"}) {
		t.Fatalf("groups %v users %v", groups, users)
	}
	picked := Pick([]User{{ID: "u3", AccountEnabled: true}, {ID: "u1", AccountEnabled: true}, {ID: "u2", AccountEnabled: false}, {ID: "u4", AccountEnabled: true}}, []string{"u1", "u2", "u3"})
	if len(picked) != 2 || picked[0].ID != "u1" || picked[1].ID != "u3" {
		t.Fatalf("picked %+v", picked)
	}
}

func TestShapeRequestsPushesWhatWaits(t *testing.T) {
	read := Tenant{Apps: []App{{Principal: principal("crm", nil)}}, Users: []User{{ID: "user-1", Mail: "User@Example.com", AccountEnabled: true}}}
	consent := ConsentRequest{ID: "c1", AppID: principal("crm", nil).AppID, AppDisplayName: "CRM"}
	var w UserConsentRequest
	w.ID, w.Status, w.Reason, w.CreatedDateTime = "w1", "InProgress", "need the CRM", "2026-11-01T10:00:00Z"
	w.CreatedBy.User.ID, w.CreatedBy.User.DisplayName = "user-1", "One"
	consent.Waiting = []UserConsentRequest{w}
	newApp := ConsentRequest{ID: "c2", AppID: "unknown-app", AppDisplayName: "Shiny"}
	var w2 UserConsentRequest
	w2.ID, w2.CreatedBy.User.ID, w2.CreatedBy.User.UserPrincipalName = "w2", "user-9", "Other@Example.com"
	newApp.Waiting = []UserConsentRequest{w2}
	var pkg, done PackageRequest
	pkg.ID, pkg.State, pkg.Justification = "p1", "pendingApproval", "project work"
	pkg.Requestor.ObjectID, pkg.Requestor.DisplayName = "user-1", "One"
	pkg.AccessPackage.DisplayName = "Payments developers"
	done.ID, done.State = "p2", "delivered"

	got := map[string]sdk.Entity{}
	for _, e := range ShapeRequests(Requests{Consent: []ConsentRequest{consent, newApp}, Packages: []PackageRequest{pkg, done}}, read, tenant) {
		got[e.Key] = e
	}
	if len(got) != 3 {
		t.Fatalf("got %d approvals, want 3: a delivered package request is not waiting", len(got))
	}
	c := got[tenant+"/consent/w1"]
	if c.Blueprint != "it_approval" || c.Title != "CRM for One" || c.Fields["kind"] != "consent" || c.Fields["decision"] != "pending" || c.Fields["system"] != "entra" || c.Fields["requested_by"] != "user@example.com" || c.Fields["url"] != ConsentReviewURL {
		t.Fatalf("consent %+v", c)
	}
	if c.Relations["app"] != tenant+"/"+principal("crm", nil).AppID || c.Relations["user"] != tenant+"/user-1" {
		t.Fatalf("consent links %+v", c.Relations)
	}
	n := got[tenant+"/consent/w2"]
	if n.Fields["kind"] != "new_app" || n.Fields["requested_by"] != "other@example.com" || len(n.Relations) != 0 {
		t.Fatalf("an app the tenant does not keep is a new app, linked to nobody the pusher does not keep: %+v", n)
	}
	if _, has := n.Fields["reason"]; has {
		t.Fatal("what Entra left empty is not written")
	}
	p := got[tenant+"/package/p1"]
	if p.Title != "Payments developers for One" || p.Fields["kind"] != "access_package" || p.Fields["reason"] != "project work" || p.Fields["url"] != PackageApprovalURL {
		t.Fatalf("package %+v", p)
	}
}

func TestRequestKinds(t *testing.T) {
	if k, err := RequestKinds(" consent, packages,consent "); err != nil || !reflect.DeepEqual(k, []string{"consent", "packages"}) {
		t.Fatalf("%v %v", k, err)
	}
	if k, err := RequestKinds(""); err != nil || len(k) != 0 {
		t.Fatalf("unset reads none: %v %v", k, err)
	}
	if _, err := RequestKinds("tickets"); err == nil {
		t.Fatal("an unknown kind is refused")
	}
}

func TestIconNameFitsTheHub(t *testing.T) {
	if got := IconName("0A1B2C3D-0000-4000-8000-00000000ABCD"); got != "entra_0a1b2c3d00004000800000000000abcd" {
		t.Fatal(got)
	}
}

func TestImageTypeKnowsPNGAndWebP(t *testing.T) {
	cases := map[string]string{"\x89PNG\r\n\x1a\nrest": "image/png", "RIFF\x00\x00\x00\x00WEBPVP8 ": "image/webp", "\xff\xd8\xff\xe0jpeg": "", "": ""}
	for in, want := range cases {
		if got := ImageType([]byte(in)); got != want {
			t.Errorf("ImageType(%q) = %q, want %q", in, got, want)
		}
	}
}

func TestTheOfferedBlueprintsHoldEveryShapedField(t *testing.T) {
	model, err := sdk.ParseCatalog(blueprintsYAML)
	if err != nil {
		t.Fatal(err)
	}
	type def struct {
		Fields    map[string]any `json:"fields"`
		Relations map[string]any `json:"relations"`
	}
	defs := map[string]def{}
	for _, b := range model.Blueprints {
		raw, _ := json.Marshal(b)
		var d def
		if err := json.Unmarshal(raw, &d); err != nil {
			t.Fatal(err)
		}
		defs[b["id"].(string)] = d
	}
	for _, id := range []string{"entra_app", "entra_user", "entra_group", "entra_app_role_assignment", "it_approval"} {
		if _, ok := defs[id]; !ok {
			t.Fatalf("blueprints.yaml does not offer %s", id)
		}
	}
	read := Tenant{
		Apps:   []App{{Principal: principal("wiki", nil), Assignments: []Assignment{{ID: "a", PrincipalID: "u", PrincipalType: "User"}, {ID: "b", PrincipalID: "g", PrincipalType: "Group"}}}},
		Groups: []Group{{ID: "g", Members: []string{"u"}}},
		Users:  []User{{ID: "u", AccountEnabled: true}},
	}
	var pkg PackageRequest
	pkg.ID, pkg.State, pkg.Justification, pkg.CreatedDateTime, pkg.Requestor.ObjectID = "p", "pendingApproval", "why", "2026-11-01T10:00:00Z", "u"
	entities := append(Shape(read, tenant), ShapeRequests(Requests{Packages: []PackageRequest{pkg}}, read, tenant)...)
	for _, e := range entities {
		d := defs[e.Blueprint]
		for name := range e.Fields {
			if _, ok := d.Fields[name]; !ok {
				t.Errorf("Shape writes %s.%s, which blueprints.yaml does not define", e.Blueprint, name)
			}
		}
		for name := range e.Relations {
			if _, ok := d.Relations[name]; !ok {
				t.Errorf("Shape writes relation %s.%s, which blueprints.yaml does not define", e.Blueprint, name)
			}
		}
	}
	person, err := sdk.ParseCatalog(personYAML)
	if err != nil || len(person.Blueprints) != 1 || person.Blueprints[0]["id"] != "entra_user" {
		t.Fatalf("person link: %v %v", err, person)
	}
}
