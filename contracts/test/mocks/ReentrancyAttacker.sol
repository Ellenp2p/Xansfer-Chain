// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {CctpV2Forwarder} from "../../src/CctpV2Forwarder.sol";

/**
 * @title ReentrancyAttacker
 * @notice Mock contract that attempts to re-enter mintAndForward on every
 *         USDC transfer.
 */
contract ReentrancyAttacker {
    CctpV2Forwarder public forwarder;
    uint256 public attackCount;
    uint256 public constant MAX_ATTACKS = 5;

    constructor(address _forwarder) {
        forwarder = CctpV2Forwarder(payable(_forwarder));
    }

    function onERC20Received(
        address,
        /* operator */
        address,
        /* from */
        uint256,
        /* amount */
        bytes calldata /* data */
    )
        external
        returns (bytes4)
    {
        // Try to re-enter if called by the forwarder contract.
        if (msg.sender == address(forwarder) && attackCount < MAX_ATTACKS) {
            attackCount++;
            // Re-enter with dummy data; should be blocked by nonReentrant.
            try forwarder.mintAndForward(hex"", hex"", address(this), 0) {
            // Should never succeed.
            }
                catch {}
        }
        return bytes4(keccak256("onERC20Received(address,address,uint256,bytes)"));
    }

    // Fallback for ERC-777 style callbacks (not used by our MockUSDC but
    // harmless to include).
    fallback() external {
        if (msg.sender == address(forwarder) && attackCount < MAX_ATTACKS) {
            attackCount++;
            try forwarder.mintAndForward(hex"", hex"", address(this), 0) {} catch {}
        }
    }
}
