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
 * @dev    Security properties:
 *         - Non-upgradeable to eliminate proxy admin risk.
 *         - `maxFeeBps` is immutable; mutable `feeBps` can never exceed it.
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

    // ============ Immutables ============

    /// @notice The USDC token contract on this chain.
    IERC20 public immutable usdc;

    /// @notice The Circle CCTP v2 MessageTransmitter contract on this chain.
    ICCTPV2MessageTransmitter public immutable messageTransmitter;

    /// @notice The maximum fee that can ever be charged, in basis points.
    uint256 public immutable maxFeeBps;

    // ============ State ============

    /// @notice Current fee in basis points (e.g. 50 = 0.5%).
    uint256 public feeBps;

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

    event FeeUpdated(uint256 oldFeeBps, uint256 newFeeBps);
    event FeeRecipientUpdated(address indexed oldRecipient, address indexed newRecipient);
    event OperatorUpdated(address indexed oldOperator, address indexed newOperator);

    // ============ Errors ============

    error ZeroAddress();
    error FeeExceedsMax(uint256 requested, uint256 max);
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
     * @param _feeBps             Initial fee in basis points.
     * @param _maxFeeBps          Hard cap on fee in basis points.
     * @param _owner              Initial owner (should be a multisig/timelock).
     * @param _operator           Initial operator (relay hot wallet).
     */
    constructor(
        address _usdc,
        address _messageTransmitter,
        address _feeRecipient,
        uint256 _feeBps,
        uint256 _maxFeeBps,
        address _owner,
        address _operator
    ) Ownable(_owner) {
        if (_usdc == address(0)) revert ZeroAddress();
        if (_messageTransmitter == address(0)) revert ZeroAddress();
        if (_feeRecipient == address(0)) revert ZeroAddress();
        if (_operator == address(0)) revert ZeroAddress();
        if (_feeBps > _maxFeeBps) {
            revert FeeExceedsMax(_feeBps, _maxFeeBps);
        }

        usdc = IERC20(_usdc);
        messageTransmitter = ICCTPV2MessageTransmitter(_messageTransmitter);
        feeRecipient = _feeRecipient;
        feeBps = _feeBps;
        maxFeeBps = _maxFeeBps;
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

        uint256 fee = (grossAmount * feeBps) / BPS_DENOMINATOR;
        uint256 netAmount = grossAmount - fee;
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
     * @notice Update the fee rate. Cannot exceed maxFeeBps.
     */
    function setFeeBps(uint256 newFeeBps) external onlyOwner {
        if (newFeeBps > maxFeeBps) {
            revert FeeExceedsMax(newFeeBps, maxFeeBps);
        }
        uint256 oldFeeBps = feeBps;
        feeBps = newFeeBps;
        emit FeeUpdated(oldFeeBps, newFeeBps);
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
        fee = (grossAmount * feeBps) / BPS_DENOMINATOR;
        netAmount = grossAmount - fee;
    }

    /**
     * @notice Returns true if a message has already been forwarded.
     */
    function isProcessed(bytes32 messageHash) external view returns (bool) {
        return processedMessages[messageHash];
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
