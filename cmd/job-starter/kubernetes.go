package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strconv"
	"strings"

	batchv1 "k8s.io/api/batch/v1"
	corev1 "k8s.io/api/core/v1"
	apierrors "k8s.io/apimachinery/pkg/api/errors"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/client-go/kubernetes"
	"sigs.k8s.io/yaml"
)

// The labels a Job and its pods carry, which is how a starter that kept
// nothing finds what it started.
const (
	LabelStarter  = "orrery/starter"
	LabelRun      = "orrery/run"
	LabelTry      = "orrery/try"
	LabelTemplate = "orrery/template"
	// The key of the run's credential in the Secret made beside its Job.
	tokenKey = "token"
	// How long a finished Job is kept when its manifest names no time.
	defaultTTL = int32(24 * 60 * 60)
)

// Kubernetes starts each run as one Job, made from a manifest the estate
// owns, in the namespace the template names. The run's credential goes into
// a Secret the Job owns, so it is never in a pod's spec and goes when the
// Job does.
type Kubernetes struct {
	Client  kubernetes.Interface
	Config  Config
	Starter string
	// HubURL is the hub's address as a job reaches it.
	HubURL string
}

var unsafeName = regexp.MustCompile(`[^a-z0-9-]+`)
var unsafeLabel = regexp.MustCompile(`[^A-Za-z0-9_.-]+`)

// jobName is the name of the Job of one try of a run. A try has one name, so
// asking twice starts one Job.
func jobName(run string, try int) string {
	name := strings.Trim(unsafeName.ReplaceAllString(strings.ToLower(run), "-"), "-")
	if len(name) > 40 {
		name = name[:40]
	}
	return fmt.Sprintf("orrery-%s-%d", name, try)
}

// labelValue is text as a label may hold it.
func labelValue(text string) string {
	v := strings.Trim(unsafeLabel.ReplaceAllString(text, "-"), "-_.")
	if len(v) > 63 {
		v = strings.TrimRight(v[:63], "-_.")
	}
	return v
}

// manifest reads the template's Job manifest afresh, so a changed file is taken by the next job.
func (k Kubernetes) manifest(t Template) (*batchv1.Job, error) {
	raw, err := os.ReadFile(filepath.Join(k.Config.Dir, t.Manifest))
	if err != nil {
		return nil, fmt.Errorf("template %s: %w", t.Name, err)
	}
	var job batchv1.Job
	if err := yaml.UnmarshalStrict(raw, &job); err != nil {
		return nil, fmt.Errorf("template %s: its manifest is not a Job: %w", t.Name, err)
	}
	if job.Kind != "" && job.Kind != "Job" {
		return nil, fmt.Errorf("template %s: its manifest is a %s, not a Job", t.Name, job.Kind)
	}
	if len(job.Spec.Template.Spec.Containers) == 0 {
		return nil, fmt.Errorf("template %s: its manifest has no container", t.Name)
	}
	return &job, nil
}

