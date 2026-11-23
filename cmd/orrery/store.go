package main

import (
	"bufio"
	"bytes"
	"errors"
	"fmt"
	"io"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"runtime"
	"strings"
)

// A person's sign-in is one line of the tokens file: a hub's machine address
// and a command that prints a token for it. The agent plugin's header script
// reads the same file, so one sign-in serves the command line and the agent.

// keyService is the name every key is kept under in the system's keychain.
const keyService = "orrery"

// hubLine is one line of the tokens file.
type hubLine struct {
	URL     string
	Command string
}

// tokensPath is where the tokens file is: ORRERY_TOKENS_FILE, or
// ~/.config/orrery/tokens.
func tokensPath(getenv func(string) string) (string, error) {
	if p := getenv("ORRERY_TOKENS_FILE"); p != "" {
		return p, nil
	}
	home, err := os.UserHomeDir()
	if err != nil {
		return "", err
	}
	return filepath.Join(home, ".config", "orrery", "tokens"), nil
}

// sameHub says whether two addresses name one hub, whatever their trailing slash.
func sameHub(a, b string) bool {
	return strings.TrimRight(a, "/") == strings.TrimRight(b, "/")
}

// readTokens reads the hubs a tokens file names, in its order. A missing file names none.
func readTokens(path string) ([]hubLine, error) {
	data, err := os.ReadFile(path)
	if errors.Is(err, os.ErrNotExist) {
		return nil, nil
	}
	if err != nil {
		return nil, err
	}
	var out []hubLine
	scan := bufio.NewScanner(bytes.NewReader(data))
	for scan.Scan() {
		if line, ok := parseLine(scan.Text()); ok {
			out = append(out, line)
		}
	}
	return out, scan.Err()
}

func parseLine(text string) (hubLine, bool) {
	text = strings.TrimSpace(text)
	if text == "" || strings.HasPrefix(text, "#") {
		return hubLine{}, false
	}
	hub, command, _ := strings.Cut(text, " ")
	command = strings.TrimSpace(command)
	if i := strings.IndexAny(hub, "\t"); i >= 0 {
		hub, command = hub[:i], strings.TrimSpace(hub[i:]+" "+command)
	}
	return hubLine{URL: hub, Command: command}, true
}

// writeTokenLine sets a hub's line, in place when the file has one, and
// leaves every other line and comment as it was. An empty command removes
// the line. The file is the person's alone.
func writeTokenLine(path, hub, command string) error {
	data, err := os.ReadFile(path)
	if err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	var kept []string
	done := false
	if len(data) > 0 {
		for _, text := range strings.Split(strings.TrimRight(string(data), "\n"), "\n") {
			line, ok := parseLine(text)
			if !ok || !sameHub(line.URL, hub) {
				kept = append(kept, text)
				continue
			}
			if command != "" && !done {
				kept = append(kept, hub+"  "+command)
				done = true
			}
		}
	}
	if command != "" && !done {
		kept = append(kept, hub+"  "+command)
	}
	if err := os.MkdirAll(filepath.Dir(path), 0o700); err != nil {
		return err
	}
	body := strings.Join(kept, "\n")
	if body != "" {
		body += "\n"
	}
	if err := os.WriteFile(path, []byte(body), 0o600); err != nil {
		return err
	}
	return os.Chmod(path, 0o600)
}

// tokenFrom runs a line's command and returns the token it prints. What the
// command says on its error stream is passed on, so a vault's own error shows.
func tokenFrom(line hubLine, stderr io.Writer) (string, error) {
	if line.Command == "" {
		return "", fmt.Errorf("the line for %s in the tokens file names no command", line.URL)
	}
	cmd := shell(line.Command)
	cmd.Stderr = stderr
	out, err := cmd.Output()
	if err != nil {
		return "", fmt.Errorf("the token command for %s failed: %w", line.URL, err)
	}
	token := strings.TrimSpace(string(out))
	if token == "" {
		return "", fmt.Errorf("the token command for %s printed nothing", line.URL)
	}
	return token, nil
}

func shell(command string) *exec.Cmd {
	if runtime.GOOS == "windows" {
		return exec.Command("cmd", "/C", command)
	}
	return exec.Command("sh", "-c", command)
}

// keyring keeps a personal key where the system keeps secrets.
type keyring interface {
	// store keeps the key for a hub and returns the command that prints it back.
	store(hub, key string) (command string, err error)
	// remove lets the key for a hub go. A key that was never kept is no error.
	remove(hub string) error
	// owns says whether a tokens-file command is one store wrote for the hub.
	owns(hub, command string) bool
}

// accountOf is the name a hub's key is kept under: its host.
func accountOf(hub string) (string, error) {
	u, err := url.Parse(hub)
	if err != nil || u.Host == "" {
		return "", fmt.Errorf("%q is not a hub address such as https://orrery-ingest.example.org", hub)
	}
	return u.Host, nil
}

