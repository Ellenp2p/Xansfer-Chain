# Xansfer Chain — AI Assistant Guide

This file helps AI coding assistants (Claude, Kimi, etc.) understand the project quickly and follow its conventions.

## Project Type

A cross-chain USDC transfer dApp built on Circle CCTP.

- **Backend**: Rust (Axum) + SQLite + async pollers.
- **Frontend**: React 19 + Vite 8 + TypeScript + Tailwind CSS 4 + Bun.
- **Wallets**: RainbowKit/wagmi (EVM), Solana, Aptos, Sui, Stellar (Freighter).

## Quick Commands

```bash
# Backend
cd backend
cargo check
cargo run

# Frontend
cd frontend
bun install
bun run dev
bun run build

# Build pointing at a deployed backend
VITE_BACKEND_URL=https://api.xansfer.example.com bun run build
```

## Architecture

### Backend (`backend/`)

- `main.rs`: bootstraps DB, attestation poller, relay worker, Axum router.
- `api/transfer.rs`: core REST handlers for chains, transactions, lookup.
- `api/ws.rs`: WebSocket endpoint broadcasting transaction status updates.
- `attestation/poller.rs`: polls Circle Iris API; checks `isMessageReceived` on destination chain.
- `chains/registry.rs`: loads `config/chains.json` and provides chain/domain/CCTP metadata.
- `db/`: SQLite schema init + migration column backfill + models.
- `relay/`: optional auto-claim worker. EVM relay is implemented with raw JSON-RPC signing; Solana, Stellar, Sui, Aptos, and Starknet are wired through the worker but currently return "not yet implemented" until their chain-specific transaction builders are added.

### Frontend (`frontend/`)

- `main.tsx`: nested wallet providers + `BrowserRouter` + network mode remount.
- `App.tsx`: routes (`/`, `/tx/:id`, `/history`, `/lookup`).
- `components/`: UI components.
- `pages/`: route-level pages.
- `hooks/cctp/`: per-chain adapters (`evm.ts`, `aptos.ts`, `stellar.ts`, `types.ts`).
- `config/backend.ts`: **single source of truth** for backend URL/API base/WebSocket URL via `VITE_BACKEND_URL`.
- `lib/api.ts`: thin fetch wrapper using `API_BASE`.
- `lib/ws.ts`: WebSocket client using `getWsUrl()`.
- `stores/`: zustand stores (persisted `networkMode`, ephemeral `backendStore`, etc.).

## Critical Conventions

### Backend

- Use `tracing` for logs; prefer structured fields (`tracing::info!(tx_hash = %hash, "...")`).
- DB uses `sqlx::query_as` with `FromRow` models in `db/models.rs`.
- Migration strategy: `migrations/001_init.sql` creates tables; `db/mod.rs` uses `PRAGMA table_info` to add missing columns for backward compatibility.
- CORS: default is fully permissive (`CorsLayer::permissive()`). To restrict, set `CORS_ALLOWED_ORIGINS=https://a.com,https://b.com`.
- Axum route params use `{name}` syntax (Axum 0.8), **not** `:name`.
- Keep panic hook in `main.rs` so panics are logged via `tracing` instead of stderr.

### Frontend

- All backend URL logic must go through `config/backend.ts` (`API_BASE`, `getWsUrl()`). Do not hardcode `/api` or `localhost:3001` elsewhere.
- Wallet error handling: `useCctpTransfer.ts` has a `formatWalletError()` helper that recognizes user-rejection patterns. When adding new wallet flows, reuse it.
- Status machine: `TransferStep` in `useCctpTransfer.ts`. Never set `complete` unless a real transaction hash was returned.
- EVM switching: changing `networkMode` remounts the entire `WagmiProvider`; do not fight this with local state.
- Backend connectivity: `useBackendPoller.ts` polls `/api/chains`; `backendStore` holds `online` state; `Header.tsx` shows red badge when offline.

## Environment Variables

Frontend (Vite, must start with `VITE_`):

- `VITE_BACKEND_URL`: deployed backend root, e.g. `https://api.xansfer.example.com`.
- `VITE_SOLANA_RPC`: Solana RPC endpoint; falls back to chain config RPC.

Backend:

