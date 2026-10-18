# 跨链 Canary（真实转账测试）

`frontend/scripts/canary.ts` 用**当前仓库的 `config/chains.json`**，在测试网上完整跑一次真实的 CCTP 流程：

```
源链 approve + depositForBurn -> Circle Iris attestation -> 目标链 receiveMessage -> 目标余额增加
```

默认是**干跑（dry-run）**，只有显式设置 `CANARY_EXECUTE=true` 才会提交交易。

## 支持的链（测试网，全部 6 种）

| 链类型 | driver | CCTP 版本 | 说明 |
| --- | --- | --- | --- |
| `evm` | `scripts/canary/evm.ts` | v1 + v2 | viem 直接签名 |
| `aptos` | `scripts/canary/aptos.ts` | v2（testnet） | 复用 Circle precompiled Move 脚本（`aptosScripts.ts`） |
| `stellar` | `scripts/canary/stellar.ts` | v2 | Soroban `deposit_for_burn` + CctpForwarder `mint_and_forward` |
| `sui` | `scripts/canary/sui.ts` | v1（testnet） | GraphQL endpoint（公共 JSON-RPC 已下线）+ PTB |
| `solana` | `scripts/canary/solana.ts` | v2 | 按 Circle `solana-cctp-contracts` 手工编码 Anchor 指令与 PDA |
| `starknet` | `scripts/canary/starknet.ts` | v2 | `starknet` SDK + 链上 ABI（`deposit_for_burn` / `receive_message`） |

路由矩阵按「两端都有 driver 且 CCTP 版本有交集」枚举，所以不会把不存在的路径算作已覆盖。全部 6 种 driver 时测试网共 **216** 条有向路由。

## 安全边界（硬编码，不可绕过）

| 限制 | 值 | 说明 |
| --- | --- | --- |
| 网络 | **仅 testnet** | 执行器只加载 `modes.testnet`，主网无法被选中 |
| 单笔金额 | ≤ **0.05 USDC** | 默认 0.01；超过直接拒绝 |
| 单次笔数 | ≤ **3** | 默认 1；`roundtrip` 默认 2 |
| 每日次数 | 默认 **1**，硬上限 3 | 本地 `.canary-state.json` 计数；CI 用 `concurrency` + 每周调度 |
| 执行开关 | 默认 dry-run | 必须 `CANARY_EXECUTE=true` |
| 私钥 | 仅测试网专用 | 只从 GitHub Secret / 环境变量注入，不落盘 |
| 轮询 | 15s 一次，超时 20 分钟 | Iris 返回 429 时退避 30s，不硬刷 |
| 失败处理 | 不自动重试 | burn 一旦发出就不再重复提交，避免双花 |
| 顺序 | 串行 | 不并发打 RPC / Circle API |

这些约束由纯函数 `frontend/src/lib/canaryPlan.ts` 实现，并有单元测试覆盖（金额、笔数、路由校验、`collect` / `roundtrip` 约束、driver 能力）。

## 三种模式

- `distribute`：按给定路由逐条 burn 到目标链（默认，用于**分发**）。
- `collect`：多条路由的**目标链必须相同**，即从多个源链**归集**到同一条链。
- `roundtrip`：一条路由 A→B 再 B→A，验证往返。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CANARY_EXECUTE` | `false` | 设为 `true` 才会真正发交易 |
| `CANARY_DRIVERS` | `all` | 可用 driver：`evm,aptos,sui,stellar,solana,starknet` |
| `CANARY_MODE` | `distribute` | `distribute` / `collect` / `roundtrip` |
| `CANARY_ROUTE` | `base-sepolia->ethereum-sepolia` | 逗号分隔多条路由 |
| `CANARY_AMOUNT_USDC` | `0.01` | 每笔金额，硬上限 0.05 |
| `CANARY_MAX_TRANSFERS` | `1`（roundtrip 为 2） | 单次笔数，硬上限 3 |
| `CANARY_DAILY_LIMIT` | `1` | 每日笔数上限，最大 3 |
| `CANARY_FAST` | `false` | `true` 用 fast（threshold 1000），否则 standard（2000） |
| `CANARY_POLL_MS` | `15000` | Iris 轮询间隔 |
| `CANARY_CLAIM_TIMEOUT_MS` | `1200000` | attestation 等待上限 |

各链私钥 / 只读地址：

| 链 | 私钥（执行） | 只读地址（dry-run 预检） |
| --- | --- | --- |
| EVM | `CANARY_EVM_PRIVATE_KEY` | `CANARY_EVM_ADDRESS` |
| Aptos | `CANARY_APTOS_PRIVATE_KEY` | `CANARY_APTOS_ADDRESS` |
| Sui | `CANARY_SUI_PRIVATE_KEY`（`suiprivkey…`） | `CANARY_SUI_ADDRESS` |
| Stellar | `CANARY_STELLAR_SECRET` | `CANARY_STELLAR_ADDRESS` |
| Solana | `CANARY_SOLANA_PRIVATE_KEY`（base58 或 JSON 数组） | `CANARY_SOLANA_ADDRESS` |
| Starknet | `CANARY_STARKNET_PRIVATE_KEY` + **`CANARY_STARKNET_ADDRESS`** | 同左 |

Starknet 的账户地址无法从私钥推导，所以执行时必须同时提供 `CANARY_STARKNET_ADDRESS`。

路由里的链名用 slug 或 domain，例如 `base-sepolia->ethereum-sepolia`、`6->0`、`ethereum-sepolia->sui-testnet`。

## 本地使用

```bash
cd frontend

