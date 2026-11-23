package main

import (
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"regexp"
	"strings"
	"time"
)

// A resource it restarts: a web or function app, one of its slots, or a
// virtual machine. Nothing else is taken.
var (
	siteID = regexp.MustCompile(`(?i)^/subscriptions/([0-9a-f-]{36})/resourceGroups/[^/]+/providers/Microsoft\.Web/sites/[^/]+(/slots/[^/]+)?$`)
	vmID   = regexp.MustCompile(`(?i)^/subscriptions/([0-9a-f-]{36})/resourceGroups/[^/]+/providers/Microsoft\.Compute/virtualMachines/[^/]+$`)
	// The tenant ARM names when it refuses a call without a token.
	tenantIn = regexp.MustCompile(`authorization_uri="https://[^/"]+/([0-9a-f-]{36})"`)
)

// Target is a resource id read as what it is.
type Target struct {
	ID, Subscription, Kind, APIVersion, Name string
}

// name is the last part of a resource id: the app, the slot, or the machine.
func name(id string) string {
	return id[strings.LastIndex(id, "/")+1:]
}

// ParseTarget takes a resource id it may restart, or says why not.
func ParseTarget(id string) (Target, error) {
	id = strings.TrimRight(strings.TrimSpace(id), "/")
	if m := siteID.FindStringSubmatch(id); m != nil {
		return Target{ID: id, Subscription: m[1], Kind: "app", APIVersion: "2023-12-01", Name: name(id)}, nil
	}
	if m := vmID.FindStringSubmatch(id); m != nil {
		return Target{ID: id, Subscription: m[1], Kind: "virtual machine", APIVersion: "2024-07-01", Name: name(id)}, nil
	}
	return Target{}, fmt.Errorf("%q is not a web app, a function app, a slot, or a virtual machine", id)
}

// Tokens gives an ARM token in a tenant.
type Tokens func(ctx context.Context, tenant string) (string, error)

// Restarter restarts resources through ARM at Root, signing in to the
// tenant each resource's subscription belongs to.
type Restarter struct {
	Root   string
	Tokens Tokens
	HTTP   *http.Client
	// How often a virtual machine's restart, an app's workers, or an app's address, is asked after.
	Every time.Duration
	Log   func(msg string, args ...any)
	// Wake asks the app once, so a worker starts: the first request after a restart starts one.
	Wake func(ctx context.Context)
}

// The steps of a restart, as the run's page shows them. A line that carries
// `step` starts it, and the lines after it are its own. An app's restart ends
// in Verify, which is where the effect is looked for: a new worker running
// each instance and, when asked, the app answering. A virtual machine's ends
// when Azure says the restart is done, which is all that is looked at.
const (
	StepSignIn  = "Sign in"
	StepRestart = "Restart"
	StepVerify  = "Verify"
)

// Outcome is what came of a restart in words, and whether it is known to
// have happened, not only to have been issued.
type Outcome struct {
	Said string
	Sure bool
}

// process is what Azure says of one process of an app's instance.
type process struct {
	Properties struct {
		ID        int    `json:"id"`
		Name      string `json:"name"`
		StartTime string `json:"start_time"`
		IsSCMSite *bool  `json:"is_scm_site"`
	} `json:"properties"`
}

// waitForWorkers waits until every instance of an app runs a worker that
// started after the restart was asked: then, and only then, has the app
// restarted. A worker starts on the first request after a restart, so each
// round also wakes the app. An app whose workers this identity may not see is
// said to be issued, not restarted.
func (r Restarter) waitForWorkers(ctx context.Context, t Target, token string, asked time.Time) (Outcome, error) {
	for {
		started, instances, latest, err := r.newWorkers(ctx, t, token, asked)
		if err != nil {
			r.Log("Its workers cannot be seen, so the restart is only known to be issued", "reason", err.Error())
			return Outcome{Said: fmt.Sprintf("issued the restart of %s, but its workers cannot be seen", t.Name)}, nil
		}
		if instances > 0 && started == instances {
			// When the last new worker started, not when this round saw it, is how long the restart took.
			took := latest.Sub(asked).Round(time.Second)
			if instances == 1 {
				return Outcome{Said: fmt.Sprintf("restarted %s: a new worker started %s after the restart was asked", t.Name, took), Sure: true}, nil
			}
			return Outcome{Said: fmt.Sprintf("restarted %s: a new worker runs each of its %d instances, the last started %s after the restart was asked", t.Name, instances, took), Sure: true}, nil
		}
		r.Log(fmt.Sprintf("Waiting for %s: %d of %d instances run a new worker", t.Name, started, instances))
		if r.Wake != nil {
			// A warming app may take long to answer; the workers are read again meanwhile.
			go r.Wake(ctx)
		}
		select {
		case <-ctx.Done():
			return Outcome{}, fmt.Errorf("Azure issued the restart, but no new worker ran %s in time (%d of %d instances)", t.Name, started, instances)
		case <-time.After(r.Every):
		}
	}
}

