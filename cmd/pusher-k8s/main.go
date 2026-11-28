// Command pusher-k8s pushes one Kubernetes cluster into an Orrery hub: the
// cluster, nodes, namespaces, workloads, pods, services, ingresses, Gateway
// API gateways and HTTP routes, network policies, and volume claims, as one
// snapshot per run. It runs in-cluster with read-only RBAC, or against a
// kubeconfig for a local look.
//
// A run of a job is a fact about the job, not an entity: a pod a Job owns is
// never pushed. A CronJob's workload carries the run record of the Jobs the
// cluster still holds (the last run's status, start, finish, and length, the
// last success and failure, the runs going now, and trends of run times and
// results), and its health is red when the newest finished run failed. A Job
// no CronJob owns is a workload of kind Job with the record of its one run.
// A job's workload runs on the nodes its pods run on now.
//
// Environment:
//
//	ORRERY_URL      the hub's ingest host, e.g. https://orrery-ingest.example.org
//	ORRERY_TOKEN    a source token for this cluster's source
//	CLUSTER_NAME    the key prefix for everything in this cluster (required)
//	INCLUDE_PODS    "false" to skip pods (default true); job runs then read the Jobs alone
//
// ArgoCD Applications are pushed too when the cluster has them and the
// service account may list them. Their sync history is pushed as sw_deployment
// entities in an incremental run of its own, scope "<cluster>/deployments":
// ArgoCD forgets old syncs, and the hub keeps them until they expire. Cilium
// policies join the network policies, and Longhorn replicas name the nodes
// that hold each volume, on the same terms.
//
// The blueprints it writes travel with it in blueprints.yaml and are offered
// to the hub at start, so the source must be registered for all of them.
//
//	INGRESS_RUNNERS comma-separated runner ids for ingress and route health checks (default hub)
//	INTERVAL        run forever on this interval, e.g. 2m; unset runs once and exits
//	KUBECONFIG      used when not in a cluster
package main

import (
	"context"
	_ "embed"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"strings"
	"syscall"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
	"k8s.io/client-go/dynamic"
	"k8s.io/client-go/kubernetes"
	"k8s.io/client-go/rest"
	"k8s.io/client-go/tools/clientcmd"
)

var version = "dev"

//go:embed blueprints.yaml
var blueprintsYAML []byte

func main() {
	log := slog.New(slog.NewJSONHandler(os.Stdout, nil)).With("component", "pusher-k8s", "version", version)
	cluster := os.Getenv("CLUSTER_NAME")
	if cluster == "" {
		log.Error("CLUSTER_NAME is required")
		os.Exit(2)
	}
	client, err := sdk.FromEnv(sdk.WithLogger(log))
	if err != nil {
		log.Error("config", "error", err)
		os.Exit(2)
	}
	cfg, err := rest.InClusterConfig()
	if err != nil {
		cfg, err = clientcmd.NewNonInteractiveDeferredLoadingClientConfig(clientcmd.NewDefaultClientConfigLoadingRules(), &clientcmd.ConfigOverrides{}).ClientConfig()
		if err != nil {
			log.Error("no in-cluster config and no kubeconfig", "error", err)
			os.Exit(2)
		}
	}
	kube, err := kubernetes.NewForConfig(cfg)
	if err != nil {
		log.Error("kubernetes client", "error", err)
		os.Exit(2)
	}
	dyn, err := dynamic.NewForConfig(cfg)
	if err != nil {
		log.Error("dynamic client", "error", err)
		os.Exit(2)
	}
	includePods := os.Getenv("INCLUDE_PODS") != "false"
	if v := os.Getenv("INGRESS_RUNNERS"); v != "" {
		ingressRunners = strings.Split(v, ",")
	}
	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	model, err := sdk.ParseCatalog(blueprintsYAML)
	if err != nil {
		log.Error("embedded blueprints", "error", err)
		os.Exit(2)
	}
	if _, err := client.OfferBlueprints(ctx, model.Blueprints); err != nil {
		log.Error("offering blueprints failed", "error", err)
		os.Exit(1)
	}

	once := func() error {
		start := time.Now()
		var deployments []sdk.Entity
		res, err := client.Snapshot(ctx, cluster, func(add func(sdk.Entity) error) error {
			in, err := collect(ctx, kube, dyn, cfg.Host, cluster, includePods, log)
			if err != nil {
				return err
			}
			deployments = Deployments(in)
			for _, e := range Shape(in, log) {
				if err := add(e); err != nil {
					return err
				}
			}
			return nil
		}, sdk.RunObservedAt(start))
		if err != nil {
			return err
		}
		log.Info("push done", "cluster", cluster, "took", time.Since(start).String(), "created", res.Counts.Created, "updated", res.Counts.Updated, "unchanged", res.Counts.Unchanged, "rejected", res.Counts.Rejected, "missing", res.Counts.Missing, "massDrop", res.MassDrop)
		if len(deployments) == 0 {
			log.Info("no deployments to push", "cluster", cluster)
			return nil
		}
		dep, err := client.Incremental(ctx, cluster+"/deployments", func(add func(sdk.Entity) error) error {
			for _, e := range deployments {
				if err := add(e); err != nil {
					return err
				}
			}
			return nil
		}, sdk.RunObservedAt(start))
		if err != nil {
			return err
		}
		log.Info("deployments pushed", "cluster", cluster, "sent", len(deployments), "created", dep.Counts.Created, "updated", dep.Counts.Updated, "unchanged", dep.Counts.Unchanged, "rejected", dep.Counts.Rejected)
		return nil
	}

	interval := os.Getenv("INTERVAL")
	if interval == "" {
		if err := once(); err != nil {
			log.Error("push failed", "error", err)
			os.Exit(1)
		}
		return
	}
	every, err := time.ParseDuration(interval)
	if err != nil {
		log.Error("bad INTERVAL", "value", interval, "error", err)
		os.Exit(2)
	}
	for {
		if err := once(); err != nil {
			log.Error("push failed", "error", err)
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(every):
		}
	}
}

