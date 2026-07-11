# Xansfer Chain

跨链 USDC 传输工具，基于 Circle CCTP（Cross-Chain Transfer Protocol）。用户可以在一条链上 burn USDC，通过 Circle 的 attestation 服务在另一条链上 claim/mint。

本项目额外包含一个 **CCTP v2 Forwarder** 合约（`contracts/`），用于 relay 模式：USDC 先 mint 到 Forwarder，合约扣除手续费后再转发给用户。

## 架构概览

```
┌─────────────────────────────────────────────────────────────────┐
│                         Frontend (React)                        │
│  React + Vite + TypeScript + Tailwind CSS + RainbowKit/wagmi    │
│  Solana / Aptos / Sui / Stellar wallet adapters                 │
└───────────────────────────┬─────────────────────────────────────┘
│  HTTP / WebSocket (VITE_BACKEND_URL)
▼
┌─────────────────────────────────────────────────────────────────┐
│                     Backend (Rust + Axum)                       │
│  REST API + WebSocket + SQLite + attestation poller + relay     │
└───────────────────────────┬─────────────────────────────────────┘
│  HTTPS
▼
┌─────────────────────────────────────────────────────────────────┐
│              Circle Iris API (attestation service)              │
│              Destination chain RPC (isMessageReceived)          │
└─────────────────────────────────────────────────────────────────┘
```

