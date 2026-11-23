package main

import (
	"context"
	"errors"
	"fmt"
	"net/url"
	"slices"
	"strings"

	"github.com/orchard-suite/orrery/v2/cmd/internal/graph"
)

// DefaultRoleID is the role Entra gives an assignment to an app that defines
// none of its own: default access.
const DefaultRoleID = "00000000-0000-0000-0000-000000000000"

// DefaultRole is how the catalog names default access.
const DefaultRole = "default"

// Outcome says what a grant did.
type Outcome string

const (
	// Granted is a new assignment or membership.
	Granted Outcome = "granted"
	// Already is a person who already held it; nothing was changed.
	Already Outcome = "already"
	// Removed is an assignment or membership taken away.
	Removed Outcome = "removed"
	// Gone is access that was not held; nothing was changed.
	Gone Outcome = "gone"
)

// AppRole is one role an app defines.
type AppRole struct {
	ID                 string   `json:"id"`
	Value              string   `json:"value"`
	AllowedMemberTypes []string `json:"allowedMemberTypes"`
	IsEnabled          bool     `json:"isEnabled"`
}

// RoleID is the id of the role an app gives users and groups by this value:
// default access for "default" on an app that defines no such role.
func RoleID(roles []AppRole, value string) (string, error) {
	var offered []string
	for _, r := range roles {
		if !r.IsEnabled || !slices.Contains(r.AllowedMemberTypes, "User") {
			continue
		}
		if strings.EqualFold(r.Value, value) {
			return r.ID, nil
		}
		offered = append(offered, r.Value)
	}
	if value == DefaultRole && len(offered) == 0 {
		return DefaultRoleID, nil
	}
	if len(offered) == 0 {
		return "", fmt.Errorf("the app has no role %q; it gives default access only", value)
	}
	return "", fmt.Errorf("the app has no role %q for people; its roles are %s", value, strings.Join(offered, ", "))
}

// HeldRoleID is the id of the role a removal takes away by this value: any
// role the app defines by it, enabled or not, since a disabled role may still
// be held, or default access for "default".
func HeldRoleID(roles []AppRole, value string) (string, error) {
	for _, r := range roles {
		if strings.EqualFold(r.Value, value) {
			return r.ID, nil
		}
	}
	if value == DefaultRole {
		return DefaultRoleID, nil
	}
	return "", fmt.Errorf("the app has no role %q", value)
}

// Ref is the id at the end of a catalog key, <tenant>/<id>, or the value as
// given when it is a bare id.
func Ref(key string) string {
	return key[strings.LastIndex(key, "/")+1:]
}

// Granter changes who holds an app or a group, through Graph.
type Granter struct {
	g *graph.Graph
}

type user struct {
	ID             string `json:"id"`
	DisplayName    string `json:"displayName"`
	AccountEnabled bool   `json:"accountEnabled"`
}

// person finds a user who may sign in, and refuses one who may not: a
// grant goes only to someone who can use it.
func (gr Granter) person(ctx context.Context, who string) (user, error) {
	u, err := gr.account(ctx, who)
	if err == nil && !u.AccountEnabled {
		err = fmt.Errorf("user %s is disabled and may not sign in", who)
	}
	return u, err
}

// account finds a user by a catalog key, an object id, or an email (their
// mail or sign-in name), enabled or not: a removal takes access from anyone.
func (gr Granter) account(ctx context.Context, who string) (user, error) {
	var u user
	if strings.Contains(who, "@") {
		quoted := strings.ReplaceAll(who, "'", "''")
		var found []user
		filter := fmt.Sprintf("mail eq '%s' or userPrincipalName eq '%s'", quoted, quoted)
		if err := gr.g.List(ctx, "/users?$select=id,displayName,accountEnabled&$filter="+url.QueryEscape(filter), &found); err != nil {
			return u, fmt.Errorf("user %s: %w", who, err)
		}
		if len(found) != 1 {
			return u, fmt.Errorf("user %s: %d people answer to it, want one", who, len(found))
		}
		return found[0], nil
	}
	if err := gr.g.Get(ctx, "/users/"+url.PathEscape(Ref(who))+"?$select=id,displayName,accountEnabled", &u); err != nil {
		return u, fmt.Errorf("user %s: %w", who, err)
	}
	return u, nil
}

type servicePrincipal struct {
	ID          string    `json:"id"`
	DisplayName string    `json:"displayName"`
	AppRoles    []AppRole `json:"appRoles"`
}

// app finds an enterprise app by its client id or its catalog key.
func (gr Granter) app(ctx context.Context, app string) (servicePrincipal, error) {
	var sp servicePrincipal
	appID := Ref(app)
	if err := gr.g.Get(ctx, "/servicePrincipals(appId='"+url.PathEscape(appID)+"')?$select=id,displayName,appRoles", &sp); err != nil {
		return sp, fmt.Errorf("app %s: %w", appID, err)
	}
	return sp, nil
}

