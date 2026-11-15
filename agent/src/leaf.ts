import { concat, keccak256, stringToBytes, type Hex } from "viem";
import { toHex32 } from "./types.js";

/** sha256("ultrahonk:v5.0"), SPEC §19.1 / §7.1 step 8. */
export const VERSION_HASH_V5: Hex = "0x91ea9b035e570dfe3d6b0dff19fb13586dfdd5a9da15c14f49f7ce6b3b2bc589";
/** keccak256("ultrahonk") */
export const ULTRAHONK_TAG: Hex = keccak256(stringToBytes("ultrahonk"));
/** V5_0 enum index byte prefixed to the raw VK before hashing (no SCALE length prefix). */
export const V5_VK_PREFIX = "0x03" as const;

/** vkHash = keccak256(0x03 ‖ vk), SPEC §19.1. `vk` is the raw 1,888-byte VK as hex. */
export function vkHashV5(vk: Hex): Hex {
  return keccak256(concat([V5_VK_PREFIX, vk]));
}

/** keccak256 of the 9 public inputs, each as a 32-byte big-endian word. */
export function pubsHash(pubs: readonly bigint[]): Hex {
  if (pubs.length !== 9) throw new Error("expected 9 public inputs");
  return keccak256(concat(pubs.map(toHex32)));
}

/**
 * Statement leaf, SPEC §19.1:
 * keccak256(abi.encodePacked(keccak256("ultrahonk"), vkHash, versionHash, keccak256(abi.encodePacked(uint256[9] pubs))))
 */
export function statementLeaf(vkHash: Hex, pubs: readonly bigint[], versionHash: Hex = VERSION_HASH_V5): Hex {
  return keccak256(concat([ULTRAHONK_TAG, vkHash, versionHash, pubsHash(pubs)]));
}
