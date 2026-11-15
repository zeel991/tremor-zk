import { describe, expect, it, vi } from "vitest";
import { isFailureStatus, KurierClient, KurierError, KURIER_TESTNET, ZkVerifyJsSubmitter } from "../src/kurier.js";

const KEY = "test-key-NOT-REAL-0123456789";
const JOB = "3f1c2a9e-1b2c-4d3e-8f00-112233445566";

function mockFetch(status: number, body: unknown) {
  return vi.fn(async (_url: string | URL | Request, _init?: RequestInit) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } }));
}

describe("Kurier client", () => {
  it("submit-proof sends the V5_0 ZK body with the registered vkHash", async () => {
    const f = mockFetch(200, { jobId: JOB, optimisticVerify: "success" });
    const k = new KurierClient({ baseUrl: KURIER_TESTNET + "/", apiKey: KEY, chainId: 84532, fetch: f as unknown as typeof fetch });
    const r = await k.submit({ proof: "0xabcd", publicSignals: ["0x01", "0x02"], vkHash: "0x8060" });
    expect(r).toEqual({ jobId: JOB, optimisticVerify: "success" });
    const [url, init] = f.mock.calls[0]!;
    expect(url).toBe(`${KURIER_TESTNET}/submit-proof/${KEY}`);
    expect(init!.method).toBe("POST");
    expect(JSON.parse(init!.body as string)).toEqual({
      proofType: "ultrahonk",
      proofOptions: { version: "V5_0", variant: "ZK" },
      vkRegistered: true,
      chainId: 84532,
      proofData: { proof: "0xabcd", publicSignals: ["0x01", "0x02"], vk: "0x8060" },
    });
  });

  it("register-vk and job-status hit the documented paths", async () => {
    const f = mockFetch(200, { vkHash: "0x8060" });
    const k = new KurierClient({ baseUrl: "https://api.kurier.xyz/api/v1", apiKey: KEY, chainId: 8453, fetch: f as unknown as typeof fetch });
    expect(await k.registerVk("0x00ff")).toEqual({ vkHash: "0x8060" });
    expect(JSON.parse(f.mock.calls[0]![1]!.body as string)).toEqual({ proofType: "ultrahonk", proofOptions: { version: "V5_0", variant: "ZK" }, vk: "0x00ff" });

    const g = mockFetch(200, { jobId: JOB, status: "Finalized" });
    const k2 = new KurierClient({ baseUrl: "https://api.kurier.xyz/api/v1", apiKey: KEY, chainId: 8453, fetch: g as unknown as typeof fetch });
    expect((await k2.status(JOB)).status).toBe("Finalized");
    expect(g.mock.calls[0]![0]).toBe(`https://api.kurier.xyz/api/v1/job-status/${KEY}/${JOB}`);
    await expect(k2.status("../../etc")).rejects.toThrow(KurierError);
  });

  it("never leaks the API key in errors", async () => {
    const f = mockFetch(400, { code: "BAD", message: `invalid key ${KEY} for /submit-proof/${KEY}` });
    const k = new KurierClient({ baseUrl: KURIER_TESTNET, apiKey: KEY, chainId: 84532, fetch: f as unknown as typeof fetch });
    const err = (await k.submit({ proof: "0x00", publicSignals: [], vkHash: "0x00" }).catch((e: unknown) => e)) as KurierError;
    expect(err).toBeInstanceOf(KurierError);
    expect(err.httpStatus).toBe(400);
    expect(String(err.message) + String(err.stack)).not.toContain(KEY);

    const down = vi.fn(async () => { throw new TypeError(`fetch failed: ${KURIER_TESTNET}/submit-proof/${KEY}`); });
    const k2 = new KurierClient({ baseUrl: KURIER_TESTNET, apiKey: KEY, chainId: 84532, fetch: down as unknown as typeof fetch });
    const e2 = (await k2.submit({ proof: "0x00", publicSignals: [], vkHash: "0x00" }).catch((e: unknown) => e)) as Error;
    expect(e2.message).not.toContain(KEY);
    expect(() => new KurierClient({ baseUrl: KURIER_TESTNET, apiKey: "", chainId: 1 })).toThrow();
  });

  it("classifies failure statuses; zkverifyjs fallback is an explicit stub", async () => {
    for (const s of ["Queued", "Valid", "Submitted", "IncludedInBlock", "Finalized", "AggregationPending", "Aggregated"]) expect(isFailureStatus(s)).toBe(false);
    for (const s of ["Failed", "AggregationFailed", "Rejected", "Error"]) expect(isFailureStatus(s)).toBe(true);
    await expect(new ZkVerifyJsSubmitter().submit({ proof: "0x", publicSignals: [], vkHash: "0x" })).rejects.toThrow(/CLI/);
  });
});