- **frontend/**：React 单页应用，负责钱包连接、构造并签名源链 burn 交易、展示状态、在目标链 claim。
- **backend/**：Rust 服务，管理链配置与交易记录，轮询 Circle attestation，提供 WebSocket 状态推送，可选 relay worker 代为在 EVM / Solana / Stellar / Sui / Aptos 上自动 claim。
- **config/**：链配置（RPC、CCTP 合约地址、domain ID、可选 Forwarder 地址等），支持 mainnet / testnet。
- **contracts/**：Foundry 项目，实现 `CctpV2Forwarder.sol` 等非升级合约，用于 relay 手续费收取。

## 核心流程

1. 用户在源链发起 burn（EVM/Aptos 调用 `depositForBurn`，Stellar 调用 `deposit_for_burn`）。
2. 前端将交易哈希注册到后端，`/api/transactions`。
3. 后端 poller 每 10 秒查询 Circle Iris API，获取 attestation 与 message。
4. 状态变为 `attested` 后，用户在目标链调用 `receiveMessage` 完成 claim；或交给 relay worker 自动执行。EVM relay 若配置了 Forwarder 地址，会走 `mintAndForward` 路径，由合约扣除手续费后再将 USDC 转发给用户。合约支持百分比（basis points）或固定额两种收费模式，并通过 `maxFeeAmount` 设置单笔上限。
5. 前端 `/tx/:hash` 页面展示实时状态，支持手动 claim。

## 技术栈

### 后端

- [Rust](https://www.rust-lang.org/) + [Axum](https://github.com/tokio-rs/axum)
- [Tokio](https://tokio.rs/) 异步运行时
- [SQLx](https://github.com/launchbadge/sqlx) + SQLite
- [reqwest](https://github.com/seanmonstar/reqwest) 调用 Circle API / 链 RPC
- [tiny-keccak](https://crates.io/crates/tiny-keccak) 计算 Solidity selector
- [tower-http](https://github.com/tower-rs/tower-http) CORS / WebSocket
- [tracing](https://github.com/tokio-rs/tracing) 日志

### 前端

- [React 19](https://react.dev/) + [Vite 8](https://vitejs.dev/) + [TypeScript](https://www.typescriptlang.org/)
- [Tailwind CSS 4](https://tailwindcss.com/)
- [wagmi](https://wagmi.sh/) + [RainbowKit](https://www.rainbowkit.com/)（EVM 钱包）
- [@solana/wallet-adapter](https://github.com/anza-xyz/wallet-adapter)
- [@aptos-labs/wallet-adapter-react](https://github.com/aptos-labs/aptos-wallet-adapter)
- [@mysten/dapp-kit](https://github.com/MystenLabs/sui/tree/main/sdk/dapp-kit)（Sui）
- [@stellar/stellar-sdk](https://github.com/stellar/js-stellar-sdk) + Freighter
- [zustand](https://github.com/pmndrs/zustand) 状态管理
- [@tanstack/react-query](https://tanstack.com/query/latest)

## 项目结构

```
.
├── backend/
│   ├── Cargo.toml
│   ├── migrations/001_init.sql        # SQLite 初始 schema + 索引
│   └── src/
│       ├── main.rs                     # 启动：数据库、poller、relay worker、HTTP/WebSocket 服务
│       ├── api/                        # HTTP 路由与 handler
│       │   ├── transfer.rs             # /api/chains, /api/transactions, /api/lookup 等
│       │   ├── relay_handler.rs        # /api/relay/claim
│       │   └── ws.rs                   # /ws WebSocket handler
│       ├── attestation/
│       │   └── poller.rs               # Circle Iris 轮询 + 链上 isMessageReceived 检查
│       ├── chains/
│       │   └── registry.rs             # 链配置注册表（mainnet/testnet）
│       ├── config/
│       │   └── loader.rs               # config/chains.json 加载与解析
│       ├── db/
│       │   ├── mod.rs                  # 数据库初始化与迁移列补齐
│       │   └── models.rs               # Transaction / RelayJob 数据模型
│       └── relay/
│           ├── worker.rs               # 自动 claim 的 relay worker（支持 EVM / Solana / Stellar / Sui / Aptos；Starknet 待实现）
│           └── signer.rs               # relay 签名者配置（EVM 私钥 / Stellar）
├── config/
│   ├── chains.json                     # 运行时链配置（默认提交在仓库中）
│   ├── chains.example.json             # 配置示例
│   └── chains.schema.json              # JSON Schema
├── contracts/                          # Foundry 合约项目
│   ├── src/
│   │   └── CctpV2Forwarder.sol         # CCTP v2 Forwarder：接收 USDC 并扣除手续费后转发
│   └── test/
│       └── CctpV2Forwarder.t.sol       # 单元 / fuzz / invariant 测试
├── frontend/
│   ├── package.json
│   ├── vite.config.ts
│   ├── .env.example
│   └── src/
│       ├── App.tsx                     # 路由
│       ├── main.tsx                    # Provider 嵌套入口
│       ├── components/                 # Header, TransferForm, TransactionStatus 等
│       ├── pages/                      # Transfer / Status / History / Lookup
│       ├── hooks/                      # useCctpTransfer, useBackendPoller, useAttestationStatus
│       │   └── cctp/                   # 各链 adapter：evm, aptos, stellar, types
│       ├── providers/                  # 各链 wallet provider
│       ├── stores/                     # zustand：networkMode, walletStore, backendStore, ...
│       ├── config/                     # wagmi, chains, backend URL, CCTP ABI
│       ├── lib/                        # api.ts, ws.ts
│       └── types/index.ts              # 共享 TS 类型
└── .github/workflows/frontend.yml      # 前端构建 + GitHub Pages 部署 CI
```

## 本地开发

### 环境要求

- [Bun](https://bun.sh/)（前端包管理器，版本见 `frontend/packageManager`）
- [Rust](https://rustup.rs/) + Cargo

### 1. 启动后端

```bash
cd backend
cargo run
```

默认监听 `0.0.0.0:3001`，SQLite 数据库 `xansfer.db`。

常用环境变量：

| 变量 | 说明 | 默认值 |
|---|---|---|
| `DATABASE_URL` | SQLite 连接串 | `sqlite:xansfer.db?mode=rwc` |
| `PORT` | 服务端口 | `3001` |
| `CORS_ALLOWED_ORIGINS` | 允许的 CORS origin，逗号分隔；不设置则完全开放 | 无（完全开放） |
| `CHAIN_CONFIG` | 链配置文件路径 | `config/chains.json` |
| `RELAY_KEY_<DOMAIN>` | EVM relay 私钥（按 domain） | 无 |
| `RELAY_KEY_STELLAR` | Stellar relay secret key（domain 27） | 无 |
| `RELAY_KEY_5` | Solana devnet relay keypair（base58） | 无 |
| `RELAY_KEY_8` | Sui testnet relay key（hex） | 无 |
| `RELAY_KEY_14` | Aptos testnet relay key（hex） | 无 |
| `EVM_FORWARDER_<DOMAIN>` | 覆盖指定 domain 的 CCTP v2 Forwarder 地址 | 无 |
| `RELAY_MAX_GAS_PRICE_GWEI` | EVM legacy gas price 上限 | 无 |
| `RELAY_MAX_PRIORITY_FEE_GWEI` | EVM EIP-1559 priority fee 上限 | 无 |
| `RELAY_TX_TIMEOUT_SECS` | 等待目标链回执的最长时间 | `300` |
| `RELAY_EVM_GAS_LIMIT` | EVM `receiveMessage` fallback gas limit | `200000` |
| `SOLANA_MESSAGE_TRANSMITTER_V2` | Solana MessageTransmitterV2 program ID | devnet/testnet 默认 |
| `SOLANA_TOKEN_MESSENGER_MINTER_V2` | Solana TokenMessengerMinterV2 program ID | devnet/testnet 默认 |
| `APTOS_MESSAGE_TRANSMITTER` | Aptos MessageTransmitter 地址 | 链配置 / testnet / mainnet 默认 |
| `APTOS_TOKEN_MESSENGER_MINTER` | Aptos TokenMessengerMinter 地址 | 链配置 / testnet / mainnet 默认 |
| `SUI_MESSAGE_TRANSMITTER_PACKAGE` 等 | Sui 共享对象地址覆盖 | testnet/mainnet 默认 |
| `RUST_LOG` | 日志级别 | `xansfer=debug` |

链配置默认读取项目根目录 `config/chains.json`。若该文件不存在，会回退到编译时嵌入的默认配置（仅包含少量链）并输出警告。也可通过环境变量 `CHAIN_CONFIG` 指定其他路径。

### 2. 启动前端

```bash
cd frontend
bun install
bun run dev
```

开发模式下前端默认通过 Vite proxy 访问 `http://localhost:3001`。

### 3. 构建前端（指定后端域名）

```bash
cd frontend
VITE_BACKEND_URL=https://api.xansfer.example.com bun run build
```

产物在 `frontend/dist`，可直接部署到任意静态托管。

## 环境变量

### 前端

| `VITE_BACKEND_URL` | 后端 API 根地址，如 `https://api.xansfer.example.com`；为空时使用 Vite dev proxy |
| `VITE_SOLANA_RPC` | Solana RPC 端点（devnet/mainnet），未设置时使用链配置里的 RPC |
| `VITE_EVM_FORWARDER_<DOMAIN>` | 覆盖指定 EVM domain 的 CCTP v2 Forwarder 地址；优先级高于 `config/chains.json` |

### 后端

| 变量 | 说明 |
|---|---|
| `DATABASE_URL` | SQLite 数据库连接串 |
| `PORT` | HTTP 服务端口 |
| `CORS_ALLOWED_ORIGINS` | 逗号分隔的允许 origin；不设置则任意 origin 均可访问 |
| `CHAIN_CONFIG` | 链配置文件路径 |
| `SEPOLIA_RPC_URL` / `ALCHEMY_KEY` | 可在 `config/chains.json` 的 `rpc_url` 模板中引用 |
| `RELAY_KEY_<DOMAIN>` | 按 domain 的 EVM relay 私钥 |
| `RELAY_KEY_STELLAR` | Stellar relay secret key（domain 27） |
| `RELAY_KEY_5` | Solana devnet relay keypair（base58） |
| `RELAY_KEY_8` | Sui testnet relay key（hex） |
| `RELAY_KEY_14` | Aptos testnet relay key（hex） |
| `EVM_FORWARDER_<DOMAIN>` | 覆盖指定 domain 的 CCTP v2 Forwarder 地址 |
| `SOLANA_MESSAGE_TRANSMITTER_V2` / `SOLANA_TOKEN_MESSENGER_MINTER_V2` | Solana CCTP program ID 覆盖 |
| `APTOS_MESSAGE_TRANSMITTER` / `APTOS_TOKEN_MESSENGER_MINTER` | Aptos CCTP 合约地址覆盖 |
| `SUI_MESSAGE_TRANSMITTER_PACKAGE` 等 | Sui 共享对象地址覆盖 |

## CI / 部署

### GitHub Pages 部署前端

仓库已配置 `.github/workflows/frontend.yml`：

- 推送到默认分支时自动构建并部署到 GitHub Pages。
- 在仓库 Settings → Secrets and variables → Actions → **Variables** 中添加 `VITE_BACKEND_URL`。
- 也支持 `workflow_dispatch` 手动触发并临时输入后端 URL。

### 后端部署

后端是独立 Rust 二进制，可部署到任意支持常驻进程的服务器/容器：

```bash
cd backend
cargo build --release
# 运行
PORT=3001 DATABASE_URL=sqlite:xansfer.db?mode=rwc ./target/release/xansfer-chain-backend
```

#### Forwarder 合约部署

`contracts/script/Deploy.s.sol` 用于部署 `CctpV2Forwarder`。部署前设置环境变量：

| 变量 | 说明 |
|---|---|
| `USDC_ADDRESS` | 该链 USDC 合约地址 |
| `MESSAGE_TRANSMITTER_ADDRESS` | CCTP v2 MessageTransmitter 地址 |
| `FEE_RECIPIENT` | 手续费收款地址 |
| `FEE_MODE` | `0` = 百分比（basis points），`1` = 固定额 |
| `FEE_VALUE` | 百分比模式下为基点（如 `50` = 0.5%），固定额模式下为 raw USDC 数量 |
| `MAX_FEE_BPS` | 百分比模式最高可设基点（如 `500` = 5%） |
| `MAX_FEE_AMOUNT` | 单笔手续费绝对上限（raw USDC，如 `100e6`），两种模式都生效 |
| `OWNER` | 合约 owner（建议多签/ timelock） |
| `OPERATOR` | relay 热钱包地址 |

示例（测试网 Base Sepolia，百分比 0.5%，上限 100 USDC）：

```bash
cd contracts
USDC_ADDRESS=0x036CbD53842c5426634e7929541eC2318f3dCF7e \
MESSAGE_TRANSMITTER_ADDRESS=0xE737e5cEBEEBa77EFE34D4aa090756590b1CE275 \
FEE_RECIPIENT=0x... \
FEE_MODE=0 \
FEE_VALUE=50 \
MAX_FEE_BPS=500 \
MAX_FEE_AMOUNT=100000000 \
OWNER=0x... \
OPERATOR=0x... \
forge script script/Deploy.s.sol --rpc-url $BASE_SEPOLIA_RPC --broadcast
```

部署后可通过 `setFeeMode(mode, value)` 切换收费模式，但 `feeValue` 始终受 `maxFeeBps` / `maxFeeAmount` 限制。

#### Windows 本地编译依赖

在 Windows 上完整编译后端需要以下原生库（Solana/Sui/Stellar SDK 依赖）：

- **NASM**：`aws-lc-sys` 需要。安装后把目录加入 `PATH`，例如 `C:\nasm\nasm-2.16.03`。
- **OpenSSL-Win64**：`openssl-sys` 需要。建议指向 VC 动态库目录：
  - `OPENSSL_DIR=C:\Program Files\OpenSSL-Win64`
  - `OPENSSL_LIB_DIR=C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD`
  - `OPENSSL_INCLUDE_DIR=C:\Program Files\OpenSSL-Win64\include`
- **libsodium**：`soroban-client` 需要。
  - `SODIUM_LIB_DIR=C:\libsodium\libsodium\x64\Release\v143\dynamic`

PowerShell 示例：

```powershell
$env:PATH = "C:\nasm\nasm-2.16.03;$env:PATH"
$env:OPENSSL_DIR = "C:\Program Files\OpenSSL-Win64"
$env:OPENSSL_LIB_DIR = "C:\Program Files\OpenSSL-Win64\lib\VC\x64\MD"
$env:OPENSSL_INCLUDE_DIR = "C:\Program Files\OpenSSL-Win64\include"
$env:SODIUM_LIB_DIR = "C:\libsodium\libsodium\x64\Release\v143\dynamic"
cargo build --release --manifest-path backend/Cargo.toml
```

#### Linux 编译

Linux 上通常只需安装系统开发包即可：

```bash
# Debian / Ubuntu
sudo apt-get install -y libssl-dev libsodium-dev nasm

# 然后直接编译
cargo build --release --manifest-path backend/Cargo.toml
```

注意：

- 生产环境请设置 `CORS_ALLOWED_ORIGINS` 或使用反向代理限制来源，除非确实需要完全开放。
- 如果前端部署在 GitHub Pages 等独立域名，必须设置 `VITE_BACKEND_URL` 指向该后端地址。

## API 简要说明

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/chains` | 列出所有链配置 |
| GET | `/api/transfer-types/{source}/{dest}` | 查询两链支持的 transfer type |
| POST | `/api/transactions` | 创建/注册交易 |
| GET | `/api/transactions/{hash}` | 获取交易详情 |
| GET | `/api/transactions/{hash}/status` | 获取交易状态（会按需查询 Circle） |
| POST | `/api/transactions/{hash}/claim` | 前端报告 claim 完成 |
| GET | `/api/transactions/address?address=...` | 按源地址查历史交易 |
| GET | `/api/lookup?source_tx_hash=...&source_domain=...` | 通过 Circle 反向查询交易 |
| POST | `/api/relay/claim` | relay 服务 claim 回调 |
| GET | `/ws` | WebSocket，接收交易状态变更通知 |

## 状态流转

```
pending → attested → complete
pending → complete        # Circle forward 已完成（fast/forward 类型）
pending → attested → minting → complete
```

- `pending`：已注册，等待 Circle attestation。
- `attested`：attestation 已拿到，可以 claim。
- `complete`：目标链已 claim 或 Circle forward 完成。

## 配置链信息

参考 `config/chains.example.json` 编辑 `config/chains.json`：

```json
{
  "version": 1,
  "modes": {
    "testnet": {
      "chains": [...],
      "cctp": {
        "v2": { "token_messenger": "...", "message_transmitter": "...", "attestation_api": "..." }
      }
    },
    "mainnet": { ... }
  }
}
```

`rpc_url` 支持两种写法：

- `{ "template": "https://eth-mainnet.g.alchemy.com/v2/${ALCHEMY_KEY}" }`
- `{ "env": "SEPOLIA_RPC_URL" }`

## 开发注意事项

- 后端 poller 默认每 10 秒轮询一次，请求间隔 300ms，避免短时间内大量请求 Circle。
- 已 attested 的交易会先在本地短接，不会重复请求 Circle（forward / relay 类型除外）。
- 前端 `useBackendPoller` 会检测后端连通性；后端离线时 Header 会显示红色 Offline 提示并支持手动重试。
- 钱包拒绝签名时，`useCctpTransfer` 会把状态置为 `error`，不会错误显示 `complete`。
- 切换 mainnet/testnet 会强制重新挂载 wagmi provider，清空当前 EVM 钱包状态。
- Relay worker 已实现 EVM、Solana、Stellar、Sui、Aptos 的自动 claim；Starknet 已占位但未实现。
- EVM relay 如配置了 `EVM_FORWARDER_<DOMAIN>`（或 `config/chains.json` 中的 `forwarder`），会走 Forwarder 合约路径。合约支持百分比（basis points）或固定额两种收费模式，并通过不可变的 `maxFeeAmount` 限制单笔最高手续费，扣除后自动将 USDC 转发给用户。

## 许可证

MIT
