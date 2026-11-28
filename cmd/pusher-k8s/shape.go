package main

import (
	"fmt"
	"log/slog"
	"sort"
	"strings"
	"time"

	"github.com/orchard-suite/orrery/v3/sdk"
	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
)

// ClusterDomain is the DNS suffix a cluster gives its services.
const ClusterDomain = "cluster.local"

// serviceHosts is every in-cluster DNS name a service answers to,
// lowercase and sorted. The three are distinct by construction.
func serviceHosts(name, namespace string) []string {
	base := strings.ToLower(name + "." + namespace)
	hosts := []string{base, base + ".svc", base + ".svc." + ClusterDomain}
	sort.Strings(hosts)
	return hosts
}

// Cluster is everything read from the API, ready to be shaped.
type Cluster struct {
	Name, Host, Version string
	Nodes               []corev1.Node
	Namespaces          []corev1.Namespace
	Deployments         []appsv1.Deployment
	StatefulSets        []appsv1.StatefulSet
	DaemonSets          []appsv1.DaemonSet
	CronJobs            []batchv1.CronJob
	Services            []corev1.Service
	Ingresses           []networkingv1.Ingress
	// Gateways and HTTPRoutes are read only where the Gateway API's CRDs exist.
	Gateways        []unstructured.Unstructured
	HTTPRoutes      []unstructured.Unstructured
	Pods            []corev1.Pod
	ReplicaSets     []appsv1.ReplicaSet
	Jobs            []batchv1.Job
	ArgoApps        []unstructured.Unstructured
	NetworkPolicies []networkingv1.NetworkPolicy
	// CiliumPolicies holds CiliumNetworkPolicy and CiliumClusterwideNetworkPolicy
	// objects, read only where Cilium's CRDs exist.
	CiliumPolicies []unstructured.Unstructured
	Claims         []corev1.PersistentVolumeClaim
	// LonghornReplicas is read only where Longhorn's CRDs exist.
	LonghornReplicas []unstructured.Unstructured
}

type workload struct {
	key       string
	namespace string
	name      string
	kind      string
	selector  labels.Selector
	// pod template labels, for service matching
	podLabels labels.Set
}

// ingressRunners are the runners every ingress and route health check is
// assigned to.
// INGRESS_RUNNERS overrides it; the hub's own runner is always a valid name.
var ingressRunners = []string{"hub"}

