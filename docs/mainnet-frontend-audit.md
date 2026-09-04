# Mainnet 前端安全审计报告与修复计划

> 审计范围：仅前端（`frontend/src`、`packages/wallet-connect`、`config/chains.json`）。
> 审计视角：用户仅在前端使用 mainnet 功能，后端几乎不做校验（不验 amount/hash、claim 无鉴权），**前端是最后一道资金防线**。
> 结论摘要：资金执行代码路径 mainnet/testnet 完全一致，无"mainnet 专属隐藏逻辑"；但存在多处地址校验缺失、mainnet 参数按 testnet 经验硬编码、配置数据错误，其中 3 条为"可直接丢钱"的严重问题。

---

## 一、严重问题（mainnet 上可直接丢钱）

### 1. 收款地址几乎零校验 —— 最大单点风险

- **位置**：`frontend/src/components/TransferForm.tsx:136-156`（只查非空）；`frontend/src/hooks/cctp/evm.ts:181-186`、`aptos.ts:22-26`、`sui.ts:48-52`（只查 hex 字符集，**不查长度**）。
- **问题**：截断一位的 EVM 地址、把 Sui/Aptos 64 位地址粘到 Ethereum 收款栏、任何带 `0x` 的垃圾地址——全部 `padStart(64,'0')` 通过，CCTP 把 USDC 铸造到无主 bytes32 地址。
- **影响**：**丢钱，不可逆**。
- **修复**：按目标链类型做严格校验——EVM 用 viem `isAddress`（40 hex + checksum）、Aptos/Sui 严格 64 hex、Stellar strkey 带 CRC 校验。TransferForm 提交前 + adapter 内双重校验。

### 2. Stellar G/M 地址 stub 明知丢钱仍放行

- **位置**：`frontend/src/hooks/cctp/stellar.ts:248-261`；`TransferForm.tsx:116`（自动填入 Stellar 钱包 G 地址）。
- **问题**：普通 Stellar 地址（G 开头，Freighter 返回格式）走 stub 路径，注释自承"资金会卡在不存在的合约里"，但仅 `console.warn`，UI 无任何警告，流程可一路点到 burn 成功。
- **另外**：`stellar.ts:235-241` 对 `0x` 地址不校验 hex 合法性，非法字符被 Buffer 静默跳过/截断。
- **影响**：**丢钱（burn 成功，mint 到不可解析地址）**。
- **修复**：mainnet 直接禁用 Stellar G/M 收款（TransferForm 层 + adapter 层双拦截）；`0x` 分支加 hex 正则校验。

### 3. Starknet 可选作目标链，但 claim 全端不支持，发送前零警告

- **位置**：`useCctpTransfer.ts:63-70`（`getAdapter` 仅对**源链** throw）；`config/chains.json` mainnet 含 Starknet(domain 25)。
- **问题**：EVM → Starknet 的 burn 照常签名成功（Starknet 地址是 `0x+64hex`，EVM hex 检查放行），之后 USDC 卡 Circle 托管态，点击 Claim 才报错。
- **影响**：**卡资金**（需第三方工具手动 relay，普通用户基本拿不回）。
- **修复**：目标链为 Starknet/Solana 时在 UI 拦截并给出醒目警告。

---

## 二、高危问题（卡资金 / 错链执行 / 多付费）

### 4. EVM 源链切换对 11 条 mainnet 链静默跳过

- **位置**：`evm.ts:76-84`（不支持的链 `return` 当成功）；根源 `config/wagmi.ts:42-51` 硬编码白名单缺：Codex(12)、World Chain(14)、Monad(15)、Sei(16)、BSC(17)、XDC(18)、HyperEVM(19)、Plume(22)、EDGE(28)、Injective(29)、Morph(30)、Pharos(31)。
- **问题**：`switchChain` 静默跳过后，`readContract`/`writeContract`（`evm.ts:99/111/162/203`）均不带 `chainId`，调用全部发到钱包当前所在链。通常因地址无合约 revert 白烧 gas，但行为不可预测；若当前链上恰有可调 allowance 的 USDC 合约，会在**错误源链**完成真实 burn → 资金卡死 + 状态全错。
- **修复**：补齐 wagmi 链定义，或 `switchChain` 失败必须 throw；所有 read/write 显式传 `chainId`。

