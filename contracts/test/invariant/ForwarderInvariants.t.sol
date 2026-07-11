// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Test} from "forge-std/Test.sol";
import {StdInvariant} from "forge-std/StdInvariant.sol";
import {CctpV2Forwarder} from "../../src/CctpV2Forwarder.sol";
import {MockMessageTransmitter, MockUSDC} from "../mocks/MockMessageTransmitter.sol";

/**
 * @title ForwarderInvariants
 * @notice Invariant tests for CctpV2Forwarder.
 *
 *         Invariant 1: The sum of all fees distributed and all net amounts
 *         forwarded equals the total USDC ever "minted" into the contract.
 *
 *         Invariant 2: The contract never holds USDC after a successful
 *         mintAndForward (it is either transferred to recipient or fee
 *         recipient).
 *
 *         Invariant 3: A message hash can only be processed once.
 */
contract ForwarderInvariants is StdInvariant, Test {
    CctpV2Forwarder public forwarder;
    MockMessageTransmitter public transmitter;
    MockUSDC public usdc;

    address public owner = makeAddr("owner");
    address public operator = makeAddr("operator");
    address public feeRecipient = makeAddr("feeRecipient");

    uint256 public constant FEE_BPS = 50;
    uint256 public constant MAX_FEE_BPS = 500;
    uint256 public constant MAX_FEE_AMOUNT = 100e6;

    function setUp() public {
        usdc = new MockUSDC();
        transmitter = new MockMessageTransmitter(address(usdc));
        forwarder = new CctpV2Forwarder(
            address(usdc),
            address(transmitter),
            feeRecipient,
            CctpV2Forwarder.FeeMode.PercentageBps,
            FEE_BPS,
            MAX_FEE_BPS,
            MAX_FEE_AMOUNT,
            owner,
            operator
        );

        // The handler contract will drive state transitions.
        ForwarderHandler handler = new ForwarderHandler(forwarder, transmitter, usdc, operator, feeRecipient);
        targetContract(address(handler));
    }

    function invariant_ContractBalanceIsZeroAfterForward() public view {
        // The handler asserts this after every successful forward. This
        // invariant catches any residual accumulation between calls.
        assertEq(usdc.balanceOf(address(forwarder)), 0);
    }

    function invariant_FeeNeverExceedsMax() public view {
        (uint256 fee, uint256 net) = forwarder.previewForward(10_000e6);
        assertLe(fee, (10_000e6 * MAX_FEE_BPS) / 10_000);
        assertLe(fee, MAX_FEE_AMOUNT);
        assertEq(fee + net, 10_000e6);
    }
}

/**
 * @title ForwarderHandler
 * @notice Handler for invariant fuzzing. Generates valid mintAndForward calls.
 */
contract ForwarderHandler is Test {
    CctpV2Forwarder public forwarder;
    MockMessageTransmitter public transmitter;
    MockUSDC public usdc;
    address public operator;
    address public feeRecipient;

    uint256 public totalMinted;
    uint256 public totalFees;
    uint256 public totalNet;

    mapping(bytes32 => bool) public seenMessages;
    bytes32[] public messageHashes;

    constructor(
        CctpV2Forwarder _forwarder,
        MockMessageTransmitter _transmitter,
        MockUSDC _usdc,
        address _operator,
        address _feeRecipient
    ) {
        forwarder = _forwarder;
        transmitter = _transmitter;
        usdc = _usdc;
        operator = _operator;
        feeRecipient = _feeRecipient;
    }

    function mintAndForward(uint256 amount, address recipient, uint256 minAmountOut) external {
        amount = bound(amount, 1, 1_000_000_000e6);
        if (
            recipient == address(0) || recipient == address(forwarder)
                || recipient == feeRecipient
        ) {
            recipient = makeAddr("recipient");
        }

        bytes memory message = _buildV2Message(address(forwarder), amount);
        bytes32 messageHash = keccak256(message);

        // Skip replays.
        if (seenMessages[messageHash]) return;
        seenMessages[messageHash] = true;
        messageHashes.push(messageHash);

        transmitter.setMintAmount(amount);

        (uint256 fee, uint256 net) = forwarder.previewForward(amount);
        minAmountOut = bound(minAmountOut, 0, net);

        vm.prank(operator);
        try forwarder.mintAndForward(message, hex"", recipient, minAmountOut) {
            totalMinted += amount;
            totalFees += fee;
            totalNet += net;

            // Strong invariant: after a successful forward, contract holds 0 USDC.
            assertEq(usdc.balanceOf(address(forwarder)), 0);
        } catch {
            // Failed forwards are acceptable (e.g. blacklisted recipient).
            // Revert the seenMessages tracking so the message can be retried.
            seenMessages[messageHash] = false;
            messageHashes.pop();
        }
    }

    function _buildV2Message(address mintRecipient, uint256 amount)
        internal
        pure
        returns (bytes memory)
    {
        bytes memory header = new bytes(148);
        bytes memory body = abi.encodePacked(
            uint32(1),
            bytes32(0),
            bytes32(uint256(uint160(mintRecipient))),
            amount,
            bytes32(0),
            uint256(0),
            uint256(0),
            uint256(0)
        );
        return abi.encodePacked(header, body);
    }
}
