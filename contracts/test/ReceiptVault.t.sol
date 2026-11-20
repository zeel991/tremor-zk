// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Test} from "forge-std/Test.sol";
import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {ReceiptVault} from "../src/ReceiptVault.sol";
import {IZkVerifyAggregation} from "../src/IZkVerifyAggregation.sol";

contract MockUSDC is ERC20 {
    constructor() ERC20("USD Coin", "USDC") {}

    function decimals() public pure override returns (uint8) {
        return 6;
    }

    function mint(address to, uint256 amt) external {
        _mint(to, amt);
    }
}

/// Returns true only for the exact (domainId, aggregationId, leaf, path, leafCount, index) tuples the
/// test registered, so a passing claim proves the vault computed the leaf the test expects.
contract MockAggregator is IZkVerifyAggregation {
    mapping(bytes32 => bool) public ok;
    bool public forceFalse;

    function allow(uint256 d, uint256 a, bytes32 leaf, bytes32[] calldata path, uint256 n, uint256 i) external {
        ok[keccak256(abi.encode(d, a, leaf, path, n, i))] = true;
    }

    function setForceFalse(bool v) external {
        forceFalse = v;
    }

    function verifyProofAggregation(uint256 d, uint256 a, bytes32 leaf, bytes32[] calldata path, uint256 n, uint256 i)
        external
        view
        returns (bool)
    {
        if (forceFalse) return false;
        return ok[keccak256(abi.encode(d, a, leaf, path, n, i))];
    }
}

contract ReceiptVaultV2 is ReceiptVault {
    function version() external pure returns (uint256) {
        return 2;
    }
}

