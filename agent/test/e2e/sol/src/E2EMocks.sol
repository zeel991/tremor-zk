// SPDX-License-Identifier: MIT
pragma solidity 0.8.28;

/// Minimal 6-decimal ERC20 standing in for USDC on a local anvil chain. Test only.
contract MockUSDC {
    string public constant name = "Mock USDC";
    string public constant symbol = "mUSDC";
    uint8 public constant decimals = 6;
    uint256 public totalSupply;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event Approval(address indexed owner, address indexed spender, uint256 value);

    function mint(address to, uint256 amount) external {
        totalSupply += amount;
        balanceOf[to] += amount;
        emit Transfer(address(0), to, amount);
    }

    function approve(address spender, uint256 amount) external returns (bool) {
        allowance[msg.sender][spender] = amount;
        emit Approval(msg.sender, spender, amount);
        return true;
    }

    function transfer(address to, uint256 amount) external returns (bool) {
        _move(msg.sender, to, amount);
        return true;
    }

    function transferFrom(address from, address to, uint256 amount) external returns (bool) {
        uint256 a = allowance[from][msg.sender];
        require(a >= amount, "allowance");
        if (a != type(uint256).max) allowance[from][msg.sender] = a - amount;
        _move(from, to, amount);
        return true;
    }

    function _move(address from, address to, uint256 amount) internal {
        require(balanceOf[from] >= amount, "balance");
        balanceOf[from] -= amount;
        balanceOf[to] += amount;
        emit Transfer(from, to, amount);
    }
}

/// IZkVerifyAggregation stand-in: true only for (domainId, aggregationId, leaf) registered via accept().
/// The Merkle path/leafCount/index are ignored. Test only.
contract MockZkVerifyAggregation {
    mapping(bytes32 => bool) public accepted;

    function accept(uint256 domainId, uint256 aggregationId, bytes32 leaf) external {
        accepted[keccak256(abi.encode(domainId, aggregationId, leaf))] = true;
    }

    function verifyProofAggregation(uint256 domainId, uint256 aggregationId, bytes32 leaf, bytes32[] calldata, uint256, uint256)
        external
        view
        returns (bool)
    {
        return accepted[keccak256(abi.encode(domainId, aggregationId, leaf))];
    }
}

/// The two Multicall3 functions viem's reader uses (aggregate3, getCurrentBlockTimestamp). Anvil has
/// no Multicall3 at the canonical address, so the e2e test deploys this and passes its address.
contract MiniMulticall3 {
    struct Call3 {
        address target;
        bool allowFailure;
        bytes callData;
    }

    struct Result {
        bool success;
        bytes returnData;
    }

    function aggregate3(Call3[] calldata calls) external payable returns (Result[] memory results) {
        results = new Result[](calls.length);
        for (uint256 i; i < calls.length; i++) {
            (bool ok, bytes memory ret) = calls[i].target.call(calls[i].callData);
            if (!ok && !calls[i].allowFailure) {
                assembly {
                    revert(add(ret, 32), mload(ret))
                }
            }
            results[i] = Result(ok, ret);
        }
    }

    function getCurrentBlockTimestamp() external view returns (uint256) {
        return block.timestamp;
    }
}
