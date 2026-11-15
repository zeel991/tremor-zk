// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// @notice zkVerify aggregation contract (SPEC §19.2, frozen).
/// Base Sepolia: 0x0807C544D38aE7729f8798388d89Be6502A1e8A8, domain 2.
/// Base:         0xCb47A3C3B9Eb2E549a3F2EA4729De28CafbB2b69, domain 2.
interface IZkVerifyAggregation {
    function verifyProofAggregation(
        uint256 _domainId,
        uint256 _aggregationId,
        bytes32 _leaf,
        bytes32[] calldata _merklePath,
        uint256 _leafCount,
        uint256 _index
    ) external view returns (bool);
}