# 干跑：只解析配置/路由/金额，不发交易（没有私钥时跳过余额预检）
bun run canary

# 带只读地址的余额预检（不签名）
CANARY_EVM_ADDRESS=0x... CANARY_APTOS_ADDRESS=0x1 \
  CANARY_ROUTE=base-sepolia->aptos-testnet bun run canary

# 多链：Base Sepolia -> Aptos Testnet（需要两端私钥，claim 在目标链签名）
CANARY_EVM_PRIVATE_KEY=0x... CANARY_APTOS_PRIVATE_KEY=ed25519-priv-0x... \
  CANARY_EXECUTE=true CANARY_ROUTE=base-sepolia->aptos-testnet bun run canary

# 归集：多条 -> 同一目标链
CANARY_EVM_PRIVATE_KEY=0x... CANARY_EXECUTE=true \
  CANARY_MODE=collect CANARY_MAX_TRANSFERS=2 \
  CANARY_ROUTE='base-sepolia->ethereum-sepolia,arbitrum-sepolia->ethereum-sepolia' \
  bun run canary
```

## CI 使用

`.github/workflows/canary.yml`：

- `workflow_dispatch`：可选 `mode` / `routes` / `amount` / `drivers` / `execute`（默认 dry-run）。
- `schedule`：每周一 04:00 UTC；配置了任一路线私钥才真正执行，否则自动降级为 dry-run，不会失败。
- `concurrency: cctp-canary`：防止并发调度把交易量放大。
- PR 的 `ci.yml` 会跑 `canary:matrix`，确保所有 driver 的路由枚举没有回归。

## 准备一个测试钱包

1. 每条要测的链用一个**专门的测试网钱包**，不要复用主钱包。
2. 确认该路由两端链的 gas 代币余额：EVM（ETH）、Aptos（APT）、Sui（SUI）、Stellar（XLM 且账户已激活）、Solana（SOL）、Starknet（STRK/ETH）。
3. 给源链钱包准备测试网 USDC（金额 ≥ 0.01）。
4. 在仓库 Secrets 里按上表添加对应私钥；Starknet 还要加 `CANARY_STARKNET_ADDRESS`。

建议先跑一次 dry-run 确认余额，再手动 dispatch 一次 `execute=true`，之后依赖每周调度即可。

## 路由矩阵与全路径覆盖

N×N 全量真实转账每轮不可能跑完，所以用**矩阵 + 分片 + 覆盖记录**：

```bash
cd frontend
bun run canary:matrix                       # 默认列出全部 driver 的路由
CANARY_DRIVERS=evm,aptos bun run canary:matrix
CANARY_SHARD=0/4 bun run canary:matrix      # 取 0/4 分片
```

- `CANARY_DRIVERS`：声明哪些链类型的 driver 已实现；矩阵只会列出**有 driver 的路径**，不会把不存在的路径算作覆盖。
- `CANARY_SHARD=i/N`：稳定分片，每条路由只属于一个分片。
- 覆盖记录在 `frontend/.canary-coverage.json`（已 gitignore），记录已跑过的 route id，多轮滚动覆盖。
- 每轮仍受金额 / 笔数 / 每日上限约束，所以用分片逐步覆盖整个矩阵，而不是一轮打满。

当前全部 driver 的测试网矩阵：**216 条有向路由**，按链类型对分布：

| 对 | 数量 |
| --- | --- |
| evm ↔ evm | 112 |
| evm ↔ aptos | 22 |
| evm ↔ stellar | 22 |
| evm ↔ solana | 22 |
| evm ↔ starknet | 22 |
| evm ↔ sui | 4（v1） |
| aptos / stellar / solana / starknet 两两 | 各 2 |
| aptos/solana/stellar/starknet ↔ sui | v1 交集为空，无 |

## 它验证什么 / 没验证什么

验证：配置里的测试网 USDC 地址、CCTP 合约、domain、EVM chain id、Iris attestation 流程、目标链 receive/mint、余额增加、mint recipient 编码（含 Stellar G 地址的 CctpForwarder hook）。

**没有**验证：浏览器 UI 的交互路径、钱包弹窗、前端路由；以及 Solana/Starknet 在本机网络受限环境下的连通性（CI runner 可访问，本机开发机可能被限制）。

## 为什么不默认上主网

主网转账涉及真实资金与公共 RPC / Circle 频控。当前执行器在代码层只加载 `modes.testnet`；如果要跑主网冒烟，建议单独一个 workflow、单独钱包、极小金额，并接受频控风险。
