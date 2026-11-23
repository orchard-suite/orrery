package main

import (
	"log/slog"
	"reflect"
	"testing"

	corev1 "k8s.io/api/core/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
)

func TestShapeGateways(t *testing.T) {
	c := Cluster{
		Name:       "home",
		Namespaces: []corev1.Namespace{{ObjectMeta: metav1.ObjectMeta{Name: "edge"}}, {ObjectMeta: metav1.ObjectMeta{Name: "beacon"}}},
		Services:   []corev1.Service{{ObjectMeta: metav1.ObjectMeta{Name: "web", Namespace: "beacon"}}},
		Gateways: []unstructured.Unstructured{{Object: map[string]any{
			"metadata": map[string]any{"name": "public", "namespace": "edge"},
			"spec": map[string]any{"gatewayClassName": "istio", "listeners": []any{
				map[string]any{"name": "https", "hostname": "*.Example.org", "port": int64(443), "protocol": "HTTPS"},
				map[string]any{"name": "http", "port": int64(80), "protocol": "HTTP"},
			}},
			"status": map[string]any{
				"addresses":  []any{map[string]any{"type": "IPAddress", "value": "10.1.2.3"}},
				"conditions": []any{map[string]any{"type": "Programmed", "status": "True"}},
			},
		}}},
		HTTPRoutes: []unstructured.Unstructured{
			{Object: map[string]any{
				"metadata": map[string]any{"name": "web", "namespace": "beacon", "annotations": map[string]any{IconAnnotation: "beacon"}},
				"spec": map[string]any{
					"hostnames":  []any{"Beacon.example.org"},
					"parentRefs": []any{map[string]any{"name": "public", "namespace": "edge"}, map[string]any{"name": "mesh", "group": "", "kind": "Service"}},
					"rules": []any{map[string]any{"backendRefs": []any{
						map[string]any{"name": "web", "port": int64(80)},
						map[string]any{"name": "bucket", "group": "storage.example.org", "kind": "Bucket"},
					}}},
				},
			}},
			{Object: map[string]any{
				"metadata": map[string]any{"name": "catchall", "namespace": "edge"},
				"spec":     map[string]any{"parentRefs": []any{map[string]any{"name": "public"}}},
			}},
		},
	}
	all := Shape(c, slog.Default())
	if missing := undefined(t, all); len(missing) > 0 {
		t.Fatalf("blueprints.yaml does not define what the pusher writes: %v", missing)
	}
	by := map[string]int{}
	for i, e := range all {
		by[e.ID()] = i
	}
	g := all[by["k8s_gateway:home/edge/public"]]
	if !reflect.DeepEqual(g.Fields["listeners"], []string{"https *.Example.org:443/HTTPS", "http *:80/HTTP"}) || !reflect.DeepEqual(g.Fields["hosts"], []string{"*.example.org"}) || !reflect.DeepEqual(g.Fields["addresses"], []string{"10.1.2.3"}) || g.Fields["programmed"] != true || g.Fields["class"] != "istio" {
		t.Fatalf("gateway: %v", g.Fields)
	}
	r := all[by["k8s_http_route:home/beacon/web"]]
	if r.Title != "beacon.example.org" || r.Icon != "beacon" {
		t.Fatalf("route title and icon: %q %q", r.Title, r.Icon)
	}
	if !reflect.DeepEqual(r.Relations["gateways"], []string{"home/edge/public"}) {
		t.Fatalf("a route attaches only to the gateways its parents name: %v", r.Relations["gateways"])
	}
	if !reflect.DeepEqual(r.Relations["services"], []string{"home/beacon/web"}) {
		t.Fatalf("a route routes only to the services its backends name: %v", r.Relations["services"])
	}
	if h := r.Fields["health"].(map[string]any); h["url"] != "https://beacon.example.org/" {
		t.Fatalf("route health: %v", h)
	}
	ca := all[by["k8s_http_route:home/edge/catchall"]]
	if !reflect.DeepEqual(ca.Fields["hosts"], []string{"*.example.org"}) {
		t.Fatalf("a route with no hostnames takes its gateways' hosts: %v", ca.Fields)
	}
	if _, ok := ca.Fields["health"]; ok {
		t.Fatalf("a route whose hosts are all wildcards has no health check: %v", ca.Fields)
	}
	if ca.Title != "*.example.org" {
		t.Fatalf("catchall title: %q", ca.Title)
	}
}
