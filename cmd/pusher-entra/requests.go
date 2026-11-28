package main

import (
	"cmp"
	"strings"

	"github.com/orchard-suite/orrery/v3/sdk"
)

// The pages in Entra where its own requests are decided.
const (
	ConsentReviewURL   = "https://entra.microsoft.com/#view/Microsoft_AAD_IAM/StartboardApplicationsMenuBlade/~/AccessRequests"
	PackageApprovalURL = "https://myaccess.microsoft.com/#/approvals"
)

// ConsentRequest is one app people asked an admin to consent to, with the
// requests still waiting.
type ConsentRequest struct {
	ID             string               `json:"id"`
	AppID          string               `json:"appId"`
	AppDisplayName string               `json:"appDisplayName"`
	Waiting        []UserConsentRequest `json:"-"`
}

// UserConsentRequest is one person's request for consent to an app.
type UserConsentRequest struct {
	ID              string `json:"id"`
	Status          string `json:"status"`
	Reason          string `json:"reason"`
	CreatedDateTime string `json:"createdDateTime"`
	CreatedBy       struct {
		User struct {
			ID                string `json:"id"`
			DisplayName       string `json:"displayName"`
			UserPrincipalName string `json:"userPrincipalName"`
		} `json:"user"`
	} `json:"createdBy"`
}

// PackageRequest is one request for an access package waiting for approval.
type PackageRequest struct {
	ID              string `json:"id"`
	State           string `json:"state"`
	Justification   string `json:"justification"`
	CreatedDateTime string `json:"createdDateTime"`
	Requestor       struct {
		ObjectID    string `json:"objectId"`
		DisplayName string `json:"displayName"`
		Email       string `json:"email"`
	} `json:"requestor"`
	AccessPackage struct {
		ID          string `json:"id"`
		DisplayName string `json:"displayName"`
	} `json:"accessPackage"`
}

// Requests is what Entra holds waiting for a decision, as the pusher read it.
type Requests struct {
	Consent  []ConsentRequest
	Packages []PackageRequest
}

// ShapeRequests turns Entra's waiting requests into pending it_approval
// entities, each linked to the app it is about when the pusher keeps that
// app, and to the requester when the pusher keeps that user. A request
// decided in Entra is not in the next read, so it leaves with the snapshot.
func ShapeRequests(r Requests, t Tenant, tenant string) []sdk.Entity {
	apps := map[string]bool{}
	for _, a := range t.Apps {
		apps[a.Principal.AppID] = true
	}
	users := map[string]User{}
	for _, u := range t.Users {
		users[u.ID] = u
	}
	out := []sdk.Entity{}
	for _, c := range r.Consent {
		kind := "new_app"
		if apps[c.AppID] {
			kind = "consent"
		}
		for _, w := range c.Waiting {
			by := w.CreatedBy.User
			fields := pending(kind, w.Reason, w.CreatedDateTime, requester(users, by.ID, by.UserPrincipalName), ConsentReviewURL)
			relations := map[string]any{}
			if apps[c.AppID] {
				relations["app"] = tenant + "/" + c.AppID
			}
			if _, ok := users[by.ID]; ok {
				relations["user"] = tenant + "/" + by.ID
			}
			out = append(out, sdk.Entity{
				Blueprint: "it_approval", Key: tenant + "/consent/" + w.ID,
				Title:  cmp.Or(c.AppDisplayName, c.AppID) + " for " + cmp.Or(by.DisplayName, by.UserPrincipalName, "someone"),
				Fields: fields, Relations: relations,
			})
		}
	}
	for _, p := range r.Packages {
		if !strings.EqualFold(p.State, "pendingApproval") {
			continue
		}
		relations := map[string]any{}
		if _, ok := users[p.Requestor.ObjectID]; ok {
			relations["user"] = tenant + "/" + p.Requestor.ObjectID
		}
		out = append(out, sdk.Entity{
			Blueprint: "it_approval", Key: tenant + "/package/" + p.ID,
			Title:     cmp.Or(p.AccessPackage.DisplayName, p.AccessPackage.ID) + " for " + cmp.Or(p.Requestor.DisplayName, p.Requestor.Email, "someone"),
			Fields:    pending("access_package", p.Justification, p.CreatedDateTime, requester(users, p.Requestor.ObjectID, p.Requestor.Email), PackageApprovalURL),
			Relations: relations,
		})
	}
	return out
}

// pending is a waiting request's fields; what Entra left empty is not written.
func pending(kind, reason, at, by, url string) map[string]any {
	fields := map[string]any{"decision": "pending", "kind": kind, "system": "entra", "url": url}
	for name, v := range map[string]string{"reason": reason, "requested_at": at, "requested_by": by} {
		if v != "" {
			fields[name] = v
		}
	}
	return fields
}

// requester is the address a request names its requester by: the user's
// catalog email when the pusher keeps them, else what Entra gave.
func requester(users map[string]User, id, fallback string) string {
	if u, ok := users[id]; ok {
		return Email(u)
	}
	return strings.ToLower(fallback)
}
