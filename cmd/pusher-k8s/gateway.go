package main

import (
	"fmt"
	"strings"

	"github.com/orchard-suite/orrery/v3/sdk"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/runtime/schema"
)

// The Gateway API resources the pusher reads, where the cluster has the CRDs.
var (
	gatewaysResource   = schema.GroupVersionResource{Group: gatewayGroup, Version: "v1", Resource: "gateways"}
	httpRoutesResource = schema.GroupVersionResource{Group: gatewayGroup, Version: "v1", Resource: "httproutes"}
)

const gatewayGroup = "gateway.networking.k8s.io"

// shapeGateways turns Gateways and HTTPRoutes into entities. A route's hosts
// are its own hostnames; a route that names none answers on every hostname
// its gateways listen on, so it takes theirs. Its health is the first host
// that is not a wildcard, over https.
func shapeGateways(c Cluster, clusterKey string) []sdk.Entity {
	var out []sdk.Entity
	listening := map[string][]string{}
	for _, g := range c.Gateways {
		key := clusterKey + "/" + g.GetNamespace() + "/" + g.GetName()
		class, _, _ := unstructured.NestedString(g.Object, "spec", "gatewayClassName")
		listeners, hosts := []string{}, []string{}
		list, _, _ := unstructured.NestedSlice(g.Object, "spec", "listeners")
		for _, l := range list {
			m, ok := l.(map[string]any)
			if !ok {
				continue
			}
			name, _ := m["name"].(string)
			host, _ := m["hostname"].(string)
			proto, _ := m["protocol"].(string)
			port, _ := m["port"].(int64)
			at := host
			if at == "" {
				at = "*"
			}
			listeners = append(listeners, fmt.Sprintf("%s %s:%d/%s", name, at, port, proto))
			if host != "" {
				hosts = append(hosts, strings.ToLower(host))
			}
		}
		addresses := []string{}
		status, _, _ := unstructured.NestedSlice(g.Object, "status", "addresses")
		for _, a := range status {
			if m, ok := a.(map[string]any); ok {
				if v, _ := m["value"].(string); v != "" {
					addresses = append(addresses, v)
				}
			}
		}
		hosts = unique(hosts)
		listening[key] = hosts
		out = append(out, sdk.Entity{
			Blueprint: "k8s_gateway", Key: key, Title: g.GetName(), Icon: iconOf(g.GetAnnotations()),
			Fields:    map[string]any{"class": class, "listeners": listeners, "hosts": hosts, "addresses": addresses, "programmed": condition(g, "Programmed")},
			Relations: map[string]any{"namespace": clusterKey + "/" + g.GetNamespace()},
		})
	}

	for _, r := range c.HTTPRoutes {
		ns := r.GetNamespace()
		gateways := map[string]bool{}
		parents, _, _ := unstructured.NestedSlice(r.Object, "spec", "parentRefs")
		for _, p := range parents {
			m, ok := p.(map[string]any)
			if !ok || !refIs(m, gatewayGroup, "Gateway") {
				continue
			}
			gateways[clusterKey+"/"+refNamespace(m, ns)+"/"+fmt.Sprint(m["name"])] = true
		}
		services := map[string]bool{}
		rules, _, _ := unstructured.NestedSlice(r.Object, "spec", "rules")
		for _, rule := range rules {
			rm, ok := rule.(map[string]any)
			if !ok {
				continue
			}
			backends, _ := rm["backendRefs"].([]any)
			for _, b := range backends {
				if m, ok := b.(map[string]any); ok && refIs(m, "", "Service") {
					services[clusterKey+"/"+refNamespace(m, ns)+"/"+fmt.Sprint(m["name"])] = true
				}
			}
		}
		names, _, _ := unstructured.NestedStringSlice(r.Object, "spec", "hostnames")
		hosts := []string{}
		for _, h := range names {
			hosts = append(hosts, strings.ToLower(h))
		}
		if len(hosts) == 0 {
			for _, g := range sortedKeys(gateways) {
				hosts = append(hosts, listening[g]...)
			}
		}
		hosts = unique(hosts)
		fields := map[string]any{"hosts": hosts}
		for _, h := range hosts {
			if !strings.HasPrefix(h, "*") {
				fields["health"] = map[string]any{"url": "https://" + h + "/", "expectStatus": "ok", "runners": ingressRunners, "timeoutMs": 8000}
				break
			}
		}
		title := strings.Join(hosts, ", ")
		if title == "" {
			title = r.GetName()
		}
		out = append(out, sdk.Entity{
			Blueprint: "k8s_http_route", Key: clusterKey + "/" + ns + "/" + r.GetName(), Title: title, Icon: iconOf(r.GetAnnotations()),
			Fields:    fields,
			Relations: map[string]any{"namespace": clusterKey + "/" + ns, "gateways": sortedKeys(gateways), "services": sortedKeys(services)},
		})
	}
	return out
}

// refIs says whether a Gateway API reference names the kind in the group,
// reading an unset group or kind as the reference's default.
func refIs(ref map[string]any, group, kind string) bool {
	g, ok := ref["group"].(string)
	if !ok {
		g = group
	}
	k, ok := ref["kind"].(string)
	if !ok {
		k = kind
	}
	return g == group && k == kind
}

// refNamespace is a reference's namespace, or the referrer's own.
func refNamespace(ref map[string]any, own string) string {
	if ns, _ := ref["namespace"].(string); ns != "" {
		return ns
	}
	return own
}

// condition is whether the object's status holds the condition as True.
func condition(o unstructured.Unstructured, kind string) bool {
	list, _, _ := unstructured.NestedSlice(o.Object, "status", "conditions")
	for _, c := range list {
		if m, ok := c.(map[string]any); ok && m["type"] == kind {
			return m["status"] == "True"
		}
	}
	return false
}

func unique(in []string) []string {
	seen := map[string]bool{}
	for _, s := range in {
		seen[s] = true
	}
	return sortedKeys(seen)
}