// collect reads the cluster. Any list that fails aborts the snapshot: a
// partial read must never commit and delete what it did not see.
func collect(ctx context.Context, kube kubernetes.Interface, dyn dynamic.Interface, host, cluster string, includePods bool, log *slog.Logger) (Cluster, error) {
	opts := metav1.ListOptions{}
	ver, err := kube.Discovery().ServerVersion()
	if err != nil {
		return Cluster{}, fmt.Errorf("server version: %w", err)
	}
	nodes, err := kube.CoreV1().Nodes().List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("nodes: %w", err)
	}
	namespaces, err := kube.CoreV1().Namespaces().List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("namespaces: %w", err)
	}
	deployments, err := kube.AppsV1().Deployments("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("deployments: %w", err)
	}
	statefulsets, err := kube.AppsV1().StatefulSets("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("statefulsets: %w", err)
	}
	daemonsets, err := kube.AppsV1().DaemonSets("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("daemonsets: %w", err)
	}
	cronjobs, err := kube.BatchV1().CronJobs("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("cronjobs: %w", err)
	}
	services, err := kube.CoreV1().Services("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("services: %w", err)
	}
	ingresses, err := kube.NetworkingV1().Ingresses("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("ingresses: %w", err)
	}
	policies, err := kube.NetworkingV1().NetworkPolicies("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("networkpolicies: %w", err)
	}
	claims, err := kube.CoreV1().PersistentVolumeClaims("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("persistentvolumeclaims: %w", err)
	}
	in := Cluster{Name: cluster, Host: host, NetworkPolicies: policies.Items, Claims: claims.Items, Version: ver.GitVersion, Nodes: nodes.Items, Namespaces: namespaces.Items, Deployments: deployments.Items, StatefulSets: statefulsets.Items, DaemonSets: daemonsets.Items, CronJobs: cronjobs.Items, Services: services.Items, Ingresses: ingresses.Items}
	if includePods {
		pods, err := kube.CoreV1().Pods("").List(ctx, opts)
		if err != nil {
			return Cluster{}, fmt.Errorf("pods: %w", err)
		}
		replicasets, err := kube.AppsV1().ReplicaSets("").List(ctx, opts)
		if err != nil {
			return Cluster{}, fmt.Errorf("replicasets: %w", err)
		}
		in.Pods = pods.Items
		in.ReplicaSets = replicasets.Items
	}
	jobs, err := kube.BatchV1().Jobs("").List(ctx, opts)
	if err != nil {
		return Cluster{}, fmt.Errorf("jobs: %w", err)
	}
	in.Jobs = jobs.Items
	// ArgoCD is optional: a cluster without the CRD simply has no applications.
	apps, err := dyn.Resource(schema.GroupVersionResource{Group: "argoproj.io", Version: "v1alpha1", Resource: "applications"}).List(ctx, opts)
	if err != nil {
		log.Info("no ArgoCD applications read", "reason", err.Error())
	} else {
		in.ArgoApps = apps.Items
	}
	// The Gateway API is optional the same way.
	for _, r := range []struct {
		res  schema.GroupVersionResource
		into *[]unstructured.Unstructured
	}{{gatewaysResource, &in.Gateways}, {httpRoutesResource, &in.HTTPRoutes}} {
		list, err := dyn.Resource(r.res).List(ctx, opts)
		if err != nil {
			log.Info("no Gateway API objects read", "resource", r.res.Resource, "reason", err.Error())
			continue
		}
		*r.into = list.Items
	}
	// Cilium and Longhorn are optional the same way.
	for _, r := range []string{"ciliumnetworkpolicies", "ciliumclusterwidenetworkpolicies"} {
		list, err := dyn.Resource(schema.GroupVersionResource{Group: "cilium.io", Version: "v2", Resource: r}).List(ctx, opts)
		if err != nil {
			log.Info("no Cilium policies read", "resource", r, "reason", err.Error())
			continue
		}
		in.CiliumPolicies = append(in.CiliumPolicies, list.Items...)
	}
	replicas, err := dyn.Resource(schema.GroupVersionResource{Group: "longhorn.io", Version: "v1beta2", Resource: "replicas"}).List(ctx, opts)
	if err != nil {
		log.Info("no Longhorn replicas read", "reason", err.Error())
	} else {
		in.LonghornReplicas = replicas.Items
	}
	log.Info("collected", "cluster", cluster, "networkPolicies", len(in.NetworkPolicies), "ciliumPolicies", len(in.CiliumPolicies), "claims", len(in.Claims), "longhornReplicas", len(in.LonghornReplicas), "nodes", len(nodes.Items), "namespaces", len(namespaces.Items), "workloads", len(deployments.Items)+len(statefulsets.Items)+len(daemonsets.Items)+len(cronjobs.Items), "jobs", len(in.Jobs), "pods", len(in.Pods), "services", len(services.Items), "ingresses", len(ingresses.Items), "gateways", len(in.Gateways), "httpRoutes", len(in.HTTPRoutes), "argoApps", len(in.ArgoApps))
	return in, nil
}
