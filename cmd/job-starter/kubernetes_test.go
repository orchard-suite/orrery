package main

import (
	"context"
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes/fake"
)

// The estate's manifest: its own service account, resources, and one variable the run overrides.
const manifest = `
apiVersion: batch/v1
kind: Job
metadata:
  name: ignored
  namespace: somewhere-else
  labels: { team: platform }
spec:
  activeDeadlineSeconds: 7200
  template:
    spec:
      serviceAccountName: infra-apply
      containers:
        - name: sidecar
          image: registry.example.com/infra/proxy:1
        - name: main
          image: registry.example.com/infra/runner:0
          command: [/bin/default]
          env:
            - { name: STATE_ACCOUNT, value: statestore }
            - { name: WORKSPACE, value: unset }
          resources: { limits: { memory: 2Gi } }
`

func kube(t *testing.T) (Kubernetes, Template) {
	t.Helper()
	dir := t.TempDir()
	if err := os.WriteFile(filepath.Join(dir, "infra-apply.yaml"), []byte(manifest), 0o600); err != nil {
		t.Fatal(err)
	}
	tpl := Template{Name: "infra-apply", Images: []string{"registry.example.com/infra/"}, Namespace: "infra-jobs", Manifest: "infra-apply.yaml", Container: "main"}
	cfg := Config{Platform: PlatformKubernetes, Dir: dir, Templates: map[string]Template{"infra-apply": tpl}}
	return Kubernetes{Client: fake.NewClientset(), Config: cfg, Starter: "jobs@estate", HubURL: "https://orrery-ingest.example.com"}, tpl
}

func asked() Job {
	return Job{Run: "9F2c41aa07b3", Action: "infra_apply", Try: 2, Template: "infra-apply", Image: "registry.example.com/infra/runner:1.4.0", Command: []string{"infra", "apply"}, Args: []string{"--workspace", "network"}, Env: map[string]string{"WORKSPACE": "network", "ASKED_BY": "a user"}, Token: "orr_run_s3cret", CeilingMs: (time.Hour).Milliseconds()}
}

func TestBuildPutsTheRunOnTheEstatesManifestAndKeepsWhatItSays(t *testing.T) {
	k, tpl := kube(t)
	job, err := k.Build(tpl, asked())
	if err != nil {
		t.Fatal(err)
	}
	if job.Name != "orrery-9f2c41aa07b3-2" || job.Namespace != "infra-jobs" {
		t.Fatalf("named %s/%s", job.Namespace, job.Name)
	}
	want := map[string]string{"team": "platform", LabelStarter: "jobs-estate", LabelRun: "9F2c41aa07b3", LabelTry: "2", LabelTemplate: "infra-apply"}
	for name, value := range want {
		if job.Labels[name] != value {
			t.Errorf("label %s = %q, want %q", name, job.Labels[name], value)
		}
	}
	if job.Spec.Template.Labels[LabelRun] != "9F2c41aa07b3" || job.Spec.Template.Labels[LabelStarter] != "jobs-estate" {
		t.Fatalf("pod labels %+v", job.Spec.Template.Labels)
	}
	spec := job.Spec.Template.Spec
	// The identity the job runs as, and everything else the estate wrote, stands.
	if spec.ServiceAccountName != "infra-apply" || spec.Containers[0].Image != "registry.example.com/infra/proxy:1" || spec.Containers[1].Resources.Limits.Memory().String() != "2Gi" {
		t.Fatalf("the manifest did not stand: %+v", spec)
	}
	main := spec.Containers[1]
	if main.Image != "registry.example.com/infra/runner:1.4.0" || strings.Join(main.Command, " ") != "infra apply" || strings.Join(main.Args, " ") != "--workspace network" {
		t.Fatalf("container %+v", main)
	}
	env := map[string]corev1.EnvVar{}
	for _, v := range main.Env {
		if _, twice := env[v.Name]; twice {
			t.Fatalf("%s is set twice", v.Name)
		}
		env[v.Name] = v
	}
	for name, value := range map[string]string{"STATE_ACCOUNT": "statestore", "WORKSPACE": "network", "ASKED_BY": "a user", EnvURL: "https://orrery-ingest.example.com", EnvRun: "9F2c41aa07b3", EnvAction: "infra_apply"} {
		if env[name].Value != value {
			t.Errorf("%s = %q, want %q", name, env[name].Value, value)
		}
	}
	// The credential is read from the Secret, and is nowhere in the Job.
	ref := env[EnvToken].ValueFrom
	if env[EnvToken].Value != "" || ref == nil || ref.SecretKeyRef.Name != "orrery-9f2c41aa07b3-2" || ref.SecretKeyRef.Key != "token" {
		t.Fatalf("token %+v", env[EnvToken])
	}
	if whole, _ := json.Marshal(job); strings.Contains(string(whole), "orr_run_s3cret") {
		t.Fatal("the credential is in the Job")
	}
	// The run's ceiling, one hour, is sooner than the manifest's two: the sooner stands.
	if *job.Spec.ActiveDeadlineSeconds != 3600 || *job.Spec.BackoffLimit != 0 || *job.Spec.TTLSecondsAfterFinished != defaultTTL || spec.RestartPolicy != corev1.RestartPolicyNever {
		t.Fatalf("deadline %d backoff %d ttl %d restart %s", *job.Spec.ActiveDeadlineSeconds, *job.Spec.BackoffLimit, *job.Spec.TTLSecondsAfterFinished, spec.RestartPolicy)
	}
	long := asked()
	long.CeilingMs = (7 * 24 * time.Hour).Milliseconds()
	if job, _ := k.Build(tpl, long); *job.Spec.ActiveDeadlineSeconds != 7200 {
		t.Fatalf("the manifest's sooner deadline did not stand: %d", *job.Spec.ActiveDeadlineSeconds)
	}
}

