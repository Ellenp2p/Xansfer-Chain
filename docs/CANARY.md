# 跨链 Canary（真实转账测试）

`frontend/scripts/canary.ts` 用**当前仓库的 `config/chains.json`、CCTP ABI 和编码逻辑**，在测试网上真实完成一次完整的 CCTP 流程：

```
源链 approve + depositForBurn -> Circle Iris attestation -> 目标链 receiveMessage -> 断言余额增加
```

它默认是**干跑（dry-run）**，只有显式设置 `CANARY_EXECUTE=true` 才会发交易。

## 安全边界（写死在代码里，不靠约定）

| 限制 | 值 | 说明 |
| --- | --- | --- |
| 网络 | **仅 testnet** | 执行器只加载 `modes.testnet`，主网无法被选中 |
| 单笔金额 | ≤ **0.05 USDC** | 默认 0.01；超过直接拒绝 |
| 单次笔数 | ≤ **3** | 默认 1；`roundtrip` 默认 2 |
| 每日次数 | 默认 **1**，硬上限 3 | 本地用 `.canary-state.json` 计数；CI 靠 `concurrency` + 每周调度 |
| 执行方式 | 默认 dry-run | 必须 `CANARY_EXECUTE=true` |
| 私钥 | 仅测试网专用钱包 | 通过 GitHub Secret 注入，不落盘 |
| 轮询 | 15s 一次，超时 20 分钟 | Iris 返回 429 时退避 30s，不硬刷 |
| 重试 | 不发交易后自动重试 | burn 一旦发出就不重发，避免双花 |
| 顺序 | 串行 | 不同时打 RPC / Circle API |

这些限制的纯逻辑在 `frontend/src/lib/canaryPlan.ts`，并有 11 个单测覆盖（金额上限、笔数上限、路由校验、collect/roundtrip 约束）。

## 三种模式

- `distribute`：按给的路由逐笔 burn 到目标链（做**分发**）。
- `collect`：多条路由但**目标链必须相同**，即从多条源链**归集**到同一条链。
- `roundtrip`：一条路由跑 A→B 再 B→A，验证双向。

## 环境变量

| 变量 | 默认 | 说明 |
| --- | --- | --- |
| `CANARY_EXECUTE` | `false` | 设 `true` 才发交易 |
| `CANARY_PRIVATE_KEY` | 无 | 测试网热钱包私钥（`0x...`），执行时必填 |
| `CANARY_MODE` | `distribute` | `distribute` / `collect` / `roundtrip` |
| `CANARY_ROUTE` | `base-sepolia->ethereum-sepolia` | 逗号分隔多条路由 |
| `CANARY_AMOUNT_USDC` | `0.01` | 每笔金额，硬上限 0.05 |
| `CANARY_MAX_TRANSFERS` | `1`（roundtrip 为 2） | 单次笔数，硬上限 3 |
| `CANARY_DAILY_LIMIT` | `1` | 每日笔数（1–3） |
| `CANARY_FAST` | `true` | `true` 用 fast（threshold 1000），否则 standard（2000） |
| `CANARY_MIN_NATIVE` | `0.0002` | 每条链最少原生代币余额（gas） |
| `CANARY_POLL_MS` | `15000` | Iris 轮询间隔 |
| `CANARY_CLAIM_TIMEOUT_MS` | `1200000` | attestation 等待上限 |

路由用链名 slug 或 domain，例如 `base-sepolia->ethereum-sepolia`、`6->0`。当前只允许 **EVM + CCTP v2** 的测试网链，其他链会被直接拒绝。

## 本地使用

```bash
cd frontend

# 干跑：只校验配置、路由、限额，不发交易（没私钥时跳过余额检查）
bun run canary

# 校验余额但不发交易
CANARY_PRIVATE_KEY=0x... bun run canary

# 真实执行 0.01 USDC，Base Sepolia -> Ethereum Sepolia
CANARY_PRIVATE_KEY=0x... CANARY_EXECUTE=true bun run canary

# 归集：两条源链 -> 同一条目标链
CANARY_PRIVATE_KEY=0x... CANARY_EXECUTE=true \
  CANARY_MODE=collect CANARY_MAX_TRANSFERS=2 \
  CANARY_ROUTE='base-sepolia->ethereum-sepolia,arbitrum-sepolia->ethereum-sepolia' \
  bun run canary
```

