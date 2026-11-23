package main

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"runtime"
	"strings"
	"time"
)

// The commands a person runs: sign in, read the catalog, and run self-service
// actions. Each is one call to the hub's API as that person, the same calls
// the web app and the agent tools make, so the hub decides everything: what
// they see, what they may run, and what a run needs. Nothing here knows an
// action, a blueprint, or a rule.

// cli is what a command reads and writes, so a test can stand in for each.
type cli struct {
	in     io.Reader
	out    io.Writer
	err    io.Writer
	getenv func(string) string
	// secret asks for a key without showing what is typed.
	secret func(prompt string) (string, error)
	// tty opens the terminal itself, past any redirect: the only place a revealed answer is written.
	tty  func() (io.WriteCloser, error)
	keys keyring
	http *http.Client
	// poll is how often a run that is followed is read again.
	poll time.Duration
}

// exit is an error that ends the command with a code of its own.
type exit struct {
	code    int
	message string
}

func (e *exit) Error() string { return e.message }

// hubError is an answer the hub refused, in its own words.
type hubError struct {
	Status  int
	Message string
	// Input names the input a refusal is about, when it is about one.
	Input string
}

func (e *hubError) Error() string {
	text := e.Message
	if e.Input != "" {
		text += " (input: " + e.Input + ")"
	}
	if e.Status == http.StatusUnauthorized {
		text += ": sign in with `orrery login`"
	}
	return text
}

// person is one hub, called as one person.
type person struct {
	hub   string
	token string
	http  *http.Client
}

// call makes one request and decodes the answer into out, when out is given.
func (p *person) call(ctx context.Context, method, path string, query url.Values, body, out any) error {
	var reader io.Reader
	if body != nil {
		data, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(data)
	}
	address := p.hub + path
	if len(query) > 0 {
		address += "?" + query.Encode()
	}
	req, err := http.NewRequestWithContext(ctx, method, address, reader)
	if err != nil {
		return err
	}
	req.Header.Set("authorization", "Bearer "+p.token)
	req.Header.Set("user-agent", "orrery-cli/"+version)
	if body != nil {
		req.Header.Set("content-type", "application/json")
	}
	res, err := p.http.Do(req)
	if err != nil {
		return fmt.Errorf("the hub at %s did not answer: %w", p.hub, err)
	}
	defer res.Body.Close()
	data, err := io.ReadAll(res.Body)
	if err != nil {
		return err
	}
	if res.StatusCode >= 400 {
		var said struct {
			Error string `json:"error"`
			Input string `json:"input"`
		}
		_ = json.Unmarshal(data, &said)
		if said.Error == "" {
			said.Error = fmt.Sprintf("the hub answered %d", res.StatusCode)
		}
		return &hubError{Status: res.StatusCode, Message: said.Error, Input: said.Input}
	}
	if out == nil || len(data) == 0 {
		return nil
	}
	return json.Unmarshal(data, out)
}

// hubOf picks the hub a command speaks to: the one named with --hub, else
// ORRERY_MCP_URL (the name the agent plugin reads), else the first hub signed
// in to, else ORRERY_URL.
func (c *cli) hubOf(named string, lines []hubLine) (string, error) {
	for _, hub := range []string{named, c.getenv("ORRERY_MCP_URL")} {
		if hub != "" {
			return strings.TrimRight(hub, "/"), nil
		}
	}
	if len(lines) > 0 {
		return strings.TrimRight(lines[0].URL, "/"), nil
	}
	if hub := c.getenv("ORRERY_URL"); hub != "" {
		return strings.TrimRight(hub, "/"), nil
	}
	return "", errors.New("no hub: name one with --hub https://orrery-ingest.example.org, set ORRERY_MCP_URL, or sign in with `orrery login --hub <address>`")
}

