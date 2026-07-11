# Xansfer Chain — AI Assistant Guide

This file helps AI coding assistants (Claude, Kimi, etc.) understand the project quickly and follow its conventions.

## Project Type

A cross-chain USDC transfer dApp built on Circle CCTP.

- **Backend**: Rust (Axum) + SQLite + async pollers.
- **Frontend**: React 19 + Vite 8 + TypeScript + Tailwind CSS 4 + Bun.
- **Wallets**: RainbowKit/wagmi (EVM), Solana, Aptos, Sui, Stellar (Freighter).
- **Contracts**: Foundry project in `contracts/` implementing the CCTP v2 Forwarder used for relay fee collection.

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
- `relay/`: optional auto-claim worker. EVM, Solana, Stellar, Sui, and Aptos relay submitters are implemented; Starknet is wired but not yet implemented. For EVM destinations, if a `forwarder` address is configured the relay routes through the CCTP v2 Forwarder contract. The Forwarder supports percentage (basis points) or fixed fees, capped by an immutable `maxFeeAmount`, and forwards the net USDC to the user; otherwise the relay calls `receiveMessage` directly. The backend reads the expected net amount from the Forwarder's `previewForward` view before submitting.

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
- `VITE_EVM_FORWARDER_<DOMAIN>` (optional): overrides the CCTP v2 Forwarder address shown to the frontend for relay transfers to an EVM domain. Takes precedence over `forwarder` in `config/chains.json`.

Backend:

- `DATABASE_URL` (default `sqlite:xansfer.db?mode=rwc`)
- `PORT` (default `3001`)
- `CORS_ALLOWED_ORIGINS` (optional, comma-separated)
- `CHAIN_CONFIG` (default `config/chains.json`)
- `RELAY_KEY_<DOMAIN>` for EVM domains (hex private key)
- `RELAY_KEY_STELLAR` for Stellar (domain 27, secret key)
- `RELAY_KEY_5` for Solana devnet (base58-encoded keypair)
- `RELAY_KEY_8` for Sui testnet (hex private key)
- `RELAY_KEY_14` for Aptos testnet (hex private key)
- `EVM_FORWARDER_<DOMAIN>` (optional): overrides the CCTP v2 Forwarder address for an EVM destination domain.
- `RELAY_MAX_GAS_PRICE_GWEI` (optional): cap on EVM legacy gas price
- `RELAY_MAX_PRIORITY_FEE_GWEI` (optional): cap on EVM EIP-1559 priority fee
- `RELAY_TX_TIMEOUT_SECS` (default `300`): max wait for a destination receipt
- `RELAY_EVM_GAS_LIMIT` (default `200000`): fallback gas limit for EVM `receiveMessage`
- `SOLANA_MESSAGE_TRANSMITTER_V2` (optional; defaults to devnet/testnet CCTP program IDs)
- `SOLANA_TOKEN_MESSENGER_MINTER_V2` (optional; defaults to devnet/testnet CCTP program IDs)
- `APTOS_MESSAGE_TRANSMITTER` (optional; falls back to `config/chains.json`, then testnet/mainnet defaults)
- `APTOS_TOKEN_MESSENGER_MINTER` (optional; falls back to `config/chains.json`, then testnet/mainnet defaults)
- Sui object overrides (optional; sensible testnet/mainnet defaults are built in):
  - `SUI_MESSAGE_TRANSMITTER_PACKAGE`
  - `SUI_TOKEN_MESSENGER_MINTER_PACKAGE`
  - `SUI_MESSAGE_TRANSMITTER_STATE`
  - `SUI_TOKEN_MESSENGER_MINTER_STATE`
  - `SUI_USDC_TYPE_TAG`
  - `SUI_DENY_LIST`
  - `SUI_TREASURY`

## Windows Build Dependencies

Compiling the backend on Windows requires native libraries used by `solana-client` / `sui-rpc` / `openssl-sys`:

- **NASM** (required by `aws-lc-sys`): install and add to `PATH`, e.g. `C:\nasm\nasm-2.16.03`.
- **OpenSSL Dev** (required by `openssl-sys`): install OpenSSL-Win64 (the non-Light package) and point to the VC libs:
  - `OPENSSL_DIR=C:\Program Files\OpenSSL-Win64`
  - `OPENSSL_LIB_DIR=C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD`
  - `OPENSSL_INCLUDE_DIR=C:\Program Files\OpenSSL-Win64\include`
- **libsodium** (required by `soroban-client`): `SODIUM_LIB_DIR=C:\libsodium\libsodium\x64\Release\v143\dynamic`.

Example Windows test command:

```powershell
$env:PATH = "C:\nasm\nasm-2.16.03;$env:PATH"
$env:OPENSSL_DIR = "C:\Program Files\OpenSSL-Win64"
$env:OPENSSL_LIB_DIR = "C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD"
$env:OPENSSL_INCLUDE_DIR = "C:\Program Files\OpenSSL-Win64\include"
$env:SODIUM_LIB_DIR = "C:\libsodium\libsodium\x64\Release\v143\dynamic"
cargo test --manifest-path backend/Cargo.toml
```

On Linux the equivalent libraries can usually be installed via the system package manager (`libssl-dev`, `libsodium-dev`, `nasm`).

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
- Relay transfers submit real destination-chain `receiveMessage` transactions for EVM, Solana, Stellar, Sui, and Aptos when the corresponding `RELAY_KEY_*` is configured. For EVM destinations, if `EVM_FORWARDER_<DOMAIN>` (or `forwarder` in `config/chains.json`) is set, the relay calls `CctpV2Forwarder.mintAndForward`. The contract supports percentage (basis points) or fixed fees, capped by `maxFeeAmount`, and forwards the net USDC to the user's `dest_address`; otherwise it calls `receiveMessage` directly.
- Starknet relay is wired but not yet implemented and will mark the job `failed`.
- Aptos relay uses precompiled Move scripts committed under `backend/src/relay/aptos_scripts/*.mv` to atomically call `receive_message` → `handle_receive_message` → `complete_receive_message`.
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
