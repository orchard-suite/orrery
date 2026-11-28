package main

import (
	"encoding/json"
	"fmt"
	"strings"

	"github.com/orchard-suite/orrery/v3/sdk"
	networkingv1 "k8s.io/api/networking/v1"
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/apis/meta/v1/unstructured"
	"k8s.io/apimachinery/pkg/labels"
	"k8s.io/apimachinery/pkg/runtime"
)

// ruleSummaryMax keeps one rule's summary to a line a person reads.
const ruleSummaryMax = 240

// shapePolicies turns NetworkPolicies and Cilium policies into one blueprint.
// Each names the workloads whose pods it selects; its rules are kept as one
// short line each, so the hub holds what a policy allows, not a copy of it.
func shapePolicies(c Cluster, clusterKey string, workloads []workload) []sdk.Entity {
	var out []sdk.Entity
	for _, p := range c.NetworkPolicies {
		out = append(out, shapeNetworkPolicy(clusterKey, p, workloads))
	}
	nsLabels := map[string]map[string]string{}
	for _, ns := range c.Namespaces {
		nsLabels[ns.Name] = ns.Labels
	}
	for _, p := range c.CiliumPolicies {
		out = append(out, shapeCiliumPolicy(clusterKey, p, workloads, nsLabels))
	}
	return out
}

func shapeNetworkPolicy(clusterKey string, p networkingv1.NetworkPolicy, workloads []workload) sdk.Entity {
	sel, err := metav1.LabelSelectorAsSelector(&p.Spec.PodSelector)
	if err != nil {
		sel = labels.Nothing()
	}
	var selected []string
	for _, w := range workloads {
		if w.namespace == p.Namespace && w.podLabels != nil && sel.Matches(w.podLabels) {
			selected = append(selected, w.key)
		}
	}
	types := []string{}
	for _, t := range p.Spec.PolicyTypes {
		types = append(types, string(t))
	}
	if len(types) == 0 {
		types = append(types, "Ingress")
		if len(p.Spec.Egress) > 0 {
			types = append(types, "Egress")
		}
	}
	ingress := []string{}
	for _, r := range p.Spec.Ingress {
		ingress = append(ingress, "from "+peers(r.From)+ports(r.Ports))
	}
	egress := []string{}
	for _, r := range p.Spec.Egress {
		egress = append(egress, "to "+peers(r.To)+ports(r.Ports))
	}
	return sdk.Entity{
		Blueprint: "k8s_network_policy", Key: clusterKey + "/" + p.Namespace + "/" + p.Name, Title: p.Name,
		Fields:    map[string]any{"kind": "NetworkPolicy", "policy_types": types, "selector": selectorText(sel, "every pod in the namespace"), "ingress": ingress, "egress": egress},
		Relations: map[string]any{"cluster": clusterKey, "namespace": clusterKey + "/" + p.Namespace, "workloads": selected},
	}
}

func peers(ps []networkingv1.NetworkPolicyPeer) string {
	if len(ps) == 0 {
		return "anywhere"
	}
	var parts []string
	for _, p := range ps {
		var bits []string
		if p.IPBlock != nil {
			b := p.IPBlock.CIDR
			if len(p.IPBlock.Except) > 0 {
				b += " except " + strings.Join(p.IPBlock.Except, ", ")
			}
			bits = append(bits, b)
		}
		if p.NamespaceSelector != nil {
			s, _ := metav1.LabelSelectorAsSelector(p.NamespaceSelector)
			bits = append(bits, "namespaces "+selectorText(s, "all"))
		}
		if p.PodSelector != nil {
			s, _ := metav1.LabelSelectorAsSelector(p.PodSelector)
			bits = append(bits, "pods "+selectorText(s, "all"))
		}
		parts = append(parts, strings.Join(bits, " "))
	}
	return strings.Join(parts, "; ")
}

func ports(ps []networkingv1.NetworkPolicyPort) string {
	if len(ps) == 0 {
		return ""
	}
	var parts []string
	for _, p := range ps {
		s := "any port"
		if p.Port != nil {
			s = p.Port.String()
		}
		if p.Protocol != nil {
			s += "/" + string(*p.Protocol)
		}
		parts = append(parts, s)
	}
	return " on " + strings.Join(parts, ", ")
}

func selectorText(s labels.Selector, empty string) string {
	if s == nil || s.Empty() {
		return empty
	}
	return s.String()
}