// signedIn is the hub a command speaks to, with the person's token: what the
// hub's line in the tokens file prints, else ORRERY_TOKEN for a script that
// carries one.
func (c *cli) signedIn(named string) (*person, error) {
	path, err := tokensPath(c.getenv)
	if err != nil {
		return nil, err
	}
	lines, err := readTokens(path)
	if err != nil {
		return nil, err
	}
	hub, err := c.hubOf(named, lines)
	if err != nil {
		return nil, err
	}
	for _, line := range lines {
		if sameHub(line.URL, hub) {
			token, err := tokenFrom(line, c.err)
			if err != nil {
				return nil, err
			}
			return &person{hub: hub, token: token, http: c.http}, nil
		}
	}
	if token := c.getenv("ORRERY_TOKEN"); token != "" {
		return &person{hub: hub, token: token, http: c.http}, nil
	}
	return nil, fmt.Errorf("not signed in to %s: run `orrery login --hub %s`", hub, hub)
}

// whoAmI is what the hub says of the caller.
type whoAmI struct {
	Identity struct {
		Kind  string   `json:"kind"`
		Name  string   `json:"name"`
		Admin bool     `json:"admin"`
		Roles []string `json:"roles"`
	} `json:"identity"`
	Version string `json:"version"`
}

// login keeps a way to get a token for a hub: a personal key in the system's
// keychain, or a command of the person's own that prints a token. Either way
// the hub is asked who the token is before anything is kept.
func (c *cli) login(ctx context.Context, named, command string) error {
	path, err := tokensPath(c.getenv)
	if err != nil {
		return err
	}
	lines, err := readTokens(path)
	if err != nil {
		return err
	}
	hub, err := c.hubOf(named, lines)
	if err != nil {
		return err
	}
	if _, err := accountOf(hub); err != nil {
		return err
	}
	check := func(token string) (whoAmI, error) {
		var who whoAmI
		err := (&person{hub: hub, token: token, http: c.http}).call(ctx, http.MethodGet, "/v1/whoami", nil, nil, &who)
		if err == nil && who.Identity.Kind != "user" {
			err = fmt.Errorf("that token is a %s token, not a person's: make a personal key under your name in the hub, API keys", who.Identity.Kind)
		}
		return who, err
	}
	var who whoAmI
	if command != "" {
		token, err := tokenFrom(hubLine{URL: hub, Command: command}, c.err)
		if err != nil {
			return err
		}
		if who, err = check(token); err != nil {
			return err
		}
	} else {
		key, err := c.secret(fmt.Sprintf("Personal key for %s (make one under your name in the hub, API keys): ", hub))
		if err != nil {
			return err
		}
		key = strings.TrimSpace(key)
		if !plainKey(key) {
			return errors.New("that is not a key: paste the key the hub showed when you made it")
		}
		if who, err = check(key); err != nil {
			return err
		}
		if command, err = c.keys.store(hub, key); err != nil {
			return err
		}
	}
	if err := writeTokenLine(path, hub, command); err != nil {
		return err
	}
	fmt.Fprintf(c.out, "signed in to %s as %s\n", hub, who.Identity.Name)
	return nil
}

// logout forgets a hub: its line, and its key when this command line kept it.
func (c *cli) logout(named string) error {
	path, err := tokensPath(c.getenv)
	if err != nil {
		return err
	}
	lines, err := readTokens(path)
	if err != nil {
		return err
	}
	hub, err := c.hubOf(named, lines)
	if err != nil {
		return err
	}
	for _, line := range lines {
		if !sameHub(line.URL, hub) {
			continue
		}
		if c.keys.owns(hub, line.Command) {
			if err := c.keys.remove(hub); err != nil {
				return err
			}
		}
		if err := writeTokenLine(path, hub, ""); err != nil {
			return err
		}
		fmt.Fprintf(c.out, "signed out of %s\n", hub)
		return nil
	}
	fmt.Fprintf(c.out, "not signed in to %s\n", hub)
	return nil
}

// terminal opens the terminal a person sits at, whatever the command's output is sent to.
func terminal() (io.WriteCloser, error) {
	name := "/dev/tty"
	if runtime.GOOS == "windows" {
		name = "CONOUT$"
	}
	return os.OpenFile(name, os.O_WRONLY, 0)
}