type group struct {
	ID          string   `json:"id"`
	DisplayName string   `json:"displayName"`
	GroupTypes  []string `json:"groupTypes"`
}

// group finds a group by its object id or its catalog key.
func (gr Granter) group(ctx context.Context, key string) (group, error) {
	var g group
	if err := gr.g.Get(ctx, "/groups/"+url.PathEscape(Ref(key))+"?$select=id,displayName,groupTypes", &g); err != nil {
		return g, fmt.Errorf("group %s: %w", key, err)
	}
	return g, nil
}

type assignment struct {
	ID                   string `json:"id"`
	PrincipalID          string `json:"principalId"`
	PrincipalType        string `json:"principalType"`
	PrincipalDisplayName string `json:"principalDisplayName"`
	AppRoleID            string `json:"appRoleId"`
}

// assignments lists who holds an app, and as what.
func (gr Granter) assignments(ctx context.Context, sp servicePrincipal) ([]assignment, error) {
	var held []assignment
	if err := gr.g.List(ctx, "/servicePrincipals/"+url.PathEscape(sp.ID)+"/appRoleAssignedTo?$select=id,principalId,principalType,principalDisplayName,appRoleId&$top=999", &held); err != nil {
		return nil, fmt.Errorf("assignments of %s: %w", sp.DisplayName, err)
	}
	return held, nil
}

// unassign deletes one assignment. One already deleted is Gone.
func (gr Granter) unassign(ctx context.Context, sp servicePrincipal, id string) (Outcome, error) {
	err := gr.g.Delete(ctx, "/servicePrincipals/"+url.PathEscape(sp.ID)+"/appRoleAssignedTo/"+url.PathEscape(id))
	if graph.Status(err) == 404 {
		return Gone, nil
	}
	if err != nil {
		return "", err
	}
	return Removed, nil
}

// Assign gives a user a role on an enterprise app, by the app's client id
// (or its catalog key). A user who already holds that role is Already.
func (gr Granter) Assign(ctx context.Context, app, who, role string) (Outcome, string, error) {
	sp, err := gr.app(ctx, app)
	if err != nil {
		return "", "", err
	}
	roleID, err := RoleID(sp.AppRoles, role)
	if err != nil {
		return "", "", fmt.Errorf("app %s: %w", sp.DisplayName, err)
	}
	u, err := gr.person(ctx, who)
	if err != nil {
		return "", "", err
	}
	held, err := gr.assignments(ctx, sp)
	if err != nil {
		return "", "", err
	}
	what := fmt.Sprintf("%s as %s on %s", u.DisplayName, role, sp.DisplayName)
	if slices.ContainsFunc(held, func(h assignment) bool { return h.PrincipalID == u.ID && h.AppRoleID == roleID }) {
		return Already, what, nil
	}
	body := map[string]string{"principalId": u.ID, "resourceId": sp.ID, "appRoleId": roleID}
	if err := gr.g.Post(ctx, "/servicePrincipals/"+url.PathEscape(sp.ID)+"/appRoleAssignedTo", body, nil); err != nil {
		return "", "", fmt.Errorf("assigning %s: %w", what, err)
	}
	return Granted, what, nil
}

// Holder says who an assignment is taken from: a user or a group.
type Holder struct {
	// Kind is "user" or "group".
	Kind string
	// Key is a catalog key or object id; a user may be named by email too.
	Key string
}

// Unassign takes a role on an enterprise app away from a user or a group.
// One who does not hold it is Gone.
func (gr Granter) Unassign(ctx context.Context, app string, holder Holder, role string) (Outcome, string, error) {
	sp, err := gr.app(ctx, app)
	if err != nil {
		return "", "", err
	}
	roleID, err := HeldRoleID(sp.AppRoles, role)
	if err != nil {
		return "", "", fmt.Errorf("app %s: %w", sp.DisplayName, err)
	}
	var id, name string
	if holder.Kind == "group" {
		g, err := gr.group(ctx, holder.Key)
		if err != nil {
			return "", "", err
		}
		id, name = g.ID, g.DisplayName
	} else {
		u, err := gr.account(ctx, holder.Key)
		if err != nil {
			return "", "", err
		}
		id, name = u.ID, u.DisplayName
	}
	held, err := gr.assignments(ctx, sp)
	if err != nil {
		return "", "", err
	}
	what := fmt.Sprintf("%s as %s on %s", name, role, sp.DisplayName)
	outcome := Gone
	for _, h := range held {
		if h.PrincipalID != id || h.AppRoleID != roleID {
			continue
		}
		done, err := gr.unassign(ctx, sp, h.ID)
		if err != nil {
			return "", "", fmt.Errorf("removing %s: %w", what, err)
		}
		if done == Removed {
			outcome = Removed
		}
	}
	return outcome, what, nil
}

// ErrDynamic is a group whose members a rule sets, so none can be added or
// removed.
var ErrDynamic = errors.New("the group's members come from a rule, so nobody can be added or removed by hand")

