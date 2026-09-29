# syntax=docker/dockerfile:1.7
# qkt-backtester: one container = the studio (Node) + the qkt engine (JVM). Build from the repository root:
#   docker build -f docker/Dockerfile -t qkt-backtester .
# Both bases are pinned by digest, so the image built today and next month runs the same engine and Node. The studio is
# verified against this qkt; to try another one:  --build-arg QKT_IMAGE=ghcr.io/elitekaycy/qkt:<tag>
# The qkt image is published for linux/amd64 only: on an arm64 host (Apple silicon, Graviton) add --platform linux/amd64.
ARG QKT_IMAGE=ghcr.io/elitekaycy/qkt:v0.54.0@sha256:0c7e3095197b5fdeb0324ffb92457a340dbf0263d8e4474cf5088ca86df62952
ARG NODE_IMAGE=node:22-bookworm-slim@sha256:43ac6c60b8f89723f746e8a92ce91abd5017e627ce1ddfe4238355d3a30b772c

FROM ${NODE_IMAGE} AS node

FROM node AS nodebin
RUN apt-get update && apt-get install -y --no-install-recommends binutils tini && strip /usr/local/bin/node

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
 && pnpm --filter @qkt-studio/web exec vite build \
 && node -e 'const z=require("zlib"),fs=require("fs"),p=require("path");const d="packages/web/dist";for(const f of fs.readdirSync(d,{recursive:true})){if(!/\.(js|css|html|svg|json|ttf)$/.test(f))continue;const b=fs.readFileSync(p.join(d,f));fs.writeFileSync(p.join(d,f)+".br",z.brotliCompressSync(b,{params:{[z.constants.BROTLI_PARAM_QUALITY]:11}}));fs.writeFileSync(p.join(d,f)+".gz",z.gzipSync(b,{level:9}))}'
RUN pnpm --filter @qkt-studio/server deploy --prod --legacy /out/server \
 && find /out/server -name "*.map" -delete \
 && rm -f /out/server/node_modules/.modules.yaml

FROM ${QKT_IMAGE} AS runtime
ARG QKT_IMAGE
ARG STUDIO_VERSION=dev
ARG VCS_REF=unknown
LABEL org.opencontainers.image.title="qkt-backtester" \
      org.opencontainers.image.description="Browser workspace for the qkt trading engine: editor, runs, charts, journal" \
      org.opencontainers.image.source="https://github.com/elitekaycy/qkt-backtester" \
      org.opencontainers.image.version="${STUDIO_VERSION}" \
      org.opencontainers.image.revision="${VCS_REF}" \
      io.qkt.engine-image="${QKT_IMAGE}"
USER root
COPY --from=nodebin /usr/local/bin/node /usr/local/bin/node
COPY --from=nodebin /usr/bin/tini /usr/bin/tini
COPY --from=build /out/server /app/server
COPY --from=build /src/packages/web/dist /app/web
COPY tools /app/tools
COPY docker/entrypoint.sh /usr/local/bin/studio-entrypoint
RUN chmod +x /usr/local/bin/studio-entrypoint && mkdir -p /workspace /data /tmp/home && chmod 1777 /tmp/home /data

ENV NODE_ENV=production LANG=C.UTF-8 \
    HOST=0.0.0.0 PORT=8080 \
    WORKSPACE=/workspace QKT_DATA_HOME=/data WEB_ROOT=/app/web \
    QKT_BIN=/opt/qkt/bin/qkt HOME=/tmp/home STUDIO_CDS_DIR=/tmp/home/cds \
    NODE_OPTIONS=--disable-warning=ExperimentalWarning
EXPOSE 8080
VOLUME ["/workspace", "/data"]
# start period: an empty workspace on a large data store is seeded from a full scan first (minutes on ~500k files)
HEALTHCHECK --interval=30s --timeout=5s --start-period=180s CMD ["node", "-e", "fetch('http://127.0.0.1:'+(process.env.PORT||8080)+'/api/health',{headers:process.env.STUDIO_TOKEN?{authorization:'Bearer '+process.env.STUDIO_TOKEN}:{}}).then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"]
ENTRYPOINT ["tini", "--", "studio-entrypoint"]
CMD ["node", "/app/server/dist/main.js"]
