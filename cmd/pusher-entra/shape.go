package main

import (
	"cmp"
	"net/url"
	"slices"
	"strings"

	"github.com/orchard-suite/orrery/v3/sdk"
)

// GalleryTag marks a service principal an admin added as an enterprise app,
// from the gallery or by hand. Microsoft's own first-party principals do not
// carry it.
const GalleryTag = "WindowsAzureActiveDirectoryIntegratedApp"

// Principal is the part of a Graph servicePrincipal the pusher reads.
type Principal struct {
	ID                        string   `json:"id"`
	AppID                     string   `json:"appId"`
	DisplayName               string   `json:"displayName"`
	AccountEnabled            bool     `json:"accountEnabled"`
	AppRoleAssignmentRequired bool     `json:"appRoleAssignmentRequired"`
	Tags                      []string `json:"tags"`
	ServicePrincipalType      string   `json:"servicePrincipalType"`
	AppOwnerOrganizationID    string   `json:"appOwnerOrganizationId"`
	LoginURL                  string   `json:"loginUrl"`
	Homepage                  string   `json:"homepage"`
	PreferredSingleSignOnMode string   `json:"preferredSingleSignOnMode"`
	ReplyURLs                 []string `json:"replyUrls"`
	Info                      struct {
		LogoURL string `json:"logoUrl"`
	} `json:"info"`
	AppRoles []AppRole `json:"appRoles"`
}

// AppRole is one role an app defines.
type AppRole struct {
	ID                 string   `json:"id"`
	Value              string   `json:"value"`
	DisplayName        string   `json:"displayName"`
	AllowedMemberTypes []string `json:"allowedMemberTypes"`
	IsEnabled          bool     `json:"isEnabled"`
}

// DefaultRoleID is the role Entra gives an assignment to an app that
// defines none of its own: default access.
const DefaultRoleID = "00000000-0000-0000-0000-000000000000"

// DefaultRole is how default access is named in the catalog.
const DefaultRole = "default"

// Assignment is one appRoleAssignedTo entry: who was given which role.
type Assignment struct {
	ID            string `json:"id"`
	PrincipalID   string `json:"principalId"`
	PrincipalType string `json:"principalType"`
	AppRoleID     string `json:"appRoleId"`
}

// App is a kept principal with who was given it, and the custom icon its
// logo was uploaded as, when it was.
type App struct {
	Principal   Principal
	Assignments []Assignment
	Icon        string
}

// User is the part of a Graph user the pusher reads.
type User struct {
	ID                string `json:"id"`
	DisplayName       string `json:"displayName"`
	Mail              string `json:"mail"`
	UserPrincipalName string `json:"userPrincipalName"`
	UserType          string `json:"userType"`
	AccountEnabled    bool   `json:"accountEnabled"`
}

// Group is the part of a Graph group the pusher reads, with the ids of its
// direct members that are users.
type Group struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	Mail        string   `json:"mail"`
	GroupTypes  []string `json:"groupTypes"`
	Members     []string `json:"-"`
}

// Tenant is one read of a tenant: its kept apps, the groups assigned to
// them, and the enabled users assigned to them or in those groups.
type Tenant struct {
	Apps   []App
	Groups []Group
	Users  []User
}

// Keep says whether a service principal is an app people sign in to: an
// enabled application, owned by this tenant or added by an admin, with a
// web sign-in. Everything else (managed identities, Microsoft's own
// principals, daemons with no redirect) is left out.
func Keep(p Principal, tenant string) bool {
	if p.ServicePrincipalType != "Application" || !p.AccountEnabled {
		return false
	}
	if !strings.EqualFold(p.AppOwnerOrganizationID, tenant) && !slices.Contains(p.Tags, GalleryTag) {
		return false
	}
	if p.LoginURL != "" || p.PreferredSingleSignOnMode == "saml" || p.PreferredSingleSignOnMode == "password" {
		return true
	}
	return slices.ContainsFunc(p.ReplyURLs, func(u string) bool { return webOrigin(u) != "" })
}

