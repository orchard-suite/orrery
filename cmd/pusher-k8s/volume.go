package main

import (
	"github.com/orchard-suite/orrery/sdk"
	corev1 "k8s.io/api/core/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

// shapeVolumes turns each PersistentVolumeClaim into a volume, linked to the
// workloads whose pods mount it. Where Longhorn runs, a volume also names the
// nodes that hold its replicas, so a node's loss can be read as data at risk.
// claimUsers is keyed "<namespace>/<claim>".
func shapeVolumes(c Cluster, clusterKey string, claimUsers map[string]map[string]bool) []sdk.Entity {
	type replicas struct {
		nodes   map[string]bool
		total   int
		running int
	}
	byVolume := map[string]*replicas{}
	for _, r := range c.LonghornReplicas {
		vol, _, _ := unstructured.NestedString(r.Object, "spec", "volumeName")
		node, _, _ := unstructured.NestedString(r.Object, "spec", "nodeID")
		state, _, _ := unstructured.NestedString(r.Object, "status", "currentState")
		if vol == "" {
			continue
		}
		rs := byVolume[vol]
		if rs == nil {
			rs = &replicas{nodes: map[string]bool{}}
			byVolume[vol] = rs
		}
		rs.total++
		if state == "running" {
			rs.running++
		}
		if node != "" {
			rs.nodes[clusterKey+"/"+node] = true
		}
	}
	var out []sdk.Entity
	for _, pvc := range c.Claims {
		class := ""
		if pvc.Spec.StorageClassName != nil {
			class = *pvc.Spec.StorageClassName
		}
		modes := []string{}
		for _, m := range pvc.Spec.AccessModes {
			modes = append(modes, string(m))
		}
		fields := map[string]any{"storage_class": class, "phase": string(pvc.Status.Phase), "access_modes": modes, "volume": pvc.Spec.VolumeName}
		if q, ok := pvc.Spec.Resources.Requests[corev1.ResourceStorage]; ok {
			fields["size_gb"] = round1(q.AsApproximateFloat64() / (1 << 30))
		}
		rel := map[string]any{"namespace": clusterKey + "/" + pvc.Namespace, "workloads": sortedKeys(claimUsers[pvc.Namespace+"/"+pvc.Name])}
		if rs := byVolume[pvc.Spec.VolumeName]; rs != nil {
			fields["replicas"] = rs.total
			fields["replicas_running"] = rs.running
			rel["nodes"] = sortedKeys(rs.nodes)
		}
		out = append(out, sdk.Entity{Blueprint: "k8s_volume", Key: clusterKey + "/" + pvc.Namespace + "/" + pvc.Name, Title: pvc.Name, Fields: fields, Relations: rel})
	}
	return out
}
