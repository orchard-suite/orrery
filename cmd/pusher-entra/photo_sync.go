package main

import (
	"context"
	"fmt"
	"net/url"
	"strconv"
	"strings"

	"github.com/orchard-suite/orrery/v2/cmd/internal/graph"
	"github.com/orchard-suite/orrery/v2/sdk/photos"
)

// PhotoPermission is what the pusher's identity needs to read photos.
const PhotoPermission = "ProfilePhoto.Read.All (or User.Read.All)"

// PhotosOn reads ENTRA_PHOTOS: whether users' photos are put on the hub.
// Unset is on.
func PhotosOn(raw string) (bool, error) {
	if strings.TrimSpace(raw) == "" {
		return true, nil
	}
	on, err := strconv.ParseBool(strings.TrimSpace(raw))
	if err != nil {
		return false, fmt.Errorf("ENTRA_PHOTOS: %q is not true or false", raw)
	}
	return on, nil
}

// GraphPhoto reads a user's photo from Graph.
func GraphPhoto(g *graph.Graph) photos.Fetch {
	return func(ctx context.Context, userID string) ([]byte, error) {
		data, err := g.Bytes(ctx, "/users/"+url.PathEscape(userID)+"/photo/$value", photos.MaxBytes)
		switch graph.Status(err) {
		case 404:
			return nil, nil
		case 403:
			return nil, fmt.Errorf("%w: %w", photos.ErrDenied, err)
		}
		return data, err
	}
}

// PhotoAddress is the address a user's photo is kept under: their mail,
// else their sign-in name, lowercased.
func PhotoAddress(u User) string {
	if u.Mail != "" {
		return strings.ToLower(u.Mail)
	}
	return strings.ToLower(u.UserPrincipalName)
}

// PhotoPeople is each user as a photo sync reads them.
func PhotoPeople(users []User) []photos.Person {
	out := make([]photos.Person, 0, len(users))
	for _, u := range users {
		out = append(out, photos.Person{Address: PhotoAddress(u), ID: u.ID})
	}
	return out
}
