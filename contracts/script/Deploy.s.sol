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
 *         - FEE_MODE              (0 = PercentageBps, 1 = FixedAmount)
 *         - FEE_VALUE             (bps or raw USDC amount)
 *         - MAX_FEE_BPS           (max percentage in bps, e.g. 500)
 *         - MAX_FEE_AMOUNT        (absolute cap in raw USDC units, 0 = no cap)
 *         - OWNER
 *         - OPERATOR
 */
contract Deploy is Script {
    function run() external returns (CctpV2Forwarder) {
        address usdc = vm.envAddress("USDC_ADDRESS");
        address messageTransmitter = vm.envAddress("MESSAGE_TRANSMITTER_ADDRESS");
        address feeRecipient = vm.envAddress("FEE_RECIPIENT");
        CctpV2Forwarder.FeeMode feeMode = CctpV2Forwarder.FeeMode(vm.envUint("FEE_MODE"));
        uint256 feeValue = vm.envUint("FEE_VALUE");
        uint256 maxFeeBps = vm.envUint("MAX_FEE_BPS");
        uint256 maxFeeAmount = vm.envUint("MAX_FEE_AMOUNT");
        address owner = vm.envAddress("OWNER");
        address operator = vm.envAddress("OPERATOR");

        vm.startBroadcast();
        CctpV2Forwarder forwarder = new CctpV2Forwarder(
            usdc, messageTransmitter, feeRecipient, feeMode, feeValue, maxFeeBps, maxFeeAmount, owner, operator
        );
        vm.stopBroadcast();

        return forwarder;
    }
}