// newWorkers counts the app's instances, and those whose worker started after asked, with when the
// last of those started. The deployment site's own processes are not the app's.
func (r Restarter) newWorkers(ctx context.Context, t Target, token string, asked time.Time) (started, instances int, latest time.Time, err error) {
	var list struct {
		Value []struct {
			Name string `json:"name"`
		} `json:"value"`
	}
	if err := r.get(ctx, t.ID+"/instances?api-version="+t.APIVersion, token, &list); err != nil {
		return 0, 0, time.Time{}, err
	}
	for _, inst := range list.Value {
		base := t.ID + "/instances/" + inst.Name + "/processes"
		var procs struct {
			Value []process `json:"value"`
		}
		if err := r.get(ctx, base+"?api-version="+t.APIVersion, token, &procs); err != nil {
			return 0, 0, time.Time{}, err
		}
		for _, p := range procs.Value {
			var one process
			if err := r.get(ctx, fmt.Sprintf("%s/%d?api-version=%s", base, p.Properties.ID, t.APIVersion), token, &one); err != nil {
				continue // A process can end between the list and the read.
			}
			at, perr := time.Parse(time.RFC3339Nano, one.Properties.StartTime)
			scm := one.Properties.IsSCMSite != nil && *one.Properties.IsSCMSite
			if perr == nil && !scm && at.After(asked) {
				started++
				if at.After(latest) {
					latest = at
				}
				break
			}
		}
	}
	return started, len(list.Value), latest, nil
}

// get reads one ARM path into out, or says why not.
func (r Restarter) get(ctx context.Context, path, token string, out any) error {
	res, body, err := r.call(ctx, http.MethodGet, r.Root+path, token)
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		return refusal(res.StatusCode, body)
	}
	return json.Unmarshal(body, out)
}

// Probe is where to ask a restarted app whether it is back: its address, and
// whether that is its health check, which only a 2xx passes.
type Probe struct {
	URL    string
	Health bool
}

// ProbeFor joins an app's address and its health check path. No address, no probe.
func ProbeFor(address, healthPath string) (Probe, bool) {
	address = strings.TrimRight(strings.TrimSpace(address), "/")
	if address == "" {
		return Probe{}, false
	}
	if !strings.Contains(address, "://") {
		address = "https://" + address
	}
	healthPath = strings.TrimSpace(healthPath)
	if healthPath == "" {
		return Probe{URL: address}, true
	}
	return Probe{URL: address + "/" + strings.TrimLeft(healthPath, "/"), Health: true}, true
}

// Answered is what asking a restarted app came to. Up: it answered as a
// running app does. Closed: it was refused (401 or 403), which says nothing
// about the app, such as an address the runner may not reach.
type Answered struct {
	Up, Closed bool
	Status     int
}

// WaitForAnswer asks the probe until the app answers or ctx ends. A health
// check passes on a 2xx; a bare address on anything below 500 but a refusal.
// A 5xx, a failing health check, or no answer is asked again.
func (r Restarter) WaitForAnswer(ctx context.Context, p Probe) (Answered, error) {
	last := "it did not answer"
	for {
		req, err := http.NewRequestWithContext(ctx, http.MethodGet, p.URL, nil)
		if err != nil {
			return Answered{}, err
		}
		res, err := r.HTTP.Do(req)
		if err == nil {
			_, _ = io.Copy(io.Discard, io.LimitReader(res.Body, 1<<16))
			res.Body.Close()
			s := res.StatusCode
			switch {
			case s == http.StatusForbidden || s == http.StatusUnauthorized:
				return Answered{Closed: true, Status: s}, nil
			case p.Health && s >= 200 && s < 300, !p.Health && s < 500:
				return Answered{Up: true, Status: s}, nil
			}
			last = fmt.Sprintf("it answered %d", s)
		}
		r.Log("Not back yet: " + last)
		select {
		case <-ctx.Done():
			return Answered{}, fmt.Errorf("it was not back in time: %s", last)
		case <-time.After(r.Every):
		}
	}
}

// TenantOf asks ARM which tenant a subscription belongs to: a call with no
// token is refused with the tenant's sign-in address.
func (r Restarter) TenantOf(ctx context.Context, subscription string) (string, error) {
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, r.Root+"/subscriptions/"+subscription+"?api-version=2022-12-01", nil)
	if err != nil {
		return "", err
	}
	res, err := r.HTTP.Do(req)
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

