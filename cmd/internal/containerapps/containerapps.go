// Package containerapps is the one client of Azure Container Apps jobs the
// commands share: read a job, start an execution of it, with or without a
// template of its own, read its executions, and stop one. It signs in to the
// tenant a job's subscription belongs to with whatever gives it a token.
package containerapps

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
)

// APIVersion is the Container Apps API it speaks.
const APIVersion = "2024-03-01"

var (
	// A Container Apps job, and nothing else.
	jobID = regexp.MustCompile(`(?i)^/subscriptions/([0-9a-f-]{36})/resourceGroups/[^/]+/providers/Microsoft\.App/jobs/([^/]+)$`)
	// The tenant ARM names when it refuses a call without a token.
	tenantIn = regexp.MustCompile(`authorization_uri="https://[^/"]+/([0-9a-f-]{36})"`)
)

// Job is a Container Apps job's resource id read as what it is.
type Job struct {
	ID, Subscription, Name string
}

// ParseJob takes the resource id of a Container Apps job, or says why not.
func ParseJob(id string) (Job, error) {
	id = strings.TrimRight(strings.TrimSpace(id), "/")
	m := jobID.FindStringSubmatch(id)
	if m == nil {
		return Job{}, fmt.Errorf("%q is not a Container Apps job", id)
	}
	return Job{ID: id, Subscription: m[1], Name: m[2]}, nil
}

// Tokens gives an ARM token in a tenant.
type Tokens func(ctx context.Context, tenant string) (string, error)

// Client calls ARM at Root.
type Client struct {
	Root   string
	Tokens Tokens
	HTTP   *http.Client
}

// EnvVar is one environment variable of a container: a value, or the name of
// one of the job's own secrets.
type EnvVar struct {
	Name      string `json:"name"`
	Value     string `json:"value,omitempty"`
	SecretRef string `json:"secretRef,omitempty"`
}

// Container is one container of a job's template, or of one execution's.
// Resources is passed through as Azure gave it.
type Container struct {
	Name      string          `json:"name,omitempty"`
	Image     string          `json:"image,omitempty"`
	Command   []string        `json:"command,omitempty"`
	Args      []string        `json:"args,omitempty"`
	Env       []EnvVar        `json:"env,omitempty"`
	Resources json.RawMessage `json:"resources,omitempty"`
}

// Template is the containers one execution runs. An execution started with
// one runs it in place of the job's own.
type Template struct {
	Containers     []Container `json:"containers,omitempty"`
	InitContainers []Container `json:"initContainers,omitempty"`
}

// Execution is what Azure says of one execution of a job.
type Execution struct {
	Name       string `json:"name"`
	Properties struct {
		Status    string   `json:"status"`
		StartTime string   `json:"startTime"`
		EndTime   string   `json:"endTime"`
		Template  Template `json:"template"`
	} `json:"properties"`
}

// TenantOf asks ARM which tenant a subscription belongs to: a call with no
// token is refused with the tenant's sign-in address.
func (c Client) TenantOf(ctx context.Context, subscription string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, c.Root+"/subscriptions/"+subscription+"?api-version=2022-12-01", nil)
	if err != nil {
		return "", err
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return "", err
	}
	defer res.Body.Close()
	m := tenantIn.FindStringSubmatch(res.Header.Get("WWW-Authenticate"))
	if m == nil {
		return "", fmt.Errorf("ARM named no tenant for subscription %s (status %d)", subscription, res.StatusCode)
	}
	return m[1], nil
}

// SignIn gives a token for the tenant that holds the job's subscription.
func (c Client) SignIn(ctx context.Context, j Job) (tenant, token string, err error) {
	if tenant, err = c.TenantOf(ctx, j.Subscription); err != nil {
		return "", "", err
	}
	if token, err = c.Tokens(ctx, tenant); err != nil {
		return tenant, "", fmt.Errorf("sign-in to tenant %s: %w", tenant, err)
	}
	return tenant, token, nil
}

