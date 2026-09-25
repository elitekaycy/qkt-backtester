# syntax=docker/dockerfile:1.7
# qkt-backtester: one container = the studio (Node) + the qkt engine (JVM). Build from the repository root:
#   docker build -f docker/Dockerfile -t qkt-backtester .
# Pin the engine for reproducible builds:  --build-arg QKT_IMAGE=ghcr.io/elitekaycy/qkt@sha256:<digest>
ARG QKT_IMAGE=ghcr.io/elitekaycy/qkt:latest
ARG NODE_IMAGE=node:22-bookworm-slim

FROM ${NODE_IMAGE} AS node

FROM node AS build
WORKDIR /src
ARG PNPM_VERSION=12.5.1
RUN npm install -g pnpm@${PNPM_VERSION}
COPY package.json pnpm-workspace.yaml pnpm-lock.yaml tsconfig.base.json ./
COPY packages/core/package.json packages/core/
COPY packages/server/package.json packages/server/
COPY packages/web/package.json packages/web/
RUN pnpm install --frozen-lockfile
COPY packages packages
RUN pnpm --filter @qkt-studio/core build \
 && pnpm --filter @qkt-studio/server build \
 && pnpm --filter @qkt-studio/web exec vite build
RUN pnpm --filter @qkt-studio/server deploy --prod --legacy /out/server

FROM ${QKT_IMAGE} AS runtime
USER root
COPY --from=node /usr/local/bin/node /usr/local/bin/node
COPY --from=build /out/server /app/server
COPY --from=build /src/packages/web/dist /app/web
COPY tools /app/tools
COPY sample-workspace /opt/sample-workspace
COPY docker/entrypoint.sh /usr/local/bin/studio-entrypoint
RUN chmod +x /usr/local/bin/studio-entrypoint && mkdir -p /workspace /data /tmp/home && chmod 1777 /tmp/home

ENV NODE_ENV=production \
    HOST=0.0.0.0 PORT=8080 \
    WORKSPACE=/workspace QKT_DATA_HOME=/data WEB_ROOT=/app/web \
    QKT_BIN=/opt/qkt/bin/qkt HOME=/tmp/home \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8080
VOLUME ["/workspace", "/data"]
HEALTHCHECK --interval=30s --timeout=5s --start-period=15s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["studio-entrypoint"]
CMD ["node", "/app/server/dist/main.js"]
