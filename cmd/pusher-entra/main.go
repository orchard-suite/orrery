// Command pusher-entra pushes one Entra tenant into an Orrery hub: each
// enterprise app people sign in to, its roles, who is assigned to it and in
// which role, the groups assigned to it with their direct members, and those
// users. It reads Microsoft Graph as a workload identity, never with a
// secret, and takes one snapshot per run.
//
// Environment:
//
//	ORRERY_URL                  the hub's ingest host, e.g. https://orrery-ingest.example.org
//	ORRERY_TOKEN                a source token for this tenant's source
//	AZURE_TENANT_ID             the tenant to read
//	AZURE_CLIENT_ID             the identity it signs in as, holding Graph's Application.Read.All,
//	                            User.Read.All, and GroupMember.Read.All
//	AZURE_FEDERATED_TOKEN_FILE  the projected service account token Entra trusts
//	AZURE_AUTHORITY_HOST        optional; defaults to https://login.microsoftonline.com/
//	ENTRA_REQUESTS              optional, comma-separated: consent (admin consent requests, needs
//	                            ConsentRequest.Read.All) and packages (access package requests, needs
//	                            EntitlementManagement.Read.All), pushed as pending it_approval in the
//	                            scope entra/<tenant>/requests; unset reads none
//	ENTRA_PHOTOS                optional; false stops putting each user's photo on the hub, which
//	                            needs ProfilePhoto.Read.All (or User.Read.All); unset is on
//	INTERVAL                    run forever on this interval, e.g. 1h; unset runs once and exits
//	DRY_RUN                     set to read once and print the entities as JSON lines, with no hub
//
// The blueprints it writes travel with it in blueprints.yaml and are offered
// to the hub at start, so the source must be registered for every one of
// them. An app's Entra logo, when it is a PNG or WebP, is uploaded as the
// custom icon entra_<app id without dashes>. Each user's photo is put on
// the hub as their picture, under their mail or else their sign-in name, at
// 64 and 256 pixels square.
package main

import (
	"context"
	_ "embed"
	"encoding/json"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"slices"
	"strings"
	"syscall"
	"time"

	"github.com/orchard-suite/orrery/v2/cmd/internal/graph"
	"github.com/orchard-suite/orrery/v2/cmd/internal/workload"
	"github.com/orchard-suite/orrery/v2/sdk"
	"github.com/orchard-suite/orrery/v2/sdk/photos"
)

var version = "dev"

//go:embed blueprints.yaml
var blueprintsYAML []byte

const principalFields = "id,appId,displayName,accountEnabled,appRoleAssignmentRequired,tags,servicePrincipalType,appOwnerOrganizationId,loginUrl,homepage,preferredSingleSignOnMode,replyUrls,info,appRoles"

