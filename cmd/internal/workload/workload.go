// Package workload signs a command in as the Azure workload identity its pod
// was given: the projected service account token, traded for an access token
// in whichever tenant a call needs, never with a secret.
package workload

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/url"
	"os"
	"strings"
	"time"
)

// Identity is the workload identity a pod is given: its home tenant, the
// client it signs in as, and the service account token Entra trusts.
type Identity struct {
	TenantID, ClientID, TokenFile, AuthorityHost string
}

// FromEnv reads the identity from the variables Azure workload identity sets.
func FromEnv() (Identity, error) {
	id := Identity{
		TenantID:      os.Getenv("AZURE_TENANT_ID"),
		ClientID:      os.Getenv("AZURE_CLIENT_ID"),
		TokenFile:     os.Getenv("AZURE_FEDERATED_TOKEN_FILE"),
		AuthorityHost: os.Getenv("AZURE_AUTHORITY_HOST"),
	}
	if id.TenantID == "" || id.ClientID == "" || id.TokenFile == "" {
		return id, errors.New("AZURE_TENANT_ID, AZURE_CLIENT_ID, and AZURE_FEDERATED_TOKEN_FILE must be set")
	}
	if id.AuthorityHost == "" {
		id.AuthorityHost = "https://login.microsoftonline.com/"
	}
	return id, nil
}

// Token trades the service account token for an access token to scope in
// tenant. Another tenant takes it when the client is a multi-tenant app it
// consented to. The kubelet rotates the file, so it is read on every call.
func (id Identity) Token(ctx context.Context, tenant, scope string) (string, error) {
	assertion, err := os.ReadFile(id.TokenFile)
	if err != nil {
		return "", fmt.Errorf("service account token: %w", err)
	}
	form := url.Values{
		"grant_type":            {"client_credentials"},
		"client_id":             {id.ClientID},
		"scope":                 {scope},
		"client_assertion_type": {"urn:ietf:params:oauth:client-assertion-type:jwt-bearer"},
		"client_assertion":      {strings.TrimSpace(string(assertion))},
	}
	endpoint := strings.TrimSuffix(id.AuthorityHost, "/") + "/" + tenant + "/oauth2/v2.0/token"
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, endpoint, strings.NewReader(form.Encode()))
	if err != nil {
		return "", err
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	res, err := (&http.Client{Timeout: 30 * time.Second}).Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	var out struct {
		AccessToken string `json:"access_token"`
		Error       string `json:"error_description"`
	}
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		return "", fmt.Errorf("token: %w", err)
	}
	if out.AccessToken == "" {
		return "", fmt.Errorf("token: %s", out.Error)
	}
	return out.AccessToken, nil
}