### 5. Circle fee API 单位换算两条路径互相矛盾

- **位置**：`evm.ts:140-146`（按 basis points 换算 + 20% buffer）vs `aptos.ts:163-166`（`Math.ceil(minimumFee * 1_000_000)` 当成整 USDC）。
- **问题**：同一 API 两种解释。按 Circle 官方文档（minimumFee 单位为 bps），Aptos 路径错了：10 USDC fast 转账正确 maxFee 应为 0.001 USDC，代码给 1 USDC。maxFee 是铸造环节实际扣费上限，高估 = 多付真金白银；EVM 的 120% buffer 同样有放大风险。
- **修复**：统一按 bps 公式换算，去掉 buffer。

### 6. mainnet v1 转账的 attestation 永远查不到

- **位置**：`frontend/src/lib/iris.ts:128-130`。
- **问题**：Circle v1 API `GET {base}/attestations/{hash}` 默认查 testnet，mainnet 必须带 `?mainnet=true`，代码没带。ETH/AVAX/OP/ARB/Base/Polygon 均配了 v1——后端不可达时 v1 转账 burn 完成但永远拿不到 attestation。
- **影响**：**卡资金**。v2 路径无此问题。
- **修复**：v1 查询按 mode 追加 `?mainnet=true`。

### 7. Sui mainnet 转账的 message 解析走已禁用的 JSON-RPC

- **位置**：`iris.ts:52-79`。
- **问题**：Sui mainnet 仅支持 v1，v1 流程需先解析源交易 message。代码用 `sui_getTransactionBlock` 走 JSON-RPC——但项目提交 ae6d170 已把 Sui 迁至 GraphQL（burn 侧改了，查询路径漏改）。
- **影响**：**卡资金**（burn 成功，message 解析失败，永远 pending）。
- **修复**：v1 message 解析迁移到 GraphQL。

### 8. EVM/Aptos 的 burn 回执不查执行状态

- **位置**：`evm.ts:236-247`（拿到 receipt 即返回，不查 `receipt.status`）；`aptos.ts:258-262`（不查 `tx.success`）。
- **问题**：对比 Stellar（`stellar.ts:324-330`）和 Sui（`sui.ts:129`）明确区分 SUCCESS/FAILED，EVM/Aptos 把 revert 的 burn 当成功注册，UI 永远 pending。
- **修复**：EVM 查 `receipt.status === 'success'`，Aptos 查 `tx.success === true`。

---

## 三、中危问题（mainnet 参数按 testnet 经验硬编码）

### 9. Stellar mainnet 参数全套硬编码

- **位置**：`stellar.ts:221`（`minFinalityThreshold = 1000`，注释明说是 testnet 行为）；`stellar.ts:229`（`maxFee = 100_000n` = 0.01 USDC，照抄 Circle 示例）；`stellar.ts:189,196-201`（approve 为 **i128 MAX 无限授权**，仅 ~6 天 ledger 过期兜底）；`useAttestationStatus.ts:31`（等待预估来自 testnet）。
- **影响**：standard 转账被按 fast 费率计费；mainnet 费率下可能直接 revert；授权面过大。
- **修复**：threshold/maxFee 按 transferType 与 mode 区分；授权改精确额度。

### 10. 金额解析不一致 + parseFloat 精度截断

- **位置**：`TransferForm.tsx:266-276`（无 >0/小数位/余额校验）；`aptos.ts:149`、`sui.ts:198`、`stellar.ts:177,211`（`Math.floor(parseFloat(amount) * 1e6)`）。
- **问题**：`"0.29"` × 1e6 = 289999.999… → floor 后实际 burn 比显示少 1 个最小单位；`"1e3"` 被 Aptos/Sui 静默当成 1000（EVM 端抛错）；负数行为各链不一致。
- **修复**：UI 层统一校验（>0、≤6 位小数、纯十进制）；各 adapter 改用字符串 → BigInt 精确换算。

