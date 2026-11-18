# Multi-stage Dockerfile for AigisBot (compatible with Podman 4.9+ and Docker)
FROM docker.io/library/node:22-alpine AS builder

WORKDIR /app

COPY package.json package-lock.json ./
RUN npm ci

COPY tsconfig.json ./
COPY src ./src
RUN npm run build && npm prune --omit=dev

FROM docker.io/library/node:22-alpine AS runtime

RUN apk add --no-cache ca-certificates tzdata

ENV NODE_ENV=production
ENV TZ=Asia/Jakarta

WORKDIR /app

COPY --from=builder /app/package.json ./
COPY --from=builder /app/node_modules ./node_modules
COPY --from=builder /app/dist ./dist
COPY assets ./assets

RUN mkdir -p auth_info data

# Run Node directly as PID 1 so SIGTERM closes Baileys & SQLite WAL cleanly
CMD ["node", "dist/index.js"]
