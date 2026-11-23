package main

import (
	"log/slog"
	"reflect"
	"strings"
	"testing"
	"time"

	"github.com/orchard-suite/orrery/sdk"

	appsv1 "k8s.io/api/apps/v1"
	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestShape(t *testing.T) {
	two := int32(2)
	c := Cluster{
		Name: "home", Host: "https://10.0.0.1:6443", Version: "v1.31.0",
		Nodes:      []corev1.Node{{ObjectMeta: metav1.ObjectMeta{Name: "n1", Labels: map[string]string{"node-role.kubernetes.io/control-plane": ""}}, Status: corev1.NodeStatus{Conditions: []corev1.NodeCondition{{Type: corev1.NodeReady, Status: corev1.ConditionTrue}}}}},
		Namespaces: []corev1.Namespace{{ObjectMeta: metav1.ObjectMeta{Name: "beacon"}}},
		Deployments: []appsv1.Deployment{{
			ObjectMeta: metav1.ObjectMeta{Name: "gateway", Namespace: "beacon", Labels: map[string]string{"app.kubernetes.io/part-of": "beacon"}},
			Spec:       appsv1.DeploymentSpec{Replicas: &two, Selector: &metav1.LabelSelector{MatchLabels: map[string]string{"app": "gateway"}}, Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: map[string]string{"app": "gateway"}}, Spec: corev1.PodSpec{Containers: []corev1.Container{{Image: "acr/gateway:1"}}}}},
			Status:     appsv1.DeploymentStatus{ReadyReplicas: 1},
		}},
		CronJobs:  []batchv1.CronJob{{ObjectMeta: metav1.ObjectMeta{Name: "gateway", Namespace: "beacon"}, Spec: batchv1.CronJobSpec{Schedule: "*/5 * * * *"}}},
		Services:  []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Name: "gateway", Namespace: "beacon"}, Spec: corev1.ServiceSpec{Selector: map[string]string{"app": "gateway"}, Ports: []corev1.ServicePort{{Name: "http", Port: 80, Protocol: "TCP"}}}}},
		Ingresses: []networkingv1.Ingress{{ObjectMeta: metav1.ObjectMeta{Name: "gateway", Namespace: "beacon", Annotations: map[string]string{IconAnnotation: " beacon "}}, Spec: networkingv1.IngressSpec{Rules: []networkingv1.IngressRule{{Host: "beacon.example.org", IngressRuleValue: networkingv1.IngressRuleValue{HTTP: &networkingv1.HTTPIngressRuleValue{Paths: []networkingv1.HTTPIngressPath{{Backend: networkingv1.IngressBackend{Service: &networkingv1.IngressServiceBackend{Name: "gateway"}}}}}}}}}}},
		ArgoApps: []unstructured.Unstructured{{Object: map[string]any{
			"metadata": map[string]any{"name": "beacon", "namespace": "argocd"},
			"spec":     map[string]any{"project": "default", "source": map[string]any{"repoURL": "https://github.com/example/mono.git", "path": "k8s/beacon", "targetRevision": "main"}, "destination": map[string]any{"namespace": "beacon"}},
			"status": map[string]any{
				"sync": map[string]any{"status": "OutOfSync"}, "health": map[string]any{"status": "Healthy"},
				"history": []any{
					map[string]any{"id": int64(7), "revision": "abc123", "deployStartedAt": "2026-09-01T10:00:00Z", "deployedAt": "2026-09-01T10:00:42Z", "initiatedBy": map[string]any{"automated": true}},
					map[string]any{"id": int64(8), "revision": "def456", "deployedAt": "2026-09-02T10:00:00Z", "initiatedBy": map[string]any{"username": "admin"}},
				},
				"operationState": map[string]any{"phase": "Failed", "message": "one or more objects failed to apply", "startedAt": "2026-09-03T09:59:50Z", "finishedAt": "2026-09-03T10:00:00Z", "operation": map[string]any{"sync": map[string]any{"revision": "0ff1ce"}}},
			},
		}}},
		ReplicaSets: []appsv1.ReplicaSet{{ObjectMeta: metav1.ObjectMeta{Name: "gateway-abc", Namespace: "beacon", OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "gateway"}}}}},
		Pods: []corev1.Pod{{
			ObjectMeta: metav1.ObjectMeta{Name: "gateway-abc-1", Namespace: "beacon", OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "gateway-abc"}}},
			Spec:       corev1.PodSpec{NodeName: "n1", Containers: []corev1.Container{{Image: "acr/gateway:1"}}},
			Status:     corev1.PodStatus{Phase: corev1.PodRunning, ContainerStatuses: []corev1.ContainerStatus{{Name: "gateway", Ready: false, State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "CrashLoopBackOff"}}}}},
		}},
	}
	byKey := map[string]map[string]any{}
	rel := map[string]map[string]any{}
	all := append(Shape(c, slog.Default()), Deployments(c)...)
	icons := map[string]string{}
	for _, e := range all {
		byKey[e.ID()] = e.Fields
		rel[e.ID()] = e.Relations
		icons[e.ID()] = e.Icon
	}
	if missing := undefined(t, all); len(missing) > 0 {
		t.Fatalf("blueprints.yaml does not define what the pusher writes: %v", missing)
	}
	if byKey["k8s_cluster:home"]["version"] != "v1.31.0" {
		t.Fatal("cluster missing")
	}
	if byKey["k8s_node:home/n1"]["health"] != "green" {
		t.Fatalf("node health: %v", byKey["k8s_node:home/n1"])
	}
	wl := byKey["k8s_workload:home/beacon/gateway"]
	if wl["kind"] != "Deployment" || wl["health"] != "amber" || wl["health_reason"] != "1/2 ready" {
		t.Fatalf("deployment: %v", wl)
	}
	if byKey["k8s_workload:home/beacon/gateway.cronjob"]["kind"] != "CronJob" {
		t.Fatalf("cronjob with a shared name must get a suffixed key: %v", byKey)
	}
	if got := rel["k8s_service:home/beacon/gateway"]["workloads"].([]string); len(got) != 1 || got[0] != "home/beacon/gateway" {
		t.Fatalf("service should route to the deployment: %v", got)
	}
	if got := rel["k8s_ingress:home/beacon/gateway"]["services"].([]string); len(got) != 1 || got[0] != "home/beacon/gateway" {
		t.Fatalf("ingress should route to the service: %v", got)
	}
	if icons["k8s_ingress:home/beacon/gateway"] != "beacon" || icons["k8s_service:home/beacon/gateway"] != "" {
		t.Fatalf("an ingress takes the icon its orrery/icon annotation names: %v", icons)
	}
	app := byKey["argocd_app:home/argocd/beacon"]
	if app["repo_url"] != "https://github.com/example/mono" || app["health"] != "amber" || rel["argocd_app:home/argocd/beacon"]["namespace"] != "home/beacon" {
		t.Fatalf("argo app: %v", app)
	}
	first := byKey["sw_deployment:home/argocd/beacon/7"]
	if first["status"] != "succeeded" || first["revision"] != "abc123" || first["duration_seconds"] != 42.0 || first["automated"] != true || rel["sw_deployment:home/argocd/beacon/7"]["app"] != "home/argocd/beacon" {
		t.Fatalf("deployment from history: %v", first)
	}
	if byKey["sw_deployment:home/argocd/beacon/8"]["initiated_by"] != "admin" {
		t.Fatalf("deployment started by a person: %v", byKey["sw_deployment:home/argocd/beacon/8"])
	}
	failed := byKey["sw_deployment:home/argocd/beacon/failed-2026-09-03T10:00:00Z"]
	if failed["status"] != "failed" || failed["revision"] != "0ff1ce" || failed["duration_seconds"] != 10.0 {
		t.Fatalf("failed sync: %v", failed)
	}
	pod := byKey["k8s_pod:home/beacon/gateway-abc-1"]
	if pod["health"] != "red" || rel["k8s_pod:home/beacon/gateway-abc-1"]["workload"] != "home/beacon/gateway" || rel["k8s_pod:home/beacon/gateway-abc-1"]["node"] != "home/n1" {
		t.Fatalf("pod: %v %v", pod, rel["k8s_pod:home/beacon/gateway-abc-1"])
	}
}

