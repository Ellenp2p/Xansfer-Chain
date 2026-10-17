# Xansfer Chain

基于 [Circle CCTP](https://www.circle.com/cross-chain-transfer-protocol) 的跨链 USDC 转账工具。用户在源链 burn USDC，等待 Circle attestation 后，在目标链 claim / mint。

- 线上地址：https://ellenp2p.github.io/Xansfer-Chain/
- 前端可独立运行：没有后端时直接查询 Circle Iris API，并用 `localStorage` 保存交易记录。

## 功能

- **多链支持**：EVM（wagmi / viem）、Solana、Sui、Aptos、Stellar；内置 mainnet 28 条链、testnet 16 条链。
- **CCTP v1 / v2**：按链配置自动选择版本，并阻止跨版本 claim。
- **完整流程**：源链 burn → attestation 轮询 → 目标链 claim / mint，支持钱包手动 claim。
- **交易追踪**：`#/tx/:hash` 状态页、历史记录、按交易哈希查询。
- **到达时间估算**：按链和 CCTP 版本给出预计等待时间；标准 attestation 已经很快的链不再提供 Fast 选项。
- **可选后端**：Rust 后端提供 SQLite 持久化、WebSocket 推送和 attestation poller；不可用时前端自动降级。
- **多网络**：右上角切换 mainnet / testnet，默认 testnet。

## 技术栈

| 部分 | 技术 |
| --- | --- |
| 前端 | React 19、Vite 8、TypeScript、Tailwind CSS 4、zustand、TanStack Query |
| 钱包 | wagmi / viem、Solana Wallet Adapter、Aptos Wallet Adapter、`@mysten/dapp-kit`、Freighter |
| 后端（可选） | Rust、Axum、Tokio、SQLx + SQLite |
| 部署 | GitHub Actions → GitHub Pages |

## 目录结构

```
Xansfer-Chain/
├── frontend/                    # React 单页应用
│   └── src/
│       ├── components/          # Header、TransferForm、TransactionStatus、Footer...
│       ├── pages/               # Transfer、Status、History、Lookup
│       ├── hooks/
│       │   ├── cctp/            # 各链 adapter：evm / solana / sui / aptos / stellar
│       │   ├── useCctpTransfer.ts
│       │   └── useAttestationStatus.ts
│       ├── config/              # chains、wagmi、CCTP ABI、图标
│       ├── lib/                 # api、iris、fees、estimate、address、localTx
│       └── stores/              # zustand：networkMode、transferStore
├── backend/                     # 可选 Rust API + attestation poller + relay worker
│   ├── migrations/
│   └── src/{api,attestation,chains,config,db,relay}/
├── config/
│   ├── chains.json              # 链配置唯一来源（前后端共用）
│   ├── chains.example.json
│   └── chains.schema.json
├── packages/wallet-connect/     # 统一钱包连接包
└── .github/workflows/deploy.yml # master 自动部署到 GitHub Pages
```

## 本地开发

前置要求：

- [Bun](https://bun.sh/)（前端与 workspace）
- [Rust](https://www.rust-lang.org/)（仅后端需要）

```bash
# 安装依赖
bun install

# 启动前端（http://localhost:5173）
bun run dev
```

前端开发服务器会把 `/api` 和 `/ws` 代理到 `http://localhost:3001`。

### 启动后端（可选）

```bash
cargo run --manifest-path backend/Cargo.toml
```

常用环境变量（完整示例见 `.env.example`）：

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `DATABASE_URL` | `sqlite:xansfer.db?mode=rwc` | SQLite 路径 |
| `PORT` | `3001` | HTTP 端口 |
| `ALLOWED_ORIGINS` | 空 | 跨域白名单，逗号分隔 |
| `CHAIN_CONFIG` | `config/chains.json` | 链配置路径 |
| `RELAY_ENABLED` | `false` | 是否启用自动 claim worker（见下方限制） |

### 构建

```bash
# 本地构建
bun run build

# GitHub Pages 子路径构建
VITE_BASE=/Xansfer-Chain/ bun run build
```

可选的构建期变量：`VITE_SOLANA_RPC`（自定义 Solana RPC）。

## 链配置

`config/chains.json` 是唯一配置源：

- 前端在构建时通过 `import` 内嵌，因此纯静态部署也能拿到完整链信息。
- 后端通过 `CHAIN_CONFIG` 读取同一份文件。
- 新增链时同时补上 `domain`、`chain_id`、`rpc_url`、`usdc_address`、`cctp_versions`、`chain_type`，以及 `supports_fast_transfer` / `supports_forwarding`。
- CCTP v1 / v2 合约地址位于同一文件的 `modes.<mode>.cctp` 下。

## 部署

推送到 `master` 会触发 `.github/workflows/deploy.yml`：

1. `bun install --frozen-lockfile`
2. 构建 `packages/wallet-connect`
3. 以 `VITE_BASE=/Xansfer-Chain/` 构建前端
4. 上传 `frontend/dist` 并部署到 GitHub Pages

## 当前限制

- **自动 claim / 转发服务尚未启用**。仓库里的 relay worker 仍是模拟实现，默认 `RELAY_ENABLED=false`；用户需要自己在目标链 claim。前端也刻意隐藏了 Forward 转账类型，避免误导。
- **Fast Transfer 仅在真实更快的链上提供**。Aptos、Avalanche、Polygon 等标准 attestation 已经接近 fast，因此不再提供 Fast 选项，避免多付费用。
- 前端使用 `HashRouter`（配合 GitHub Pages），深链接形如 `/#/tx/0x...`。

## 开发约定

- 金额一律使用整数单位 + `BigInt` / `parseUsdcUnits`，不要用 `Number` 处理 32 字节金额。
- 链相关逻辑优先走 `config/chains.ts` 的解析函数，不要在组件里硬编码 domain / 合约地址。
- CCTP v1 与 v2 的消息格式不同，改动 claim 逻辑时注意保持版本隔离。
- 修改 `config/chains.json` 后，前端与后端都应以它为准，不要另建副本。