// Definition reads the containers the job's own template runs.
func (c Client) Definition(ctx context.Context, j Job, token string) (Template, error) {
	var def struct {
		Properties struct {
			Template Template `json:"template"`
		} `json:"properties"`
	}
	if err := c.Get(ctx, j.ID+"?api-version="+APIVersion, token, &def); err != nil {
		return Template{}, err
	}
	return def.Properties.Template, nil
}

// Start starts one execution of the job: of its own template when with is
// nil, else of that one. It answers the execution's name when Azure gives it.
func (c Client) Start(ctx context.Context, j Job, token string, with *Template) (string, error) {
	var body []byte
	if with != nil {
		var err error
		if body, err = json.Marshal(with); err != nil {
			return "", err
		}
	}
	res, answer, err := c.Call(ctx, http.MethodPost, c.Root+j.ID+"/start?api-version="+APIVersion, token, body)
	if err != nil {
		return "", err
	}
	if res.StatusCode != http.StatusOK && res.StatusCode != http.StatusAccepted {
		return "", refusal(res.StatusCode, answer)
	}
	var started Execution
	_ = json.Unmarshal(answer, &started)
	return started.Name, nil
}

// Executions lists every execution Azure still shows of the job, page by page.
func (c Client) Executions(ctx context.Context, j Job, token string) ([]Execution, error) {
	var out []Execution
	next := c.Root + j.ID + "/executions?api-version=" + APIVersion
	for next != "" {
		res, body, err := c.Call(ctx, http.MethodGet, next, token, nil)
		if err != nil {
			return nil, err
		}
		if res.StatusCode >= 300 {
			return nil, refusal(res.StatusCode, body)
		}
		var page struct {
			Value    []Execution `json:"value"`
			NextLink string      `json:"nextLink"`
		}
		if err := json.Unmarshal(body, &page); err != nil {
			return nil, err
		}
		out = append(out, page.Value...)
		next = page.NextLink
	}
	return out, nil
}

// Stop stops one execution of the job.
func (c Client) Stop(ctx context.Context, j Job, token, execution string) error {
	res, body, err := c.Call(ctx, http.MethodPost, c.Root+j.ID+"/executions/"+execution+"/stop?api-version="+APIVersion, token, nil)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return refusal(res.StatusCode, body)
	}
	return nil
}

// Get reads one ARM path into out, or says why not.
func (c Client) Get(ctx context.Context, path, token string, out any) error {
	res, body, err := c.Call(ctx, http.MethodGet, c.Root+path, token, nil)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return refusal(res.StatusCode, body)
	}
	return json.Unmarshal(body, out)
}

// Call sends one request to ARM with the token, and a JSON body when given.
func (c Client) Call(ctx context.Context, method, target, token string, body []byte) (*http.Response, []byte, error) {
	var payload io.Reader
	if body != nil {
		payload = bytes.NewReader(body)
	}
	req, err := http.NewRequestWithContext(ctx, method, target, payload)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := c.HTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	answer, err := io.ReadAll(io.LimitReader(res.Body, 4<<20))
	return res, answer, err
}

// Refused is ARM's answer in words: its error message when it gives one.
type Refused struct {
	Status        int
	Code, Message string
}

func (r Refused) Error() string {
	if r.Message != "" {
		return fmt.Sprintf("Azure refused it (%d %s): %s", r.Status, r.Code, r.Message)
	}
	return fmt.Sprintf("Azure refused it (%d)", r.Status)
}

func refusal(status int, body []byte) error {
	var e struct {
		Error struct {
			Code, Message string
		} `json:"error"`
	}
	_ = json.Unmarshal(body, &e)
	return Refused{Status: status, Code: e.Error.Code, Message: e.Error.Message}
}

// Passing says whether a failed call may succeed if asked again: a lost
// connection, Azure busy, or throttled. A refusal for anything else stands.
func Passing(err error) bool {
	var r Refused
	if !errors.As(err, &r) {
		return true
	}
	return r.Status == http.StatusTooManyRequests || r.Status >= 500
}