// Shape turns one read of a tenant into entities: an entra_app per kept app,
// an entra_group per group assigned to one, an entra_user per enabled user
// assigned to one or in such a group, and an entra_app_role_assignment per
// assignment to a user or a group.
func Shape(t Tenant, tenant string) []sdk.Entity {
	out := make([]sdk.Entity, 0, len(t.Apps)+len(t.Groups)+len(t.Users))
	users := map[string]bool{}
	for _, u := range t.Users {
		users[u.ID] = true
	}
	groups := map[string]bool{}
	for _, g := range t.Groups {
		groups[g.ID] = true
	}
	for _, a := range t.Apps {
		p := a.Principal
		publisher := "gallery"
		if strings.EqualFold(p.AppOwnerOrganizationID, tenant) {
			publisher = "tenant"
		}
		roles, titles := Roles(p.AppRoles)
		out = append(out, sdk.Entity{
			Blueprint: "entra_app",
			Key:       tenant + "/" + p.AppID,
			Title:     p.DisplayName,
			Icon:      a.Icon,
			Fields: map[string]any{
				"app_id":              p.AppID,
				"object_id":           p.ID,
				"tenant_id":           tenant,
				"assignment_required": p.AppRoleAssignmentRequired,
				"assigned_groups":     principals(a.Assignments, "Group"),
				"assigned_users":      principals(a.Assignments, "User"),
				"roles":               roles,
				"role_titles":         titles,
				"launch_url":          LaunchURL(p, tenant),
				"sign_in":             signIn(p.PreferredSingleSignOnMode),
				"publisher":           publisher,
				"portal":              "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/ManagedAppMenuBlade/~/Overview/objectId/" + p.ID + "/appId/" + p.AppID,
			},
		})
		for _, as := range a.Assignments {
			kind, relation := "", ""
			switch {
			case as.PrincipalType == "User" && users[as.PrincipalID]:
				kind, relation = "user", "user"
			case as.PrincipalType == "Group" && groups[as.PrincipalID]:
				kind, relation = "group", "group"
			default:
				continue
			}
			role := RoleValue(p.AppRoles, as.AppRoleID)
			out = append(out, sdk.Entity{
				Blueprint: "entra_app_role_assignment",
				Key:       tenant + "/" + as.ID,
				Title:     p.DisplayName + ": " + role,
				Fields:    map[string]any{"role": role, "principal_type": kind},
				Relations: map[string]any{"app": tenant + "/" + p.AppID, relation: tenant + "/" + as.PrincipalID},
			})
		}
	}
	for _, g := range t.Groups {
		members := []string{}
		for _, m := range g.Members {
			if users[m] && !slices.Contains(members, tenant+"/"+m) {
				members = append(members, tenant+"/"+m)
			}
		}
		slices.Sort(members)
		kind := "security"
		if slices.Contains(g.GroupTypes, "Unified") {
			kind = "microsoft365"
		}
		out = append(out, sdk.Entity{
			Blueprint: "entra_group",
			Key:       tenant + "/" + g.ID,
			Title:     g.DisplayName,
			Fields:    map[string]any{"object_id": g.ID, "mail": g.Mail, "kind": kind, "dynamic": slices.Contains(g.GroupTypes, "DynamicMembership")},
			Relations: map[string]any{"members": members},
		})
	}
	for _, u := range t.Users {
		kind := "member"
		if strings.EqualFold(u.UserType, "Guest") {
			kind = "guest"
		}
		out = append(out, sdk.Entity{
			Blueprint: "entra_user",
			Key:       tenant + "/" + u.ID,
			Title:     cmp.Or(u.DisplayName, Email(u)),
			Fields:    map[string]any{"object_id": u.ID, "email": Email(u), "upn": u.UserPrincipalName, "user_type": kind, "enabled": u.AccountEnabled},
		})
	}
	return out
}

