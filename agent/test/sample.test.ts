import { generateKeyPairSync } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { zeroAddress } from "viem";
import { handleRequest } from "../src/index.js";
import { buildSampleReceipt, importPkcs8Pem, rfc5322Date, sampleAmountMinor, sampleHeadersAndBody, signEmail } from "../src/sample.js";
import type { Env } from "../src/types.js";
import { makeD1, mockReader, mockSettler, mockSubmitter, VK_HASH } from "./helpers.js";

// Cross-package: the circuits/js libraries and the compiled circuit, imported from their own folder.
const CIRCUITS = new URL("../../circuits/", import.meta.url).pathname;
const LIB = `${CIRCUITS}js/lib/`;
const NOIR_JS = `${CIRCUITS}js/node_modules/@noir-lang/noir_js/lib/index.mjs`;
const CIRCUIT_JSON = `${CIRCUITS}target/receipt_rsa2048.json`;
const SKIP_CROSS = process.env.RP_SKIP_CROSS === "1";

const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048, publicExponent: 65537 }); // throwaway
const PEM = privateKey.export({ type: "pkcs8", format: "pem" }) as string;
const MODULUS = BigInt("0x" + Buffer.from(privateKey.export({ format: "jwk" }).n!, "base64url").toString("hex"));
const DOMAIN = "sample.receiptproof.invalid";
const SELECTOR = "rp1";
const NOW = Date.parse("2026-11-15T10:12:33Z");

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const load = (p: string): Promise<any> => import(/* @vite-ignore */ p);

let db: D1Database;
let now = NOW;
const env = (over: Partial<Env> = {}) =>
  ({
    DB: db, KURIER_BASE_URL: "x", CHAIN_ID: "84532", RPC_URL: "http://127.0.0.1:1", ZKV_AGGREGATION: zeroAddress, ZKV_DOMAIN_ID: "2",
    VK_HASHES: JSON.stringify({ rsa2048: VK_HASH }), ALLOWED_ORIGINS: "", MAX_SUBMISSIONS_PER_DAY: "5", DECISION_TTL_SECONDS: "3600",
    AI_MODEL: "x", POLL_BATCH: "10", SAMPLE_DKIM_PRIVATE_KEY: PEM, SAMPLE_DKIM_DOMAIN: DOMAIN, SAMPLE_DKIM_SELECTOR: SELECTOR,
    SAMPLE_RECEIPTS_PER_IP_PER_DAY: "5", REGISTRATIONS_PER_IP_PER_DAY: "3", ...over,
  }) as Env;
const ctx = { waitUntil: () => {}, passThroughOnException: () => {} } as unknown as ExecutionContext;
const f = () => ({ reader: () => mockReader(), submitter: () => mockSubmitter(), settler: () => mockSettler(), now: () => now });
const post = (body: unknown, ip = "203.0.113.7") =>
  new Request("https://agent.example/api/sample-receipt", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify(body),
  });

beforeEach(() => {
  db = makeD1();
  now = NOW;
});

describe("sample receipt signer", () => {
  it("formats the Date header as RFC 5322 in UTC", () => {
    expect(rfc5322Date(NOW)).toBe("Sun, 15 Nov 2026 10:12:33 +0000");
    expect(rfc5322Date(Date.parse("2026-11-03T08:00:05Z"))).toBe("Tue, 3 Nov 2026 08:00:05 +0000");
  });

  it("validates amount: 1–50 INR, ≤ 2 decimals, default 49", () => {
    expect(sampleAmountMinor(undefined)).toBe(4900);
    expect(sampleAmountMinor(1)).toBe(100);
    expect(sampleAmountMinor(12.34)).toBe(1234);
    expect(sampleAmountMinor(50)).toBe(5000);
    for (const bad of [0.99, 50.01, 1.234, "10", NaN, Infinity]) expect(sampleAmountMinor(bad)).toBeNull();
  });

  it.skipIf(SKIP_CROSS)("produces byte-identical .eml to circuits/js/lib/dkim.mjs signEmail (same key, same inputs)", async () => {
    const { signEmail: refSign } = await load(`${LIB}dkim.mjs`);
    const { headers, body } = sampleHeadersAndBody({ to: "Judge.One@example.com", amountMinor: 4900, nowMs: NOW, id: "0123abcd-0000-4000-8000-000000000000", domain: DOMAIN });
    const ours = await signEmail({ headers, body, domain: DOMAIN, selector: SELECTOR, privateKey: await importPkcs8Pem(PEM) });
    const ref = refSign({ headers, body, domain: DOMAIN, selector: SELECTOR, privateKey: PEM });
    expect(ours).toBe(ref.eml);
    expect(ours).toContain("h=from:to:subject:date:message-id;");
    expect(ours).toContain("\r\nAmount paid: INR 49.00\r\n");
  });
});