## CI 使用

`.github/workflows/canary.yml`：

- `workflow_dispatch`：可选 mode / routes / amount / execute（默认 dry-run）
- `schedule`：每周一 04:00 UTC，仅在配置了 secret 时执行（默认 1 笔 0.01 USDC）
- `concurrency: cctp-canary`：禁止并发，避免无意中放大调用量
- 未配置 secret 时自动降级为 dry-run，不会失败

## 准备一个测试网钱包

1. 生成一个**专门用于测试**的钱包（不要复用主钱包）。
2. 在默认路由涉及的两条链上充值原生代币做 gas：Base Sepolia、Ethereum Sepolia。
3. 给该地址准备测试网 USDC（Base Sepolia / Ethereum Sepolia）。
4. 在仓库 Secrets 里添加 `CANARY_EVM_PRIVATE_KEY`。

建议先手动 dry-run 确认余额，再手动 dispatch 一次 `execute=true`，最后再依赖每周调度。

## 路由矩阵与全路径覆盖

真实转账不可能每轮把所有路径跑一遍，所以用**矩阵 + 分片 + 覆盖记录**：

```bash
cd frontend
bun run canary:matrix                                   # 默认只列已实现的 driver（当前是 evm）
CANARY_DRIVERS=evm,aptos,sui,stellar bun run canary:matrix   # 按计划中的 driver 预览矩阵
CANARY_SHARD=0/4 bun run canary:matrix                  # 只看第 0/4 片
```

- `CANARY_DRIVERS`：声明哪些链类型有 driver；矩阵只会列出**有 driver 的路径**，不会把不存在的路径算进去。
- `CANARY_SHARD=i/N`：稳定分片，每条路径只属于一个分片。
- 覆盖记录写在 `frontend/.canary-coverage.json`（已 gitignore），执行成功后记录 route id，下次优先挑未覆盖的。
- 每轮仍受金额 / 笔数 / 每日上限约束，所以清空整个矩阵需要多轮；这正是避免撞限流的方式。

当前测试网规模（`CANARY_DRIVERS=evm`）：

| driver 组合 | 路径数 |
| --- | --- |
| 仅 `evm`（已实现） | 112 |
| `evm,aptos,sui,stellar`（计划中） | 168 |

也就是说：EVM 全部有向路径是 112 条，加上 Aptos / Sui / Stellar 后是 168 条；Solana、Starknet 目前连 driver 都没有，矩阵里不会出现。

### Driver 状态

| 链类型 | burn/claim driver | 说明 |
| --- | --- | --- |
| EVM | ✅ 已实现 | `canary.ts` 内建 |
| Stellar | ⏳ 待实现 | 可用 `@stellar/stellar-sdk` + Keypair 直接签 |
| Aptos | ⏳ 待实现 | 复用 Move 脚本 bytecode + `@aptos-labs/ts-sdk` |
| Sui | ⏳ 待实现 | 复用 PTB 逻辑 + `@mysten/sui` |
| Solana | ❌ 未实现 | 需要 CCTP Solana 指令编码 |
| Starknet | ❌ 未实现 | 需要 Starknet CCTP ABI 与签名 |

矩阵层已经就位：每补一个 driver，只需要把它加进 `CANARY_DRIVERS`，对应的所有路径就会自动纳入分片和覆盖统计。

## 它验证了什么 / 没验证什么


验证：当前配置里的 USDC 地址、CCTP v2 合约地址、domain、EVM chain id、Iris attestation 流程、目标链 receiveMessage、金额编码与 mint recipient 编码。

**没有**验证：浏览器 UI 的交互路径（钱包弹窗、表单、路由）、非 EVM 链（Solana / Sui / Aptos / Stellar）的真实 burn/claim、CCTP Forwarder 转发。非 EVM 路线需要各自 SDK 的 headless 实现，可以后续按同样模式扩展。

## 为什么不默认上主网

主网转账涉及真实资金，且公共 RPC / Circle 都有频率与额度限制。这一版把主网彻底排除在执行器之外；如果将来要做主网冒烟，建议单独一个 workflow、单独的钱包、极低金额，并且只手动触发。
