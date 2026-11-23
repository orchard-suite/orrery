package workload

import (
	"context"
	"net/http"
	"net/http/httptest"
	"os"
	"path/filepath"
	"testing"
)

func TestTokenSignsInToTheTenantAskedWithTheServiceAccountToken(t *testing.T) {
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		_ = r.ParseForm()
		if r.URL.Path != "/other-tenant/oauth2/v2.0/token" || r.Form.Get("client_assertion") != "sa-token" || r.Form.Get("scope") != "https://management.azure.com/.default" || r.Form.Get("client_id") != "app" {
			_, _ = w.Write([]byte(`{"error_description":"wrong request"}`))
			return
		}
		_, _ = w.Write([]byte(`{"access_token":"arm-token"}`))
	}))
	defer srv.Close()
	file := filepath.Join(t.TempDir(), "token")
	if err := os.WriteFile(file, []byte("sa-token\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	id := Identity{TenantID: "home", ClientID: "app", TokenFile: file, AuthorityHost: srv.URL + "/"}
	got, err := id.Token(context.Background(), "other-tenant", "https://management.azure.com/.default")
	if err != nil || got != "arm-token" {
		t.Fatalf("got %q, %v", got, err)
	}
	if _, err := id.Token(context.Background(), "home", "https://graph.microsoft.com/.default"); err == nil {
		t.Fatal("a refused sign-in was taken")
	}
}
