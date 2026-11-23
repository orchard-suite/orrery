package main

import (
	"context"
	"errors"
	"net/http"
	"net/http/httptest"
	"testing"

	"github.com/orchard-suite/orrery/cmd/internal/graph"
	"github.com/orchard-suite/orrery/sdk/photos"
)

func TestPhotosOnIsOnUnlessTurnedOff(t *testing.T) {
	for raw, want := range map[string]bool{"": true, "true": true, "1": true, "false": false, "0": false} {
		if got, err := PhotosOn(raw); err != nil || got != want {
			t.Fatalf("%q: %v %v", raw, got, err)
		}
	}
	if _, err := PhotosOn("maybe"); err == nil {
		t.Fatal("want an error")
	}
}

func TestPhotoAddressIsMailElseSignInLowercased(t *testing.T) {
	if got := PhotoAddress(User{Mail: "A.Person@Example.org", UserPrincipalName: "x@example.org"}); got != "a.person@example.org" {
		t.Fatal(got)
	}
	if got := PhotoAddress(User{UserPrincipalName: "B@Example.org"}); got != "b@example.org" {
		t.Fatal(got)
	}
}

func TestGraphPhotoReadsNoneOn404AndDeniedOn403(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		switch r.URL.Path {
		case "/users/has/photo/$value":
			w.Write([]byte("\xff\xd8\xff"))
		case "/users/none/photo/$value":
			w.WriteHeader(404)
		default:
			w.WriteHeader(403)
		}
	}))
	defer srv.Close()
	fetch, ctx := GraphPhoto(graph.New(srv.URL, "tok")), context.Background()
	if data, err := fetch(ctx, "has"); err != nil || len(data) != 3 {
		t.Fatalf("has: %q %v", data, err)
	}
	if data, err := fetch(ctx, "none"); err != nil || data != nil {
		t.Fatalf("none: %q %v", data, err)
	}
	if _, err := fetch(ctx, "denied"); !errors.Is(err, photos.ErrDenied) {
		t.Fatalf("denied: %v", err)
	}
}

func TestPhotoPeopleKeepsEachUsersAddressAndID(t *testing.T) {
	got := PhotoPeople([]User{{ID: "1", Mail: "A@example.org"}, {ID: "2", UserPrincipalName: "b@example.org"}})
	if len(got) != 2 || got[0] != (photos.Person{Address: "a@example.org", ID: "1"}) || got[1] != (photos.Person{Address: "b@example.org", ID: "2"}) {
		t.Fatalf("%+v", got)
	}
}