- `DATABASE_URL` (default `sqlite:xansfer.db?mode=rwc`)
- `PORT` (default `3001`)
- `CORS_ALLOWED_ORIGINS` (optional, comma-separated)
- `CHAIN_CONFIG` (default `config/chains.json`)
- `RELAY_KEY_<DOMAIN>` for EVM domains (hex private key)
- `RELAY_KEY_STELLAR` for Stellar (domain 27)
- `RELAY_KEY_5` for Solana devnet (base58 keypair)
- `RELAY_KEY_8` for Sui testnet (hex private key)
- `RELAY_KEY_14` for Aptos testnet (hex private key)
- `RELAY_MAX_GAS_PRICE_GWEI` (optional): cap on EVM legacy gas price
- `RELAY_MAX_PRIORITY_FEE_GWEI` (optional): cap on EVM EIP-1559 priority fee
- `RELAY_TX_TIMEOUT_SECS` (default `300`): max wait for a destination receipt
- `RELAY_EVM_GAS_LIMIT` (default `200000`): fallback gas limit for EVM `receiveMessage`
- `SOLANA_MESSAGE_TRANSMITTER_V2` (optional, default devnet)
- `SOLANA_TOKEN_MESSENGER_MINTER_V2` (optional, default devnet)
- `APTOS_MESSAGE_TRANSMITTER` (optional, default testnet)
- `APTOS_TOKEN_MESSENGER_MINTER` (optional, default testnet)
- `SUI_MESSAGE_TRANSMITTER_PACKAGE`, `SUI_TOKEN_MESSENGER_MINTER_PACKAGE`, `SUI_MESSAGE_TRANSMITTER_STATE`, `SUI_TOKEN_MESSENGER_MINTER_STATE` (required for Sui)

## Common Tasks

### Adding a New Chain

1. Add chain entry to `config/chains.json` under `modes.mainnet` or `modes.testnet`.
2. Add CCTP contracts / attestation API to the same mode's `cctp` section.
3. If the chain type is new, add an adapter in `frontend/src/hooks/cctp/` and wire it into `useCctpTransfer.ts`.
4. Add chain type-specific config in `frontend/src/config/chains.ts` if needed.

### Adding an API Endpoint

1. Add handler in `backend/src/api/transfer.rs` (or new module).
2. Register route in `backend/src/main.rs` using `{param}` syntax.
3. Add frontend fetch helper in `frontend/src/lib/api.ts`.
4. Update TS types in `frontend/src/types/index.ts` if response shape changes.

### Changing the Database Schema

1. Update `backend/migrations/001_init.sql` for new installs.
2. Add a new column entry in `backend/src/db/mod.rs` `desired_cols` so existing databases get backfilled.
3. Update `backend/src/db/models.rs` `Transaction`/`RelayJob` structs.

### Deploying Frontend from CI

- Set `VITE_BACKEND_URL` as a repository variable (not secret) under Settings → Secrets and variables → Actions → Variables.
- Push to the default branch triggers `.github/workflows/frontend.yml` and deploys to GitHub Pages.

## Known Gotchas

- `CorsLayer::permissive()` does **not** allow credentials (cookies). The backend does not use session cookies, so this is fine.
- The attestation poller short-circuits already-attested non-forward transactions to avoid redundant Circle API calls.
- `useCctpTransfer.ts` reports claim to backend via `/api/transactions/:hash/claim` but swallows errors with `.catch(() => {})`; this is intentional to not block UI.
- Stellar source uses Soroban RPC + USDC SAC allowance + `deposit_for_burn` with 7-decimal subunits.
- Stellar destination: EVM → Stellar uses `depositForBurnWithHook` + CCTP Forwarder contract; claims call `CctpForwarder.mint_and_forward`.
- Stellar uses SAC (`usdc_sac`) as the burn token, while EVM uses `usdc_address`.
- Relay transfers on EVM now submit a real `receiveMessage` transaction when `RELAY_KEY_<DOMAIN>` is configured. Non-EVM relay destinations are routed to chain-specific submitters but currently return a clear "not yet implemented" error and mark the relay job `failed`.
- `config/chains.json` is embedded at compile time as a fallback, but runtime `CHAIN_CONFIG` takes precedence.

## Files to Read for Context

When asked to modify a feature, read these in order:

1. `backend/src/main.rs` — entry + routes
2. `backend/src/api/transfer.rs` — HTTP handlers
3. `backend/src/attestation/poller.rs` — Circle polling logic
4. `backend/src/db/models.rs` + `backend/migrations/001_init.sql` — data model
5. `frontend/src/config/backend.ts` — backend URL resolution
6. `frontend/src/lib/api.ts` + `frontend/src/lib/ws.ts` — client communication
7. `frontend/src/hooks/useCctpTransfer.ts` — transfer state machine
8. `frontend/src/types/index.ts` — shared types

## Package Manager

Frontend uses **Bun**. Do not introduce `package-lock.json`; keep `bun.lock` as the lockfile. Backend uses Cargo.
