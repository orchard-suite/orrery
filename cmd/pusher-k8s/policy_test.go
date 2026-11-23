package main

import (
	"log/slog"
	"reflect"
	"testing"

	"github.com/orchard-suite/orrery/sdk"

	appsv1 "k8s.io/api/apps/v1"
	corev1 "k8s.io/api/core/v1"
	networkingv1 "k8s.io/api/networking/v1"
	"k8s.io/apimachinery/pkg/api/resource"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/util/intstr"
)

func deployment(ns, name string, podLabels map[string]string) appsv1.Deployment {
	return appsv1.Deployment{
		ObjectMeta: metav1.ObjectMeta{Name: name, Namespace: ns},
		Spec: appsv1.DeploymentSpec{
			Selector: &metav1.LabelSelector{MatchLabels: podLabels},
			Template: corev1.PodTemplateSpec{ObjectMeta: metav1.ObjectMeta{Labels: podLabels}},
		},
	}
}

func TestPoliciesVolumesAndNodePlacement(t *testing.T) {
	tcp := corev1.ProtocolTCP
	port := intstr.FromString("http")
	c := Cluster{
		Name: "home",
		Nodes: []corev1.Node{{
			ObjectMeta: metav1.ObjectMeta{Name: "w1", Labels: map[string]string{"topology.kubernetes.io/zone": "zone-a"}},
			Status: corev1.NodeStatus{
				NodeInfo:    corev1.NodeSystemInfo{SystemUUID: "0E1D3C2B-0000-4000-8000-00000000000A"},
				Capacity:    corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("6"), corev1.ResourceMemory: resource.MustParse("14Gi")},
				Allocatable: corev1.ResourceList{corev1.ResourceCPU: resource.MustParse("5500m"), corev1.ResourceMemory: resource.MustParse("12800Mi")},
			},
		}},
		Namespaces: []corev1.Namespace{
			{ObjectMeta: metav1.ObjectMeta{Name: "app", Labels: map[string]string{"team": "house"}}},
			{ObjectMeta: metav1.ObjectMeta{Name: "kube-system"}},
		},
		Deployments: []appsv1.Deployment{
			deployment("app", "web", map[string]string{"app": "web"}),
			deployment("app", "db", map[string]string{"app": "db"}),
			deployment("kube-system", "dns", map[string]string{"k8s-app": "dns"}),
		},
		ReplicaSets: []appsv1.ReplicaSet{{ObjectMeta: metav1.ObjectMeta{Name: "db-1", Namespace: "app", OwnerReferences: []metav1.OwnerReference{{Kind: "Deployment", Name: "db"}}}}},
		Pods: []corev1.Pod{{
			ObjectMeta: metav1.ObjectMeta{Name: "db-1-a", Namespace: "app", OwnerReferences: []metav1.OwnerReference{{Kind: "ReplicaSet", Name: "db-1"}}},
			Spec:       corev1.PodSpec{NodeName: "w1", Volumes: []corev1.Volume{{Name: "data", VolumeSource: corev1.VolumeSource{PersistentVolumeClaim: &corev1.PersistentVolumeClaimVolumeSource{ClaimName: "db-data"}}}}},
		}},
		NetworkPolicies: []networkingv1.NetworkPolicy{{
			ObjectMeta: metav1.ObjectMeta{Name: "web-from-traefik", Namespace: "app"},
			Spec: networkingv1.NetworkPolicySpec{
				PodSelector: metav1.LabelSelector{MatchLabels: map[string]string{"app": "web"}},
				Ingress: []networkingv1.NetworkPolicyIngressRule{{
					From:  []networkingv1.NetworkPolicyPeer{{NamespaceSelector: &metav1.LabelSelector{MatchLabels: map[string]string{"kubernetes.io/metadata.name": "traefik"}}}},
					Ports: []networkingv1.NetworkPolicyPort{{Protocol: &tcp, Port: &port}},
				}},
			},
		}},
		CiliumPolicies: []unstructured.Unstructured{{Object: map[string]any{
			"kind":     "CiliumClusterwideNetworkPolicy",
			"metadata": map[string]any{"name": "lan-egress-default"},
			"spec": map[string]any{
				"endpointSelector": map[string]any{"matchExpressions": []any{
					map[string]any{"key": "k8s:io.kubernetes.pod.namespace", "operator": "NotIn", "values": []any{"kube-system"}},
				}},
				"egressDeny": []any{map[string]any{"toCIDRSet": []any{map[string]any{"cidr": "192.168.0.0/16"}}}},
			},
		}}},
		Claims: []corev1.PersistentVolumeClaim{{
			ObjectMeta: metav1.ObjectMeta{Name: "db-data", Namespace: "app"},
			Spec: corev1.PersistentVolumeClaimSpec{
				VolumeName: "pvc-123",
				Resources:  corev1.VolumeResourceRequirements{Requests: corev1.ResourceList{corev1.ResourceStorage: resource.MustParse("10Gi")}},
			},
			Status: corev1.PersistentVolumeClaimStatus{Phase: corev1.ClaimBound},
		}},
		LonghornReplicas: []unstructured.Unstructured{
			{Object: map[string]any{"spec": map[string]any{"volumeName": "pvc-123", "nodeID": "w1"}, "status": map[string]any{"currentState": "running"}}},
			{Object: map[string]any{"spec": map[string]any{"volumeName": "pvc-123", "nodeID": "w2"}, "status": map[string]any{"currentState": "stopped"}}},
			{Object: map[string]any{"spec": map[string]any{"volumeName": "pvc-other", "nodeID": "w3"}}},
		},
	}
	all := Shape(c, slog.Default())
	if missing := undefined(t, all); len(missing) > 0 {
		t.Fatalf("blueprints.yaml does not define what the pusher writes: %v", missing)
	}
	byID := map[string]sdk.Entity{}
	for _, e := range all {
		byID[e.ID()] = e
	}

	node := byID["k8s_node:home/w1"].Fields
	if node["zone"] != "zone-a" || node["system_uuid"] != "0e1d3c2b-0000-4000-8000-00000000000a" || node["allocatable_cpu"] != 5.5 || node["allocatable_memory_gb"] != 12.5 {
		t.Fatalf("node placement fields: %v", node)
	}

	np := byID["k8s_network_policy:home/app/web-from-traefik"]
	if !reflect.DeepEqual(np.Relations["workloads"], []string{"home/app/web"}) {
		t.Fatalf("network policy selects %v, want only web", np.Relations["workloads"])
	}
	if got := np.Fields["ingress"]; !reflect.DeepEqual(got, []string{"from namespaces kubernetes.io/metadata.name=traefik on http/TCP"}) {
		t.Fatalf("ingress summary: %v", got)
	}
	if np.Relations["namespace"] != "home/app" {
		t.Fatalf("namespace: %v", np.Relations)
	}

	ccnp := byID["k8s_network_policy:home/cluster/lan-egress-default"]
	if !reflect.DeepEqual(ccnp.Relations["workloads"], []string{"home/app/db", "home/app/web"}) {
		t.Fatalf("cluster-wide policy selects %v, want every workload outside kube-system", ccnp.Relations["workloads"])
	}
	if _, ok := ccnp.Relations["namespace"]; ok {
		t.Fatalf("a cluster-wide policy has no namespace: %v", ccnp.Relations)
	}
	if !reflect.DeepEqual(ccnp.Fields["policy_types"], []string{"Egress"}) || !reflect.DeepEqual(ccnp.Fields["egress"], []string{`deny {"toCIDRSet":[{"cidr":"192.168.0.0/16"}]}`}) {
		t.Fatalf("cluster-wide policy fields: %v", ccnp.Fields)
	}

	vol := byID["k8s_volume:home/app/db-data"]
	if vol.Fields["size_gb"] != 10.0 || vol.Fields["replicas"] != 2 || vol.Fields["replicas_running"] != 1 {
		t.Fatalf("volume fields: %v", vol.Fields)
	}
	if !reflect.DeepEqual(vol.Relations["workloads"], []string{"home/app/db"}) || !reflect.DeepEqual(vol.Relations["nodes"], []string{"home/w1", "home/w2"}) {
		t.Fatalf("volume relations: %v", vol.Relations)
	}
}
