# Build do front + back e imagem mínima de runtime
FROM node:22-alpine AS builder

WORKDIR /app

# Dependências para argon2 (node-gyp)
RUN apk add --no-cache python3 make g++ openssl

COPY package.json package-lock.json* ./
RUN npm ci

COPY tsconfig.json tsconfig.server.json tsconfig.web.json vite.config.ts biome.json drizzle.config.ts ./
COPY src ./src
COPY drizzle ./drizzle

RUN npm run build:web

# ---- runtime ----
FROM node:22-alpine AS runtime

WORKDIR /app

ENV NODE_ENV=production

RUN apk add --no-cache wget ca-certificates openssl

COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/package.json ./package.json
COPY --from=builder /app/src ./src
COPY --from=builder /app/dist/web ./dist/web
COPY --from=builder /app/drizzle ./drizzle
COPY --from=builder /app/tsconfig.json ./tsconfig.json
COPY --from=builder /app/tsconfig.server.json ./tsconfig.server.json
# scripts/ — backfills e utilitários rodados via `npm run` dentro do container
COPY scripts ./scripts

EXPOSE 3010

HEALTHCHECK --interval=30s --timeout=5s --start-period=15s --retries=3 \
  CMD wget -qO- http://127.0.0.1:3010/healthz || exit 1

CMD ["npm", "run", "start:tsx"]
