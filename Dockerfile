# The hub. Build the web app, then ship the server source as-is: Node 24
# runs TypeScript directly, so the server has no build step.
# WEB says where the web app comes from: `build` builds it here, and
# `prebuilt` copies dist/web from the context, built beforehand from the same
# source. The release builds it on the runner and passes
# --build-arg WEB=prebuilt.
ARG WEB=build
# The Node every stage runs, said once.
ARG NODE=24.22.3

FROM node:${NODE}-alpine AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

FROM node:${NODE}-alpine AS web-build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY vite.config.ts tsconfig.json ./
COPY src ./src
RUN npm run build

FROM scratch AS web-prebuilt
COPY dist/web /app/dist/web

FROM web-${WEB} AS web

FROM node:${NODE}-alpine
ENV NODE_ENV=production \
    PORT=8080 \
    INGEST_PORT=8081 \
    DATA_DIR=/data
WORKDIR /app
COPY --from=deps /app/node_modules ./node_modules
COPY --from=web /app/dist/web ./dist/web
COPY package.json ./
COPY src/server ./src/server
COPY src/shared ./src/shared
COPY docs/modelling.md ./docs/modelling.md
# The hub runs node, git, and nothing else. This step comes after the source
# is copied in, so a build of new source takes the system packages of its own
# day and never a cached layer's. The base's npm, corepack, and yarn go: the
# hub never calls them, and they carry packages of their own to patch.
RUN apk upgrade --no-cache && apk add --no-cache git \
 && rm -rf /usr/local/lib/node_modules /opt/yarn-* \
      /usr/local/bin/npm /usr/local/bin/npx /usr/local/bin/corepack \
      /usr/local/bin/yarn /usr/local/bin/yarnpkg
# The tests and the data only they load are not part of the hub.
RUN find src -name '*.test.ts' -delete && rm -rf src/server/fixtures \
 && mkdir -p /data && chown node:node /data
USER node
VOLUME /data
EXPOSE 8080 8081
HEALTHCHECK --interval=30s --timeout=3s CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "--no-warnings=ExperimentalWarning", "src/server/main.ts"]