func TestBuildRefusesAManifestThatIsNoJobOrLacksTheContainer(t *testing.T) {
	k, tpl := kube(t)
	tpl.Container = "nope"
	if _, err := k.Build(tpl, asked()); err == nil || !strings.Contains(err.Error(), `no container "nope"`) {
		t.Fatalf("err %v", err)
	}
	if err := os.WriteFile(filepath.Join(k.Config.Dir, "infra-apply.yaml"), []byte("apiVersion: v1\nkind: Pod\nmetadata: {name: x}\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	tpl.Container = ""
	if _, err := k.Build(tpl, asked()); err == nil {
		t.Fatal("a Pod was taken for a Job")
	}
}

func TestStartMakesOneJobATryAndItsCredentialBesideIt(t *testing.T) {
	k, tpl := kube(t)
	ctx := context.Background()
	ref, err := k.Start(ctx, tpl, asked())
	if err != nil {
		t.Fatal(err)
	}
	if ref != "infra-jobs/orrery-9f2c41aa07b3-2" {
		t.Fatalf("ref %s", ref)
	}
	// Asked again for the same try, as a starter that restarted would: still one Job and one Secret.
	if _, err := k.Start(ctx, tpl, asked()); err != nil {
		t.Fatal(err)
	}
	jobs, _ := k.Client.BatchV1().Jobs("infra-jobs").List(ctx, metav1.ListOptions{})
	secrets, _ := k.Client.CoreV1().Secrets("infra-jobs").List(ctx, metav1.ListOptions{})
	if len(jobs.Items) != 1 || len(secrets.Items) != 1 {
		t.Fatalf("%d jobs, %d secrets", len(jobs.Items), len(secrets.Items))
	}
	secret := secrets.Items[0]
	if secret.Name != "orrery-9f2c41aa07b3-2" || secret.StringData["token"] != "orr_run_s3cret" {
		t.Fatalf("secret %+v", secret)
	}
	// The Job owns it, so it goes when the Job does.
	if len(secret.OwnerReferences) != 1 || secret.OwnerReferences[0].Kind != "Job" || secret.OwnerReferences[0].Name != jobs.Items[0].Name {
		t.Fatalf("owners %+v", secret.OwnerReferences)
	}
	// Another try is another Job.
	next := asked()
	next.Try = 3
	if _, err := k.Start(ctx, tpl, next); err != nil {
		t.Fatal(err)
	}
	if jobs, _ := k.Client.BatchV1().Jobs("infra-jobs").List(ctx, metav1.ListOptions{}); len(jobs.Items) != 2 {
		t.Fatalf("%d jobs", len(jobs.Items))
	}
}

func TestSeenReadsEachJobItStartedAndHowItsPodStands(t *testing.T) {
	k, tpl := kube(t)
	ctx := context.Background()
	mine := map[string]string{LabelStarter: "jobs-estate", LabelTemplate: "infra-apply"}
	job := func(name, run string, try string, conditions ...batchv1.JobCondition) {
		labels := merged(mine, map[string]string{LabelRun: run, LabelTry: try})
		_, err := k.Client.BatchV1().Jobs(tpl.Namespace).Create(ctx, &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: tpl.Namespace, Labels: labels, CreationTimestamp: metav1.NewTime(at.Add(-time.Hour))}, Status: batchv1.JobStatus{Conditions: conditions}}, metav1.CreateOptions{})
		if err != nil {
			t.Fatal(err)
		}
	}
	pod := func(name, of string, status corev1.PodStatus) {
		labels := merged(mine, map[string]string{"batch.kubernetes.io/job-name": of})
		if _, err := k.Client.CoreV1().Pods(tpl.Namespace).Create(ctx, &corev1.Pod{ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: tpl.Namespace, Labels: labels}, Status: status}, metav1.CreateOptions{}); err != nil {
			t.Fatal(err)
		}
	}
	yes := func(kind batchv1.JobConditionType, reason, message string) batchv1.JobCondition {
		return batchv1.JobCondition{Type: kind, Status: corev1.ConditionTrue, Reason: reason, Message: message, LastTransitionTime: metav1.NewTime(at)}
	}
	job("orrery-run1-1", "run1", "1")
	pod("run1-pod", "orrery-run1-1", corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Running: &corev1.ContainerStateRunning{}}}}})
	job("orrery-run2-1", "run2", "1")
	pod("run2-pod", "orrery-run2-1", corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Waiting: &corev1.ContainerStateWaiting{Reason: "ImagePullBackOff", Message: "manifest unknown"}}}}})
	job("orrery-run3-1", "run3", "1", yes(batchv1.JobComplete, "", ""))
	job("orrery-run4-2", "run4", "2", yes(batchv1.JobFailed, "BackoffLimitExceeded", "Job has reached the specified backoff limit"))
	pod("run4-pod", "orrery-run4-2", corev1.PodStatus{ContainerStatuses: []corev1.ContainerStatus{{State: corev1.ContainerState{Terminated: &corev1.ContainerStateTerminated{ExitCode: 137, Reason: "OOMKilled"}}}}})
	// A Job someone else made in the namespace, and one of another starter: neither is this starter's.
	if _, err := k.Client.BatchV1().Jobs(tpl.Namespace).Create(ctx, &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "nightly", Namespace: tpl.Namespace}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Client.BatchV1().Jobs(tpl.Namespace).Create(ctx, &batchv1.Job{ObjectMeta: metav1.ObjectMeta{Name: "orrery-other-1", Namespace: tpl.Namespace, Labels: map[string]string{LabelStarter: "another", LabelRun: "other", LabelTry: "1"}}}, metav1.CreateOptions{}); err != nil {
		t.Fatal(err)
	}
	seen, err := k.Seen(ctx)
	if err != nil {
		t.Fatal(err)
	}
	got := map[string]Seen{}
	for _, s := range seen {
		got[s.Run] = s
	}
	if len(got) != 4 {
		t.Fatalf("seen %+v", seen)
	}
	if s := got["run1"]; s.Phase != Active || !s.Started || s.Ref != "infra-jobs/orrery-run1-1" || s.Try != 1 || s.Template != "infra-apply" {
		t.Errorf("run1 %+v", s)
	}
	if s := got["run2"]; s.Phase != Active || s.Started || s.Why != "ImagePullBackOff: manifest unknown" {
		t.Errorf("run2 %+v", s)
	}
	if s := got["run3"]; s.Phase != Succeeded || !s.Ended.Equal(at) {
		t.Errorf("run3 %+v", s)
	}
	if s := got["run4"]; s.Phase != Failed || s.Try != 2 || s.Why != "exit 137: OOMKilled (BackoffLimitExceeded: Job has reached the specified backoff limit)" {
		t.Errorf("run4 %+v", s)
	}
	// Stopping one deletes its Job; stopping it again is no error.
	if err := k.Stop(ctx, got["run1"]); err != nil {
		t.Fatal(err)
	}
	if err := k.Stop(ctx, got["run1"]); err != nil {
		t.Fatal(err)
	}
	if _, err := k.Client.BatchV1().Jobs(tpl.Namespace).Get(ctx, "orrery-run1-1", metav1.GetOptions{}); err == nil {
		t.Fatal("the job is still there")
	}
}