// Build is the Job of one try of a run: the estate's manifest, with the
// run's image, command, arguments, and environment on its container, and
// what the job is handed by the hub. Whatever the manifest says of the
// service account, the resources, the volumes, and the rest stands.
func (k Kubernetes) Build(t Template, j Job) (*batchv1.Job, error) {
	job, err := k.manifest(t)
	if err != nil {
		return nil, err
	}
	name := jobName(j.Run, j.Try)
	labels := map[string]string{LabelStarter: labelValue(k.Starter), LabelRun: labelValue(j.Run), LabelTry: strconv.Itoa(j.Try), LabelTemplate: labelValue(t.Name)}
	job.TypeMeta = metav1.TypeMeta{APIVersion: "batch/v1", Kind: "Job"}
	job.ObjectMeta = metav1.ObjectMeta{Name: name, Namespace: t.Namespace, Labels: merged(job.Labels, labels), Annotations: merged(job.Annotations, map[string]string{"orrery/action": j.Action})}
	pod := &job.Spec.Template
	pod.Labels = merged(pod.Labels, labels)
	at := 0
	if t.Container != "" {
		at = -1
		for i, c := range pod.Spec.Containers {
			if c.Name == t.Container {
				at = i
			}
		}
		if at < 0 {
			return nil, fmt.Errorf("template %s: its manifest has no container %q", t.Name, t.Container)
		}
	}
	c := &pod.Spec.Containers[at]
	c.Image = j.Image
	if len(j.Command) > 0 {
		c.Command = j.Command
	}
	if len(j.Args) > 0 {
		c.Args = j.Args
	}
	names := make([]string, 0, len(j.Env))
	for name := range j.Env {
		names = append(names, name)
	}
	sort.Strings(names)
	for _, name := range names {
		c.Env = setEnv(c.Env, corev1.EnvVar{Name: name, Value: j.Env[name]})
	}
	c.Env = setEnv(c.Env, corev1.EnvVar{Name: EnvURL, Value: k.HubURL})
	c.Env = setEnv(c.Env, corev1.EnvVar{Name: EnvRun, Value: j.Run})
	c.Env = setEnv(c.Env, corev1.EnvVar{Name: EnvAction, Value: j.Action})
	c.Env = setEnv(c.Env, corev1.EnvVar{Name: EnvToken, ValueFrom: &corev1.EnvVarSource{SecretKeyRef: &corev1.SecretKeySelector{LocalObjectReference: corev1.LocalObjectReference{Name: name}, Key: tokenKey}}})
	if pod.Spec.RestartPolicy == "" {
		pod.Spec.RestartPolicy = corev1.RestartPolicyNever
	}
	// One container a try: the hub tries a run again, as its action says, never the platform.
	if job.Spec.BackoffLimit == nil {
		zero := int32(0)
		job.Spec.BackoffLimit = &zero
	}
	if job.Spec.TTLSecondsAfterFinished == nil {
		ttl := defaultTTL
		job.Spec.TTLSecondsAfterFinished = &ttl
	}
	// The platform ends the job at the run's ceiling too, should the starter be gone then.
	if ceiling := j.CeilingMs / 1000; ceiling > 0 && (job.Spec.ActiveDeadlineSeconds == nil || *job.Spec.ActiveDeadlineSeconds > ceiling) {
		job.Spec.ActiveDeadlineSeconds = &ceiling
	}
	return job, nil
}

// Start makes the Job and then the Secret it reads its credential from,
// owned by the Job. A Job that is there already is the one asked for.
func (k Kubernetes) Start(ctx context.Context, t Template, j Job) (string, error) {
	job, err := k.Build(t, j)
	if err != nil {
		return "", err
	}
	jobs := k.Client.BatchV1().Jobs(t.Namespace)
	made, err := jobs.Create(ctx, job, metav1.CreateOptions{})
	if apierrors.IsAlreadyExists(err) {
		made, err = jobs.Get(ctx, job.Name, metav1.GetOptions{})
	}
	if err != nil {
		return "", err
	}
	owned := true
	secret := &corev1.Secret{
		ObjectMeta: metav1.ObjectMeta{Name: job.Name, Namespace: t.Namespace, Labels: job.Labels, OwnerReferences: []metav1.OwnerReference{{APIVersion: "batch/v1", Kind: "Job", Name: made.Name, UID: made.UID, Controller: &owned}}},
		Type:       corev1.SecretTypeOpaque,
		StringData: map[string]string{tokenKey: j.Token},
	}
	if _, err := k.Client.CoreV1().Secrets(t.Namespace).Create(ctx, secret, metav1.CreateOptions{}); err != nil && !apierrors.IsAlreadyExists(err) {
		// A Job with no credential would wait for one for ever: it goes, and the run is told why.
		background := metav1.DeletePropagationBackground
		_ = jobs.Delete(ctx, job.Name, metav1.DeleteOptions{PropagationPolicy: &background})
		return "", fmt.Errorf("the job's credential could not be stored: %w", err)
	}
	return t.Namespace + "/" + job.Name, nil
}