// systemKeyring picks the keychain of the system it runs on: the macOS
// keychain, the Secret Service where secret-tool is installed, and otherwise
// a file only the person can read.
func systemKeyring() keyring {
	if runtime.GOOS == "darwin" {
		if _, err := exec.LookPath("security"); err == nil {
			return macKeychain{}
		}
	}
	if runtime.GOOS == "linux" {
		if _, err := exec.LookPath("secret-tool"); err == nil {
			return secretService{}
		}
	}
	dir := ""
	if home, err := os.UserHomeDir(); err == nil {
		dir = filepath.Join(home, ".config", "orrery", "keys")
	}
	return fileKeys{dir: dir}
}

// plainKey says whether a key can be written inside double quotes, and on a line of a file, as it is.
func plainKey(key string) bool {
	return key != "" && !strings.ContainsAny(key, "\"\\'` \t\r\n$")
}

type macKeychain struct{}

func (macKeychain) command(account string) string {
	return fmt.Sprintf("security find-generic-password -s %s -a %s -w", keyService, account)
}

func (k macKeychain) store(hub, key string) (string, error) {
	account, err := accountOf(hub)
	if err != nil {
		return "", err
	}
	// The key goes to security on its input, never on a command line another process could read.
	cmd := exec.Command("security", "-i")
	cmd.Stdin = strings.NewReader(fmt.Sprintf("add-generic-password -U -s %s -a %s -l \"Orrery key for %s\" -w \"%s\"\n", keyService, account, account, key))
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("the keychain did not take the key: %s", firstLine(out, err))
	}
	return k.command(account), nil
}

func (macKeychain) remove(hub string) error {
	account, err := accountOf(hub)
	if err != nil {
		return err
	}
	// Exit 44 is the keychain's "no such item".
	out, err := exec.Command("security", "delete-generic-password", "-s", keyService, "-a", account).CombinedOutput()
	var exit *exec.ExitError
	if err != nil && !(errors.As(err, &exit) && exit.ExitCode() == 44) {
		return fmt.Errorf("the keychain did not let the key go: %s", firstLine(out, err))
	}
	return nil
}

func (k macKeychain) owns(hub, command string) bool {
	account, err := accountOf(hub)
	return err == nil && command == k.command(account)
}

type secretService struct{}

func (secretService) command(account string) string {
	return fmt.Sprintf("secret-tool lookup service %s account %s", keyService, account)
}

func (k secretService) store(hub, key string) (string, error) {
	account, err := accountOf(hub)
	if err != nil {
		return "", err
	}
	cmd := exec.Command("secret-tool", "store", "--label=Orrery key for "+account, "service", keyService, "account", account)
	cmd.Stdin = strings.NewReader(key)
	if out, err := cmd.CombinedOutput(); err != nil {
		return "", fmt.Errorf("the keyring did not take the key: %s", firstLine(out, err))
	}
	return k.command(account), nil
}

func (secretService) remove(hub string) error {
	account, err := accountOf(hub)
	if err != nil {
		return err
	}
	// secret-tool clear answers the same whether or not it held one.
	_ = exec.Command("secret-tool", "clear", "service", keyService, "account", account).Run()
	return nil
}

func (k secretService) owns(hub, command string) bool {
	account, err := accountOf(hub)
	return err == nil && command == k.command(account)
}

// fileKeys keeps each key in a file of its own that only the person reads.
type fileKeys struct{ dir string }

func (k fileKeys) path(hub string) (string, error) {
	account, err := accountOf(hub)
	if err != nil {
		return "", err
	}
	if k.dir == "" {
		return "", errors.New("no home directory to keep a key in")
	}
	return filepath.Join(k.dir, strings.ReplaceAll(account, ":", "_")), nil
}

func (k fileKeys) command(path string) string {
	if runtime.GOOS == "windows" {
		return `type "` + path + `"`
	}
	return "cat '" + path + "'"
}

func (k fileKeys) store(hub, key string) (string, error) {
	path, err := k.path(hub)
	if err != nil {
		return "", err
	}
	if strings.ContainsAny(path, "'\"") {
		return "", fmt.Errorf("the key file's path %q holds a quote", path)
	}
	if err := os.MkdirAll(k.dir, 0o700); err != nil {
		return "", err
	}
	if err := os.WriteFile(path, []byte(key+"\n"), 0o600); err != nil {
		return "", err
	}
	if err := os.Chmod(path, 0o600); err != nil {
		return "", err
	}
	return k.command(path), nil
}

func (k fileKeys) remove(hub string) error {
	path, err := k.path(hub)
	if err != nil {
		return err
	}
	if err := os.Remove(path); err != nil && !errors.Is(err, os.ErrNotExist) {
		return err
	}
	return nil
}

func (k fileKeys) owns(hub, command string) bool {
	path, err := k.path(hub)
	return err == nil && command == k.command(path)
}

func firstLine(out []byte, err error) string {
	if text := strings.TrimSpace(string(out)); text != "" {
		return strings.SplitN(text, "\n", 2)[0]
	}
	return err.Error()
}
