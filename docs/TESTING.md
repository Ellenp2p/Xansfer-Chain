# 测试与自动化验证

跨链工具的风险集中在两类事情上：**地址 / 编码写错**（钱可能 mint 到错误地址）和 **链上配置过期**（合约已迁移、RPC 已下线）。下面这套验证按"确定性 → 只读链上 → 真实转账"三层来做，前两层已经接入 CI。

## 第 1 层：确定性单测（每个 PR 必跑）

基于 Vitest，位于 `frontend/src/**/*.test.ts`，不依赖网络，几百毫秒跑完。

覆盖：

- `lib/address.test.ts`：EVM / Aptos / Sui / Stellar 目标地址校验，主网拒绝 Stellar G/M 账户地址。
- `lib/cctpEncoding.test.ts`：`normalizeMintRecipient`（EVM 地址左侧补零成 bytes32）、Stellar 合约 strkey 解码、Forwarder `hookData` 布局。
- `lib/fees.test.ts`：USDC 精度转换（禁止浮点）、Circle fee API 的 bps 换算与失败处理。
- `lib/estimate.test.ts`：到达时间估算与 fallback。
- `lib/iris.test.ts`：Circle Iris v1/v2 URL 与响应解析，EVM `MessageSent` log、Aptos / Sui 事件的 message 提取。
- `lib/api.test.ts`：目标链交易哈希格式校验。
- `config/chains.test.ts`：`config/chains.json` 的结构不变量——domain 唯一且与 Circle 官方 domain 一致、每个声明的 CCTP 版本都有合约地址、地址格式匹配链类型、只有支持 v2 的链才开放 Fast、RPC 必须是 HTTPS。

本地运行：

```bash
cd frontend
bun run test          # 单次
bun run test:watch    # watch
```

> 这套测试已经抓过一次真实 bug：Sui 的 `MessageSent` 解析返回 `0x0x...`（`bytesToHex` 自带 `0x` 前缀）。

## 第 2 层：链上只读校验（定时 / 手动 / 改链配置时）

脚本：`frontend/scripts/verify-chains.ts`。只读，不签名、不发交易。

它对每条链检查：

- RPC 可达、EVM `eth_chainId` 与 `chain_id` 一致；
- USDC 地址有合约代码且 `decimals() == 6`；
- 每个声明的 CCTP 版本的 TokenMessenger / MessageTransmitter 存在（EVM `eth_getCode`、Solana 程序账户、Sui GraphQL object、Stellar 合约实例、Aptos 账户、Starknet class hash）。

```bash
cd frontend
bun run verify:chains                                  # 默认 testnet
bun run verify:chains -- --mode mainnet
bun run verify:chains -- --mode all --type evm,stellar
bun run verify:chains -- --json
bun run verify:chains -- --mode testnet --allow-network-errors
```

`--allow-network-errors` 只把网络 / RPC 错误当作警告，**只有配置不匹配（地址错、合约不存在、decimals 不对）才返回非零退出码**。

CI：`.github/workflows/verify-chains.yml`

- 每天 03:00 UTC 自动跑一次；
- 手动 `workflow_dispatch`；
- 当 `config/chains.json` 或脚本本身在 PR 中被修改时触发。

工作流使用 `--allow-network-errors`，避免公共 RPC 抖动误报，但只要出现真实配置问题就会红。

## 第 3 层：真实跨链转账 canary（已实现）

`frontend/scripts/canary.ts` + `.github/workflows/canary.yml`，用当前配置在测试网真实跑完整闭环：approve → depositForBurn → Circle Iris attestation → receiveMessage → 断言目标链余额增加。

默认 dry-run，仅测试网，单笔 ≤ 0.05 USDC、单次 ≤ 3 笔、每日 ≤ 1 笔，Iris 429 退避，串行执行。支持 `distribute`（分发）/ `collect`（归集）/ `roundtrip` 三种模式。

```bash
cd frontend
bun run canary                                    # dry run
CANARY_PRIVATE_KEY=0x... CANARY_EXECUTE=true bun run canary
```

当前覆盖 EVM + CCTP v2 测试网；非 EVM（Solana / Sui / Aptos / Stellar）的真实 burn/claim 尚未实现。完整说明见 [`CANARY.md`](CANARY.md)。

## 第 4 层（可选）：浏览器冒烟测试