// Shape turns cluster objects into entities. Keys are "<cluster>/<ns>/<name>"
// so several clusters share one estate.
func Shape(c Cluster, log *slog.Logger) []sdk.Entity {
	var out []sdk.Entity
	clusterKey := c.Name
	out = append(out, sdk.Entity{Blueprint: "k8s_cluster", Key: clusterKey, Title: c.Name, Fields: map[string]any{"version": c.Version, "api_url": c.Host}})

	for _, n := range c.Nodes {
		ready, reason := nodeHealth(n)
		roles := []string{}
		for k := range n.Labels {
			if strings.HasPrefix(k, "node-role.kubernetes.io/") {
				roles = append(roles, strings.TrimPrefix(k, "node-role.kubernetes.io/"))
			}
		}
		sort.Strings(roles)
		ip := ""
		for _, a := range n.Status.Addresses {
			if a.Type == corev1.NodeInternalIP {
				ip = a.Address
			}
		}
		health := "green"
		if !ready {
			health = "red"
		}
		out = append(out, sdk.Entity{
			Blueprint: "k8s_node", Key: clusterKey + "/" + n.Name, Title: n.Name,
			Fields: map[string]any{
				"roles": roles, "version": n.Status.NodeInfo.KubeletVersion, "os": n.Status.NodeInfo.OSImage, "arch": n.Status.NodeInfo.Architecture,
				"cpu": n.Status.Capacity.Cpu().AsApproximateFloat64(), "memory_gb": round1(n.Status.Capacity.Memory().AsApproximateFloat64() / (1 << 30)),
				"allocatable_cpu": n.Status.Allocatable.Cpu().AsApproximateFloat64(), "allocatable_memory_gb": round1(n.Status.Allocatable.Memory().AsApproximateFloat64() / (1 << 30)),
				"zone": n.Labels["topology.kubernetes.io/zone"], "system_uuid": strings.ToLower(n.Status.NodeInfo.SystemUUID),
				"internal_ip": ip, "ready": ready, "health": health, "health_reason": reason,
			},
			Relations: map[string]any{"cluster": clusterKey},
		})
	}

	for _, ns := range c.Namespaces {
		out = append(out, sdk.Entity{
			Blueprint: "k8s_namespace", Key: clusterKey + "/" + ns.Name, Title: ns.Name,
			Fields:    map[string]any{"name": ns.Name, "labels": stringMap(ns.Labels), "phase": string(ns.Status.Phase)},
			Relations: map[string]any{"cluster": clusterKey},
		})
	}

	keys := map[string]bool{}
	var workloads []workload
	at := map[string]int{} // a workload's place in out, by key
	add := func(ns, name, kind string, sel labels.Selector, podLabels map[string]string, e sdk.Entity) {
		key := clusterKey + "/" + ns + "/" + name
		if keys[key] {
			key += "." + strings.ToLower(kind)
			log.Warn("workload name shared across kinds; suffixing key", "namespace", ns, "name", name, "kind", kind, "key", key)
		}
		keys[key] = true
		e.Blueprint = "k8s_workload"
		e.Key = key
		e.Title = name
		e.Fields["name"] = name
		e.Fields["kind"] = kind
		e.Relations = map[string]any{"namespace": clusterKey + "/" + ns}
		at[key] = len(out)
		out = append(out, e)
		workloads = append(workloads, workload{key: key, namespace: ns, name: name, kind: kind, selector: sel, podLabels: podLabels})
	}
	for _, d := range c.Deployments {
		desired := int32(1)
		if d.Spec.Replicas != nil {
			desired = *d.Spec.Replicas
		}
		health, reason := replicaHealth(desired, d.Status.ReadyReplicas)
		sel, _ := labelSelector(d.Spec.Selector)
		add(d.Namespace, d.Name, "Deployment", sel, d.Spec.Template.Labels, sdk.Entity{Fields: map[string]any{
			"images": images(d.Spec.Template.Spec), "replicas": desired, "ready": d.Status.ReadyReplicas, "health": health, "health_reason": reason,
			"labels": stringMap(d.Labels), "created_at": d.CreationTimestamp.UTC().Format(time.RFC3339),
		}})
	}
	for _, s := range c.StatefulSets {
		desired := int32(1)
		if s.Spec.Replicas != nil {
			desired = *s.Spec.Replicas
		}
		health, reason := replicaHealth(desired, s.Status.ReadyReplicas)
		sel, _ := labelSelector(s.Spec.Selector)
		add(s.Namespace, s.Name, "StatefulSet", sel, s.Spec.Template.Labels, sdk.Entity{Fields: map[string]any{
			"images": images(s.Spec.Template.Spec), "replicas": desired, "ready": s.Status.ReadyReplicas, "health": health, "health_reason": reason,
			"labels": stringMap(s.Labels), "created_at": s.CreationTimestamp.UTC().Format(time.RFC3339),
		}})
	}
	for _, d := range c.DaemonSets {
		health, reason := replicaHealth(d.Status.DesiredNumberScheduled, d.Status.NumberReady)
		sel, _ := labelSelector(d.Spec.Selector)
		add(d.Namespace, d.Name, "DaemonSet", sel, d.Spec.Template.Labels, sdk.Entity{Fields: map[string]any{
			"images": images(d.Spec.Template.Spec), "replicas": d.Status.DesiredNumberScheduled, "ready": d.Status.NumberReady, "health": health, "health_reason": reason,
			"labels": stringMap(d.Labels), "created_at": d.CreationTimestamp.UTC().Format(time.RFC3339),
		}})
	}
	// Jobs, by "<ns>/<job>": the CronJob that owns each, and the pods of each.
	cronOf := map[string]string{}
	for _, j := range c.Jobs {
		for _, o := range j.OwnerReferences {
			if o.Kind == "CronJob" {
				cronOf[j.Namespace+"/"+j.Name] = o.Name
			}
		}
	}
	podsOf := map[string][]corev1.Pod{}
	for _, p := range c.Pods {
		if job := jobOf(p); job != "" {
			podsOf[p.Namespace+"/"+job] = append(podsOf[p.Namespace+"/"+job], p)
		}
	}
	runsOf := map[string][]run{} // by "<ns>/<cronjob>"
	for _, j := range c.Jobs {
		if cj, ok := cronOf[j.Namespace+"/"+j.Name]; ok {
			runsOf[j.Namespace+"/"+cj] = append(runsOf[j.Namespace+"/"+cj], runOf(j, podsOf[j.Namespace+"/"+j.Name]))
		}
	}
	for _, j := range c.CronJobs {
		suspended := j.Spec.Suspend != nil && *j.Spec.Suspend
		fields := map[string]any{
			"images": images(j.Spec.JobTemplate.Spec.Template.Spec), "schedule": j.Spec.Schedule, "suspended": suspended,
			"labels": stringMap(j.Labels), "created_at": j.CreationTimestamp.UTC().Format(time.RFC3339),
		}
		if j.Status.LastScheduleTime != nil {
			fields["last_schedule_at"] = j.Status.LastScheduleTime.UTC().Format(time.RFC3339)
		}
		var lastSuccess time.Time
		if j.Status.LastSuccessfulTime != nil {
			lastSuccess = j.Status.LastSuccessfulTime.Time
		}
		fields["health"], fields["health_reason"] = runRecord(fields, runsOf[j.Namespace+"/"+j.Name], suspended, lastSuccess)
		add(j.Namespace, j.Name, "CronJob", nil, j.Spec.JobTemplate.Spec.Template.Labels, sdk.Entity{Fields: fields})
	}
	for _, j := range c.Jobs {
		if _, ok := cronOf[j.Namespace+"/"+j.Name]; ok {
			continue
		}
		suspended := j.Spec.Suspend != nil && *j.Spec.Suspend
		fields := map[string]any{
			"images": images(j.Spec.Template.Spec), "suspended": suspended,
			"labels": stringMap(j.Labels), "created_at": j.CreationTimestamp.UTC().Format(time.RFC3339),
		}
		fields["health"], fields["health_reason"] = runRecord(fields, []run{runOf(j, podsOf[j.Namespace+"/"+j.Name])}, suspended, time.Time{})
		add(j.Namespace, j.Name, "Job", nil, j.Spec.Template.Labels, sdk.Entity{Fields: fields})
	}

	// Services route to the workloads whose pod template their selector matches.
	svcByKey := map[string]int{}
	for _, s := range c.Services {
		key := clusterKey + "/" + s.Namespace + "/" + s.Name
		var targets []string
		if len(s.Spec.Selector) > 0 {
			sel := labels.SelectorFromSet(s.Spec.Selector)
			for _, w := range workloads {
				if w.namespace == s.Namespace && w.podLabels != nil && sel.Matches(w.podLabels) {
					targets = append(targets, w.key)
				}
			}
		}
		ports := []string{}
		for _, p := range s.Spec.Ports {
			ports = append(ports, fmt.Sprintf("%s:%d/%s", p.Name, p.Port, p.Protocol))
		}
		external := ""
		for _, i := range s.Status.LoadBalancer.Ingress {
			if i.IP != "" {
				external = i.IP
			} else if i.Hostname != "" {
				external = i.Hostname
			}
		}
		if external == "" && s.Spec.LoadBalancerIP != "" {
			external = s.Spec.LoadBalancerIP
		}
		svcByKey[key] = len(out)
		out = append(out, sdk.Entity{
			Blueprint: "k8s_service", Key: key, Title: s.Name,
			Fields:    map[string]any{"type": string(s.Spec.Type), "cluster_ip": s.Spec.ClusterIP, "external_ip": external, "ports": ports, "selector": stringMap(s.Spec.Selector), "hosts": serviceHosts(s.Name, s.Namespace)},
			Relations: map[string]any{"namespace": clusterKey + "/" + s.Namespace, "workloads": targets},
		})
	}

	for _, ing := range c.Ingresses {
		hosts := []string{}
		targets := map[string]bool{}
		for _, r := range ing.Spec.Rules {
			if r.Host != "" {
				hosts = append(hosts, r.Host)
			}
			if r.HTTP != nil {
				for _, p := range r.HTTP.Paths {
					if p.Backend.Service != nil {
						targets[clusterKey+"/"+ing.Namespace+"/"+p.Backend.Service.Name] = true
					}
				}
			}
		}
		if ing.Spec.DefaultBackend != nil && ing.Spec.DefaultBackend.Service != nil {
			targets[clusterKey+"/"+ing.Namespace+"/"+ing.Spec.DefaultBackend.Service.Name] = true
		}
		class := ""
		if ing.Spec.IngressClassName != nil {
			class = *ing.Spec.IngressClassName
		} else if v, ok := ing.Annotations["kubernetes.io/ingress.class"]; ok {
			class = v
		}
		fields := map[string]any{"class": class, "hosts": hosts, "tls": len(ing.Spec.TLS) > 0}
		if len(hosts) > 0 {
			fields["health"] = map[string]any{"url": "https://" + hosts[0] + "/", "expectStatus": "ok", "runners": ingressRunners, "timeoutMs": 8000}
		}
		out = append(out, sdk.Entity{
			Blueprint: "k8s_ingress", Key: clusterKey + "/" + ing.Namespace + "/" + ing.Name, Title: strings.Join(hosts, ", "), Icon: iconOf(ing.Annotations),
			Fields:    fields,
			Relations: map[string]any{"namespace": clusterKey + "/" + ing.Namespace, "services": sortedKeys(targets)},
		})
	}

	out = append(out, shapeGateways(c, clusterKey)...)

	for _, a := range c.ArgoApps {
		out = append(out, shapeArgoApp(clusterKey, a))
	}

	out = append(out, shapePolicies(c, clusterKey, workloads)...)

	// claimUsers is each claim's mounting workloads, read from the pods.
	claimUsers := map[string]map[string]bool{}
	if c.Pods != nil {
		// ReplicaSet -> Deployment, through owner references.
		rsOwner := map[string]string{}
		for _, rs := range c.ReplicaSets {
			for _, o := range rs.OwnerReferences {
				if o.Kind == "Deployment" {
					rsOwner[rs.Namespace+"/"+rs.Name] = o.Name
				}
			}
		}
		// jobNodes is the nodes each job's workload runs on now.
		jobNodes := map[string]map[string]bool{}
		wlKey := map[string]string{}
		for _, w := range workloads {
			wlKey[w.namespace+"/"+w.kind+"/"+w.name] = w.key
		}
		for _, p := range c.Pods {
			owner := ""
			for _, o := range p.OwnerReferences {
				switch o.Kind {
				case "ReplicaSet":
					if d, ok := rsOwner[p.Namespace+"/"+o.Name]; ok {
						owner = wlKey[p.Namespace+"/Deployment/"+d]
					}
				case "StatefulSet", "DaemonSet":
					owner = wlKey[p.Namespace+"/"+o.Kind+"/"+o.Name]
				case "Job":
					if cj, ok := cronOf[p.Namespace+"/"+o.Name]; ok {
						owner = wlKey[p.Namespace+"/CronJob/"+cj]
					} else {
						owner = wlKey[p.Namespace+"/Job/"+o.Name]
					}
				}
			}
			if owner != "" {
				for _, v := range p.Spec.Volumes {
					if v.PersistentVolumeClaim != nil {
						claim := p.Namespace + "/" + v.PersistentVolumeClaim.ClaimName
						if claimUsers[claim] == nil {
							claimUsers[claim] = map[string]bool{}
						}
						claimUsers[claim][owner] = true
					}
				}
			}
			if jobOf(p) != "" {
				// A job's pod is one of its runs: its claims and its node are
				// the job's, and it is never a k8s_pod.
				if owner != "" && p.Spec.NodeName != "" && (p.Status.Phase == corev1.PodRunning || p.Status.Phase == corev1.PodPending) {
					if jobNodes[owner] == nil {
						jobNodes[owner] = map[string]bool{}
					}
					jobNodes[owner][clusterKey+"/"+p.Spec.NodeName] = true
				}
				continue
			}
			health, reason, ready, restarts := podHealth(p)
			fields := map[string]any{"phase": string(p.Status.Phase), "ready": ready, "restarts": restarts, "images": images(p.Spec), "health": health, "health_reason": reason}
			if p.Status.StartTime != nil {
				fields["started_at"] = p.Status.StartTime.UTC().Format(time.RFC3339)
			}
			rel := map[string]any{"namespace": clusterKey + "/" + p.Namespace}
			if owner != "" {
				rel["workload"] = owner
			}
			if p.Spec.NodeName != "" {
				rel["node"] = clusterKey + "/" + p.Spec.NodeName
			}
			out = append(out, sdk.Entity{Blueprint: "k8s_pod", Key: clusterKey + "/" + p.Namespace + "/" + p.Name, Title: p.Name, Fields: fields, Relations: rel})
		}
		for key, nodes := range jobNodes {
			out[at[key]].Relations["node"] = sortedKeys(nodes)
		}
	}
	return append(out, shapeVolumes(c, clusterKey, claimUsers)...)
}

