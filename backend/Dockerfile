# Backend (Rust/axum + SQLite) — serves the API + WebSocket.
# Requires config/chains.json (build context must be the repo root).

FROM rust:1-slim AS builder
WORKDIR /build

RUN apt-get update && apt-get install -y --no-install-recommends pkg-config libssl-dev && rm -rf /var/lib/apt/lists/*

COPY backend/Cargo.toml backend/Cargo.lock ./
# Cache dependency compilation
RUN mkdir -p src && echo 'fn main() {}' > src/main.rs && cargo build --release || true

COPY backend/src ./src
RUN cargo build --release

FROM debian:bookworm-slim
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates && rm -rf /var/lib/apt/lists/*

WORKDIR /app
COPY --from=builder /build/target/release/xansfer-chain-backend /app/xansfer-chain-backend
COPY config /app/config

ENV CHAIN_CONFIG=/app/config/chains.json
EXPOSE 3001
CMD ["/app/xansfer-chain-backend"]
