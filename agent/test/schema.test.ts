import { describe, expect, it } from "vitest";
import { parseClaimRequest, BN254_R } from "../src/schema.js";
import { goodPubs, pubsHex, PROOF } from "./helpers.js";

const valid = () => ({ vaultId: "7", circuit: "rsa2048", proof: PROOF, pubs: pubsHex(goodPubs()), note: "client dinner" });

describe("POST /api/claim schema", () => {
  it("accepts exactly {vaultId, circuit, proof, pubs, note?}", () => {
    const r = parseClaimRequest(JSON.stringify(valid()));
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.value.vaultId).toBe(7n);
      expect(r.value.pubs).toHaveLength(9);
      expect(r.value.pubs[3]).toBe(64200n);
    }
    const { note: _n, ...noNote } = valid();
    expect(parseClaimRequest(JSON.stringify(noNote)).ok).toBe(true);
  });

  it.each(["email", "eml", "raw", "headers", "body", "to", "salt", "anything"])("rejects extra field %s (email bytes are never accepted)", (k) => {
    const r = parseClaimRequest(JSON.stringify({ ...valid(), [k]: "From: noreply@uber.com\r\nDKIM-Signature: v=1; ..." }));
    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.status).toBe(400);
      expect(JSON.stringify(r.issues)).toContain("unrecognized_keys");
    }
  });

  it("rejects wrong public input count and out-of-field values", () => {
    expect(parseClaimRequest(JSON.stringify({ ...valid(), pubs: pubsHex(goodPubs()).slice(0, 8) })).ok).toBe(false);
    const big = pubsHex(goodPubs());
    big[0] = "0x" + BN254_R.toString(16);
    expect(parseClaimRequest(JSON.stringify({ ...valid(), pubs: big })).ok).toBe(false);
    const num = [...pubsHex(goodPubs())] as unknown[];
    num[3] = 64200; // JSON numbers lose precision; only strings allowed
    expect(parseClaimRequest(JSON.stringify({ ...valid(), pubs: num })).ok).toBe(false);
  });

  it("rejects bad proof, circuit, note and oversized or malformed bodies", () => {
    expect(parseClaimRequest(JSON.stringify({ ...valid(), proof: "not-hex" })).ok).toBe(false);
    expect(parseClaimRequest(JSON.stringify({ ...valid(), circuit: "rsa4096" })).ok).toBe(false);
    expect(parseClaimRequest(JSON.stringify({ ...valid(), note: "x".repeat(281) })).ok).toBe(false);
    const huge = parseClaimRequest(JSON.stringify({ ...valid(), proof: "0x" + "ab".repeat(40000) }));
    expect(huge.ok === false && huge.status).toBe(413);
    const bad = parseClaimRequest("{nope");
    expect(bad.ok === false && bad.error).toBe("INVALID_JSON");
  });
});
