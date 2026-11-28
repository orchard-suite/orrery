# The Go binaries: the k8s pusher, the Entra pusher, the generic CLI, the
# runner, the access runner (the runner carrying entra-grant), the Azure
# runner (the runner carrying azure-restart and azure-job-start), the
# telemetry runner (the runner carrying telemetry-query and annals-read), and
# the job starter.
# Build with
#   docker build -f go.Dockerfile --target pusher-k8s .
#   docker build -f go.Dockerfile --target pusher-entra .
#   docker build -f go.Dockerfile --target cli .
#   docker build -f go.Dockerfile --target runner .
#   docker build -f go.Dockerfile --target access-runner .
#   docker build -f go.Dockerfile --target azure-runner .
#   docker build -f go.Dockerfile --target telemetry-runner .
#   docker build -f go.Dockerfile --target job-starter .
# BINARIES says where the programs come from: `build` compiles them here, and
# `prebuilt` copies them from out/ in the context, compiled beforehand with
# the same flags. The release compiles beforehand, with Go's cache restored
# from the Actions cache, and passes --build-arg BINARIES=prebuilt.
ARG BINARIES=build

FROM golang:1.27-alpine AS build
ARG VERSION=dev
WORKDIR /src
COPY go.mod go.sum ./
RUN go mod download
COPY sdk ./sdk
COPY cmd ./cmd
RUN CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/pusher-k8s ./cmd/pusher-k8s \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/pusher-entra ./cmd/pusher-entra \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/orrery ./cmd/orrery \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/runner ./cmd/runner \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/entra-grant ./cmd/entra-grant \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/azure-restart ./cmd/azure-restart \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/azure-job-start ./cmd/azure-job-start \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/telemetry-query ./cmd/telemetry-query \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/annals-read ./cmd/annals-read \
 && CGO_ENABLED=0 go build -ldflags "-s -w -X main.version=${VERSION}" -o /out/job-starter ./cmd/job-starter

FROM scratch AS prebuilt
COPY out/ /out/

FROM ${BINARIES} AS binaries

# What every image below starts from: no shell, no package manager, no
# packages to patch. It holds CA certificates, time zones, and a user that is
# not root.
FROM gcr.io/distroless/static-debian13:nonroot AS base

FROM base AS pusher-k8s
COPY --from=binaries /out/pusher-k8s /pusher-k8s
ENTRYPOINT ["/pusher-k8s"]

FROM base AS pusher-entra
COPY --from=binaries /out/pusher-entra /pusher-entra
ENTRYPOINT ["/pusher-entra"]

FROM base AS cli
COPY --from=binaries /out/orrery /orrery
ENTRYPOINT ["/orrery"]

FROM base AS runner
COPY --from=binaries /out/runner /runner
ENTRYPOINT ["/runner"]

# A runner whose jobs give people access in Entra: the runner, and
# entra-grant for its commands to call.
FROM base AS access-runner
COPY --from=binaries /out/runner /runner
COPY --from=binaries /out/entra-grant /entra-grant
ENTRYPOINT ["/runner"]

# A runner whose jobs restart Azure apps and virtual machines and start Container
# Apps jobs: the runner, and azure-restart and azure-job-start for its commands
# to call.
FROM base AS azure-runner
COPY --from=binaries /out/runner /runner
COPY --from=binaries /out/azure-restart /azure-restart
COPY --from=binaries /out/azure-job-start /azure-job-start
ENTRYPOINT ["/runner"]

# A runner whose tools read logs, metrics, and the tables Annals publishes:
# the runner, and telemetry-query and annals-read for its commands to call.
# It reads Loki, Prometheus, and Annals and changes nothing.
FROM base AS telemetry-runner
COPY --from=binaries /out/runner /runner
COPY --from=binaries /out/telemetry-query /telemetry-query
COPY --from=binaries /out/annals-read /annals-read
ENTRYPOINT ["/runner"]

# The job starter: it starts one container for each run of a `job` action, on
# Kubernetes or Azure Container Apps. It holds the starter and nothing else:
# no shell, no package manager, no cloud CLI. A job never runs in this image;
# each family of jobs has its own, which the estate's templates name.
FROM base AS job-starter
COPY --from=binaries /out/job-starter /job-starter
ENTRYPOINT ["/job-starter"]
