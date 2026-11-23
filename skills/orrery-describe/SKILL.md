---
name: orrery-describe
description: Describe the service a repository builds to the Orrery catalog, with an orrery.yaml the estate's forge reader reads. Use when building or changing an app that runs as a service, when an app gains or loses a connector to another app or service, when a landscape or integration web is wrong about an app, or when an app should or should not be listed in an estate.
---

# Orrery describe

A repository says what service it builds and what that service connects to
in an `orrery.yaml`: at its root, or beside each service in a repository that
builds several. The forge reader of each estate ([Muster](https://github.com/orchard-suite/muster))
reads the file with the repository, at the same commit as the code, and
writes the service, its logo, its connectors, and the APIs it provides. The
app itself never writes its description: an estate lists exactly the
services of the repositories it reads. An estate that runs the app from a
repository it does not read sees its workload and its image, never its
service. Read the Landscape section of `modelling_guide` first.

## The file

```yaml
service: github/acme/tally/cmd/tally   # its key: the repository path
icon:                                   # optional: its logo, both keys or neither
  name: tally
  file: logo.svg
provides:                               # each becomes an API <service>/<id>
  - id: costs
    title: Tally costs API
    kind: rest                          # rest, graphql, grpc, event, mcp, web
    description: What the estate costs.
    spec: api/openapi.yaml              # optional: where its definition is read
consumes:                               # API keys it calls today
  - github/acme/orrery/catalog
will_consume: []                        # API keys it should call, not yet
fields:                                 # optional: its place in one estate's scheme
  category: Cost
relations:                              # optional: the same, as links
  pillars: [platform/cost]
deploys:                                # optional: how it deploys, where the forge does not say
  pipeline: .gitlab-ci.yml              # its good default-branch or tag runs are its deployments
  environment: production               # where those runs deploy; production when left out
  argocd:                               # the sources its Argo CD apps read their manifests from
    - https://gitlab.example.com/ops/gitops/-/tree/main/apps/tally
```

`service` is the repository's own key (`<forge>/<owner>/<repo>`) or a folder
in it; a file in a folder names a service at or under that folder. A file
that names another repository's key describes nothing. Paths in the file
(`icon.file`, `spec`) are from the repository root, wherever the file sits.

`fields` and `relations` place the app in one estate's own scheme, written
onto its service as they are, in a write of their own: a hub that lacks one
of the names keeps the service without its place. Leave them out of software
meant for any estate. Software that runs in more than one estate never sets a
relation to a Core blueprint here (a team, a customer, a site): each estate
names Core in its own words, so the name would be wrong somewhere.

`spec` names an API's machine-readable definition (OpenAPI, AsyncAPI,
protobuf, or a GraphQL schema): a path from the repository's root, or a full
URL. A path becomes the file's link on the default branch, in the forge's own
form. Keep the definition in the repository, generated from the code with a
test that fails while it is stale: a conformance board judges it there, and a
pipeline compares it with the last release. Never name a URL only one estate
serves.

`deploys` ties deployments to the service that the forge cannot tie to it.
Name `pipeline` only for a service whose pipeline deploys it without a forge
environment (a scheduled job, a data pusher, an infrastructure project):
each revision's first good run of that pipeline file on the default branch,
or for a tag, is one deployment. Leave it out where the forge records the
service's deployments, or each counts twice. Name `argocd` when the Argo CD
apps that deploy the service read their manifests from another repository,
such as a GitOps repository: the folder, or a folder above it, that the apps'
sources sit in. In a repository of several services, the forge reader also
places a deployment by its environment or job naming a component the
estate's reader is set to read from `fields` (for example
`deploy_component`), else by the folders the deployed changes touched.

The logo is an svg, png, or webp of at most 256 KiB, its name lowercase
letters, digits, and underscores, never a name the built-in icon set has.

A connector is a line here: add it to `consumes` in the same change that
makes the call work, or to `will_consume` while it is still to build.

## What reaches the catalog

When the default branch moves, the forge reader reads the file and writes:

1. The service, `origin: built`, wearing the logo, with `consumes` and
   `will_consume` (an empty list removes what was there).
2. One `sw_api` per provided API, keyed `<service>/<id>`, with `kind`,
   `description`, `visibility: internal`, `external: false`, `spec`, and the
   relation `service`. An API that leaves the file leaves the catalog on the
   reader's next full sweep.
3. The `fields` and `relations`, as a patch of their own.

A file it cannot use is logged by the reader and left out; the services the
repository builds still stand.

## Wiring it into an estate

Nothing in the app. The estate's forge reader must be allowed to read the
repository (its allowed accounts or organisations). To keep an app out of an
estate, keep its repository out of that estate's reader.

Check after a push to the default branch: `get_entity` on the service shows
`origin`, its logo, and its relations, and each API is listed under it.

## Not for

Open source the estate runs and services it only calls have no repository the
estate reads. They are written by a person or a catalog file, as the guide's
Landscape section says.