// Restart restarts the target and, for a virtual machine, waits for ARM to
// say it is done. It returns what happened in words.
func (r Restarter) Restart(ctx context.Context, t Target) (Outcome, error) {
	tenant, err := r.TenantOf(ctx, t.Subscription)
	if err != nil {
		return Outcome{}, err
	}
	r.Log(fmt.Sprintf("Signing in to tenant %s, which holds subscription %s", tenant, t.Subscription), "step", StepSignIn)
	token, err := r.Tokens(ctx, tenant)
	if err != nil {
		return Outcome{}, fmt.Errorf("sign-in to tenant %s: %w", tenant, err)
	}
	// Azure answers an app's restart as soon as it has issued it, whatever it is asked to wait for: an
	// app has restarted only once a new worker process runs it, which is waited for below.
	query := "?api-version=" + t.APIVersion
	if t.Kind == "app" {
		query += "&softRestart=false&synchronous=true"
	}
	asked := time.Now()
	r.Log(fmt.Sprintf("Asking Azure to restart %s", t.Name), "step", StepRestart)
	res, body, err := r.call(ctx, http.MethodPost, r.Root+t.ID+"/restart"+query, token)
	if err != nil {
		return Outcome{}, err
	}
	switch {
	case (res.StatusCode == http.StatusOK || res.StatusCode == http.StatusNoContent) && t.Kind == "app":
		r.Log(fmt.Sprintf("Azure issued the restart of %s; waiting for a new worker to run it", t.Name), "step", StepVerify)
		return r.waitForWorkers(ctx, t, token, asked)
	case res.StatusCode == http.StatusOK || res.StatusCode == http.StatusNoContent:
		return Outcome{Said: fmt.Sprintf("restarted %s", t.Name), Sure: true}, nil
	case res.StatusCode == http.StatusAccepted:
	default:
		return Outcome{}, refusal(res.StatusCode, body)
	}
	op := res.Header.Get("Azure-AsyncOperation")
	if op == "" {
		op = res.Header.Get("Location")
	}
	if op == "" {
		return Outcome{Said: fmt.Sprintf("took the restart of %s, and gave no way to follow it", t.Name)}, nil
	}
	r.Log(fmt.Sprintf("Azure took the restart of %s; waiting for it to finish", t.Name))
	for {
		select {
		case <-ctx.Done():
			return Outcome{}, fmt.Errorf("the %s was still restarting when the run's time ran out", t.Kind)
		case <-time.After(r.Every):
		}
		res, body, err := r.call(ctx, http.MethodGet, op, token)
		if err != nil {
			return Outcome{}, err
		}
		if res.StatusCode == http.StatusForbidden {
			// Reading the operation is not restarting: the restart stands, unseen.
			r.Log("This identity may not follow the restart, so it cannot say when it finished", "status", res.StatusCode)
			return Outcome{Said: fmt.Sprintf("took the restart of %s, which this identity may not follow", t.Name)}, nil
		}
		if res.StatusCode >= 300 {
			return Outcome{}, refusal(res.StatusCode, body)
		}
		var st struct {
			Status string `json:"status"`
			Error  struct {
				Message string `json:"message"`
			} `json:"error"`
		}
		_ = json.Unmarshal(body, &st)
		switch strings.ToLower(st.Status) {
		case "succeeded":
			return Outcome{Said: fmt.Sprintf("restarted %s", t.Name), Sure: true}, nil
		case "failed", "canceled":
			return Outcome{}, fmt.Errorf("the restart %s: %s", strings.ToLower(st.Status), st.Error.Message)
		}
	}
}

func (r Restarter) call(ctx context.Context, method, target, token string) (*http.Response, []byte, error) {
	req, err := http.NewRequestWithContext(ctx, method, target, nil)
	if err != nil {
		return nil, nil, err
	}
	req.Header.Set("Authorization", "Bearer "+token)
	res, err := r.HTTP.Do(req)
	if err != nil {
		return nil, nil, err
	}
	defer res.Body.Close()
	body, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	return res, body, err
}

// refusal is ARM's answer in words: its error message when it gives one.
func refusal(status int, body []byte) error {
	var e struct {
		Error struct {
			Code, Message string
		} `json:"error"`
	}
	if json.Unmarshal(body, &e) == nil && e.Error.Message != "" {
		return fmt.Errorf("Azure refused it (%d %s): %s", status, e.Error.Code, e.Error.Message)
	}
	return fmt.Errorf("Azure refused it (%d)", status)
}