//go:embed person.yaml
var personYAML []byte

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "pusher-entra", "version", version)
	dry := os.Getenv("DRY_RUN") != ""
	if dry {
		log = slog.New(slog.NewJSONHandler(os.Stderr, nil)).With("component", "pusher-entra", "version", version)
	}
	id, err := workload.FromEnv()
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()
	logos := &http.Client{Timeout: 20 * time.Second}
	scope := "entra/" + id.TenantID
	requests, err := RequestKinds(os.Getenv("ENTRA_REQUESTS"))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	photosOn, err := PhotosOn(os.Getenv("ENTRA_PHOTOS"))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}

	if dry {
		_, read, err := collect(ctx, id, requests, log)
		if err != nil {
			log.Error("collect failed", "error", err)
			os.Exit(1)
		}
		out := json.NewEncoder(os.Stdout)
		for _, e := range append(Shape(read.Tenant, id.TenantID), ShapeRequests(read.Requests, read.Tenant, id.TenantID)...) {
			if err := out.Encode(e); err != nil {
				log.Error("write", "error", err)
				os.Exit(1)
			}
		}
		log.Info("dry run done", "scope", scope, "apps", len(read.Tenant.Apps), "groups", len(read.Tenant.Groups), "users", len(read.Tenant.Users))
		return
	}

	client, err := sdk.FromEnv(sdk.WithLogger(log))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	model, err := sdk.ParseCatalog(blueprintsYAML)
	if err != nil {
		log.Error("embedded blueprints", "error", err)
		os.Exit(2)
	}
	if _, err := client.OfferBlueprints(ctx, model.Blueprints); err != nil {
		log.Error("offering blueprints failed", "error", err)
		os.Exit(1)
	}
	// The link to the core person is offered on its own: a hub that keeps no
	// person refuses it, and the users are pushed all the same.
	if person, err := sdk.ParseCatalog(personYAML); err != nil {
		log.Error("embedded person link", "error", err)
		os.Exit(2)
	} else if _, err := client.OfferBlueprints(ctx, person.Blueprints); err != nil {
		log.Warn("entra_user not linked to person: the hub refused the relation", "error", err)
	}

	once := func() error {
		start := time.Now()
		var (
			read Read
			g    *graph.Graph
		)
		res, err := client.Snapshot(ctx, scope, func(add func(sdk.Entity) error) error {
			var err error
			if g, read, err = collect(ctx, id, requests, log); err != nil {
				return err
			}
			for i := range read.Tenant.Apps {
				read.Tenant.Apps[i].Icon = uploadLogo(ctx, client, logos, read.Tenant.Apps[i].Principal, log)
			}
			for _, e := range Shape(read.Tenant, id.TenantID) {
				if err := add(e); err != nil {
					return err
				}
			}
			return nil
		}, sdk.RunObservedAt(start))
		if err != nil {
			return err
		}
		log.Info("push done", "scope", scope, "took", time.Since(start).String(), "created", res.Counts.Created, "updated", res.Counts.Updated, "unchanged", res.Counts.Unchanged, "rejected", res.Counts.Rejected, "missing", res.Counts.Missing, "massDrop", res.MassDrop)
		if photosOn {
			pushPhotos(ctx, client, g, read.Tenant.Users, log)
		}
		if len(requests) == 0 {
			return nil
		}
		// Requests are their own snapshot, so one decided in Entra leaves the next push.
		waiting := ShapeRequests(read.Requests, read.Tenant, id.TenantID)
		res, err = client.Snapshot(ctx, scope+"/requests", func(add func(sdk.Entity) error) error {
			for _, e := range waiting {
				if err := add(e); err != nil {
					return err
				}
			}
			return nil
		}, sdk.RunObservedAt(start))
		if err != nil {
			return err
		}
		log.Info("requests pushed", "scope", scope+"/requests", "waiting", len(waiting), "created", res.Counts.Created, "missing", res.Counts.Missing)
		return nil
	}

	interval := os.Getenv("INTERVAL")
	if interval == "" {
		if err := once(); err != nil {
			log.Error("push failed", "error", err)
			os.Exit(1)
		}
		return
	}
	every, err := time.ParseDuration(interval)
	if err != nil {
		log.Error("bad INTERVAL", "value", interval, "error", err)
		os.Exit(2)
	}
	for {
		if err := once(); err != nil {
			log.Error("push failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// Read is one read of a tenant and of the requests it holds.
type Read struct {
	Tenant   Tenant
	Requests Requests
}

// RequestKinds reads ENTRA_REQUESTS: which of Entra's request queues to read.
func RequestKinds(raw string) ([]string, error) {
	var kinds []string
	for _, k := range strings.Split(raw, ",") {
		switch k = strings.TrimSpace(k); k {
		case "":
		case "consent", "packages":
			if !slices.Contains(kinds, k) {
				kinds = append(kinds, k)
			}
		default:
			return nil, fmt.Errorf("ENTRA_REQUESTS: %q is not consent or packages", k)
		}
	}
	return kinds, nil
}

// collect reads the tenant's service principals, keeps the apps people sign
// in to, who is assigned to each, the groups assigned and their direct
// members, those users, and the requests asked for. Any read that fails
// aborts the snapshot, so a partial read never deletes what it did not see.
// It answers the Graph it signed in to with the read, for the photos read
// after the snapshot.
func collect(ctx context.Context, id workload.Identity, requests []string, log *slog.Logger) (*graph.Graph, Read, error) {
	g, err := graph.SignIn(ctx, id)
	if err != nil {
		return nil, Read{}, err
	}
	r, err := read(ctx, g, id.TenantID, requests, log)
	return g, r, err
}

// read is collect once signed in.
func read(ctx context.Context, g *graph.Graph, tenant string, requests []string, log *slog.Logger) (Read, error) {
	var all []Principal
	if err := g.List(ctx, "/servicePrincipals?$select="+principalFields+"&$top=999", &all); err != nil {
		return Read{}, fmt.Errorf("service principals: %w", err)
	}
	var read Read
	for _, p := range all {
		if !Keep(p, tenant) {
			continue
		}
		var assigned []Assignment
		if err := g.List(ctx, "/servicePrincipals/"+url.PathEscape(p.ID)+"/appRoleAssignedTo?$select=id,principalId,principalType,appRoleId&$top=999", &assigned); err != nil {
			return Read{}, fmt.Errorf("assignments of %s: %w", p.AppID, err)
		}
		read.Tenant.Apps = append(read.Tenant.Apps, App{Principal: p, Assignments: assigned})
	}
	groupIDs, userIDs := Wanted(read.Tenant.Apps)
	for _, gid := range groupIDs {
		var grp Group
		if err := g.Get(ctx, "/groups/"+url.PathEscape(gid)+"?$select=id,displayName,mail,groupTypes", &grp); err != nil {
			return Read{}, fmt.Errorf("group %s: %w", gid, err)
		}
		var members []struct {
			Type string `json:"@odata.type"`
			ID   string `json:"id"`
		}
		if err := g.List(ctx, "/groups/"+url.PathEscape(gid)+"/members?$select=id&$top=999", &members); err != nil {
			return Read{}, fmt.Errorf("members of group %s: %w", gid, err)
		}
		for _, m := range members {
			if m.Type == "#microsoft.graph.user" {
				grp.Members = append(grp.Members, m.ID)
				userIDs = append(userIDs, m.ID)
			}
		}
		read.Tenant.Groups = append(read.Tenant.Groups, grp)
	}
	if slices.Contains(requests, "consent") {
		var asked []ConsentRequest
		if err := g.List(ctx, "/identityGovernance/appConsent/appConsentRequests?$select=id,appId,appDisplayName&$top=100", &asked); err != nil {
			return Read{}, fmt.Errorf("consent requests: %w", err)
		}
		for i, c := range asked {
			if err := g.List(ctx, "/identityGovernance/appConsent/appConsentRequests/"+url.PathEscape(c.ID)+"/userConsentRequests?$filter="+url.QueryEscape("status eq 'InProgress'"), &asked[i].Waiting); err != nil {
				return Read{}, fmt.Errorf("consent requests for %s: %w", c.AppID, err)
			}
			for _, w := range asked[i].Waiting {
				userIDs = append(userIDs, w.CreatedBy.User.ID)
			}
		}
		read.Requests.Consent = asked
	}
	if slices.Contains(requests, "packages") {
		if err := g.List(ctx, "/identityGovernance/entitlementManagement/assignmentRequests?$expand=requestor,accessPackage&$filter="+url.QueryEscape("state eq 'pendingApproval'"), &read.Requests.Packages); err != nil {
			return Read{}, fmt.Errorf("access package requests: %w", err)
		}
		for _, p := range read.Requests.Packages {
			userIDs = append(userIDs, p.Requestor.ObjectID)
		}
	}
	if len(userIDs) > 0 {
		var users []User
		if err := g.List(ctx, "/users?$select=id,displayName,mail,userPrincipalName,userType,accountEnabled&$top=999", &users); err != nil {
			return Read{}, fmt.Errorf("users: %w", err)
		}
		read.Tenant.Users = Pick(users, userIDs)
	}
	log.Info("collected", "tenant", tenant, "principals", len(all), "apps", len(read.Tenant.Apps), "groups", len(read.Tenant.Groups), "users", len(read.Tenant.Users), "consent_requests", len(read.Requests.Consent), "package_requests", len(read.Requests.Packages))
	return read, nil
}

// uploadLogo puts an app's Entra logo on the hub as its custom icon and
// names it, or names none when the app has no logo the hub keeps. A logo
// that fails is a warning: the app is still pushed, with its blueprint's
// icon.
func uploadLogo(ctx context.Context, hub *sdk.Client, client *http.Client, p Principal, log *slog.Logger) string {
	if p.Info.LogoURL == "" {
		return ""
	}
	data, kind, err := Logo(ctx, client, p.Info.LogoURL)
	if err != nil {
		log.Warn("logo skipped: fetch failed", "app", p.AppID, "error", err)
		return ""
	}
	if kind == "" {
		log.Info("logo skipped: not PNG or WebP", "app", p.AppID)
		return ""
	}
	name := IconName(p.AppID)
	if err := hub.PutIcon(ctx, name, kind, data); err != nil {
		log.Warn("logo skipped: upload failed", "app", p.AppID, "icon", name, "error", err)
		return ""
	}
	return name
}

// pushPhotos puts the users' photos on the hub after their snapshot. A photo
// that fails is a warning: the users are pushed all the same.
func pushPhotos(ctx context.Context, hub *sdk.Client, g *graph.Graph, users []User, log *slog.Logger) {
	start := time.Now()
	t := photos.Sync(ctx, hub, GraphPhoto(g), PhotoPeople(users), log)
	if t.Denied {
		log.Warn("photos skipped: grant the identity "+PhotoPermission, "permission", PhotoPermission)
	}
	log.Info("photos done", "took", time.Since(start).String(), "users", len(users), "fetched", t.Fetched, "put", t.Put, "unchanged", t.Unchanged, "deleted", t.Deleted, "none", t.None, "failed", t.Failed, "denied", t.Denied)
}
