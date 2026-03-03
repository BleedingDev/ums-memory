# syntax=docker/dockerfile:1.7

FROM node:22-bookworm-slim AS deps
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev && npm cache clean --force

FROM node:22-bookworm-slim AS runtime-base
ENV NODE_ENV=production
WORKDIR /app

RUN groupadd --system --gid 10001 ums \
  && useradd --system --uid 10001 --gid ums --create-home --home-dir /home/ums ums

COPY --from=deps /app/node_modules ./node_modules
COPY package.json package-lock.json ./
COPY apps ./apps
COPY libs ./libs

RUN mkdir -p /var/lib/ums \
  && chown -R ums:ums /app /var/lib/ums

USER ums

FROM runtime-base AS api
ENV UMS_API_HOST=0.0.0.0
ENV UMS_API_PORT=8787
ENV UMS_STATE_FILE=/var/lib/ums/.ums-state.json

EXPOSE 8787

HEALTHCHECK --interval=30s --timeout=5s --start-period=10s --retries=3 \
  CMD node -e "const http=require('node:http');const req=http.get('http://127.0.0.1:'+(process.env.UMS_API_PORT||8787)+'/',(res)=>process.exit(res.statusCode===200?0:1));req.on('error',()=>process.exit(1));"

CMD ["node", "--import", "tsx", "apps/api/src/server.ts"]

FROM runtime-base AS worker
ENV UMS_STATE_FILE=/var/lib/ums/.ums-state.json
ENV UMS_WORKER_STATE_FILE=/var/lib/ums/.ums-state.json

CMD ["node", "--import", "tsx", "apps/ums/src/index.ts", "worker"]