// AddToGroup makes a user a direct member of a group, by its object id (or
// its catalog key). A user who already is one is Already.
func (gr Granter) AddToGroup(ctx context.Context, key, who string) (Outcome, string, error) {
	g, err := gr.group(ctx, key)
	if err != nil {
		return "", "", err
	}
	if slices.Contains(g.GroupTypes, "DynamicMembership") {
		return "", "", fmt.Errorf("group %s: %w", g.DisplayName, ErrDynamic)
	}
	u, err := gr.person(ctx, who)
	if err != nil {
		return "", "", err
	}
	what := fmt.Sprintf("%s in %s", u.DisplayName, g.DisplayName)
	body := map[string]string{"@odata.id": graph.Root + "/directoryObjects/" + u.ID}
	if err := gr.g.Post(ctx, "/groups/"+url.PathEscape(g.ID)+"/members/$ref", body, nil); err != nil {
		var e *graph.Error
		// Graph refuses a member who is one already, saying the reference exists.
		if errors.As(err, &e) && e.Status == 400 && strings.Contains(e.Message, "already exist") {
			return Already, what, nil
		}
		return "", "", fmt.Errorf("adding %s: %w", what, err)
	}
	return Granted, what, nil
}

// RemoveFromGroup takes a user out of a group's direct members, by its object
// id (or its catalog key). A user who is not one is Gone.
func (gr Granter) RemoveFromGroup(ctx context.Context, key, who string) (Outcome, string, error) {
	g, err := gr.group(ctx, key)
	if err != nil {
		return "", "", err
	}
	if slices.Contains(g.GroupTypes, "DynamicMembership") {
		return "", "", fmt.Errorf("group %s: %w", g.DisplayName, ErrDynamic)
	}
	u, err := gr.account(ctx, who)
	if err != nil {
		return "", "", err
	}
	what := fmt.Sprintf("%s in %s", u.DisplayName, g.DisplayName)
	err = gr.g.Delete(ctx, "/groups/"+url.PathEscape(g.ID)+"/members/"+url.PathEscape(u.ID)+"/$ref")
	// Graph answers 404 for someone who is not a member.
	if graph.Status(err) == 404 {
		return Gone, what, nil
	}
	if err != nil {
		return "", "", fmt.Errorf("removing %s: %w", what, err)
	}
	return Removed, what, nil
}

// Removal is one assignment a review took away.
type Removal struct {
	// Key is the assignment as it was asked for: its catalog key or id.
	Key     string
	Outcome Outcome
	What    string
}

// Review is what a review did to an application's apps.
type Review struct {
	Removed []Removal
	// Kept counts the user and group assignments left on the apps.
	Kept int
}

// Review takes away each listed assignment (by catalog key or id) from the
// apps an application signs in through, and counts what is left. An
// assignment none of the apps holds is Gone: it was taken away already.
func (gr Granter) Review(ctx context.Context, apps, remove []string) (Review, error) {
	type held struct {
		sp servicePrincipal
		as assignment
	}
	all := map[string]held{}
	sps := make([]servicePrincipal, 0, len(apps))
	for _, app := range apps {
		sp, err := gr.app(ctx, app)
		if err != nil {
			return Review{}, err
		}
		list, err := gr.assignments(ctx, sp)
		if err != nil {
			return Review{}, err
		}
		for _, as := range list {
			all[as.ID] = held{sp: sp, as: as}
		}
		sps = append(sps, sp)
	}
	var r Review
	taken := map[string]bool{}
	for _, key := range remove {
		h, ok := all[Ref(key)]
		if !ok {
			r.Removed = append(r.Removed, Removal{Key: key, Outcome: Gone, What: "not held on " + names(sps)})
			continue
		}
		what := fmt.Sprintf("%s as %s on %s", h.as.PrincipalDisplayName, roleValue(h.sp.AppRoles, h.as.AppRoleID), h.sp.DisplayName)
		outcome, err := gr.unassign(ctx, h.sp, h.as.ID)
		if err != nil {
			return r, fmt.Errorf("removing %s: %w", what, err)
		}
		taken[h.as.ID] = true
		r.Removed = append(r.Removed, Removal{Key: key, Outcome: outcome, What: what})
	}
	for id, h := range all {
		if !taken[id] && (h.as.PrincipalType == "User" || h.as.PrincipalType == "Group") {
			r.Kept++
		}
	}
	return r, nil
}

// roleValue names a role by its value, or default for default access.
func roleValue(roles []AppRole, id string) string {
	for _, r := range roles {
		if r.ID == id {
			return r.Value
		}
	}
	if id == DefaultRoleID {
		return DefaultRole
	}
	return id
}

func names(sps []servicePrincipal) string {
	out := make([]string, len(sps))
	for i, sp := range sps {
		out[i] = sp.DisplayName
	}
	return strings.Join(out, ", ")
}
