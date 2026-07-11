// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Ownable2Step} from "@openzeppelin/contracts/access/Ownable2Step.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {Pausable} from "@openzeppelin/contracts/utils/Pausable.sol";
import {ReentrancyGuard} from "@openzeppelin/contracts/utils/ReentrancyGuard.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Address} from "@openzeppelin/contracts/utils/Address.sol";

import {ICCTPV2MessageTransmitter} from "./interfaces/ICCTPV2MessageTransmitter.sol";
import {BurnMessageParser} from "./libraries/BurnMessageParser.sol";

/**
 * @title  CctpV2Forwarder
 * @notice Receives CCTP v2 mints on behalf of users, deducts a configurable
 *         fee, and forwards the net USDC amount to the intended recipient.
 *
 * @dev    Fee model:
 *         - Percentage: fee = (grossAmount * feeValue) / 10_000.
 *         - Fixed:      fee = feeValue (raw USDC units).
 *         In both cases the final fee is capped by `maxFeeAmount`, and the
 *         owner can switch between the two models via `setFeeMode`.
 *
 *         Security properties:
 *         - Non-upgradeable to eliminate proxy admin risk.
 *         - `maxFeeBps` and `maxFeeAmount` are immutable; mutable `feeValue`
 *           can never exceed the corresponding cap.
 *         - `minAmountOut` lets users enforce a minimum received amount
 *           (slippage/fee protection).
 *         - `processedMessages` prevents the same message from being forwarded
 *           twice, even if Circle's internal nonce check is somehow bypassed.
 *         - `ReentrancyGuard` + checks-effects-interactions on all transfers.
 *         - `Pausable` emergency brake for the operator flow.
 *         - `Ownable2Step` for ownership transfers.
 *         - Separate `operator` role so the relay hot wallet does not need
 *           owner privileges.
 */
