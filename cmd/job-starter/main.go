// Command job-starter starts one container for each run of a `job` action:
// a Kubernetes Job, or an execution of an Azure Container Apps job. It signs
// in to the hub as a runner source, claims the runs that name it the moment
// they are approved, starts each from a template the estate owns, says while
// a job runs that it does, and reports how its container ended. Nothing of
// whoever asked for a run has to be awake.
//
// It holds one right on its platform: start a job, see it, and stop it. The
// job runs as its own identity, which the template gives it; the starter
// holds none of that power, and the hub holds no credential of the platform.
//
// It keeps nothing between passes. What it holds is what the hub says it
// claimed and what the platform shows, each job named or labelled with its
// run, so one that restarts carries on where the last one stopped.
//
//	ORRERY_URL      the hub's ingest host
//	ORRERY_TOKEN    a source token for this starter's source (class runner)
//	CONFIG          the estate's config: the platform and the templates
//	                (default /etc/job-starter/config.yaml)
//	JOB_ORRERY_URL  the hub's address as a job reaches it, when that is not
//	                ORRERY_URL
//	INTERVAL        time between looks at the jobs it started, default 15s
//	JOBS            the most runs it claims in one ask, default 10
//	ARM_URL         Azure Resource Manager, for the azure-container-apps
//	                platform; https://management.azure.com when unset
//	KUBECONFIG      used by the kubernetes platform when not in a cluster
//
// On the azure-container-apps platform it signs in as its own workload
// identity (AZURE_TENANT_ID, AZURE_CLIENT_ID, AZURE_FEDERATED_TOKEN_FILE),
// never with a secret.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"net/http"
	"net/url"
	"os"
	"os/signal"
	"strconv"
	"strings"
	"syscall"
	"time"

	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"

	"github.com/orchard-suite/orrery/cmd/internal/containerapps"
	"github.com/orchard-suite/orrery/cmd/internal/workload"
	"github.com/orchard-suite/orrery/sdk"
)

var version = "dev"

