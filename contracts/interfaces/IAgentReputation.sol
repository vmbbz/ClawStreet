// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

interface IAgentReputation {
    /**
     * @dev Returns the x402 reputation score for a given agent address.
     * Score is typically between 0 and 1000.
     */
    function getAgentScore(address agent) external view returns (uint256);
}
