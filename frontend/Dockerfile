# Frontend (React/Vite) — built static site served by nginx.
# Works standalone (no backend required): attestation status is queried
# directly from Circle Iris and history is stored in the browser.
# nginx also reverse-proxies /api and /ws to the backend container when present.
# Build context must be the repo root (workspace + chains.json in /config).

FROM oven/bun:1-slim AS build
WORKDIR /repo

COPY package.json bun.lock ./
RUN bun install --frozen-lockfile

COPY packages packages
COPY frontend frontend
COPY config /config

RUN cd packages/wallet-connect && bun run build

WORKDIR /repo/frontend
RUN bun run build

FROM nginx:1.27-alpine
COPY --from=build /repo/frontend/dist /usr/share/nginx/html
COPY frontend/nginx.conf /etc/nginx/conf.d/default.conf
EXPOSE 80