describe("POST /api/sample-receipt", () => {
  it("rejects extra fields, header injection, bad amounts; 503 when unconfigured", async () => {
    const h = (b: unknown, e?: Partial<Env>) => handleRequest(post(b), env(e), ctx, f());
    expect((await h({ to: "a@example.com", eml: "x" })).status).toBe(400);
    expect((await h({ to: "a@example.com\r\nBcc: x@evil.example" })).status).toBe(400);
    expect((await h({ to: "Alice <a@example.com>" })).status).toBe(400);
    expect((await h({ to: "a@example.com", amount: 51 })).status).toBe(400);
    expect((await h({ to: "a@example.com", amount: 0 })).status).toBe(400);
    expect((await h({ to: "a@example.com" }, { SAMPLE_DKIM_PRIVATE_KEY: undefined })).status).toBe(503);
  });

  it("rate-limits per IP per day (5), stores no raw IP, resets next day", async () => {
    for (let i = 0; i < 5; i++) expect((await handleRequest(post({ to: "a@example.com" }), env(), ctx, f())).status).toBe(200);
    expect((await handleRequest(post({ to: "a@example.com" }), env(), ctx, f())).status).toBe(429);
    expect((await handleRequest(post({ to: "a@example.com" }, "198.51.100.1"), env(), ctx, f())).status).toBe(200);
    const rows = (await db.prepare("SELECT * FROM rate_limits").all()).results as { client: string }[];
    expect(JSON.stringify(rows)).not.toContain("203.0.113.7");
    now = NOW + 86_400_000;
    expect((await handleRequest(post({ to: "a@example.com" }), env(), ctx, f())).status).toBe(200);
  });

  describe.skipIf(SKIP_CROSS)("cross-package: verify with dkim-verify.mjs and execute the real circuit", () => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    let verify: any, inputs: any, noir: any;
    beforeAll(async () => {
      for (const p of [`${LIB}dkim-verify.mjs`, `${LIB}inputs.mjs`, NOIR_JS, CIRCUIT_JSON]) expect(existsSync(p), `missing ${p}`).toBe(true);
      verify = await load(`${LIB}dkim-verify.mjs`);
      inputs = await load(`${LIB}inputs.mjs`);
      const { Noir } = await load(NOIR_JS);
      noir = new Noir(JSON.parse(readFileSync(CIRCUIT_JSON, "utf8")));
    });

    const cases: [string, number, number | undefined, number][] = [
      ["2-digit day, amount 12.34", NOW, 12.34, 1234],
      ["1-digit day, default amount", Date.parse("2026-11-03T08:00:05Z"), undefined, 4900],
      ["integer amount 50", Date.parse("2026-11-14T23:59:59Z"), 50, 5000],
    ];
    it.each(cases)("%s → circuit outputs template 100, amount, INR, date", async (_n, at, amount, minor) => {
      now = at;
      const res = await handleRequest(post(amount === undefined ? { to: "Judge.One@Example.com" } : { to: "Judge.One@Example.com", amount }), env(), ctx, f());
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toBe("message/rfc822");
      const eml = await res.text();

      const parsed = verify.parseEmail(eml);
      expect(parsed.sigs).toHaveLength(1);
      const dkimResult = verify.verifyWithModulus(parsed, parsed.sigs[0], MODULUS);
      expect(dkimResult.signingDomain).toBe(DOMAIN);
      expect(() => verify.verifyWithModulus(verify.parseEmail(eml.replace(/INR \d+\.\d\d/, "INR 49.99")), parsed.sigs[0], MODULUS)).toThrow();

      const recipient = "0x00000000000000000000000000000000000000aa";
      const { inputs: ci } = inputs.buildInputs(dkimResult, { templateId: 100, salt: "0x1234", recipient, vaultId: 0 });
      const { returnValue } = await noir.execute(ci);
      const out = (returnValue as string[]).map((x) => BigInt(x));
      expect(out).toHaveLength(9);
      expect(out[2]).toBe(100n);
      expect(out[3]).toBe(BigInt(minor));
      expect(out[4]).toBe(356n);
      expect(out[5]).toBe(BigInt(Math.floor(at / 1000)));
      expect(out[7]).toBe(BigInt(recipient));
      expect(out[8]).toBe(0n);
    }, 120_000);
  });
});

describe("buildSampleReceipt", () => {
  it("uses a fresh Message-ID and order number per id", async () => {
    const key = await importPkcs8Pem(PEM);
    const a = await buildSampleReceipt({ to: "a@example.com", amountMinor: 100, nowMs: NOW, id: "aaaaaaaa-1", domain: DOMAIN, selector: SELECTOR, privateKey: key });
    const b = await buildSampleReceipt({ to: "a@example.com", amountMinor: 100, nowMs: NOW, id: "bbbbbbbb-2", domain: DOMAIN, selector: SELECTOR, privateKey: key });
    expect(a).toContain(`Message-ID: <sample-aaaaaaaa-1@${DOMAIN}>`);
    expect(a).not.toBe(b);
    await expect(importPkcs8Pem("-----BEGIN RSA PRIVATE KEY-----\nAAAA\n-----END RSA PRIVATE KEY-----")).rejects.toThrow(/PKCS8/);
  });
});