// Email is how the catalog and a front door name a user: their mail, else
// their sign-in name, in lower case.
func Email(u User) string {
	return strings.ToLower(cmp.Or(u.Mail, u.UserPrincipalName))
}

// Roles lists the enabled roles of an app that users and groups may be given,
// by value, with their titles in the same order. An app that defines none
// gives default access only.
func Roles(defined []AppRole) (values, titles []string) {
	values, titles = []string{}, []string{}
	for _, r := range defined {
		if r.IsEnabled && r.Value != "" && slices.Contains(r.AllowedMemberTypes, "User") {
			values = append(values, r.Value)
			titles = append(titles, cmp.Or(r.DisplayName, r.Value))
		}
	}
	if len(values) == 0 {
		return []string{DefaultRole}, []string{"Default access"}
	}
	return values, titles
}

// RoleValue names an assignment's role by the value its app gives it;
// default access is DefaultRole, and a role the app no longer defines keeps
// its id.
func RoleValue(defined []AppRole, id string) string {
	if id == DefaultRoleID || id == "" {
		return DefaultRole
	}
	for _, r := range defined {
		if r.ID == id {
			return cmp.Or(r.Value, r.DisplayName, id)
		}
	}
	return id
}

// Wanted is who the pusher reads besides the apps: the groups assigned to a
// kept app, and the users assigned to one, by id.
func Wanted(apps []App) (groups, users []string) {
	for _, a := range apps {
		for _, as := range a.Assignments {
			switch as.PrincipalType {
			case "Group":
				if !slices.Contains(groups, as.PrincipalID) {
					groups = append(groups, as.PrincipalID)
				}
			case "User":
				if !slices.Contains(users, as.PrincipalID) {
					users = append(users, as.PrincipalID)
				}
			}
		}
	}
	slices.Sort(groups)
	slices.Sort(users)
	return groups, users
}

// LaunchURL is where a person opens the app: its sign-on URL, else its home
// page, else the site its first web redirect belongs to, else Microsoft's
// launcher, which starts the sign-in the app is set up for.
func LaunchURL(p Principal, tenant string) string {
	if p.LoginURL != "" {
		return p.LoginURL
	}
	if p.Homepage != "" {
		return p.Homepage
	}
	for _, u := range p.ReplyURLs {
		if o := webOrigin(u); o != "" {
			return o
		}
	}
	return "https://launcher.myapps.microsoft.com/api/signin/" + p.AppID + "?tenantId=" + tenant
}

// webOrigin is the https origin of a redirect a browser reaches, or empty
// for a local, custom-scheme, or unparseable one.
func webOrigin(raw string) string {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.Host == "" {
		return ""
	}
	switch host := strings.ToLower(u.Hostname()); host {
	case "localhost", "127.0.0.1", "::1":
		return ""
	}
	return "https://" + u.Host
}

func signIn(mode string) string {
	switch mode {
	case "saml", "password":
		return mode
	}
	return "oidc"
}

// principals lists the ids of one kind of assignee, sorted, each once.
func principals(as []Assignment, kind string) []string {
	ids := []string{}
	for _, a := range as {
		if a.PrincipalType == kind && !slices.Contains(ids, a.PrincipalID) {
			ids = append(ids, a.PrincipalID)
		}
	}
	slices.Sort(ids)
	return ids
}

// Pick keeps the enabled users among all whose ids are wanted, by id.
func Pick(all []User, wanted []string) []User {
	want := map[string]bool{}
	for _, id := range wanted {
		want[id] = true
	}
	out := []User{}
	for _, u := range all {
		if want[u.ID] && u.AccountEnabled {
			out = append(out, u)
		}
	}
	slices.SortFunc(out, func(a, b User) int { return cmp.Compare(a.ID, b.ID) })
	return out
}

// IconName is the custom icon an app's Entra logo is uploaded as.
func IconName(appID string) string {
	return "entra_" + strings.ToLower(strings.ReplaceAll(appID, "-", ""))
}
