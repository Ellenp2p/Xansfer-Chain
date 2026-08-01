# Frontend (React/Vite) — built static site served by nginx.
# Works standalone (no backend required): attestation status is queried
# directly from Circle Iris and history is stored in the browser.
# nginx also reverse-proxies /api and /ws to the backend container when present.
# Build context must be the repo root (chains.json lives in /config).

FROM oven/bun:1-slim AS build
WORKDIR /app

COPY frontend/package.json frontend/bun.lock ./
RUN bun install --frozen-lockfile

COPY frontend/ ./
COPY config /config
RUN bun run build

FROM nginx:1.27-alpine
COPY --from=build /app/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