### 11. Aptos/Sui 钱包网络与 URL mode 无一致性检查

- **位置**：`aptos.ts:135-137`、`sui.ts:179-181`。
- **问题**：Aptos 预编译字节码内嵌 mainnet 合约地址、Sui GraphQL 端点按 mode 选择，但无人确认钱包实际网络。钱包在 testnet 而 URL 是 /mainnet 时，会用 mainnet 地址签 testnet 交易。
- **修复**：签名前读钱包网络并与 mode 比对，不一致则拦截。

---

## 四、低危 / 状态类问题

| # | 问题 | 位置 | 影响 |
|---|------|------|------|
| 12 | Claim 的 message+attestation 用户盲签，无法核对金额/地址；claim 用当前 URL mode 取合约，转账后切 mode 再 claim 会用错合约 | `useCctpTransfer.ts:246,217` | 状态错误（revert） |
| 13 | "Transfer Complete" 完全采信后端标记，前端零链上验证（后端 claim 无鉴权） | `TransactionStatus.tsx:56,143-153` | 假到账显示 |
| 14 | status/history/lookup API 均不带 mode，URL 手填 hash 可跨 mode 串数据 | `api.ts:114,166,196,268` | 状态误导 |
| 15 | 钱包签名弹窗期间切换网络，在途 claim 闭包会用到另一 mode 的合约地址 | `NetworkToggle.tsx:29`、`useCctpTransfer.ts:60` | 流程卡死 |
| 16 | burn 成功但注册失败时显示"失败"，用户误以为没转成（资金可 lookup 找回） | `useCctpTransfer.ts:188-201` | 状态错误 |
| 17 | EVM 只等 1 个区块确认，不查 `finality_blocks`（无双花风险，Circle attester 自等最终性） | `evm.ts:236-247` | 展示偏乐观 |
| 18 | claim 广播返回 hash 即显示 complete，不等链上确认 | `useCctpTransfer.ts:261-262` | 状态错误 |
| 19 | EVM fee API 请求无超时，挂起卡死在 burning 步；失败时 maxFee=0 可能 revert | `evm.ts:137`、`aptos.ts:159` | 卡流程 |
| 20 | Sui findUsdcCoin 只取前 50 个 coin 对象，碎片化账户可能误报余额不足 | `sui.ts:112` | 误报 |
| 21 | Stellar C 地址目标绕过 Forwarder 直接 mint 给合约，合约若无提现能力则卡资金 | `stellar.ts:242-247` | 卡资金（低频） |
| 22 | 路由 `startsWith('/mainnet')` 宽松匹配；`main.tsx:41` 注释与实际行为相反 | `chains.ts:11-13` | mode 混淆面 |
| 23 | 切 mode 全部钱包断连（`key={mode}` 重挂 Provider）；TransferForm 切 mode 不重置金额 | `main.tsx:62`、`TransferForm.tsx:33-40` | 体验 |
| 24 | history 列表渲染不带 mode 标识，慢网络/快速切换时旧 mode 数据短暂显示 | `TransactionHistory.tsx:44-46` | 状态误导 |

---

## 五、chains.json 配置数据错误

| 链 | 问题 | 位置 | 影响 |
|----|------|------|------|
| Arc (domain 26) | mainnet `usdc_address` 为 `0x0000…0000` 零占位符 | `chains.json:355` | 选中即失败 |
| Pharos (domain 31) | `chain_id: 0`，非法 | `chains.json:433` | 功能错误 |
| Solana (domain 5) | mainnet 与 testnet 的 v2 TokenMessenger/MessageTransmitter 地址完全相同，疑似照抄；当前 adapter throw 暂无实际影响，接入后即高危 | `chains.json:486,504` vs `838,847` | 潜在丢钱 |
| EDGE (domain 28) | v2 合约地址与所有其他 EVM 链的统一地址不同，需向 Circle 人工核实 | `chains.json:505,535` | 若错 = 丢钱 |
| Stellar (testnet) | testnet `usdc_sac` 抄了 mainnet 值（SAC 由网络 passphrase 派生，testnet 必然不同） | `chains.json:771-772` | testnet 功能错误 |
| Sui | mainnet `supports_fast_transfer: false`，testnet 为 `true`，配置不对称 | `chains.json:131-138` vs `798-811` | 行为差异 |