// shapeCiliumPolicy reads a CiliumNetworkPolicy or a
// CiliumClusterwideNetworkPolicy. Cilium prefixes label keys with their
// source (`k8s:`, `any:`) and gives each pod its namespace as
// `io.kubernetes.pod.namespace` and its namespace's labels as
// `io.cilium.k8s.namespace.labels.<key>`; a workload is matched on those.
func shapeCiliumPolicy(clusterKey string, p unstructured.Unstructured, workloads []workload, nsLabels map[string]map[string]string) sdk.Entity {
	kind := p.GetKind()
	ns := p.GetNamespace()
	specs, _, _ := unstructured.NestedSlice(p.Object, "specs")
	if spec, ok, _ := unstructured.NestedMap(p.Object, "spec"); ok {
		specs = append([]any{spec}, specs...)
	}
	selected := map[string]bool{}
	typeSet := map[string]bool{}
	ingress, egress := []string{}, []string{}
	var selectors []string
	for _, raw := range specs {
		spec, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		sel := ciliumSelector(spec["endpointSelector"])
		selectors = append(selectors, selectorText(sel, "every endpoint"))
		for _, w := range workloads {
			if w.podLabels == nil || (ns != "" && w.namespace != ns) {
				continue
			}
			if sel.Matches(endpointLabels(w, nsLabels[w.namespace])) {
				selected[w.key] = true
			}
		}
		for _, dir := range []struct{ key, typ, prefix string }{{"ingress", "Ingress", ""}, {"ingressDeny", "Ingress", "deny "}, {"egress", "Egress", ""}, {"egressDeny", "Egress", "deny "}} {
			rules, _, _ := unstructured.NestedSlice(spec, dir.key)
			if len(rules) == 0 {
				continue
			}
			typeSet[dir.typ] = true
			for _, r := range rules {
				line := dir.prefix + ruleText(r)
				if dir.typ == "Ingress" {
					ingress = append(ingress, line)
				} else {
					egress = append(egress, line)
				}
			}
		}
	}
	types := sortedKeys(typeSet)
	rel := map[string]any{"cluster": clusterKey, "workloads": sortedKeys(selected)}
	key := clusterKey + "/cluster/" + p.GetName()
	if ns != "" {
		key = clusterKey + "/" + ns + "/" + p.GetName()
		rel["namespace"] = clusterKey + "/" + ns
	}
	return sdk.Entity{
		Blueprint: "k8s_network_policy", Key: key, Title: p.GetName(),
		Fields:    map[string]any{"kind": kind, "policy_types": types, "selector": strings.Join(selectors, "; "), "ingress": ingress, "egress": egress},
		Relations: rel,
	}
}

// ciliumSelector converts an endpointSelector, dropping the source prefix
// from every key. An absent or unreadable selector selects nothing.
func ciliumSelector(raw any) labels.Selector {
	m, ok := raw.(map[string]any)
	if !ok {
		return labels.Nothing()
	}
	var ls metav1.LabelSelector
	if err := runtime.DefaultUnstructuredConverter.FromUnstructured(m, &ls); err != nil {
		return labels.Nothing()
	}
	if ls.MatchLabels != nil {
		clean := map[string]string{}
		for k, v := range ls.MatchLabels {
			clean[stripSource(k)] = v
		}
		ls.MatchLabels = clean
	}
	for i := range ls.MatchExpressions {
		ls.MatchExpressions[i].Key = stripSource(ls.MatchExpressions[i].Key)
	}
	sel, err := metav1.LabelSelectorAsSelector(&ls)
	if err != nil {
		return labels.Nothing()
	}
	return sel
}

func stripSource(k string) string {
	for _, p := range []string{"k8s:", "any:"} {
		k = strings.TrimPrefix(k, p)
	}
	return k
}

func endpointLabels(w workload, nsl map[string]string) labels.Set {
	set := labels.Set{"io.kubernetes.pod.namespace": w.namespace}
	for k, v := range w.podLabels {
		set[k] = v
	}
	for k, v := range nsl {
		set["io.cilium.k8s.namespace.labels."+k] = v
	}
	return set
}

// ruleText is one rule as compact JSON, cut to a line.
func ruleText(r any) string {
	b, err := json.Marshal(r)
	if err != nil {
		return fmt.Sprint(r)
	}
	s := string(b)
	if len(s) > ruleSummaryMax {
		s = s[:ruleSummaryMax-1] + "…"
	}
	return s
}