用 Playwright 加载前端、切 network、填地址、断言校验提示，可注入一个 mock EIP-1193 provider，不需要真实钱包。当前没做，优先级低于上面三层。

## Aptos CCTP v2（已核对）

Circle 的 Aptos 部署已经是 **CCTP v2**（四个 Move 包：`TokenMessengerMinterV2`、`MessageTransmitterV2`、`StablecoinHandler`、`CctpExtensions`）。本仓库的配置和脚本已经对齐：

- 包地址与 Circle 文档一致（testnet / mainnet 的 TokenMessenger、MessageTransmitter、CctpExtensions、StablecoinHandler、Stablecoin object）。
- 内嵌的 `deposit_for_burn` / `deposit_for_burn_with_hook` / `receive_message` Move 脚本与 Circle `aptos-cctp` master 的 precompiled `.mv` 完全一致。
- V2 接口是 8 参数的 `deposit_for_burn`（含 `hook_data`）和 3 参数的 `receive_message`。
- 前端默认使用 v2；v1 代码保留用于历史交易的 claim（以及 Sui v1 路线）。

自动防回归：

```bash
cd frontend
bun run verify:aptos-scripts   # 与 Circle aptos-cctp master 的 .mv 逐字节比较
```

- `aptosScripts.test.ts` 固定了当前脚本的 SHA-256，防止本地误改。
- `verify-chains.yml` 每天/改配置时跑 `verify:aptos-scripts`，Circle 升级脚本会直接失败并提示更新。
- `verify-chains.ts` 额外检查 Aptos v2 的包账户、`deposit_for_burn` 8 参数、`receive_message` 3 参数。

## 加一条新链时

1. 在 `config/chains.json` 里补 `domain`、`chain_id`、`rpc_url`、`usdc_address`、`cctp_versions` 和对应 CCTP 合约地址；如果该链 USDC 不是 6 位小数，再加 `usdc_decimals`；
2. `bun run test`（`config/chains.test.ts` 会检查结构与 domain 映射）；
3. `bun run verify:chains -- --type <chain_type>`（会去链上确认地址）；
4. 合并后 CI 会再跑一遍完整校验。

## 已知的 RPC / 校验问题

以下都是 2026-10 实测得到的结论，多数已经在同一次整理中修复：

- **Sui**：公共 JSON-RPC 已废弃，脚本改用 GraphQL，全部通过。
- **BNB Smart Chain**：USDC 是 **18 位小数**（不是 6 位）。现在 `config/chains.json` 支持 `usdc_decimals`，前端金额解析 / 格式化 / burn 参数都按链取小数位，校验脚本也按配置值比较。
- **Starknet**：免费公共 RPC（drpc）只开放 `starknet_chainId`，其余方法需要 API key，因此 Starknet 的合约存在性校验在 CI 上会记为网络错误。要给 Starknet 完整校验需要配置带 key 的 RPC。
- **EDGE**：本地请求证书校验失败（`rpc.edge.network`），CI 上可能正常，当前记为网络错误。

同一次整理中还修正了这些签名明显的配置错误：

| 链 | 问题 | 修复 |
| --- | --- | --- |
| Codex | `chain_id` 8333，RPC 实际 81224 | → 81224 |
| Monad | `chain_id` 10143（测试网值），RPC 实际 143 | → 143 |
| Injective | `chain_id` 60808；RPC 用的是 Tendermint 端点 | → 1776 + EVM RPC |
| Sonic Testnet | `chain_id` 57054 + 已失效 RPC | → 14601 + `rpc.testnet.soniclabs.com` |
| Ethereum / Polygon / HyperEVM / Cronos | 公共 RPC 返回 403 / 401 / 404 | 换成可用的 publicnode / drpc 端点 |
| Polygon Amoy / Cronos Testnet / Arc Testnet / Starknet | RPC 域名失效 | 换成 publicnode / drpc 端点 |
| Stellar mainnet | `soroban-rpc.stellar.org` 解析失败 | → `mainnet.sorobanrpc.com` |

修复后本地实测：

- testnet 全量：**79/79 通过**
- mainnet EVM：**117/119**，仅 2 个网络错误（EDGE 证书、Cronos 旧端点已修）
- mainnet 非 EVM：17/20，仅 Starknet drpc 方法限制