contract ReceiptVaultTest is Test {
    bytes32 constant VERSION_HASH = 0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589;
    bytes32 constant VK = 0x806073cafcaee81e9803c622546730931813769bf9eef8126a95e8c318cd6dca;
    uint256 constant VAULT_ID = 7;
    uint256 constant DOMAIN_ID = 2;
    uint256 constant AGG_ID = 65470;
    uint256 constant PK_UBER = 0x1111;
    uint256 constant PK_TEST = 0x2222;
    uint256 constant TPL_UBER = 1;
    uint256 constant TPL_TEST_USD = 101;
    uint256 constant INR = 356;
    uint256 constant USD = 840;
    uint256 constant TO_COMMIT = 0xC0FFEE;
    uint192 constant INR_RATE = 120e18; // 1 paise = 120 USDC base units (₹1 = $0.012)
    bytes32 constant POLICY = keccak256("policy-v1");

    ReceiptVault vault;
    MockUSDC usdc;
    MockAggregator agg;
    address owner = makeAddr("owner");
    address alice = makeAddr("alice");
    address mallory = makeAddr("mallory");
    uint256 agentPk = 0xA11CE;
    address agentAddr;
    uint256 T0;
    uint256 nonce;

    function setUp() public {
        vm.warp(1_800_000_000);
        agentAddr = vm.addr(agentPk);
        usdc = new MockUSDC();
        agg = new MockAggregator();
        vault = _deploy(VAULT_ID);

        vm.startPrank(owner);
        vault.setAcceptedVk(VK, true);
        vault.proposeKey(PK_UBER, "uber.com", "s2048", new bytes(256));
        vault.proposeKey(PK_TEST, "test.receiptproof.xyz", "rp1", new bytes(128));
        vault.setMerchant(TPL_UBER, "uber.com", 500_000, 2_000_000, true); // ₹5,000 / claim, ₹20,000 / day
        vault.setMerchant(TPL_TEST_USD, "test.receiptproof.xyz", 10_000, 100_000, true); // $100 / claim
        vault.registerEmployee(TO_COMMIT, alice);
        vault.queueFxRate(INR, INR_RATE);
        vm.stopPrank();

        usdc.mint(address(this), 1_000e6);
        usdc.approve(address(vault), type(uint256).max);
        vault.deposit(1_000e6);

        vm.warp(block.timestamp + 24 hours + 1); // keys + FX active
        T0 = block.timestamp;
    }

    // ------------------------------------------------------------ helpers

    function _deploy(uint256 vaultId) internal returns (ReceiptVault v) {
        ReceiptVault impl = new ReceiptVault();
        bytes memory init = abi.encodeCall(
            ReceiptVault.initialize,
            (owner, IERC20(address(usdc)), vaultId, IZkVerifyAggregation(address(agg)), DOMAIN_ID, VERSION_HASH, agentAddr, 50e6)
        );
        v = ReceiptVault(address(new ERC1967Proxy(address(impl), init)));
    }

    function _pubs(uint256 tpl, uint256 pk, uint256 amount, uint256 currency, uint256 sentAt)
        internal
        returns (uint256[9] memory p)
    {
        p[0] = pk;
        p[1] = uint256(keccak256(abi.encode("nullifier", ++nonce))) >> 8;
        p[2] = tpl;
        p[3] = amount;
        p[4] = currency;
        p[5] = sentAt;
        p[6] = TO_COMMIT;
        p[7] = uint256(uint160(alice));
        p[8] = VAULT_ID;
    }

    function _inr(uint256 amount) internal returns (uint256[9] memory) {
        return _pubs(TPL_UBER, PK_UBER, amount, INR, T0);
    }

    function _path() internal pure returns (bytes32[] memory path) {
        path = new bytes32[](3);
        path[0] = bytes32(uint256(1));
        path[1] = bytes32(uint256(2));
        path[2] = bytes32(uint256(3));
    }

    /// Independent restatement of SPEC §19.1's leaf.
    function _leaf(uint256[9] memory p, bytes32 vk, bytes32 versionHash) internal pure returns (bytes32) {
        bytes memory packed;
        for (uint256 i; i < 9; i++) packed = bytes.concat(packed, bytes32(p[i]));
        assertEq(packed.length, 288);
        return keccak256(bytes.concat(keccak256("ultrahonk"), vk, versionHash, keccak256(packed)));
    }

    function _allow(uint256[9] memory p) internal {
        agg.allow(DOMAIN_ID, AGG_ID, _leaf(p, VK, VERSION_HASH), _path(), 8, 5);
    }

    function _sign(ReceiptVault v, uint256 pk, uint256 vaultId, uint256 nullifier, uint256 amount, uint64 deadline)
        internal
        view
        returns (bytes memory)
    {
        bytes32 typehash = keccak256(
            "Decision(uint256 vaultId,uint256 nullifier,uint256 amountMinor,bytes32 policyHash,uint64 deadline)"
        );
        bytes32 domainSep = keccak256(
            abi.encode(
                keccak256("EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"),
                keccak256("ReceiptVault"),
                keccak256("1"),
                block.chainid,
                address(v)
            )
        );
        bytes32 structHash = keccak256(abi.encode(typehash, vaultId, nullifier, amount, POLICY, deadline));
        (uint8 vv, bytes32 r, bytes32 s) = vm.sign(pk, keccak256(abi.encodePacked("\x19\x01", domainSep, structHash)));
        return abi.encodePacked(r, s, vv);
    }

    function _claimWith(ReceiptVault v, uint256[9] memory p, bytes32 vk, uint64 deadline, bytes memory sig) internal {
        v.claim(p, vk, AGG_ID, _path(), 8, 5, POLICY, deadline, sig);
    }

    function _claim(uint256[9] memory p) internal {
        uint64 dl = uint64(block.timestamp + 1 hours);
        _claimWith(vault, p, VK, dl, _sign(vault, agentPk, p[8], p[1], p[3], dl));
    }

    function _claimOk(uint256[9] memory p) internal {
        _allow(p);
        _claim(p);
    }

    // ------------------------------------------------------------ happy paths

    function test_claim_INR_paysAtPolicyRate() public {
        uint256[9] memory p = _inr(10_000); // ₹100.00
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(vault, agentPk, VAULT_ID, p[1], p[3], dl);
        vm.expectEmit(address(vault));
        emit ReceiptVault.Claimed(p[1], TO_COMMIT, alice, TPL_UBER, 10_000, INR, 1_200_000, AGG_ID, POLICY);
        vm.prank(mallory); // anyone may relay; funds still go to the registered wallet
        _claimWith(vault, p, VK, dl, sig);
        assertEq(usdc.balanceOf(alice), 1_200_000); // $1.20
        assertTrue(vault.spent(p[1]));
        assertEq(vault.statementLeaf(p, VK), _leaf(p, VK, VERSION_HASH));
    }

    function test_claim_USD_paysOneToOne() public {
        uint256[9] memory p = _pubs(TPL_TEST_USD, PK_TEST, 1234, USD, T0);
        _claimOk(p);
        assertEq(usdc.balanceOf(alice), 12.34e6);
    }

    // ------------------------------------------------------------ check 1-3

    function test_revert_vkNotAccepted() public {
        uint256[9] memory p = _inr(100);
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1);
        bytes memory sig = _sign(vault, agentPk, VAULT_ID, p[1], p[3], dl);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.VkNotAccepted.selector, bytes32(uint256(9))));
        _claimWith(vault, p, bytes32(uint256(9)), dl, sig);
    }

    function test_revert_vkRemoved() public {
        vm.prank(owner);
        vault.setAcceptedVk(VK, false);
        uint256[9] memory p = _inr(100);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.VkNotAccepted.selector, VK));
        _claim(p);
    }

    function test_revert_wrongVault() public {
        uint256[9] memory p = _inr(100);
        p[8] = VAULT_ID + 1;
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.WrongVault.selector, VAULT_ID + 1, VAULT_ID));
        _claim(p);
    }

    function test_revert_doubleClaim() public {
        uint256[9] memory p = _inr(100);
        _claimOk(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.NullifierSpent.selector, p[1]));
        _claim(p);
    }

    function test_checkOrder_earliestFailureWins() public {
        uint256[9] memory p = _inr(100);
        _claimOk(p);
        // now also wrong vault, wrong payee, expired, unaggregated: wrong vault (check 2) must be reported
        p[8] = 99;
        p[7] = uint256(uint160(mallory));
        p[5] = 1;
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.WrongVault.selector, 99, VAULT_ID));
        _claim(p);
        // with vault fixed, the spent nullifier (check 3) is reported before payee / window
        p[8] = VAULT_ID;
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.NullifierSpent.selector, p[1]));
        _claim(p);
    }

    // ------------------------------------------------------------ check 4: keys & merchants

    function test_revert_unknownKey() public {
        uint256[9] memory p = _pubs(TPL_UBER, 0xBAD, 100, INR, T0);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.UnknownKey.selector, 0xBAD));
        _claim(p);
    }

    function test_revert_keyUsedBefore24hActivation() public {
        uint256 pk = 0x3333;
        vm.prank(owner);
        vault.proposeKey(pk, "uber.com", "s2", new bytes(256));
        uint256 activatesAt = block.timestamp + 24 hours;
        uint256[9] memory p = _pubs(TPL_UBER, pk, 100, INR, T0);
        _allow(p);
        vm.warp(activatesAt - 1);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.KeyNotYetActive.selector, pk, uint64(activatesAt)));
        _claim(p);
        vm.warp(activatesAt);
        _claim(p);
        assertEq(usdc.balanceOf(alice), 12_000);
    }

    function test_revert_cancelledKey_and_cancelWindow() public {
        uint256 pk = 0x4444;
        vm.startPrank(owner);
        vault.proposeKey(pk, "uber.com", "s3", new bytes(256));
        vm.expectEmit(address(vault));
        emit ReceiptVault.KeyCancelled(pk);
        vault.cancelKey(pk);
        vm.stopPrank();
        vm.warp(block.timestamp + 2 days);
        uint256[9] memory p = _pubs(TPL_UBER, pk, 100, INR, block.timestamp);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.UnknownKey.selector, pk));
        _claim(p);
        // an active key can no longer be cancelled (only during the 24 h window)
        vm.prank(owner);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.KeyAlreadyActive.selector, PK_UBER));
        vault.cancelKey(PK_UBER);
    }

    function test_proposeKey_storesFullModulus_andValidates() public {
        bytes memory modulus = new bytes(256);
        modulus[0] = 0xC3;
        modulus[255] = 0x01;
        vm.startPrank(owner);
        vault.proposeKey(0x5555, "swiggy.in", "google", modulus);
        ReceiptVault.DkimKey memory k = vault.dkimKey(0x5555);
        assertEq(k.modulus, modulus);
        assertEq(k.domain, "swiggy.in");
        assertEq(k.selector, "google");
        assertEq(k.activatesAt, block.timestamp + 24 hours);
        assertEq(vault.activeKeyDomain(0x5555), bytes32(0));
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.KeyExists.selector, 0x5555));
        vault.proposeKey(0x5555, "evil.com", "x", modulus);
        vm.expectRevert(ReceiptVault.InvalidKey.selector);
        vault.proposeKey(0x6666, "swiggy.in", "google", new bytes(200));
        vm.stopPrank();
        assertEq(vault.activeKeyDomain(PK_UBER), keccak256("uber.com"));
    }

    function test_revert_merchantInactive() public {
        vm.prank(owner);
        vault.setMerchant(TPL_UBER, "uber.com", 500_000, 2_000_000, false);
        uint256[9] memory p = _inr(100);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.MerchantInactive.selector, TPL_UBER));
        _claim(p);
    }

    function test_revert_keyDomainMismatch() public {
        // a valid test-domain key presented for the Uber template
        uint256[9] memory p = _pubs(TPL_UBER, PK_TEST, 100, INR, T0);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.KeyDomainMismatch.selector, PK_TEST, TPL_UBER));
        _claim(p);
    }

    // ------------------------------------------------------------ check 5: employee / payee

    function test_revert_unregisteredEmployee() public {
        uint256[9] memory p = _inr(100);
        p[6] = 0xDEAD;
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.EmployeeNotRegistered.selector, 0xDEAD));
        _claim(p);
    }

    function test_revert_revokedEmployee() public {
        vm.prank(owner);
        vault.revokeEmployee(TO_COMMIT);
        uint256[9] memory p = _inr(100);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.EmployeeNotRegistered.selector, TO_COMMIT));
        _claim(p);
    }

    function test_revert_wrongPayee() public {
        uint256[9] memory p = _inr(100);
        p[7] = uint256(uint160(mallory));
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.WrongPayee.selector, alice, p[7]));
        _claim(p);
    }

    function test_revert_wrongPayee_highBitsSet() public {
        // a recipient field that truncates to alice but is not a clean uint160
        uint256[9] memory p = _inr(100);
        p[7] = (uint256(1) << 160) | uint256(uint160(alice));
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.WrongPayee.selector, alice, p[7]));
        _claim(p);
    }

    // ------------------------------------------------------------ check 6: window / registration

    function test_revert_expiredClaim() public {
        uint256 sentAt = T0;
        vm.warp(T0 + 60 days); // exactly 60 days old: still OK
        uint256[9] memory p = _pubs(TPL_UBER, PK_UBER, 100, INR, sentAt);
        _claimOk(p);
        vm.warp(T0 + 60 days + 1);
        uint256[9] memory q = _pubs(TPL_UBER, PK_UBER, 100, INR, sentAt);
        _allow(q);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ReceiptExpired.selector, sentAt));
        _claim(q);
    }

    function test_revert_futureClaim() public {
        uint256[9] memory ok = _pubs(TPL_UBER, PK_UBER, 100, INR, block.timestamp + 1 hours);
        _claimOk(ok);
        uint256[9] memory p = _pubs(TPL_UBER, PK_UBER, 100, INR, block.timestamp + 1 hours + 1);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ReceiptInFuture.selector, p[5]));
        _claim(p);
        // absurd sent_at must not overflow-panic
        p[5] = type(uint256).max;
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ReceiptInFuture.selector, p[5]));
        _claim(p);
    }

    function test_revert_receiptBeforeRegistration() public {
        // employee lost their salt and re-registered: new commitment registered at T0 + 1 day
        vm.warp(T0 + 1 days);
        uint256 newCommit = 0xBEEF;
        vm.prank(owner);
        vault.registerEmployee(newCommit, alice);
        uint256[9] memory p = _pubs(TPL_UBER, PK_UBER, 100, INR, T0 + 1 days - 1);
        p[6] = newCommit;
        _allow(p);
        vm.expectRevert(
            abi.encodeWithSelector(ReceiptVault.ReceiptBeforeRegistration.selector, p[5], uint64(T0 + 1 days))
        );
        _claim(p);
        p[5] = T0 + 1 days; // at/after registration: fine
        _claimOk(p);
    }

    // ------------------------------------------------------------ check 7: caps & FX

    function test_revert_perClaimCap() public {
        vm.prank(owner);
        vault.setEmployeeDailyCap(type(uint128).max);
        uint256[9] memory p = _inr(500_001);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ExceedsPerClaimCap.selector, 500_001, 500_000));
        _claim(p);
        _claimOk(_inr(500_000)); // boundary passes
    }

    function test_revert_merchantDailyCap() public {
        vm.prank(owner);
        vault.setEmployeeDailyCap(type(uint128).max);
        for (uint256 i; i < 4; i++) _claimOk(_inr(500_000)); // ₹20,000 = maxPerDay
        uint256[9] memory p = _inr(1);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ExceedsMerchantDailyCap.selector, TPL_UBER));
        _claim(p);
        vm.warp(block.timestamp + 1 days); // window reopens
        uint256[9] memory q = _pubs(TPL_UBER, PK_UBER, 1, INR, block.timestamp);
        _claimOk(q);
    }

    function test_revert_employeeDailyCap() public {
        // employee cap 50 USDC; ₹5,000 = $60 at 120e18 -> over the employee cap even within the merchant cap
        uint256[9] memory p = _inr(500_000);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ExceedsEmployeeDailyCap.selector, TO_COMMIT));
        _claim(p);
        // ₹4,000 = $48 ok, then $2.40 more hits $50.40 > $50
        _claimOk(_inr(400_000));
        uint256[9] memory q = _inr(20_000);
        _allow(q);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ExceedsEmployeeDailyCap.selector, TO_COMMIT));
        _claim(q);
        vm.warp(block.timestamp + 1 days);
        _claimOk(_pubs(TPL_UBER, PK_UBER, 20_000, INR, block.timestamp));
        assertEq(usdc.balanceOf(alice), 48e6 + 2.4e6);
    }

    function test_revert_noRate() public {
        vm.prank(owner);
        vault.setMerchant(TPL_UBER, "uber.com", 500_000, 2_000_000, true);
        uint256[9] memory p = _pubs(TPL_UBER, PK_UBER, 100, 978, T0); // EUR, never queued
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.NoRate.selector, 978, T0));
        _claim(p);
    }

    function test_fx_rateBeforeEffectiveTime() public {
        // a currency whose only rate is still in its 24 h timelock -> NoRate even though it is queued
        vm.prank(owner);
        vault.queueFxRate(978, 1.1e22);
        uint256[9] memory e = _pubs(TPL_UBER, PK_UBER, 100, 978, block.timestamp + 30 minutes);
        _allow(e);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.NoRate.selector, 978, e[5]));
        _claim(e);

        // INR: new rate queued at T0; receipts dated before T0+24h use the old rate, after it the new one
        vm.prank(owner);
        vm.expectEmit(address(vault));
        emit ReceiptVault.FxRateQueued(INR, 100e18, uint64(T0 + 24 hours));
        vault.queueFxRate(INR, 100e18);
        vm.warp(T0 + 25 hours);
        _claimOk(_pubs(TPL_UBER, PK_UBER, 10_000, INR, T0 + 24 hours - 1)); // old: 120 -> $1.20
        assertEq(usdc.balanceOf(alice), 1_200_000);
        _claimOk(_pubs(TPL_UBER, PK_UBER, 10_000, INR, T0 + 24 hours)); // new: 100 -> $1.00
        assertEq(usdc.balanceOf(alice), 2_200_000);
        assertEq(vault.fxHistory(INR).length, 2);
    }

    function test_fx_usdFixed_and_zeroPayout() public {
        vm.startPrank(owner);
        vm.expectRevert(ReceiptVault.UsdRateFixed.selector);
        vault.queueFxRate(USD, 1);
        vm.expectRevert(ReceiptVault.ZeroRate.selector);
        vault.queueFxRate(INR, 0);
        vault.queueFxRate(392, 1e17); // a rate so small that 1 minor unit pays 0
        vm.stopPrank();
        vm.warp(T0 + 24 hours);
        uint256[9] memory p = _pubs(TPL_UBER, PK_UBER, 1, 392, block.timestamp);
        _allow(p);
        vm.expectRevert(ReceiptVault.ZeroPayout.selector);
        _claim(p);
    }

    // ------------------------------------------------------------ check 8: aggregation

    function test_revert_aggregationReturnsFalse() public {
        uint256[9] memory p = _inr(100);
        _allow(p);
        agg.setForceFalse(true);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ProofNotAggregated.selector, AGG_ID));
        _claim(p);
    }

    function test_revert_leafMismatch() public {
        // aggregator knows the statement for amount 100; the claimant inflates the amount to 200
        uint256[9] memory p = _inr(100);
        _allow(p);
        p[3] = 200;
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ProofNotAggregated.selector, AGG_ID));
        _claim(p);
    }

    function test_setVerifierParams_changesLeaf() public {
        bytes32 v2 = keccak256("ultrahonk:v6");
        vm.prank(owner);
        vm.expectEmit(address(vault));
        emit ReceiptVault.VerifierParamsSet(address(agg), 3, v2);
        vault.setVerifierParams(IZkVerifyAggregation(address(agg)), 3, v2);
        uint256[9] memory p = _inr(100);
        _allow(p); // old domain + old version: must no longer pass
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ProofNotAggregated.selector, AGG_ID));
        _claim(p);
        agg.allow(3, AGG_ID, _leaf(p, VK, v2), _path(), 8, 5);
        _claim(p);
    }

    // ------------------------------------------------------------ check 9: agent

    function test_revert_forgedAgentSignature() public {
        uint256[9] memory p = _inr(100);
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1 hours);
        bytes memory sig = _sign(vault, 0xBADBAD, VAULT_ID, p[1], p[3], dl);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, sig);
        // malformed signature bytes
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, hex"1234");
    }

    function test_revert_agentSignedDifferentDecision() public {
        uint256[9] memory p = _inr(100);
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1 hours);
        // signed for another amount, another nullifier, another vault, another deadline
        bytes memory s1 = _sign(vault, agentPk, VAULT_ID, p[1], 99, dl);
        bytes memory s2 = _sign(vault, agentPk, VAULT_ID, p[1] + 1, p[3], dl);
        bytes memory s3 = _sign(vault, agentPk, VAULT_ID + 1, p[1], p[3], dl);
        bytes memory s4 = _sign(vault, agentPk, VAULT_ID, p[1], p[3], dl + 1);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, s1);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, s2);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, s3);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, s4);
    }

    function test_revert_expiredAgentSignature() public {
        uint256[9] memory p = _inr(100);
        _allow(p);
        uint64 dl = uint64(block.timestamp);
        bytes memory sig = _sign(vault, agentPk, VAULT_ID, p[1], p[3], dl);
        vm.warp(block.timestamp + 1);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.DecisionExpired.selector, dl));
        _claimWith(vault, p, VK, dl, sig);
    }

    function test_agentRotation() public {
        uint256 newPk = 0xB0B;
        vm.prank(owner);
        vault.setAgent(vm.addr(newPk));
        uint256[9] memory p = _inr(100);
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1 hours);
        vm.expectRevert(ReceiptVault.BadAgentSignature.selector);
        _claimWith(vault, p, VK, dl, _sign(vault, agentPk, VAULT_ID, p[1], p[3], dl));
        _claimWith(vault, p, VK, dl, _sign(vault, newPk, VAULT_ID, p[1], p[3], dl));
    }

    // ------------------------------------------------------------ check 10 / pause / funds

    function test_revert_paused() public {
        vm.prank(owner);
        vault.pause();
        uint256[9] memory p = _inr(100);
        _allow(p);
        vm.expectRevert(PausableUpgradeable.EnforcedPause.selector);
        _claim(p);
        vm.prank(owner);
        vault.unpause();
        _claim(p);
    }

    function test_revert_insufficientBalance() public {
        vm.prank(owner);
        vault.withdraw(owner, 1_000e6);
        assertEq(usdc.balanceOf(owner), 1_000e6);
        uint256[9] memory p = _inr(100);
        _allow(p);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.InsufficientVaultBalance.selector, 0, 12_000));
        _claim(p);
    }

    function test_onlyOwner_admin() public {
        vm.startPrank(mallory);
        bytes memory err = abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory);
        vm.expectRevert(err);
        vault.withdraw(mallory, 1);
        vm.expectRevert(err);
        vault.registerEmployee(1, mallory);
        vm.expectRevert(err);
        vault.revokeEmployee(TO_COMMIT);
        vm.expectRevert(err);
        vault.proposeKey(9, "x.com", "s", new bytes(128));
        vm.expectRevert(err);
        vault.cancelKey(PK_UBER);
        vm.expectRevert(err);
        vault.setMerchant(1, "x.com", 1, 1, true);
        vm.expectRevert(err);
        vault.setAgent(mallory);
        vm.expectRevert(err);
        vault.setVerifierParams(IZkVerifyAggregation(mallory), 1, bytes32(0));
        vm.expectRevert(err);
        vault.setAcceptedVk(bytes32(0), true);
        vm.expectRevert(err);
        vault.queueFxRate(INR, 1);
        vm.expectRevert(err);
        vault.setEmployeeDailyCap(1);
        vm.expectRevert(err);
        vault.pause();
        vm.stopPrank();
    }

    // ------------------------------------------------------------ sandbox (vaultId 0)

    function test_sandbox_registerSelf() public {
        vm.expectRevert(ReceiptVault.NotSandbox.selector);
        vault.registerSelf(123);

        ReceiptVault sb = _deploy(0);
        vm.startPrank(owner);
        sb.setAcceptedVk(VK, true);
        sb.proposeKey(PK_TEST, "test.receiptproof.xyz", "rp1", new bytes(128));
        sb.setMerchant(TPL_TEST_USD, "test.receiptproof.xyz", 60, 240, true); // small caps
        vm.stopPrank();
        usdc.mint(address(sb), 20e6);
        vm.warp(block.timestamp + 24 hours);

        vm.prank(alice);
        sb.registerSelf(TO_COMMIT);
        assertEq(sb.employee(TO_COMMIT), alice);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.AlreadyRegistered.selector, TO_COMMIT));
        sb.registerSelf(TO_COMMIT);

        uint256[9] memory p = _pubs(TPL_TEST_USD, PK_TEST, 50, USD, block.timestamp);
        p[8] = 0;
        _allow(p);
        uint64 dl = uint64(block.timestamp + 1 hours);
        _claimWith(sb, p, VK, dl, _sign(sb, agentPk, 0, p[1], p[3], dl));
        assertEq(usdc.balanceOf(alice), 0.5e6);

        uint256[9] memory q = _pubs(TPL_TEST_USD, PK_TEST, 61, USD, block.timestamp);
        q[8] = 0;
        _allow(q);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.ExceedsPerClaimCap.selector, 61, 60));
        _claimWith(sb, q, VK, dl, _sign(sb, agentPk, 0, q[1], q[3], dl));

        // a sandbox proof cannot be replayed into a company vault
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.WrongVault.selector, 0, VAULT_ID));
        _claimWith(vault, q, VK, dl, _sign(vault, agentPk, 0, q[1], q[3], dl));
    }

    function test_sandbox_registerFor_onlyRegistrar_onlySandbox() public {
        address relayer = makeAddr("relayer");
        vm.prank(owner);
        vault.setRegistrar(relayer);
        vm.prank(relayer);
        vm.expectRevert(ReceiptVault.NotSandbox.selector);
        vault.registerFor(1, alice);

        ReceiptVault sb = _deploy(0);
        vm.prank(mallory);
        vm.expectRevert(ReceiptVault.NotRegistrar.selector);
        sb.registerFor(1, mallory);

        vm.prank(owner);
        sb.setRegistrar(relayer);
        vm.prank(relayer);
        vm.expectRevert(ReceiptVault.ZeroAddress.selector);
        sb.registerFor(1, address(0));
        vm.prank(relayer);
        sb.registerFor(1, alice);
        assertEq(sb.employee(1), alice);
        assertEq(sb.registeredAt(1), uint64(block.timestamp));
        vm.prank(relayer);
        vm.expectRevert(abi.encodeWithSelector(ReceiptVault.AlreadyRegistered.selector, 1));
        sb.registerFor(1, mallory);
    }

    // ------------------------------------------------------------ upgrade safety

    function test_upgrade_onlyOwner_preservesState() public {
        _claimOk(_inr(100));
        ReceiptVaultV2 v2 = new ReceiptVaultV2();
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSelector(OwnableUpgradeable.OwnableUnauthorizedAccount.selector, mallory));
        vault.upgradeToAndCall(address(v2), "");
        vm.prank(owner);
        vault.upgradeToAndCall(address(v2), "");
        assertEq(ReceiptVaultV2(address(vault)).version(), 2);
        assertEq(vault.vaultId(), VAULT_ID);
        assertEq(vault.employee(TO_COMMIT), alice);
        assertEq(vault.agent(), agentAddr);
        assertTrue(vault.acceptedVk(VK));
        assertEq(vault.rateAt(INR, T0), INR_RATE);
        // EIP-712 domain unchanged after upgrade: an existing signature still verifies
        _claimOk(_inr(100));
    }

    // ------------------------------------------------------------ configurable timelocks

    function test_delays_defaultTo24h() public view {
        assertEq(vault.keyActivationDelay(), 24 hours);
        assertEq(vault.fxDelay(), 24 hours);
        assertTrue(vault.delaysLocked()); // setUp already proposed keys
    }

    function test_setDelays_lockedAfterFirstKey() public {
        vm.prank(owner);
        vm.expectRevert(ReceiptVault.DelaysLocked.selector);
        vault.setDelays(10 minutes, 10 minutes);
    }

    function test_setDelays_shortSandboxDelay_appliesToKeysAndFx() public {
        ReceiptVault v = _deploy(99);
        vm.prank(mallory);
        vm.expectRevert(abi.encodeWithSignature("OwnableUnauthorizedAccount(address)", mallory));
        v.setDelays(10 minutes, 10 minutes);

        vm.startPrank(owner);
        vm.expectEmit(address(v));
        emit ReceiptVault.DelaysSet(10 minutes, 5 minutes);
        v.setDelays(10 minutes, 5 minutes);
        assertEq(v.keyActivationDelay(), 10 minutes);
        assertEq(v.fxDelay(), 5 minutes);
        v.proposeKey(0x7777, "sandbox.tremor.in", "tremor1", new bytes(256));
        assertTrue(v.delaysLocked());
        vm.expectRevert(ReceiptVault.DelaysLocked.selector);
        v.setDelays(1, 1); // cannot shorten after a key exists
        v.queueFxRate(INR, INR_RATE);
        vm.stopPrank();

        assertEq(v.activeKeyDomain(0x7777), bytes32(0));
        vm.warp(block.timestamp + 10 minutes);
        assertEq(v.activeKeyDomain(0x7777), keccak256("sandbox.tremor.in"));
        assertEq(v.rateAt(INR, block.timestamp), INR_RATE);
    }

    function test_setDelays_lockedAfterFirstFxRate() public {
        ReceiptVault v = _deploy(98);
        vm.startPrank(owner);
        v.queueFxRate(INR, INR_RATE);
        vm.expectRevert(ReceiptVault.DelaysLocked.selector);
        v.setDelays(1, 1);
        vm.stopPrank();
    }

    function test_cannotReinitialize() public {
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        vault.initialize(mallory, IERC20(address(usdc)), 0, IZkVerifyAggregation(address(agg)), 0, 0, mallory, 0);
        ReceiptVault impl = new ReceiptVault();
        vm.expectRevert(Initializable.InvalidInitialization.selector);
        impl.initialize(mallory, IERC20(address(usdc)), 0, IZkVerifyAggregation(address(agg)), 0, 0, mallory, 0);
    }

    // ------------------------------------------------------------ fuzz

    function testFuzz_payoutRoundsDown(uint64 amount, uint192 rate) public {
        amount = uint64(bound(amount, 1, 500_000));
        rate = uint192(bound(rate, 1e18, 1e24));
        vm.startPrank(owner);
        vault.queueFxRate(INR, rate);
        vault.setEmployeeDailyCap(type(uint128).max);
        vm.stopPrank();
        usdc.mint(address(vault), type(uint96).max);
        vm.warp(T0 + 24 hours);
        _claimOk(_pubs(TPL_UBER, PK_UBER, amount, INR, block.timestamp));
        assertEq(usdc.balanceOf(alice), uint256(amount) * rate / 1e18);
    }

    /// Real ReceiptProof proof (CI fixture good_inr, V5_0 ZK): the contract's statementLeaf must equal the
    /// leaf computed independently in JS from the same public inputs and vkHash.
    function test_realProof_statementLeaf_matchesJs() public view {
        string memory j = vm.readFile("test/fixtures/real_receipt_good_inr.json");
        bytes32[] memory raw = vm.parseJsonBytes32Array(j, ".pubs");
        uint256[9] memory p;
        for (uint256 i = 0; i < 9; i++) p[i] = uint256(raw[i]);
        bytes32 vkHash = vm.parseJsonBytes32(j, ".vkHash");
        assertEq(vault.statementLeaf(p, vkHash), vm.parseJsonBytes32(j, ".leaf"));
        assertEq(p[2], 100); // template
        assertEq(p[3], 124950); // INR 1,249.50 in paise
        assertEq(p[4], 356);
    }
}
