import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { encodePacked, keccak256, sha256, stringToBytes, type Hex } from "viem";
import { statementLeaf, VERSION_HASH_V5, vkHashV5 } from "../src/leaf.js";
import { pubsToArray } from "../src/types.js";
import { goodPubs } from "./helpers.js";

const KNOWN_VK_HASH: Hex = "0x806073cafcaee81e9803c622546730931813769bf9eef8126a95e8c318cd6dca";

describe("statement leaf (SPEC §19.1)", () => {
  it("versionHash is sha256('ultrahonk:v5.0')", () => {
    expect(sha256(stringToBytes("ultrahonk:v5.0"))).toBe(VERSION_HASH_V5);
  });

  it("vkHash = keccak256(0x03 ‖ vk) reproduces the value Volta's vk_hash_ultrahonk RPC returned", () => {
    const vk = `0x${readFileSync(new URL("./fixtures/vk-v5.hex", import.meta.url).pathname, "utf8").trim()}` as Hex;
    expect((vk.length - 2) / 2).toBe(1888);
    expect(vkHashV5(vk)).toBe(KNOWN_VK_HASH);
  });

  it("matches an independent encodePacked + keccak256 computation", () => {
    for (const p of [goodPubs(), goodPubs({ nullifier: 2n ** 250n + 17n, amountMinor: 999999999999n, vaultId: 0n })]) {
      const pubs = pubsToArray(p);
      const inner = keccak256(encodePacked(["uint256[9]"], [pubs as never]));
      const expected = keccak256(
        encodePacked(["bytes32", "bytes32", "bytes32", "bytes32"], [keccak256(stringToBytes("ultrahonk")), KNOWN_VK_HASH, VERSION_HASH_V5, inner]),
      );
      expect(statementLeaf(KNOWN_VK_HASH, pubs)).toBe(expected);
    }
  });

  it("changes when any public input or the vkHash changes", () => {
    const a = statementLeaf(KNOWN_VK_HASH, pubsToArray(goodPubs()));
    expect(statementLeaf(KNOWN_VK_HASH, pubsToArray(goodPubs({ recipient: 1n })))).not.toBe(a);
    expect(statementLeaf(VERSION_HASH_V5, pubsToArray(goodPubs()))).not.toBe(a);
    expect(() => statementLeaf(KNOWN_VK_HASH, [1n, 2n])).toThrow();
  });
});