---

## 六、值得肯定的地方（无需改动）

- EVM approve 为**精确额度**非无限授权，且先查链上 allowance 跳过重复 approve（`evm.ts:111-116`）。
- 钱包签名弹窗的内容即真实合约调用参数（标准 `depositForBurn`/`receiveMessage` ABI），无隐藏 to/data 篡改。
- CCTP v1/v2 共享版本检查能在 burn 前拦截无共同版本的链组合（`useCctpTransfer.ts:95-107`）。
- 配置为构建时打包的纯字面值，无运行时拉取/缓存旧配置风险。
- `localTx` 本地记录按 `mode:hash` 键隔离，不串模式。
- Stellar/Sui 等待逻辑区分 SUCCESS/FAILED；claim 可重试，on-chain nonce 防双花。
- Stellar→EVM/Aptos 的 mintRecipient 32 字节左填充、forwarder hookData 布局与 Circle 文档吻合；mainnet forwarder 地址已对照 Circle 官方文档核实正确。
- Stellar allowance 读取正确还原 i128（hi/lo 拼接）。

---

## 七、修复计划（按优先级）

### P0 —— 阻断丢钱路径（必须先做）

1. **严格地址校验**：`TransferForm` 提交前 + 各 adapter 内，按目标链类型双重校验——EVM 用 `isAddress`（40 hex）、Aptos/Sui 严格 64 hex、Stellar strkey 带 CRC。
2. **禁用 Stellar G/M 收款**：UI 层拦截 + `stellar.ts` adapter 层 throw；`0x` 分支补 hex 正则。
3. **拦截不可 claim 的目标链**：目标链为 Starknet/Solana 时表单直接报错，不给 burn 机会。

### P1 —— 消除错链执行与卡资金

4. EVM：补齐 wagmi 链定义或 `switchChain` 失败 throw；所有 read/write 显式传 `chainId`。
5. 统一 Circle fee API 的 bps 换算（`evm.ts`/`aptos.ts`），去掉 buffer。
6. `iris.ts` v1 查询补 `?mainnet=true`。
7. Sui v1 message 解析迁移到 GraphQL。
8. EVM/Aptos `waitForSourceTx` 检查执行状态（`receipt.status` / `tx.success`）。

### P2 —— mainnet 参数修正

9. Stellar：threshold/maxFee 按 transferType + mode 区分；approve 改精确额度。
10. 金额输入 UI 层统一校验；各 adapter 改字符串 → BigInt 精确换算。
11. Aptos/Sui 签名前校验钱包网络与 mode 一致。

### P3 —— 状态可靠性

12. status/history/lookup API 携带 mode；TransactionStatus 对 complete 做链上核对或至少校验 dest_tx_hash 格式。
13. 在途交易期间禁止切换网络（或 claim 闭包捕获当时的 mode）。
14. 修正 `chains.json`：Arc 零地址、Pharos chain_id、Solana 地址核实、EDGE 地址核实、testnet Stellar SAC。

### 给 mainnet 用户的过渡性安全守则（修复完成前）

1. 只用"连接的钱包地址"作收款人，不用自定义地址栏。
2. 目标链只用 ETH / Arbitrum / Base / OP / Polygon / Avalanche（wagmi 支持 + v2 + Circle 官方公开地址）。
3. 避开 Starknet、Stellar、Sui、Arc 及全部 11 条 wagmi 不支持的 mainnet 新链。
4. 新链组合第一笔用最小金额试转。
5. 金额用纯十进制、≤6 位小数（避免 `0.29` 类截断差值），优先整数。
6. 转账全程不要切换 mainnet/testnet 开关。
