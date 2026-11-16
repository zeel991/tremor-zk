import { describe, it, expect } from "vitest";
import { samplePublicKey } from "../src/sample";
import { generateKeyPairSync, createPublicKey } from "node:crypto";

describe("samplePublicKey", () => {
  it("returns the modulus of the sample DKIM key, matching node's own export", async () => {
    const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
    const pem = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
    const k = await samplePublicKey(pem);
    const n = Buffer.from(createPublicKey(privateKey).export({ format: "jwk" }).n as string, "base64url").toString("hex");
    expect(k.bits).toBe(2048);
    expect(k.modulus).toBe("0x" + n);
  });
});
