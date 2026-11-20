// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

import {Initializable} from "@openzeppelin/contracts-upgradeable/proxy/utils/Initializable.sol";
import {UUPSUpgradeable} from "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import {OwnableUpgradeable} from "@openzeppelin/contracts-upgradeable/access/OwnableUpgradeable.sol";
import {PausableUpgradeable} from "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import {EIP712Upgradeable} from "@openzeppelin/contracts-upgradeable/utils/cryptography/EIP712Upgradeable.sol";
import {ECDSA} from "@openzeppelin/contracts/utils/cryptography/ECDSA.sol";
import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {SafeERC20} from "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import {Math} from "@openzeppelin/contracts/utils/math/Math.sol";
import {IZkVerifyAggregation} from "./IZkVerifyAggregation.sol";

/// @title ReceiptVault
/// @notice Pays USDC to a registered employee wallet for a DKIM-signed merchant receipt, proven in
///         zero knowledge (Noir/UltraHonk) and aggregated by zkVerify. See SPEC §7 and §19.
///
/// Design choices (documented here as required):
/// - ONE VAULT PER CONTRACT (per proxy). `vaultId` is written once in `initialize` and has no setter,
///   so it is immutable in practice; `claim` requires `pubs[8] == vaultId`. One proxy per company keeps
///   every mapping un-nested and makes "a bad DKIM key only costs its own vault" (SPEC §7.2) a storage
///   fact rather than an access-control rule. A Solidity `immutable` is not used because a UUPS
///   implementation is shared by proxies; the storage slot plays that role.
/// - UUPS upgradeable (OpenZeppelin v5.1). Only the owner can upgrade. The implementation constructor
///   disables initializers.
/// - `vaultId == 0` is the judges' sandbox: `registerSelf` is open there and reverts everywhere else.
///   Sandbox caps are ordinary merchant / employee caps, set small by the deployer.
/// - Caps: `Merchant.maxPerClaim` / `maxPerDay` are in the merchant template's minor units (each
///   template has one fixed currency, SPEC §19.3); `maxPerDay` is a vault-wide per-merchant total.
///   The per-employee cap is in USDC base units so it spans currencies.
///   "Rolling" daily windows are implemented as a 24 h window opened by the first claim after the
///   previous window expired (not a true sliding window): worst case 2x the cap inside one 24 h span.
/// - FX: payout = amount_minor * rate / 1e18 with the newest queued rate whose effectiveAt <= sent_at
///   (SPEC §19.5). USD (840) is fixed at 1:1 (1e4 * 1e18 per cent) and cannot be queued (SPEC §7.1
///   step 10 "USD receipts pay 1:1"). The rate lookup happens in step 7 because the per-employee cap
///   is denominated in USDC.
contract ReceiptVault is
    Initializable,
    UUPSUpgradeable,
    OwnableUpgradeable,
    PausableUpgradeable,
    EIP712Upgradeable
{
    using SafeERC20 for IERC20;

    // ---------------------------------------------------------------- constants

    /// @dev Default timelocks. A vault can set shorter ones once, before its first key or rate (setDelays).
    uint256 public constant KEY_ACTIVATION_DELAY = 24 hours;
    uint256 public constant FX_DELAY = 24 hours;
    uint256 public constant MAX_RECEIPT_AGE = 60 days;
    uint256 public constant MAX_FUTURE_SKEW = 1 hours;
    uint256 public constant WINDOW = 1 days;
    uint256 public constant USD = 840;
    uint256 public constant USD_RATE_E18 = 1e4 * 1e18; // 1 cent = 1e4 USDC base units
    /// @dev pallet hash_context_data() for UltraHonk.
    bytes32 public constant ULTRAHONK_CTX = keccak256("ultrahonk");
    /// @dev SPEC §19.4 (frozen).
    bytes32 public constant DECISION_TYPEHASH = keccak256(
        "Decision(uint256 vaultId,uint256 nullifier,uint256 amountMinor,bytes32 policyHash,uint64 deadline)"
    );

    // ---------------------------------------------------------------- types

    struct Merchant {
        bytes32 domainHash; // keccak256(bytes(domain)), e.g. keccak256("uber.com")
        uint64 maxPerClaim; // minor units of the template currency
        uint64 maxPerDay; // minor units, vault-wide for this merchant
        bool active;
    }

    struct DkimKey {
        bytes32 domainHash; // 0 => unknown
        uint64 activatesAt;
        bool cancelled;
        string domain;
        string selector;
        bytes modulus; // full RSA modulus, big-endian (128 or 256 bytes)
    }

    struct FxPoint {
        uint64 effectiveAt;
        uint192 rateE18;
    }

    struct Window {
        uint64 start;
        uint192 used;
    }

    // ---------------------------------------------------------------- storage

    IERC20 public usdc;
    uint256 public vaultId;

    IZkVerifyAggregation public zkv;
    uint256 public domainId;
    bytes32 public versionHash;
    address public agent;

    mapping(bytes32 vkHash => bool) public acceptedVk;
    mapping(uint256 pubkeyHash => DkimKey) internal _keys;
    mapping(uint256 templateId => Merchant) public merchants;
    mapping(uint256 toCommit => address) public employee;
    mapping(uint256 toCommit => uint64) public registeredAt;
    mapping(uint256 nullifier => bool) public spent;
    mapping(uint256 currency => FxPoint[]) internal _fx;

    uint128 public employeeDailyCap; // USDC base units
    mapping(uint256 templateId => Window) public merchantWindow;
    mapping(uint256 toCommit => Window) public employeeWindow;

    address public registrar; // sandbox gas relayer (registerFor)

    // Timelock overrides (0 = default 24 h). Settable once, only before the first key or FX rate is queued,
    // so a key can never activate faster than the delay that was public when it was proposed.
    uint64 public keyDelayOverride;
    uint64 public fxDelayOverride;
    bool public delaysLocked;

    uint256[38] private __gap;

    // ---------------------------------------------------------------- errors (one per claim check)

    error VkNotAccepted(bytes32 vkHash); // 1
    error WrongVault(uint256 got, uint256 expected); // 2
    error NullifierSpent(uint256 nullifier); // 3
    error UnknownKey(uint256 pubkeyHash); // 4
    error KeyNotYetActive(uint256 pubkeyHash, uint64 activatesAt); // 4
    error MerchantInactive(uint256 templateId); // 4
    error KeyDomainMismatch(uint256 pubkeyHash, uint256 templateId); // 4
    error EmployeeNotRegistered(uint256 toCommit); // 5
    error WrongPayee(address registered, uint256 provenRecipient); // 5
    error ReceiptExpired(uint256 sentAt); // 6
    error ReceiptInFuture(uint256 sentAt); // 6
    error ReceiptBeforeRegistration(uint256 sentAt, uint64 registeredAt); // 6
    error ExceedsPerClaimCap(uint256 amount, uint256 cap); // 7
    error ExceedsMerchantDailyCap(uint256 templateId); // 7
    error NoRate(uint256 currency, uint256 at); // 7 (FX lookup)
    error ZeroPayout(); // 7
    error ExceedsEmployeeDailyCap(uint256 toCommit); // 7
    error ProofNotAggregated(uint256 aggregationId); // 8
    error DecisionExpired(uint64 deadline); // 9
    error BadAgentSignature(); // 9
    error InsufficientVaultBalance(uint256 balance, uint256 payout); // 10

    // admin errors
    error ZeroAddress();
    error NotSandbox();
    error AlreadyRegistered(uint256 toCommit);
    error KeyExists(uint256 pubkeyHash);
    error InvalidKey();
    error KeyAlreadyActive(uint256 pubkeyHash);
    error UsdRateFixed();
    error ZeroRate();
    error NotRegistrar();
    error DelaysLocked();

    // ---------------------------------------------------------------- events

    event DelaysSet(uint64 keyActivationDelay, uint64 fxDelay);

    event Claimed(
        uint256 indexed nullifier,
        uint256 indexed toCommit,
        address indexed recipient,
        uint256 templateId,
        uint256 amountMinor,
        uint256 currency,
        uint256 payout,
        uint256 aggregationId,
        bytes32 policyHash
    );
    event Deposited(address indexed from, uint256 amount);
    event Withdrawn(address indexed to, uint256 amount);
    event MerchantSet(uint256 indexed templateId, string domain, bytes32 domainHash, uint64 maxPerClaim, uint64 maxPerDay, bool active);
    event KeyProposed(uint256 indexed pubkeyHash, string domain, string selector, bytes modulus, uint64 activatesAt);
    event KeyCancelled(uint256 indexed pubkeyHash);
    event EmployeeRegistered(uint256 indexed toCommit, address indexed wallet, uint64 registeredAt, bool selfRegistered);
    event EmployeeRevoked(uint256 indexed toCommit, address indexed wallet);
    event AgentSet(address indexed agent);
    event VerifierParamsSet(address indexed zkv, uint256 domainId, bytes32 versionHash);
    event AcceptedVkSet(bytes32 indexed vkHash, bool accepted);
    event FxRateQueued(uint256 indexed currency, uint256 rateE18, uint64 effectiveAt);
    event EmployeeDailyCapSet(uint128 cap);
    event RegistrarSet(address indexed registrar);

    // ---------------------------------------------------------------- init / upgrade

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        address owner_,
        IERC20 usdc_,
        uint256 vaultId_,
        IZkVerifyAggregation zkv_,
        uint256 domainId_,
        bytes32 versionHash_,
        address agent_,
        uint128 employeeDailyCap_
    ) external initializer {
        if (address(usdc_) == address(0) || address(zkv_) == address(0) || agent_ == address(0)) revert ZeroAddress();
        __Ownable_init(owner_);
        __Pausable_init();
        __EIP712_init("ReceiptVault", "1");
        usdc = usdc_;
        vaultId = vaultId_;
        zkv = zkv_;
        domainId = domainId_;
        versionHash = versionHash_;
        agent = agent_;
        employeeDailyCap = employeeDailyCap_;
        emit VerifierParamsSet(address(zkv_), domainId_, versionHash_);
        emit AgentSet(agent_);
        emit EmployeeDailyCapSet(employeeDailyCap_);
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    // ---------------------------------------------------------------- claim

    /// @param pubs SPEC §19.1: [pubkey_hash, nullifier, template_id, amount_minor, currency, sent_at,
    ///             to_commit, recipient, vault_id]
    /// @param policyHash / deadline / agentSig: the agent's EIP-712 Decision (SPEC §19.4).
    function claim(
        uint256[9] calldata pubs,
        bytes32 vkHash,
        uint256 aggregationId,
        bytes32[] calldata path,
        uint256 leafCount,
        uint256 index,
        bytes32 policyHash,
        uint64 deadline,
        bytes calldata agentSig
    ) external whenNotPaused {
        // 1. accepted verification key
        if (!acceptedVk[vkHash]) revert VkNotAccepted(vkHash);
        // 2. vault binding
        if (pubs[8] != vaultId) revert WrongVault(pubs[8], vaultId);
        // 3. one-shot nullifier
        if (spent[pubs[1]]) revert NullifierSpent(pubs[1]);
        // 4. DKIM key is known, past its 24 h timelock, and belongs to the active merchant's domain
        _checkKeyAndMerchant(pubs[0], pubs[2]);
        // 5. registered inbox, payout only to the registered wallet
        _checkPayee(pubs[6], pubs[7]);
        // 6. claim window and re-registration rule
        _checkWindow(pubs[5], pubs[6]);
        // 7. caps (per claim, per merchant per day, per employee per day in USDC)
        uint256 payout = _applyCaps(pubs);
        // 8. zkVerify aggregation inclusion
        _checkAggregation(pubs, vkHash, aggregationId, path, leafCount, index);
        // 9. agent approval
        _checkAgent(pubs[1], pubs[3], policyHash, deadline, agentSig);
        // 10. effects + payout (daily totals were written in step 7; a revert undoes them)
        _pay(pubs, payout, aggregationId, policyHash);
    }

    function _pay(uint256[9] calldata pubs, uint256 payout, uint256 aggregationId, bytes32 policyHash) internal {
        spent[pubs[1]] = true;
        address recipient = address(uint160(pubs[7]));
        uint256 bal = usdc.balanceOf(address(this));
        if (bal < payout) revert InsufficientVaultBalance(bal, payout);
        emit Claimed(pubs[1], pubs[6], recipient, pubs[2], pubs[3], pubs[4], payout, aggregationId, policyHash);
        usdc.safeTransfer(recipient, payout);
    }

    /// @notice SPEC §19.1 statement leaf:
    /// keccak256(keccak256("ultrahonk") ‖ vkHash ‖ versionHash ‖ keccak256(pubs as 9×32 bytes)).
    function statementLeaf(uint256[9] calldata pubs, bytes32 vkHash) public view returns (bytes32) {
        return keccak256(abi.encodePacked(ULTRAHONK_CTX, vkHash, versionHash, keccak256(abi.encodePacked(pubs))));
    }

    function decisionDigest(uint256 nullifier, uint256 amountMinor, bytes32 policyHash, uint64 deadline)
        public
        view
        returns (bytes32)
    {
        return _hashTypedDataV4(
            keccak256(abi.encode(DECISION_TYPEHASH, vaultId, nullifier, amountMinor, policyHash, deadline))
        );
    }

    function _checkAggregation(
        uint256[9] calldata pubs,
        bytes32 vkHash,
        uint256 aggregationId,
        bytes32[] calldata path,
        uint256 leafCount,
        uint256 index
    ) internal view {
        _verifyLeaf(statementLeaf(pubs, vkHash), aggregationId, path, leafCount, index);
    }

    /// @dev The single place the vault calls zkVerify (exercised against the real Base Sepolia
    ///      contract by test/ZkVerifyFork.t.sol through a harness).
    function _verifyLeaf(bytes32 leaf, uint256 aggregationId, bytes32[] calldata path, uint256 leafCount, uint256 index)
        internal
        view
    {
        if (!zkv.verifyProofAggregation(domainId, aggregationId, leaf, path, leafCount, index)) {
            revert ProofNotAggregated(aggregationId);
        }
    }

    function _checkKeyAndMerchant(uint256 pubkeyHash, uint256 templateId) internal view {
        DkimKey storage k = _keys[pubkeyHash];
        if (k.domainHash == bytes32(0) || k.cancelled) revert UnknownKey(pubkeyHash);
        if (block.timestamp < k.activatesAt) revert KeyNotYetActive(pubkeyHash, k.activatesAt);
        Merchant storage m = merchants[templateId];
        if (!m.active) revert MerchantInactive(templateId);
        if (m.domainHash != k.domainHash) revert KeyDomainMismatch(pubkeyHash, templateId);
    }

    function _checkPayee(uint256 toCommit, uint256 recipient) internal view {
        address w = employee[toCommit];
        if (w == address(0)) revert EmployeeNotRegistered(toCommit);
        if (recipient >> 160 != 0 || address(uint160(recipient)) != w) revert WrongPayee(w, recipient);
    }

    function _checkWindow(uint256 sentAt, uint256 toCommit) internal view {
        // future check first so `sentAt + MAX_RECEIPT_AGE` below cannot overflow
        if (sentAt > block.timestamp + MAX_FUTURE_SKEW) revert ReceiptInFuture(sentAt);
        if (sentAt + MAX_RECEIPT_AGE < block.timestamp) revert ReceiptExpired(sentAt);
        uint64 reg = registeredAt[toCommit];
        if (sentAt < reg) revert ReceiptBeforeRegistration(sentAt, reg);
    }

    function _applyCaps(uint256[9] calldata pubs) internal returns (uint256 payout) {
        uint256 amount = pubs[3];
        Merchant storage m = merchants[pubs[2]];
        if (amount > m.maxPerClaim) revert ExceedsPerClaimCap(amount, m.maxPerClaim);
        if (!_consume(merchantWindow[pubs[2]], amount, m.maxPerDay)) revert ExceedsMerchantDailyCap(pubs[2]);
        payout = Math.mulDiv(amount, rateAt(pubs[4], pubs[5]), 1e18);
        if (payout == 0) revert ZeroPayout();
        if (!_consume(employeeWindow[pubs[6]], payout, employeeDailyCap)) revert ExceedsEmployeeDailyCap(pubs[6]);
    }

    function _consume(Window storage w, uint256 amount, uint256 cap) internal returns (bool) {
        if (block.timestamp >= uint256(w.start) + WINDOW) {
            w.start = uint64(block.timestamp);
            w.used = 0;
        }
        uint256 used = uint256(w.used) + amount;
        if (used > cap) return false;
        w.used = uint192(used); // used <= cap <= type(uint128).max or uint64.max
        return true;
    }

    function _checkAgent(uint256 nullifier, uint256 amountMinor, bytes32 policyHash, uint64 deadline, bytes calldata sig)
        internal
        view
    {
        if (block.timestamp > deadline) revert DecisionExpired(deadline);
        (address signer, ECDSA.RecoverError err,) =
            ECDSA.tryRecover(decisionDigest(nullifier, amountMinor, policyHash, deadline), sig);
        if (err != ECDSA.RecoverError.NoError || signer != agent) revert BadAgentSignature();
    }

    // ---------------------------------------------------------------- timelocks

    /// @notice One-time timelock setting for this vault, e.g. a short delay on a testnet sandbox vault.
    ///         Only before the first proposeKey/queueFxRate; 0 keeps the 24 h default.
    function setDelays(uint64 keyDelay, uint64 fxDelay_) external onlyOwner {
        if (delaysLocked) revert DelaysLocked();
        keyDelayOverride = keyDelay;
        fxDelayOverride = fxDelay_;
        emit DelaysSet(uint64(keyActivationDelay()), uint64(fxDelay()));
    }

    function keyActivationDelay() public view returns (uint256) {
        return keyDelayOverride == 0 ? KEY_ACTIVATION_DELAY : keyDelayOverride;
    }

    function fxDelay() public view returns (uint256) {
        return fxDelayOverride == 0 ? FX_DELAY : fxDelayOverride;
    }

    // ---------------------------------------------------------------- FX (SPEC §19.5)

    /// @notice Queue a rate (USDC base units per one minor unit, scaled 1e18), effective in 24 h.
    function queueFxRate(uint256 currency, uint192 rateE18) external onlyOwner {
        if (currency == USD) revert UsdRateFixed();
        if (rateE18 == 0) revert ZeroRate();
        delaysLocked = true;
        uint64 eff = uint64(block.timestamp + fxDelay());
        _fx[currency].push(FxPoint(eff, rateE18));
        emit FxRateQueued(currency, rateE18, eff);
    }

    /// @notice Newest rate with effectiveAt <= at. Reverts NoRate if none.
    function rateAt(uint256 currency, uint256 at) public view returns (uint256) {
        if (currency == USD) return USD_RATE_E18;
        FxPoint[] storage h = _fx[currency];
        // effectiveAt is non-decreasing (block.timestamp + constant): binary search for the last <= at
        uint256 lo = 0;
        uint256 hi = h.length;
        while (lo < hi) {
            uint256 mid = (lo + hi) / 2;
            if (h[mid].effectiveAt <= at) lo = mid + 1;
            else hi = mid;
        }
        if (lo == 0) revert NoRate(currency, at);
        return h[lo - 1].rateE18;
    }

    function fxHistory(uint256 currency) external view returns (FxPoint[] memory) {
        return _fx[currency];
    }

    // ---------------------------------------------------------------- DKIM keys (SPEC §7.2)

    /// @notice Propose a DKIM key. Active after 24 h; cancellable until then. The full modulus is
    ///         stored so anyone can compare it with DNS / archive.zk.email. The contract cannot check
    ///         that `pubkeyHash == poseidon_large(modulus)` (no Poseidon here); the off-chain checker does.
    function proposeKey(uint256 pubkeyHash, string calldata domain, string calldata selector, bytes calldata modulus)
        external
        onlyOwner
    {
        if (pubkeyHash == 0 || bytes(domain).length == 0 || (modulus.length != 128 && modulus.length != 256)) {
            revert InvalidKey();
        }
        DkimKey storage k = _keys[pubkeyHash];
        if (k.domainHash != bytes32(0) && !k.cancelled) revert KeyExists(pubkeyHash);
        delaysLocked = true;
        uint64 activatesAt = uint64(block.timestamp + keyActivationDelay());
        _keys[pubkeyHash] = DkimKey(keccak256(bytes(domain)), activatesAt, false, domain, selector, modulus);
        emit KeyProposed(pubkeyHash, domain, selector, modulus, activatesAt);
    }

    /// @notice Cancel a proposed key during its 24 h window.
    function cancelKey(uint256 pubkeyHash) external onlyOwner {
        DkimKey storage k = _keys[pubkeyHash];
        if (k.domainHash == bytes32(0) || k.cancelled) revert UnknownKey(pubkeyHash);
        if (block.timestamp >= k.activatesAt) revert KeyAlreadyActive(pubkeyHash);
        k.cancelled = true;
        emit KeyCancelled(pubkeyHash);
    }

    function dkimKey(uint256 pubkeyHash) external view returns (DkimKey memory) {
        return _keys[pubkeyHash];
    }

    /// @notice domainHash of an active key, 0 if unknown / pending / cancelled.
    function activeKeyDomain(uint256 pubkeyHash) external view returns (bytes32) {
        DkimKey storage k = _keys[pubkeyHash];
        if (k.cancelled || block.timestamp < k.activatesAt) return bytes32(0);
        return k.domainHash;
    }

    // ---------------------------------------------------------------- merchants / employees

    function setMerchant(uint256 templateId, string calldata domain, uint64 maxPerClaim, uint64 maxPerDay, bool active)
        external
        onlyOwner
    {
        bytes32 h = keccak256(bytes(domain));
        merchants[templateId] = Merchant(h, maxPerClaim, maxPerDay, active);
        emit MerchantSet(templateId, domain, h, maxPerClaim, maxPerDay, active);
    }

    function registerEmployee(uint256 toCommit, address wallet) external onlyOwner {
        if (wallet == address(0)) revert ZeroAddress();
        _register(toCommit, wallet, false);
    }

    /// @notice Sandbox only (vaultId 0): anyone registers an inbox commitment to their own wallet.
    ///         First come; an existing registration cannot be overwritten.
    function registerSelf(uint256 toCommit) external whenNotPaused {
        if (vaultId != 0) revert NotSandbox();
        if (employee[toCommit] != address(0)) revert AlreadyRegistered(toCommit);
        _register(toCommit, msg.sender, true);
    }

    /// @notice Sandbox only: the gas relayer registers an inbox commitment for a judge's wallet, so a
    ///         judge needs no testnet ETH. Same first-come rule as registerSelf. Worst case a griefer
    ///         front-runs a commitment to their own wallet: claims then revert WrongPayee (proofs bind
    ///         `recipient`), so it is a denial of service on the sandbox, never a theft.
    function registerFor(uint256 toCommit, address wallet) external whenNotPaused {
        if (vaultId != 0) revert NotSandbox();
        if (msg.sender != registrar) revert NotRegistrar();
        if (wallet == address(0)) revert ZeroAddress();
        if (employee[toCommit] != address(0)) revert AlreadyRegistered(toCommit);
        _register(toCommit, wallet, true);
    }

    function setRegistrar(address registrar_) external onlyOwner {
        registrar = registrar_;
        emit RegistrarSet(registrar_);
    }

    function _register(uint256 toCommit, address wallet, bool self) internal {
        uint64 t = uint64(block.timestamp);
        employee[toCommit] = wallet;
        registeredAt[toCommit] = t;
        emit EmployeeRegistered(toCommit, wallet, t, self);
    }

    function revokeEmployee(uint256 toCommit) external onlyOwner {
        address w = employee[toCommit];
        if (w == address(0)) revert EmployeeNotRegistered(toCommit);
        delete employee[toCommit];
        emit EmployeeRevoked(toCommit, w);
    }

    // ---------------------------------------------------------------- config

    function setAgent(address agent_) external onlyOwner {
        if (agent_ == address(0)) revert ZeroAddress();
        agent = agent_;
        emit AgentSet(agent_);
    }

    function setVerifierParams(IZkVerifyAggregation zkv_, uint256 domainId_, bytes32 versionHash_) external onlyOwner {
        if (address(zkv_) == address(0)) revert ZeroAddress();
        zkv = zkv_;
        domainId = domainId_;
        versionHash = versionHash_;
        emit VerifierParamsSet(address(zkv_), domainId_, versionHash_);
    }

    function setAcceptedVk(bytes32 vkHash, bool accepted) external onlyOwner {
        acceptedVk[vkHash] = accepted;
        emit AcceptedVkSet(vkHash, accepted);
    }

    function setEmployeeDailyCap(uint128 cap) external onlyOwner {
        employeeDailyCap = cap;
        emit EmployeeDailyCapSet(cap);
    }

    function pause() external onlyOwner {
        _pause(); // emits Paused
    }

    function unpause() external onlyOwner {
        _unpause(); // emits Unpaused
    }

    // ---------------------------------------------------------------- funds

    function deposit(uint256 amount) external {
        usdc.safeTransferFrom(msg.sender, address(this), amount);
        emit Deposited(msg.sender, amount);
    }

    function withdraw(address to, uint256 amount) external onlyOwner {
        if (to == address(0)) revert ZeroAddress();
        emit Withdrawn(to, amount);
        usdc.safeTransfer(to, amount);
    }
}
