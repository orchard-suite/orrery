.PHONY: check db api land test build go docker

# Lands main: release-damnit land runs the config's check (make check) on
# exactly what lands and signs its proof, which the release verifies.
land: ## land, running the check and signing its proof (from a worktree: make land BRANCH=<branch>)
	release-damnit land $(BRANCH)

check: db api ## typecheck, test, build web, vet and test Go, judge the API
	npm run check
	go vet ./... && go test ./...

# The server tests' Postgres on :5433, started when it is not running. In CI
# the workflow's Postgres service is already there.
db:
	@[ -n "$(CI)" ] || docker start orrery-pg >/dev/null 2>&1 || docker run -d --name orrery-pg -p 5433:5432 \
		-e POSTGRES_USER=orrery -e POSTGRES_PASSWORD=orrery -e POSTGRES_DB=orrery postgres:17-alpine >/dev/null
	@[ -n "$(CI)" ] || until docker exec orrery-pg pg_isready -q -U orrery; do sleep 1; done

# The API must not break a caller since its last release: Trellis judges
# openapi.json against the same file at the latest tag. It runs in a
# container with git, the checkout and its git directory mounted at their
# own paths so a worktree works too.
TRELLIS := ghcr.io/orchard-suite/trellis:6.0.0
GIT_COMMON := $(shell cd "$$(git rev-parse --git-common-dir)" && pwd)
api:
	@printf 'FROM $(TRELLIS) AS trellis\nFROM alpine/git:2.49.1\nCOPY --from=trellis /app/trellis /usr/local/bin/trellis\nENTRYPOINT ["trellis"]\n' \
		| docker build -q --platform linux/amd64 -t orrery-trellis - >/dev/null
	docker run --rm --platform linux/amd64 -e GIT_CONFIG_COUNT=1 -e GIT_CONFIG_KEY_0=safe.directory -e GIT_CONFIG_VALUE_0='*' \
		-v "$(CURDIR):$(CURDIR)" -v "$(GIT_COMMON):$(GIT_COMMON)" -w "$(CURDIR)" \
		orrery-trellis check -dir . -packs interfaces -match 'v*' -fail-on high

go: ## build the Go binaries into bin/
	go build -o bin/orrery ./cmd/orrery
	go build -o bin/pusher-k8s ./cmd/pusher-k8s
	go build -o bin/pusher-entra ./cmd/pusher-entra
	go build -o bin/runner ./cmd/runner
	go build -o bin/entra-grant ./cmd/entra-grant
	go build -o bin/azure-restart ./cmd/azure-restart
	go build -o bin/azure-job-start ./cmd/azure-job-start
	go build -o bin/telemetry-query ./cmd/telemetry-query
	go build -o bin/annals-read ./cmd/annals-read
	go build -o bin/job-starter ./cmd/job-starter

docker: ## build every image for linux/amd64
	docker build --platform linux/amd64 -t orrery .
	docker build --platform linux/amd64 -f go.Dockerfile --target pusher-k8s -t orrery-pusher-k8s .
	docker build --platform linux/amd64 -f go.Dockerfile --target pusher-entra -t orrery-pusher-entra .
	docker build --platform linux/amd64 -f go.Dockerfile --target cli -t orrery-cli .
	docker build --platform linux/amd64 -f go.Dockerfile --target runner -t orrery-runner .
	docker build --platform linux/amd64 -f go.Dockerfile --target access-runner -t orrery-access-runner .
	docker build --platform linux/amd64 -f go.Dockerfile --target azure-runner -t orrery-azure-runner .
	docker build --platform linux/amd64 -f go.Dockerfile --target telemetry-runner -t orrery-telemetry-runner .
	docker build --platform linux/amd64 -f go.Dockerfile --target job-starter -t orrery-job-starter .
