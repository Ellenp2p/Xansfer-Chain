# CCTP v2 Forwarder

Foundry project implementing `CctpV2Forwarder.sol`, a non-upgradeable helper
contract that receives CCTP v2 USDC mints on behalf of users, deducts a fee,
and forwards the net amount to the intended recipient.

## Fee model

The contract supports two switchable fee models, both guarded by immutable caps:

- **Percentage (`FeeMode.PercentageBps`)**: `fee = (grossAmount * feeValue) / 10_000`.
- **Fixed (`FeeMode.FixedAmount`)**: `fee = feeValue` raw USDC units.

In both modes the final fee is clamped to `maxFeeAmount` (and can never exceed
the gross amount). The owner can switch models via `setFeeMode(mode, value)`.

## Layout

```
contracts/
├── src/
│   ├── CctpV2Forwarder.sol
│   ├── interfaces/ICCTPV2MessageTransmitter.sol
│   └── libraries/BurnMessageParser.sol
├── test/
│   ├── CctpV2Forwarder.t.sol
│   ├── invariant/ForwarderInvariants.t.sol
│   └── mocks/
├── script/Deploy.s.sol
└── slither.config.json
```

## Commands

```shell
forge build
forge test
forge fmt
```

## Deploy

```shell
cd contracts
USDC_ADDRESS=0x... \
MESSAGE_TRANSMITTER_ADDRESS=0x... \
FEE_RECIPIENT=0x... \
FEE_MODE=0              # 0 = percentage bps, 1 = fixed amount \
FEE_VALUE=50            # 0.5% in bps, or fixed USDC units \
MAX_FEE_BPS=500         # max configurable percentage \
MAX_FEE_AMOUNT=100e6    # absolute cap per transfer in USDC units \
OWNER=0x... \
OPERATOR=0x... \
forge script script/Deploy.s.sol --rpc-url <rpc> --broadcast
```

## Security notes

- Non-upgradeable; no proxy admin risk.
- `operator` (relay hot wallet) is separate from `owner`.
- `maxFeeBps` and `maxFeeAmount` are immutable fee ceilings.
- `processedMessages` prevents replay even if Circle's nonce check is bypassed.
- `ReentrancyGuard` + checks-effects-interactions on all transfers.
- `Pausable` emergency stop for the operator flow.
- `recoverUSDC` can rescue stuck USDC only when paused and only to an address
  specified by the owner.

Run Slither:

```shell
slither src/CctpV2Forwarder.sol --config-file slither.config.json
```
