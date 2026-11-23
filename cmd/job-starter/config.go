package main

import (
	"errors"
	"fmt"
	"os"
	"path/filepath"
	"regexp"
	"sort"
	"strings"
	"time"

	"gopkg.in/yaml.v3"

	"github.com/orchard-suite/orrery/cmd/internal/containerapps"
)

// The platforms a starter starts jobs on. One starter serves one.
const (
	PlatformKubernetes    = "kubernetes"
	PlatformContainerApps = "azure-container-apps"
)

// Config is the estate's own word on what this starter may start: its
// platform and its templates. An action names a template and an image; where
// the job runs, as what, and which images it may run are decided here.
type Config struct {
	Platform string `yaml:"platform"`
	// StartWithin is how long a job's container may take to start before the
	// job is stopped and its run failed, such as an image that cannot be pulled.
	StartWithin time.Duration       `yaml:"-"`
	RawStart    string              `yaml:"start_within"`
	Templates   map[string]Template `yaml:"templates"`
	// Dir is the folder the file is in: a manifest is named beside it.
	Dir string `yaml:"-"`
}

// Template is one kind of job the estate lets actions ask for.
type Template struct {
	Name string `yaml:"-"`
	// Images a run may name. One that ends in /, :, or @ allows every image
	// that starts with it; any other allows that one image alone.
	Images []string `yaml:"images"`
	// Container takes the run's image, command, arguments, and environment;
	// the first container when left out.
	Container string `yaml:"container"`
	// Kubernetes: the namespace its Jobs are made in, and the Job manifest
	// they are made from, a file beside the config.
	Namespace string `yaml:"namespace"`
	Manifest  string `yaml:"manifest"`
	// Azure Container Apps: the job that is started, by its resource id.
	Job string `yaml:"job"`
}

var (
	templateName  = regexp.MustCompile(`^[a-z0-9][a-z0-9_-]*$`)
	namespaceName = regexp.MustCompile(`^[a-z0-9]([-a-z0-9]*[a-z0-9])?$`)
)

// DefaultStartWithin is how long a container may take to start when the config names no time.
const DefaultStartWithin = 15 * time.Minute

// LoadConfig reads the starter's config and holds it to its platform: every
// template names what its platform needs, and nothing of the other.
func LoadConfig(path string) (Config, error) {
	raw, err := os.ReadFile(path)
	if err != nil {
		return Config{}, err
	}
	return ParseConfig(raw, filepath.Dir(path))
}

// ParseConfig is LoadConfig over the file's text, with the folder it is in.
func ParseConfig(raw []byte, dir string) (Config, error) {
	var c Config
	if err := yaml.Unmarshal(raw, &c); err != nil {
		return c, err
	}
	c.Dir = dir
	if c.Platform != PlatformKubernetes && c.Platform != PlatformContainerApps {
		return c, fmt.Errorf("platform is %q: it is %s or %s", c.Platform, PlatformKubernetes, PlatformContainerApps)
	}
	c.StartWithin = DefaultStartWithin
	if c.RawStart != "" {
		d, err := time.ParseDuration(c.RawStart)
		if err != nil || d <= 0 {
			return c, fmt.Errorf("start_within is %q: name a time, such as 15m", c.RawStart)
		}
		c.StartWithin = d
	}
	if len(c.Templates) == 0 {
		return c, errors.New("templates: the starter starts nothing without one")
	}
	for name, t := range c.Templates {
		t.Name = name
		if !templateName.MatchString(name) {
			return c, fmt.Errorf("template %q: a name is lowercase letters, digits, - and _", name)
		}
		if len(t.Images) == 0 {
			return c, fmt.Errorf("template %q: images names the images a run may ask for; without one it allows none", name)
		}
		for _, image := range t.Images {
			if strings.TrimSpace(image) != image || image == "" || strings.ContainsAny(image, " \t\n*") {
				return c, fmt.Errorf("template %q: image %q is a whole image, or the start of one ending in /, :, or @", name, image)
			}
		}
		switch c.Platform {
		case PlatformKubernetes:
			if !namespaceName.MatchString(t.Namespace) {
				return c, fmt.Errorf("template %q: namespace names the namespace its jobs are made in", name)
			}
			if t.Manifest == "" || filepath.IsAbs(t.Manifest) || strings.Contains(t.Manifest, "..") {
				return c, fmt.Errorf("template %q: manifest names a Job manifest in the config's own folder", name)
			}
			if t.Job != "" {
				return c, fmt.Errorf("template %q: job is for the %s platform", name, PlatformContainerApps)
			}
		case PlatformContainerApps:
			if _, err := containerapps.ParseJob(t.Job); err != nil {
				return c, fmt.Errorf("template %q: job: %w", name, err)
			}
			if t.Namespace != "" || t.Manifest != "" {
				return c, fmt.Errorf("template %q: namespace and manifest are for the %s platform", name, PlatformKubernetes)
			}
		}
		c.Templates[name] = t
	}
	return c, nil
}

// Allows says whether a run may ask this template for an image.
func (t Template) Allows(image string) bool {
	if image == "" || strings.ContainsAny(image, " \t\n") {
		return false
	}
	for _, allowed := range t.Images {
		if strings.HasSuffix(allowed, "/") || strings.HasSuffix(allowed, ":") || strings.HasSuffix(allowed, "@") {
			if strings.HasPrefix(image, allowed) && len(image) > len(allowed) {
				return true
			}
		} else if image == allowed {
			return true
		}
	}
	return false
}

// names is the templates' names, in order, for a message.
func (c Config) names() string {
	out := make([]string, 0, len(c.Templates))
	for name := range c.Templates {
		out = append(out, name)
	}
	sort.Strings(out)
	return strings.Join(out, ", ")
}
