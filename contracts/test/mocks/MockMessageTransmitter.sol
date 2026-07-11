// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ICCTPV2MessageTransmitter} from "../../src/interfaces/ICCTPV2MessageTransmitter.sol";

/**
 * @title MockMessageTransmitter
 * @notice Simulates Circle CCTP v2 MessageTransmitter for testing.
 *         Mints a configurable amount of USDC to the forwarder when
 *         receiveMessage is called.
 */
contract MockMessageTransmitter is ICCTPV2MessageTransmitter {
    address public usdc;
    mapping(bytes32 => bool) public received;

    // Set by tests to control how much USDC is "minted".
    uint256 public mintAmount;
    bool public shouldFail;

    event MessageReceived(bytes32 indexed messageHash, uint256 mintAmount);

    constructor(address _usdc) {
        usdc = _usdc;
    }

    function setMintAmount(uint256 _mintAmount) external {
        mintAmount = _mintAmount;
    }

    function setShouldFail(bool _shouldFail) external {
        shouldFail = _shouldFail;
    }

    function receiveMessage(
        bytes calldata message,
        bytes calldata /* attestation */
    )
        external
        override
        returns (bool)
    {
        if (shouldFail) return false;

        bytes32 messageHash = keccak256(message);
        if (received[messageHash]) return false;
        received[messageHash] = true;

        MockUSDC(usdc).mintTo(msg.sender, mintAmount);

        emit MessageReceived(messageHash, mintAmount);
        return true;
    }

    function isMessageReceived(bytes32 messageHash) external view override returns (bool) {
        return received[messageHash];
    }
}

/**
 * @title MockUSDC
 * @notice Minimal ERC20 mock with mint/burn and a blacklisting capability
 *         for testing transfer failures.
 */
contract MockUSDC is IERC20 {
    string public name = "Mock USDC";
    string public symbol = "mUSDC";
    uint8 public decimals = 6;

    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;
    mapping(address => bool) public blacklisted;

    uint256 public totalSupply;

    error Blacklisted();
    error InsufficientBalance();
    error InsufficientAllowance();

    function mintTo(address to, uint256 amount) external {
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function setBlacklisted(address account, bool status) external {
        blacklisted[account] = status;
    }

    function approve(address spender, uint256 amount) external override returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external override returns (bool) {
        if (blacklisted[msg.sender] || blacklisted[to]) revert Blacklisted();
        if (balanceOf[msg.sender] < amount) revert InsufficientBalance();
        balanceOf[msg.sender] -= amount;
        balanceOf[to] += amount;
        emit Transfer(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external override returns (bool) {
        if (blacklisted[from] || blacklisted[to] || blacklisted[msg.sender]) {
            revert Blacklisted();
        }
        if (balanceOf[from] < amount) revert InsufficientBalance();
        if (allowance[from][msg.sender] < amount) revert InsufficientAllowance();
        allowance[from][msg.sender] -= amount;
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
        return true;
    }
}
