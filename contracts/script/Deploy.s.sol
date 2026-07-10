// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {Script} from "forge-std/Script.sol";
import {CctpV2Forwarder} from "../src/CctpV2Forwarder.sol";

/**
 * @title Deploy
 * @notice Deployment script for CctpV2Forwarder.
 *
 *         Required environment variables:
 *         - USDC_ADDRESS
 *         - MESSAGE_TRANSMITTER_ADDRESS
 *         - FEE_RECIPIENT
 *         - FEE_BPS
 *         - MAX_FEE_BPS
 *         - OWNER
 *         - OPERATOR
 */
contract Deploy is Script {
    function run() external returns (CctpV2Forwarder) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address messageTransmitter = vm.envAddress("MESSAGE_TRANSMITTER_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        uint256 feeBps = vm.envUint("FEE_BPS");
        uint256 maxFeeBps = vm.envUint("MAX_FEE_BPS");
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");

        vm.startBroadcast();
        CctpV2Forwarder forwarder = new CctpV2Forwarder(
            usdc,
            messageTransmitter,
            feeRecipient,
            feeBps,
            maxFeeBps,
            owner,
            operator
        );
        vm.stopBroadcast();

        return forwarder;
    }
}