// jobOf is the Job that owns a pod, or "".
func jobOf(p corev1.Pod) string {
	for _, o := range p.OwnerReferences {
		if o.Kind == "Job" {
			return o.Name
		}
	}
	return ""
}

func nodeHealth(n corev1.Node) (bool, string) {
	for _, c := range n.Status.Conditions {
		if c.Type == corev1.NodeReady {
			if c.Status == corev1.ConditionTrue {
				if n.Spec.Unschedulable {
					return true, "cordoned"
				}
				return true, ""
			}
			return false, "not ready: " + c.Message
		}
	}
	return false, "no Ready condition"
}

func replicaHealth(desired, ready int32) (string, string) {
	switch {
	case desired == 0:
		return "grey", "scaled to zero"
	case ready >= desired:
		return "green", ""
	case ready == 0:
		return "red", fmt.Sprintf("0/%d ready", desired)
	default:
		return "amber", fmt.Sprintf("%d/%d ready", ready, desired)
	}
}

func podHealth(p corev1.Pod) (health, reason string, ready bool, restarts int32) {
	ready = true
	for _, cs := range p.Status.ContainerStatuses {
		restarts += cs.RestartCount
		if !cs.Ready {
			ready = false
		}
		if cs.State.Waiting != nil && (cs.State.Waiting.Reason == "CrashLoopBackOff" || cs.State.Waiting.Reason == "ImagePullBackOff" || cs.State.Waiting.Reason == "ErrImagePull") {
			return "red", cs.Name + ": " + cs.State.Waiting.Reason, false, restarts
		}
	}
	switch p.Status.Phase {
	case corev1.PodRunning:
		if ready {
			return "green", "", true, restarts
		}
		return "amber", "running but not ready", false, restarts
	case corev1.PodSucceeded:
		return "grey", "completed", false, restarts
	case corev1.PodFailed:
		return "red", "failed: " + p.Status.Reason, false, restarts
	case corev1.PodPending:
		return "amber", "pending: " + p.Status.Reason, false, restarts
	default:
		return "grey", string(p.Status.Phase), false, restarts
	}
}

