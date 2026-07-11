// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title ICCTPV2MessageTransmitter
 * @notice Minimal interface for Circle CCTP v2 MessageTransmitter.
 */
interface ICCTPV2MessageTransmitter {
    /**
     * @notice Receives a message and its attestation and mints USDC on the
     *         destination chain.
     * @param message       The raw CCTP message bytes.
     * @param attestation   The Circle attestation bytes.
     * @return success      True if the message was received successfully.
     */
    function receiveMessage(bytes calldata message, bytes calldata attestation) external returns (bool success);

    /**
     * @notice Returns whether a message hash has already been received.
     */
    function isMessageReceived(bytes32 messageHash) external view returns (bool);
}