// Seen lists the Jobs this starter made in every namespace its templates
// name, each with how its pod stands.
func (k Kubernetes) Seen(ctx context.Context) ([]Seen, error) {
	selector := LabelStarter + "=" + labelValue(k.Starter)
	spaces := map[string]bool{}
	for _, t := range k.Config.Templates {
		spaces[t.Namespace] = true
	}
	var out []Seen
	for ns := range spaces {
		jobs, err := k.Client.BatchV1().Jobs(ns).List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err != nil {
			return nil, fmt.Errorf("jobs in %s: %w", ns, err)
		}
		pods, err := k.Client.CoreV1().Pods(ns).List(ctx, metav1.ListOptions{LabelSelector: selector})
		if err != nil {
			return nil, fmt.Errorf("pods in %s: %w", ns, err)
		}
		// The newest pod of each Job says how its container stands.
		newest := map[string]corev1.Pod{}
		for _, p := range pods.Items {
			name := p.Labels["batch.kubernetes.io/job-name"]
			if name == "" {
				name = p.Labels["job-name"]
			}
			if was, ok := newest[name]; !ok || p.CreationTimestamp.After(was.CreationTimestamp.Time) {
				newest[name] = p
			}
		}
		for _, job := range jobs.Items {
			try, err := strconv.Atoi(job.Labels[LabelTry])
			if err != nil || job.Labels[LabelRun] == "" {
				continue
			}
			s := Seen{Run: job.Labels[LabelRun], Try: try, Ref: ns + "/" + job.Name, Template: job.Labels[LabelTemplate], Created: job.CreationTimestamp.Time}
			pod, has := newest[job.Name]
			if has {
				s.Started, s.Why = podStands(pod)
			}
			for _, c := range job.Status.Conditions {
				if c.Status != corev1.ConditionTrue {
					continue
				}
				switch c.Type {
				case batchv1.JobComplete:
					s.Phase, s.Ended = Succeeded, c.LastTransitionTime.Time
				case batchv1.JobFailed:
					s.Phase, s.Ended = Failed, c.LastTransitionTime.Time
					said := strings.TrimSpace(c.Reason + ": " + c.Message)
					if s.Why != "" {
						said = s.Why + " (" + said + ")"
					}
					s.Why = strings.Trim(said, ": ")
				}
			}
			out = append(out, s)
		}
	}
	return out, nil
}

// podStands says whether a pod's containers have started, and what the pod
// waits for or how its container ended.
func podStands(p corev1.Pod) (started bool, why string) {
	for _, c := range p.Status.ContainerStatuses {
		switch {
		case c.State.Terminated != nil:
			started = true
			t := c.State.Terminated
			if t.ExitCode != 0 {
				why = strings.Trim(fmt.Sprintf("exit %d: %s %s", t.ExitCode, t.Reason, strings.TrimSpace(t.Message)), ": ")
			}
		case c.State.Running != nil:
			started = true
		case c.State.Waiting != nil && why == "":
			why = strings.Trim(c.State.Waiting.Reason+": "+c.State.Waiting.Message, ": ")
		}
	}
	if !started && why == "" {
		for _, c := range p.Status.Conditions {
			if c.Type == corev1.PodScheduled && c.Status == corev1.ConditionFalse {
				why = strings.Trim(c.Reason+": "+c.Message, ": ")
			}
		}
	}
	return started, why
}

// Stop deletes the Job, and with it its pods and its Secret.
func (k Kubernetes) Stop(ctx context.Context, s Seen) error {
	ns, name, ok := strings.Cut(s.Ref, "/")
	if !ok {
		return fmt.Errorf("%q is not a job of this platform", s.Ref)
	}
	background := metav1.DeletePropagationBackground
	err := k.Client.BatchV1().Jobs(ns).Delete(ctx, name, metav1.DeleteOptions{PropagationPolicy: &background})
	if apierrors.IsNotFound(err) {
		return nil
	}
	return err
}

func merged(base, over map[string]string) map[string]string {
	out := map[string]string{}
	for k, v := range base {
		out[k] = v
	}
	for k, v := range over {
		out[k] = v
	}
	return out
}

// setEnv sets one variable, in place of one of the same name.
func setEnv(env []corev1.EnvVar, v corev1.EnvVar) []corev1.EnvVar {
	for i := range env {
		if env[i].Name == v.Name {
			env[i] = v
			return env
		}
	}
	return append(env, v)
}