func images(spec corev1.PodSpec) []string {
	seen := map[string]bool{}
	var out []string
	for _, c := range spec.Containers {
		if !seen[c.Image] {
			seen[c.Image] = true
			out = append(out, c.Image)
		}
	}
	if out == nil {
		out = []string{}
	}
	return out
}

func stringMap(m map[string]string) map[string]any {
	out := map[string]any{}
	for k, v := range m {
		out[k] = v
	}
	return out
}

func sortedKeys(m map[string]bool) []string {
	out := make([]string, 0, len(m))
	for k := range m {
		out = append(out, k)
	}
	sort.Strings(out)
	return out
}

func round1(f float64) float64 { return float64(int(f*10+0.5)) / 10 }

// shapeArgoApp turns an ArgoCD Application into an entity. The repo URL is
// normalised (no .git, no trailing slash) so a relation rule can match it to
// a service by URL.
func shapeArgoApp(clusterKey string, a unstructured.Unstructured) sdk.Entity {
	str := func(path ...string) string {
		v, _, _ := unstructured.NestedString(a.Object, path...)
		return v
	}
	repo := str("spec", "source", "repoURL")
	path := str("spec", "source", "path")
	rev := str("spec", "source", "targetRevision")
	if repo == "" {
		// Multi-source applications: take the first source.
		if sources, ok, _ := unstructured.NestedSlice(a.Object, "spec", "sources"); ok && len(sources) > 0 {
			if first, ok := sources[0].(map[string]any); ok {
				repo, _ = first["repoURL"].(string)
				path, _ = first["path"].(string)
				rev, _ = first["targetRevision"].(string)
			}
		}
	}
	repo = strings.TrimSuffix(strings.TrimSuffix(repo, "/"), ".git")
	sync := str("status", "sync", "status")
	healthStatus := str("status", "health", "status")
	health, reason := "green", ""
	switch {
	case healthStatus == "Degraded" || healthStatus == "Missing":
		health, reason = "red", healthStatus
	case sync == "OutOfSync":
		health, reason = "amber", "out of sync"
	case healthStatus == "Progressing" || healthStatus == "Suspended":
		health, reason = "amber", healthStatus
	case healthStatus == "" || healthStatus == "Unknown":
		health, reason = "grey", "unknown"
	}
	fields := map[string]any{
		"project": str("spec", "project"), "path": path, "target_revision": rev, "destination_namespace": str("spec", "destination", "namespace"),
		"sync_status": sync, "health_status": healthStatus, "revision": str("status", "sync", "revision"), "health": health, "health_reason": reason,
	}
	if strings.HasPrefix(repo, "http") {
		fields["repo_url"] = repo
	}
	if t := str("status", "operationState", "finishedAt"); t != "" {
		fields["last_sync_at"] = t
	}
	rel := map[string]any{"cluster": clusterKey}
	if ns := str("spec", "destination", "namespace"); ns != "" {
		rel["namespace"] = clusterKey + "/" + ns
	}
	return sdk.Entity{Blueprint: "argocd_app", Key: argoAppKey(clusterKey, a), Title: a.GetName(), Fields: fields, Relations: rel}
}

