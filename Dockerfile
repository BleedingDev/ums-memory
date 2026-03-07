# syntax=docker/dockerfile:1.7

FROM oven/bun:1.3.10 AS deps
WORKDIR /app
COPY package.json ./
RUN bun install --production

FROM oven/bun:1.3.10 AS runtime-base
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 ums \
  && useradd --system --uid 10001 --gid ums --create-home --home-dir /home/ums ums

COPY --from=deps /app/node_modules ./node_modules
COPY package.json ./
COPY apps ./apps
COPY libs ./libs

RUN mkdir -p /var/lib/ums \
  && chown -R ums:ums /app /var/lib/ums

USER ums

FROM runtime-base AS api
ENV UMS_API_HOST=0.0.0.0
ENV UMS_API_PORT=8787
ENV UMS_RUNTIME_STATE_FILE=/var/lib/ums/.ums-runtime-state

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD bun -e "import http from 'node:http'; const req=http.get('http://127.0.0.1:'+(process.env.UMS_API_PORT||8787)+'/',(res)=>process.exit(res.statusCode===200?0:1)); req.on('error',()=>process.exit(1));"

CMD ["bun", "apps/api/src/server.ts"]

FROM runtime-base AS worker
ENV UMS_RUNTIME_STATE_FILE=/var/lib/ums/.ums-runtime-state
ENV UMS_WORKER_STATE_FILE=/var/lib/ums/.ums-runtime-state

CMD ["bun", "apps/ums/src/index.ts", "worker"]
