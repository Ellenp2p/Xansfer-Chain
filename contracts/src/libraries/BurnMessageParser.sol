// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

/**
 * @title BurnMessageParser
 * @notice Low-level parser for CCTP v2 burn messages.
 * @dev    This library intentionally avoids external dependencies. All offsets
 *         and sizes are hard-coded to match Circle's CCTP v2 Message and
 *         BurnMessageV2 layouts.
 *
 *         CCTP v2 Message header (148 bytes):
 *         - version                  uint32   offset 0
 *         - sourceDomain             uint32   offset 4
 *         - destinationDomain        uint32   offset 8
 *         - nonce                    bytes32  offset 12
 *         - sender                   bytes32  offset 44
 *         - recipient                bytes32  offset 76
 *         - destinationCaller        bytes32  offset 108
 *         - minFinalityThreshold     uint32   offset 140
 *         - finalityThresholdExecuted uint32  offset 144
 *
 *         BurnMessageV2 body (minimum 228 bytes, dynamic hookData tail):
 *         - version                  uint32   offset 0
 *         - burnToken                bytes32  offset 4
 *         - mintRecipient            bytes32  offset 36
 *         - amount                   uint256  offset 68
 *         - messageSender            bytes32  offset 100
 *         - maxFee                   uint256  offset 132
 *         - feeExecuted              uint256  offset 164
 *         - expirationBlock          uint256  offset 196
 *         - hookData                 bytes    offset 228
 */
library BurnMessageParser {
    uint256 private constant V2_HEADER_LEN = 148;
    uint256 private constant BODY_MIN_LEN = 228;

    uint256 private constant BODY_MINT_RECIPIENT_OFFSET = 36;
    uint256 private constant BODY_AMOUNT_OFFSET = 68;

    error MessageTooShort(uint256 length);
    error InvalidMintRecipient();

    /**
     * @notice Extract the mint recipient and amount from a CCTP v2 message.
     * @param message The full CCTP v2 message bytes.
     * @return mintRecipient The EVM address that the message instructs Circle
     *                       to mint USDC to.
     * @return amount        The amount of USDC to be minted.
     */
    function parseV2(bytes calldata message) internal pure returns (address mintRecipient, uint256 amount) {
        uint256 minLen = V2_HEADER_LEN + BODY_MIN_LEN;
        if (message.length < minLen) {
            revert MessageTooShort(message.length);
        }

        uint256 bodyStart = V2_HEADER_LEN;

        bytes32 mintRecipientBytes =
            bytes32(message[bodyStart + BODY_MINT_RECIPIENT_OFFSET:bodyStart + BODY_MINT_RECIPIENT_OFFSET + 32]);
        mintRecipient = address(uint160(uint256(mintRecipientBytes)));

        amount = uint256(bytes32(message[bodyStart + BODY_AMOUNT_OFFSET:bodyStart + BODY_AMOUNT_OFFSET + 32]));
    }

    /**
     * @notice Convenience helper: parse and assert that the mint recipient is
     *         the expected forwarder address.
     */
    function parseV2AndValidate(bytes calldata message, address expectedRecipient)
        internal
        pure
        returns (uint256 amount)
    {
        (address mintRecipient, uint256 parsedAmount) = parseV2(message);
        if (mintRecipient != expectedRecipient) {
            revert InvalidMintRecipient();
        }
        amount = parsedAmount;
    }
}