func argoAppKey(clusterKey string, a unstructured.Unstructured) string {
	return clusterKey + "/" + a.GetNamespace() + "/" + a.GetName()
}

// Deployments turns every ArgoCD Application's sync history into sw_deployment
// entities: one per sync ArgoCD recorded, and one for a last operation that
// failed. ArgoCD keeps only the latest few history entries, so these are not
// part of the cluster snapshot.
func Deployments(c Cluster) []sdk.Entity {
	var out []sdk.Entity
	for _, a := range c.ArgoApps {
		app := argoAppKey(c.Name, a)
		rel := map[string]any{"app": app}
		history, _, _ := unstructured.NestedSlice(a.Object, "status", "history")
		for _, h := range history {
			entry, ok := h.(map[string]any)
			if !ok {
				continue
			}
			deployedAt, _ := entry["deployedAt"].(string)
			if entry["id"] == nil || deployedAt == "" {
				continue
			}
			id := fmt.Sprint(entry["id"])
			fields := map[string]any{"status": "succeeded", "deployed_at": deployedAt}
			if rev, _ := entry["revision"].(string); rev != "" {
				fields["revision"] = rev
			} else if revs, _ := entry["revisions"].([]any); len(revs) > 0 {
				fields["revision"] = fmt.Sprint(revs[0])
			}
			if startedAt, _ := entry["deployStartedAt"].(string); startedAt != "" {
				fields["started_at"] = startedAt
				if d, ok := secondsBetween(startedAt, deployedAt); ok {
					fields["duration_seconds"] = d
				}
			}
			by, _, _ := unstructured.NestedString(entry, "initiatedBy", "username")
			automated, _, _ := unstructured.NestedBool(entry, "initiatedBy", "automated")
			fields["automated"] = automated
			if by != "" {
				fields["initiated_by"] = by
			}
			out = append(out, sdk.Entity{Blueprint: "sw_deployment", Key: app + "/" + id, Title: a.GetName() + " #" + id, Fields: fields, Relations: rel})
		}
		phase, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "phase")
		finishedAt, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "finishedAt")
		if (phase == "Failed" || phase == "Error") && finishedAt != "" {
			fields := map[string]any{"status": "failed", "deployed_at": finishedAt}
			if msg, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "message"); msg != "" {
				fields["message"] = msg
			}
			if rev, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "operation", "sync", "revision"); rev != "" {
				fields["revision"] = rev
			}
			if startedAt, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "startedAt"); startedAt != "" {
				fields["started_at"] = startedAt
				if d, ok := secondsBetween(startedAt, finishedAt); ok {
					fields["duration_seconds"] = d
				}
			}
			by, _, _ := unstructured.NestedString(a.Object, "status", "operationState", "operation", "initiatedBy", "username")
			automated, _, _ := unstructured.NestedBool(a.Object, "status", "operationState", "operation", "initiatedBy", "automated")
			fields["automated"] = automated
			if by != "" {
				fields["initiated_by"] = by
			}
			out = append(out, sdk.Entity{Blueprint: "sw_deployment", Key: app + "/failed-" + finishedAt, Title: a.GetName() + " failed " + finishedAt, Fields: fields, Relations: rel})
		}
	}
	return out
}

func secondsBetween(from, to string) (float64, bool) {
	a, errA := time.Parse(time.RFC3339, from)
	b, errB := time.Parse(time.RFC3339, to)
	if errA != nil || errB != nil {
		return 0, false
	}
	return b.Sub(a).Seconds(), true
}

// IconAnnotation names, on an ingress, the icon of the hub's set the app it
// serves is drawn with, such as gitlab. The hub keeps an icon a person picks
// over it.
const IconAnnotation = "orrery/icon"

// iconOf is the icon an object's annotations name, or none.
func iconOf(annotations map[string]string) string {
	return strings.TrimSpace(annotations[IconAnnotation])
}