contract CctpV2Forwarder is Ownable2Step, Pausable, ReentrancyGuard {
    using SafeERC20 for IERC20;
    using BurnMessageParser for bytes;

    /// @notice Supported fee charging models.
    enum FeeMode {
        PercentageBps,
        FixedAmount
    }

    // ============ Immutables ============

    /// @notice The USDC token contract on this chain.
    IERC20 public immutable usdc;

    /// @notice The Circle CCTP v2 MessageTransmitter contract on this chain.
    ICCTPV2MessageTransmitter public immutable messageTransmitter;

    /// @notice Maximum percentage fee that can be configured, in basis points.
    uint256 public immutable maxFeeBps;

    /// @notice Hard cap on the absolute fee charged for any single transfer.
    uint256 public immutable maxFeeAmount;

    // ============ State ============

    /// @notice Current fee model.
    FeeMode public feeMode;

    /// @notice Current fee parameter. Interpretation depends on `feeMode`:
    ///         - PercentageBps: basis points (e.g. 50 = 0.5%).
    ///         - FixedAmount: raw USDC amount.
    uint256 public feeValue;

    /// @notice Address that receives fee earnings.
    address public feeRecipient;

    /// @notice Address authorized to call mintAndForward (the relay hot wallet).
    address public operator;

    /// @notice Messages that have already been forwarded.
    mapping(bytes32 => bool) public processedMessages;

    // ============ Constants ============

    uint256 private constant BPS_DENOMINATOR = 10_000;

    // ============ Events ============

    event MintAndForward(
        bytes32 indexed messageHash,
        address indexed recipient,
        uint256 grossAmount,
        uint256 fee,
        uint256 netAmount
    );

    event FeeModeUpdated(
        FeeMode indexed oldMode,
        FeeMode indexed newMode,
        uint256 oldValue,
        uint256 newValue
    );
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ============ Errors ============

    error ZeroAddress();
    error FeeExceedsMax(uint256 requested, uint256 max);
    error InvalidFeeMode();
    error NotOperator(address caller);
    error AlreadyProcessed(bytes32 messageHash);
    error InvalidMintRecipient();
    error ZeroAmount();
    error SlippageExceeded(uint256 netAmount, uint256 minAmountOut);
    error ReceiveMessageFailed();
    error RescueOwnToken(address token);

    // ============ Modifiers ============

    modifier onlyOperator() {
        if (msg.sender != operator) {
            revert NotOperator(msg.sender);
        }
        _;
    }

    // ============ Constructor ============

    /**
     * @param _usdc               USDC token contract address.
     * @param _messageTransmitter CCTP v2 MessageTransmitter address.
     * @param _feeRecipient       Address that receives fees.
     * @param _feeMode            Initial fee model.
     * @param _feeValue           Initial fee value (bps or raw USDC units).
     * @param _maxFeeBps          Hard cap on percentage fee in basis points.
     * @param _maxFeeAmount       Hard cap on absolute fee per transfer.
     * @param _owner              Initial owner (should be a multisig/timelock).
     * @param _operator           Initial operator (relay hot wallet).
     */
    constructor(
        address _usdc,
        address _messageTransmitter,
        address _feeRecipient,
        FeeMode _feeMode,
        uint256 _feeValue,
        uint256 _maxFeeBps,
        uint256 _maxFeeAmount,
        address _owner,
        address _operator
    ) Ownable(_owner) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_messageTransmitter == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_operator == address(0)) revert ZeroAddress();
        if (_maxFeeBps > BPS_DENOMINATOR) {
            revert FeeExceedsMax(_maxFeeBps, BPS_DENOMINATOR);
        }

        _validateFeeValue(_feeMode, _feeValue);

        usdc = IERC20(_usdc);
        messageTransmitter = ICCTPV2MessageTransmitter(_messageTransmitter);
        feeRecipient = _feeRecipient;
        feeMode = _feeMode;
        feeValue = _feeValue;
        maxFeeBps = _maxFeeBps;
        maxFeeAmount = _maxFeeAmount;
        operator = _operator;
    }

    // ============ Core Function ============

    /**
     * @notice Receives a CCTP v2 message, mints USDC to this contract, deducts
     *         the fee, and forwards the remainder to `_recipient`.
     * @param message         The full CCTP v2 message bytes.
     * @param attestation     The Circle attestation.
     * @param recipient       The final recipient of the net USDC amount.
     * @param minAmountOut    Minimum net USDC the recipient must receive.
     * @return success        True if the full flow succeeded.
     */
    function mintAndForward(
        bytes calldata message,
        bytes calldata attestation,
        address recipient,
        uint256 minAmountOut
    ) external nonReentrant whenNotPaused onlyOperator returns (bool success) {
        if (recipient == address(0)) revert ZeroAddress();

        bytes32 messageHash = keccak256(message);
        if (processedMessages[messageHash]) {
            revert AlreadyProcessed(messageHash);
        }

        // Mark as processed before any external call. If something below
        // reverts, this state change is rolled back automatically.
        processedMessages[messageHash] = true;

        // Parse the message to verify it is minting to this contract and to
        // determine the gross amount. Circle will re-verify the attestation
        // inside receiveMessage, so we do not duplicate signature checks here.
        uint256 grossAmount = message.parseV2AndValidate(address(this));
        if (grossAmount == 0) revert ZeroAmount();

        (uint256 fee, uint256 netAmount) = _calculateFee(grossAmount);
        if (netAmount < minAmountOut) {
            revert SlippageExceeded(netAmount, minAmountOut);
        }

        // External call to Circle's audited contract. We intentionally do not
        // snapshot/verify the USDC balance because:
        //   1. `nonReentrant` prevents reentrancy-based balance manipulation.
        //   2. `processedMessages` prevents replay.
        //   3. A successful `receiveMessage` for a valid CCTP v2 burn message
        //      always mints exactly `grossAmount` to this contract.
        bool received = messageTransmitter.receiveMessage(message, attestation);
        if (!received) revert ReceiveMessageFailed();

        // Effects complete; perform transfers following CEI.
        if (fee > 0) {
            usdc.safeTransfer(feeRecipient, fee);
        }
        usdc.safeTransfer(recipient, netAmount);

        emit MintAndForward(messageHash, recipient, grossAmount, fee, netAmount);
        return true;
    }

    // ============ Admin Functions ============

    /**
     * @notice Switch fee model and/or update the fee value.
     * @param newMode   New fee model.
     * @param newValue  New fee value (capped by maxFeeBps or maxFeeAmount
     *                  depending on the mode).
     */
    function setFeeMode(FeeMode newMode, uint256 newValue) external onlyOwner {
        _validateFeeValue(newMode, newValue);

        FeeMode oldMode = feeMode;
        uint256 oldValue = feeValue;

        feeMode = newMode;
        feeValue = newValue;

        emit FeeModeUpdated(oldMode, newMode, oldValue, newValue);
    }

    /**
     * @notice Update the fee recipient address.
     */
    function setFeeRecipient(address newFeeRecipient) external onlyOwner {
        if (newFeeRecipient == address(0)) revert ZeroAddress();
        address oldRecipient = feeRecipient;
        feeRecipient = newFeeRecipient;
        emit FeeRecipientUpdated(oldRecipient, newFeeRecipient);
    }

    /**
     * @notice Update the operator address (relay hot wallet).
     */
    function setOperator(address newOperator) external onlyOwner {
        if (newOperator == address(0)) revert ZeroAddress();
        address oldOperator = operator;
        operator = newOperator;
        emit OperatorUpdated(oldOperator, newOperator);
    }

    /**
     * @notice Pause forwarding. Owner only.
     */
    function pause() external onlyOwner {
        _pause();
    }

    /**
     * @notice Unpause forwarding. Owner only.
     */
    function unpause() external onlyOwner {
        _unpause();
    }

    /**
     * @notice Rescue arbitrary ERC20 tokens stuck in the contract.
     * @dev    Cannot rescue USDC to avoid interfering with in-flight forwards.
     *         In production this should be rare and invoked via multisig.
     */
    function rescueERC20(address token, address to, uint256 amount) external onlyOwner {
        if (token == address(0) || to == address(0)) revert ZeroAddress();
        if (token == address(usdc)) revert RescueOwnToken(token);
        IERC20(token).safeTransfer(to, amount);
    }

    /**
     * @notice Rescue native gas tokens (ETH/MATIC/etc.) accidentally sent here.
     */
    function rescueNative(address payable to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        Address.sendValue(to, amount);
    }

    /**
     * @notice Recover USDC that could not be forwarded (e.g. recipient
     *         blacklisted). This sends USDC to the owner who can then resolve
     *         the situation off-chain.
     * @dev    This is a centralization vector and should be clearly documented.
     *         Only callable when paused to prevent interference with live flows.
     */
    function recoverUSDC(address to, uint256 amount) external onlyOwner whenPaused {
        if (to == address(0)) revert ZeroAddress();
        usdc.safeTransfer(to, amount);
    }

    // ============ View Helpers ============

    /**
     * @notice Convenience helper to preview the fee and net amount for a given
     *         gross amount without mutating state.
     */
    function previewForward(uint256 grossAmount)
        external
        view
        returns (uint256 fee, uint256 netAmount)
    {
        return _calculateFee(grossAmount);
    }

    /**
     * @notice Returns true if a message has already been forwarded.
     */
    function isProcessed(bytes32 messageHash) external view returns (bool) {
        return processedMessages[messageHash];
    }

    // ============ Internal Helpers ============

    /**
     * @notice Calculate fee and net amount for a gross amount, honoring the
     *         configured fee model and the absolute `maxFeeAmount` cap.
     */
    function _calculateFee(uint256 grossAmount)
        internal
        view
        returns (uint256 fee, uint256 netAmount)
    {
        if (feeMode == FeeMode.PercentageBps) {
            fee = (grossAmount * feeValue) / BPS_DENOMINATOR;
        } else if (feeMode == FeeMode.FixedAmount) {
            fee = feeValue;
        } else {
            revert InvalidFeeMode();
        }

        if (maxFeeAmount > 0 && fee > maxFeeAmount) {
            fee = maxFeeAmount;
        }
        if (fee > grossAmount) {
            fee = grossAmount;
        }

        netAmount = grossAmount - fee;
    }

    /**
     * @notice Validate that a fee value respects the immutable caps for its mode.
     */
    function _validateFeeValue(FeeMode mode, uint256 value) internal view {
        if (mode == FeeMode.PercentageBps) {
            if (value > maxFeeBps) {
                revert FeeExceedsMax(value, maxFeeBps);
            }
        } else if (mode == FeeMode.FixedAmount) {
            if (value > maxFeeAmount) {
                revert FeeExceedsMax(value, maxFeeAmount);
            }
        } else {
            revert InvalidFeeMode();
        }
    }

    /**
     * @notice Explicitly reject accidental direct ETH transfers.
     */
    receive() external payable {
        revert();
    }

    /**
     * @notice Explicitly reject accidental direct ETH transfers to non-existent
     *         selectors.
     */
    fallback() external payable {
        revert();
    }
}