// How the claim paces itself: how long one ask holds open, and how long it
// rests after an ask that failed or came back empty at once.
const (
	claimWait   = 25 * time.Second
	claimRest   = 5 * time.Second
	claimPrompt = 2 * time.Second
	reportWait  = 30 * time.Second
)

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "job-starter", "version", version)
	client, err := sdk.FromEnv(sdk.WithLogger(log))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	path := os.Getenv("CONFIG")
	if path == "" {
		path = "/etc/job-starter/config.yaml"
	}
	cfg, err := LoadConfig(path)
	if err != nil {
		log.Error("config", "file", path, "error", err)
		os.Exit(2)
	}
	interval := 15 * time.Second
	if v := os.Getenv("INTERVAL"); v != "" {
		if d, err := time.ParseDuration(v); err == nil && d > 0 {
			interval = d
		}
	}
	slots := 10
	if v := os.Getenv("JOBS"); v != "" {
		n, err := strconv.Atoi(v)
		if err != nil || n < 1 {
			log.Error("config", "error", "JOBS must be a whole number, 1 or more")
			os.Exit(2)
		}
		slots = n
	}
	hubURL := os.Getenv("JOB_ORRERY_URL")
	if hubURL == "" {
		hubURL = os.Getenv("ORRERY_URL")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	hub := &hubClient{client: client}
	// The hub says which source this token is: the name its jobs are labelled with.
	var id string
	for id == "" {
		if id, err = hub.whoAmI(ctx); err != nil {
			log.Error("the hub did not answer as a runner source; asking again", "error", err)
			select {
			case <-ctx.Done():
				return
			case <-time.After(claimRest):
			}
		}
	}
	platform, err := platformOf(cfg, id, strings.TrimRight(hubURL, "/"))
	if err != nil {
		log.Error("platform", "platform", cfg.Platform, "error", err)
		os.Exit(2)
	}
	log.Info("starting", "starter", id, "platform", cfg.Platform, "templates", cfg.names(), "interval", interval.String())
	s := &Starter{Hub: hub, Platform: platform, Config: cfg, Log: log}

	claims := make(chan struct{})
	go func() {
		defer close(claims)
		claimLoop(ctx, s, slots, log)
	}()
	// A stopping starter leaves only once every job it was handed is started or its run told why not.
	defer func() { <-claims }()
	for {
		if err := client.Call(ctx, http.MethodPost, "/v1/ingest/heartbeat", map[string]string{"version": version}, nil); err != nil && ctx.Err() == nil {
			log.Error("heartbeat failed", "error", err)
		}
		if err := s.Pass(ctx); err != nil && ctx.Err() == nil {
			log.Error("pass given up; nothing was judged", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(interval):
		}
	}
}

// claimLoop holds a claim open to the hub so a job starts as its run is
// approved, and starts each run it is handed. A run handed over is started,
// or told why not, even when the starter is stopping.
func claimLoop(ctx context.Context, s *Starter, max int, log *slog.Logger) {
	for ctx.Err() == nil {
		asked := time.Now()
		jobs, err := s.Hub.Claim(ctx, max)
		if err != nil && ctx.Err() == nil {
			log.Error("claim failed", "error", err)
		}
		for _, j := range jobs {
			taking, cancel := context.WithTimeout(context.WithoutCancel(ctx), 2*time.Minute)
			s.Take(taking, j)
			cancel()
		}
		if err != nil || (len(jobs) == 0 && time.Since(asked) < claimPrompt) {
			select {
			case <-ctx.Done():
				return
			case <-time.After(claimRest):
			}
		}
	}
}

// platformOf is the platform the config names, as this starter.
func platformOf(cfg Config, starter, hubURL string) (Platform, error) {
	switch cfg.Platform {
	case PlatformKubernetes:
		rc, err := rest.InClusterConfig()
		if err != nil {
			rc, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
			if err != nil {
				return nil, fmt.Errorf("no in-cluster config and no kubeconfig: %w", err)
			}
		}
		kube, err := kubernetes.NewForConfig(rc)
		if err != nil {
			return nil, err
		}
		return Kubernetes{Client: kube, Config: cfg, Starter: starter, HubURL: hubURL}, nil
	case PlatformContainerApps:
		id, err := workload.FromEnv()
		if err != nil {
			return nil, err
		}
		root := strings.TrimRight(os.Getenv("ARM_URL"), "/")
		if root == "" {
			root = "https://management.azure.com"
		}
		arm := containerapps.Client{Root: root, HTTP: &http.Client{Timeout: time.Minute}, Tokens: func(ctx context.Context, tenant string) (string, error) {
			return id.Token(ctx, tenant, root+"/.default")
		}}
		return ContainerApps{Client: arm, Config: cfg, Starter: starter, HubURL: hubURL}, nil
	}
	return nil, fmt.Errorf("unknown platform %q", cfg.Platform)
}

// hubClient is the hub, through the SDK, as this starter's source.
type hubClient struct {
	client *sdk.Client
}

// whoAmI is the id of the source the token is for.
func (h *hubClient) whoAmI(ctx context.Context) (string, error) {
	var out struct {
		Starter string `json:"starter"`
	}
	if err := h.client.Call(ctx, http.MethodPost, "/v1/ingest/starter/runs", map[string]any{}, &out); err != nil {
		return "", err
	}
	if out.Starter == "" {
		return "", fmt.Errorf("the hub named no source for this token")
	}
	return out.Starter, nil
}

func (h *hubClient) Claim(ctx context.Context, max int) ([]Job, error) {
	var out struct {
		Jobs []Job `json:"jobs"`
	}
	path := fmt.Sprintf("/v1/ingest/starter/jobs?wait=%d&max=%d", int(claimWait.Seconds()), max)
	if err := h.client.Call(ctx, http.MethodGet, path, nil, &out); err != nil {
		return nil, err
	}
	return out.Jobs, nil
}

func (h *hubClient) Runs(ctx context.Context, seen []string) ([]Run, error) {
	var out struct {
		Runs []Run `json:"runs"`
	}
	if seen == nil {
		seen = []string{}
	}
	if err := h.client.Call(ctx, http.MethodPost, "/v1/ingest/starter/runs", map[string]any{"seen": seen}, &out); err != nil {
		return nil, err
	}
	return out.Runs, nil
}

// Report outlives a stopping starter, so a run is told how its job ended.
func (h *hubClient) Report(ctx context.Context, run string, r sdk.ActionReport) error {
	sending, cancel := context.WithTimeout(context.WithoutCancel(ctx), reportWait)
	defer cancel()
	return h.client.Call(sending, http.MethodPost, "/v1/ingest/runner/jobs/"+url.PathEscape(run)+"/report", r, nil)
}
