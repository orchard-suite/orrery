package main

import (
	metav1 "k8s.io/apimachinery/pkg/apis/meta/v1"
	"k8s.io/apimachinery/pkg/labels"
)

func labelSelector(s *metav1.LabelSelector) (labels.Selector, error) {
	if s == nil {
		return labels.Nothing(), nil
	}
	return metav1.LabelSelectorAsSelector(s)
}
