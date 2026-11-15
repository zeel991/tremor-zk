// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {stdJson} from "forge-std/StdJson.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReceiptVault} from "../src/ReceiptVault.sol";
import {IZkVerifyAggregation} from "../src/IZkVerifyAggregation.sol";

/// Exposes the vault's own zkVerify call (`_verifyLeaf`) so the fork test runs the production code path
/// with a raw leaf. A ReceiptProof UltraHonk statement does not exist yet, so the leaf comes from a
/// third-party proof in a real published aggregation.
contract ReceiptVaultLeafHarness is ReceiptVault {
    function verifyLeaf(bytes32 leaf, uint256 aggregationId, bytes32[] calldata path, uint256 leafCount, uint256 index)
        external
        view
    {
        _verifyLeaf(leaf, aggregationId, path, leafCount, index);
    }
}

/// Fork test against the REAL zkVerify aggregation contract on Base Sepolia.
/// Fixture: test/fixtures/zkv_base_sepolia_65470.json (Volta aggregation 65470, domain 2, path from
/// `aggregate_statementPath`, root posted on Base Sepolia in block 58876905).
/// RPC: $BASE_SEPOLIA_RPC_URL, default https://base-sepolia-rpc.publicnode.com. Read-only; no transactions.
contract ZkVerifyForkTest is Test {
    using stdJson for string;

    IZkVerifyAggregation zkv;
    uint256 domainId;
    uint256 aggregationId;
    bytes32 leaf;
    bytes32[] path;
    uint256 leafCount;
    uint256 index;

    function setUp() public {
        string memory j = vm.readFile(string.concat(vm.projectRoot(), "/test/fixtures/zkv_base_sepolia_65470.json"));
        zkv = IZkVerifyAggregation(j.readAddress(".aggregationContract"));
        domainId = j.readUint(".domainId");
        aggregationId = j.readUint(".aggregationId");
        leaf = j.readBytes32(".leaf");
        path = j.readBytes32Array(".merklePath");
        leafCount = j.readUint(".leafCount");
        index = j.readUint(".index");

        string memory rpc = vm.envOr("BASE_SEPOLIA_RPC_URL", string("https://base-sepolia-rpc.publicnode.com"));
        vm.createSelectFork(rpc);
        assertEq(block.chainid, 84532, "not Base Sepolia");
        assertGt(address(zkv).code.length, 0, "no code at aggregation contract");
    }

    function test_fork_realAggregation_true() public view {
        assertTrue(zkv.verifyProofAggregation(domainId, aggregationId, leaf, path, leafCount, index));
    }

    function test_fork_flippedLeaf_false() public view {
        bytes32 flipped = leaf ^ bytes32(uint256(1));
        assertFalse(zkv.verifyProofAggregation(domainId, aggregationId, flipped, path, leafCount, index));
    }

    function test_fork_wrongIndexOrDomain_false() public view {
        assertFalse(zkv.verifyProofAggregation(domainId, aggregationId, leaf, path, leafCount, index + 1));
        assertFalse(zkv.verifyProofAggregation(domainId, aggregationId + 1, leaf, path, leafCount, index));
    }

    /// The vault's own verifier call, configured exactly as Deploy.s.sol would, against the real contract.
    function test_fork_vaultCallShape() public {
        ReceiptVaultLeafHarness impl = new ReceiptVaultLeafHarness();
        bytes memory init = abi.encodeCall(
            ReceiptVault.initialize,
            (
                address(this),
                IERC20(address(0xdead)),
                1,
                zkv,
                domainId,
                0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589,
                address(0xbeef),
                0
            )
        );
        ReceiptVaultLeafHarness v = ReceiptVaultLeafHarness(address(new ERC1967Proxy(address(impl), init)));
        v.verifyLeaf(leaf, aggregationId, path, leafCount, index); // does not revert
        bytes32 flipped = leaf ^ bytes32(uint256(1));
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ProofNotAggregated.selector, aggregationId));
        v.verifyLeaf(flipped, aggregationId, path, leafCount, index);
    }
}
