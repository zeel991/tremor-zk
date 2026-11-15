// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Script, console2} from "forge-std/Script.sol";
import {ERC1967Proxy} from "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {ReceiptVault} from "../src/ReceiptVault.sol";
import {IZkVerifyAggregation} from "../src/IZkVerifyAggregation.sol";

/// Deploys one ReceiptVault (implementation + UUPS proxy) and configures it from env vars.
///
/// This script never reads a private key. The signer comes from the forge CLI (`--account`,
/// `--ledger`, `--sender` ...). Without `--broadcast` it is a local simulation only.
///
/// Required env:
///   USDC                 USDC token address
///   VAULT_ID             uint (0 = sandbox with open registerSelf)
///   ZKV                  zkVerify aggregation contract (Base 0xCb47…2b69 / Base Sepolia 0x0807…e8A8)
///   AGENT                EIP-712 decision signer
/// Optional env (defaults in brackets):
///   OWNER                final owner [the broadcaster]; ownership is transferred after configuration
///   DOMAIN_ID            [2]
///   VERSION_HASH         [sha256("ultrahonk:v5.0") = 0x91ea…c589]
///   EMPLOYEE_DAILY_CAP   USDC base units [50e6]
///   ACCEPTED_VKS         comma-separated bytes32 vkHashes [none]
///   TEMPLATE_IDS, MERCHANT_DOMAINS, MAX_PER_CLAIM, MAX_PER_DAY   parallel comma-separated lists [none]
///   INR_RATE_E18         queue an INR (356) rate, USDC base units per paise × 1e18 [none]
///   KEY_HASHES, KEY_DOMAINS, KEY_SELECTORS, KEY_MODULI           parallel lists; keys activate 24 h later [none]
contract Deploy is Script {
    bytes32 constant DEFAULT_VERSION_HASH = 0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589;

    function run() external returns (ReceiptVault vault) {
        address usdc = vm.envAddress("USDC");
        uint256 vaultId = vm.envUint("VAULT_ID");
        address zkv = vm.envAddress("ZKV");
        address agent = vm.envAddress("AGENT");
        uint256 domainId = vm.envOr("DOMAIN_ID", uint256(2));
        bytes32 versionHash = vm.envOr("VERSION_HASH", DEFAULT_VERSION_HASH);
        uint128 empCap = uint128(vm.envOr("EMPLOYEE_DAILY_CAP", uint256(50e6)));

        vm.startBroadcast();
        address deployer = msg.sender;
        address owner = vm.envOr("OWNER", deployer);

        ReceiptVault impl = new ReceiptVault();
        bytes memory init = abi.encodeCall(
            ReceiptVault.initialize,
            (deployer, IERC20(usdc), vaultId, IZkVerifyAggregation(zkv), domainId, versionHash, agent, empCap)
        );
        vault = ReceiptVault(address(new ERC1967Proxy(address(impl), init)));

        bytes32[] memory vks = vm.envOr("ACCEPTED_VKS", ",", new bytes32[](0));
        for (uint256 i; i < vks.length; i++) vault.setAcceptedVk(vks[i], true);

        _configureMerchants(vault);
        _proposeKeys(vault);

        uint256 inrRate = vm.envOr("INR_RATE_E18", uint256(0));
        if (inrRate > 0) vault.queueFxRate(356, uint192(inrRate));

        if (owner != deployer) vault.transferOwnership(owner);
        vm.stopBroadcast();

        console2.log("implementation", address(impl));
        console2.log("vault (proxy) ", address(vault));
        console2.log("vaultId       ", vaultId);
        console2.log("owner         ", owner);
    }

    function _configureMerchants(ReceiptVault vault) internal {
        uint256[] memory tpl = vm.envOr("TEMPLATE_IDS", ",", new uint256[](0));
        if (tpl.length > 0) {
            string[] memory doms = vm.envString("MERCHANT_DOMAINS", ",");
            uint256[] memory perClaim = vm.envUint("MAX_PER_CLAIM", ",");
            uint256[] memory perDay = vm.envUint("MAX_PER_DAY", ",");
            require(doms.length == tpl.length && perClaim.length == tpl.length && perDay.length == tpl.length, "merchant lists");
            for (uint256 i; i < tpl.length; i++) {
                vault.setMerchant(tpl[i], doms[i], uint64(perClaim[i]), uint64(perDay[i]), true);
            }
        }
    }

    function _proposeKeys(ReceiptVault vault) internal {
        uint256[] memory keyHashes = vm.envOr("KEY_HASHES", ",", new uint256[](0));
        if (keyHashes.length > 0) {
            string[] memory kd = vm.envString("KEY_DOMAINS", ",");
            string[] memory ks = vm.envString("KEY_SELECTORS", ",");
            bytes[] memory km = vm.envBytes("KEY_MODULI", ",");
            require(kd.length == keyHashes.length && ks.length == keyHashes.length && km.length == keyHashes.length, "key lists");
            for (uint256 i; i < keyHashes.length; i++) vault.proposeKey(keyHashes[i], kd[i], ks[i], km[i]);
        }
    }
}