// undefined lists every field and relation the entities carry that the
// blueprints offered to the hub do not define.
func undefined(t *testing.T, entities []sdk.Entity) []string {
	t.Helper()
	model, err := sdk.ParseCatalog(blueprintsYAML)
	if err != nil {
		t.Fatal(err)
	}
	defined := map[string]bool{}
	for _, b := range model.Blueprints {
		id := b["id"].(string)
		defined[id] = true
		for _, section := range []string{"fields", "relations"} {
			names, _ := b[section].(sdk.Blueprint)
			for name := range names {
				defined[id+"."+name] = true
			}
		}
	}
	var missing []string
	for _, e := range entities {
		if !defined[e.Blueprint] {
			missing = append(missing, e.Blueprint)
			continue
		}
		for name := range e.Fields {
			if !defined[e.Blueprint+"."+name] {
				missing = append(missing, e.Blueprint+"."+name)
			}
		}
		for name := range e.Relations {
			if !defined[e.Blueprint+"."+name] {
				missing = append(missing, e.Blueprint+"."+name)
			}
		}
	}
	return missing
}

func TestShapeJobs(t *testing.T) {
	ts := func(s string) metav1.Time {
		v, err := time.Parse(time.RFC3339, s)
		if err != nil {
			t.Fatal(err)
		}
		return metav1.NewTime(v)
	}
	ptr := func(s string) *metav1.Time { v := ts(s); return &v }
	cron := []metav1.OwnerReference{{Kind: "CronJob", Name: "backup"}}
	job := func(name, start string, owners []metav1.OwnerReference, conds ...batchv1.JobCondition) batchv1.Job {
		return batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ops", OwnerReferences: owners, CreationTimestamp: ts(start)}, Status: batchv1.JobStatus{StartTime: ptr(start), Conditions: conds}}
	}
	done := func(at string) batchv1.JobCondition {
		return batchv1.JobCondition{Type: batchv1.JobComplete, Status: corev1.ConditionTrue, LastTransitionTime: ts(at)}
	}
	failed := func(at, reason string) batchv1.JobCondition {
		return batchv1.JobCondition{Type: batchv1.JobFailed, Status: corev1.ConditionTrue, LastTransitionTime: ts(at), Reason: reason}
	}
	ok1 := job("backup-1", "2026-11-15T10:00:00Z", cron, done("2026-11-15T10:01:30Z"))
	ok1.Status.CompletionTime = ptr("2026-11-15T10:01:30Z")
	bad := job("backup-2", "2026-11-15T11:00:00Z", cron, failed("2026-11-15T11:02:00Z", "BackoffLimitExceeded"))
	going := job("backup-3", "2026-11-15T12:00:00Z", cron)
	solo := job("migrate", "2026-11-15T09:00:00Z", nil, done("2026-11-15T09:00:20Z"))
	solo.Spec.Template.Spec.Containers = []corev1.Container{{Image: "acr/migrate:1"}}
	pod := func(name, job string, phase corev1.PodPhase) corev1.Pod {
		return corev1.Pod{
			ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: "ops", OwnerReferences: []metav1.OwnerReference{{Kind: "Job", Name: job}}},
			Spec:       corev1.PodSpec{NodeName: "n1", Volumes: []corev1.Volume{{VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "dumps"}}}}},
			Status:     corev1.PodStatus{Phase: phase},
		}
	}
	badPod := pod("backup-2-x", "backup-2", corev1.PodFailed)
	badPod.Spec.NodeName = "n2"
	badPod.Status.ContainerStatuses = []corev1.ContainerStatus{{Name: "dump", State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 3, Reason: "Error", Message: "disk full\nmore", FinishedAt: ts("2026-11-15T11:01:59Z")}}}}
	c := Cluster{
		Name:       "home",
		Nodes:      []corev1.Node{{ObjectMeta: metav1.ObjectMeta{Name: "n1"}}, {ObjectMeta: metav1.ObjectMeta{Name: "n2"}}},
		Namespaces: []corev1.Namespace{{ObjectMeta: metav1.ObjectMeta{Name: "ops"}}},
		CronJobs:   []batchv1.CronJob{{ObjectMeta: metav1.ObjectMeta{Name: "backup", Namespace: "ops"}, Spec: batchv1.CronJobSpec{Schedule: "0 * * * *"}}},
		Jobs:       []batchv1.Job{going, bad, ok1, solo},
		Pods:       []corev1.Pod{pod("backup-1-x", "backup-1", corev1.PodSucceeded), badPod, pod("backup-3-x", "backup-3", corev1.PodRunning), pod("migrate-x", "migrate", corev1.PodSucceeded)},
		Claims:     []corev1.PersistentVolumeClaim{{ObjectMeta: metav1.ObjectMeta{Name: "dumps", Namespace: "ops"}}},
	}
	all := Shape(c, slog.Default())
	if missing := undefined(t, all); len(missing) > 0 {
		t.Fatalf("blueprints.yaml does not define what the pusher writes: %v", missing)
	}
	byID := map[string]sdk.Entity{}
	for _, e := range all {
		if e.Blueprint == "k8s_pod" {
			t.Fatalf("a job's pod is never pushed: %s", e.Key)
		}
		byID[e.ID()] = e
	}

	wl := byID["k8s_workload:home/ops/backup"]
	f := wl.Fields
	want := map[string]any{
		"last_run_status": "running", "last_run_started_at": "2026-11-15T12:00:00Z", "running_count": 1,
		"last_success_at": "2026-11-15T10:01:30Z", "last_failure_at": "2026-11-15T11:02:00Z",
		"last_failure_reason": "BackoffLimitExceeded (dump: disk full, exit code 3)",
		"health":              "red", "health_reason": "last run failed 2026-11-15T11:02:00Z: BackoffLimitExceeded (dump: disk full, exit code 3)",
	}
	for k, v := range want {
		if f[k] != v {
			t.Errorf("cronjob %s = %v, want %v", k, f[k], v)
		}
	}
	if _, ok := f["last_run_finished_at"]; ok {
		t.Errorf("a run still going has no finish: %v", f["last_run_finished_at"])
	}
	times := f["run_seconds"].(map[string]any)["points"].([]map[string]any)
	if len(times) != 2 || times[0]["value"] != 90.0 || times[1]["value"] != 120.0 || times[0]["at"] != "2026-11-15T10:01:30Z" {
		t.Errorf("run times, oldest first: %v", times)
	}
	results := f["run_results"].(map[string]any)
	if pts := results["points"].([]map[string]any); results["step"] != true || pts[0]["value"] != 1.0 || pts[1]["value"] != 0.0 {
		t.Errorf("run results: %v", results)
	}
	if nodes := wl.Relations["node"]; !reflect.DeepEqual(nodes, []string{"home/n1"}) {
		t.Errorf("a cronjob runs on the nodes its running pods are on: %v", nodes)
	}
	if users := byID["k8s_volume:home/ops/dumps"].Relations["workloads"]; !reflect.DeepEqual(users, []string{"home/ops/backup", "home/ops/migrate"}) {
		t.Errorf("a job's pods still name its workload on the volumes they mount: %v", users)
	}

	// The newest finished run decides health: once it succeeds, green.
	c.Jobs[0] = job("backup-3", "2026-11-15T12:00:00Z", cron, done("2026-11-15T12:00:45Z"))
	c.Pods[2].Status.Phase = corev1.PodSucceeded
	for _, e := range Shape(c, slog.Default()) {
		if e.ID() == "k8s_workload:home/ops/backup" {
			if e.Fields["health"] != "green" || e.Fields["last_run_status"] != "succeeded" || e.Fields["last_run_seconds"] != 45.0 || e.Fields["running_count"] != 0 || e.Fields["last_failure_at"] != "2026-11-15T11:02:00Z" {
				t.Errorf("after a good run: %v", e.Fields)
			}
			if _, ok := e.Relations["node"]; ok {
				t.Errorf("nothing runs now, so it runs on no node: %v", e.Relations["node"])
			}
		}
	}

	m := byID["k8s_workload:home/ops/migrate"]
	if m.Fields["kind"] != "Job" || m.Fields["health"] != "green" || m.Fields["last_run_status"] != "succeeded" || m.Fields["last_run_seconds"] != 20.0 || !reflect.DeepEqual(m.Fields["images"], []string{"acr/migrate:1"}) {
		t.Errorf("a standalone job is a workload of kind Job: %v", m.Fields)
	}
	for id := range byID {
		if strings.HasPrefix(id, "k8s_workload:home/ops/backup-") {
			t.Errorf("a cronjob's jobs are not workloads: %s", id)
		}
	}
}

func TestServiceHosts(t *testing.T) {
	c := Cluster{Name: "c1", Services: []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Name: "Ingest", Namespace: "Apps"}}}}
	for _, e := range Shape(c, slog.Default()) {
		if e.Blueprint != "k8s_service" {
			continue
		}
		want := []string{"ingest.apps", "ingest.apps.svc", "ingest.apps.svc.cluster.local"}
		if got, _ := e.Fields["hosts"].([]string); !reflect.DeepEqual(got, want) {
			t.Fatalf("a service names every in-cluster DNS name it answers to: got %v, want %v", got, want)
		}
		return
	}
	t.Fatal("no k8s_service shaped")
}
