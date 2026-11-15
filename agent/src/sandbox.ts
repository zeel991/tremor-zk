import { getAddress, isAddress, zeroAddress, type Address } from "viem";
import { z } from "zod";
import type { Deps } from "./pipeline.js";
import { buildSampleReceipt, EMAIL_RE, importPkcs8Pem, MAX_TO_LEN, sampleAmountMinor } from "./sample.js";
import { BN254_R } from "./schema.js";
import type { Env } from "./types.js";

export interface SandboxResult {
  status: number;
  json?: Record<string, unknown>;
  eml?: string;
}

export const SampleRequestSchema = z.strictObject({
  to: z.string().max(MAX_TO_LEN).regex(EMAIL_RE, "to must be a plain email address"),
  amount: z.number().optional(),
});

export const RegisterRequestSchema = z.strictObject({
  vaultId: z.union([z.number(), z.string()]),
  toCommit: z
    .string()
    .regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/)
    .transform((s) => BigInt(s))
    .refine((v) => v > 0n && v < BN254_R, "toCommit must be a non-zero BN254 field element"),
  wallet: z
    .string()
    .refine((s) => isAddress(s, { strict: false }) && s.toLowerCase() !== zeroAddress, "wallet must be a non-zero EVM address")
    .transform((s) => getAddress(s)),
});

function parseJson(raw: string): unknown {
  if (raw.length > 4096) throw new Error("BODY_TOO_LARGE");
  return JSON.parse(raw);
}

function issues(e: z.ZodError) {
  return e.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message }));
}

/** POST /api/sample-receipt: a fresh test-merchant receipt (template 100) signed with the sandbox DKIM key. */
export async function handleSampleReceipt(raw: string, ip: string, env: Env, d: Deps): Promise<SandboxResult> {
  let body: unknown;
  try {
    body = parseJson(raw);
  } catch {
    return { status: 400, json: { error: "INVALID_JSON" } };
  }
  const r = SampleRequestSchema.safeParse(body);
  if (!r.success) return { status: 400, json: { error: "INVALID_REQUEST", issues: issues(r.error) } };
  const amountMinor = sampleAmountMinor(r.data.amount);
  if (amountMinor === null) return { status: 400, json: { error: "INVALID_AMOUNT", message: "amount must be 1–50 INR with at most 2 decimals" } };
  if (!env.SAMPLE_DKIM_PRIVATE_KEY || !env.SAMPLE_DKIM_DOMAIN || !env.SAMPLE_DKIM_SELECTOR) return { status: 503, json: { error: "SAMPLE_NOT_CONFIGURED" } };

  const cap = Number(env.SAMPLE_RECEIPTS_PER_IP_PER_DAY || "5");
  if (!(await d.repo.tryConsumeRate("sample-receipt", ip, d.now(), cap))) return { status: 429, json: { error: "RATE_LIMITED" } };

  let key: CryptoKey;
  try {
    key = await importPkcs8Pem(env.SAMPLE_DKIM_PRIVATE_KEY);
  } catch {
    return { status: 503, json: { error: "SAMPLE_KEY_INVALID" } };
  }
  const eml = await buildSampleReceipt({
    to: r.data.to,
    amountMinor,
    nowMs: d.now(),
    id: d.newId(),
    domain: env.SAMPLE_DKIM_DOMAIN,
    selector: env.SAMPLE_DKIM_SELECTOR,
    privateKey: key,
  });
  return { status: 200, eml };
}

const REGISTER_ERRORS: Record<string, [number, string]> = {
  AlreadyRegistered: [409, "ALREADY_REGISTERED"],
  NotSandbox: [400, "NOT_SANDBOX"],
  NotRegistrar: [503, "RELAYER_NOT_REGISTRAR"],
  EnforcedPause: [503, "PAUSED"],
  ZeroAddress: [400, "ZERO_ADDRESS"],
};

/** POST /api/register: sandbox (vaultId 0) only. The relayer pays gas for registerFor(toCommit, wallet). */
export async function handleRegister(raw: string, ip: string, env: Env, d: Deps): Promise<SandboxResult> {
  let body: unknown;
  try {
    body = parseJson(raw);
  } catch {
    return { status: 400, json: { error: "INVALID_JSON" } };
  }
  const r = RegisterRequestSchema.safeParse(body);
  if (!r.success) return { status: 400, json: { error: "INVALID_REQUEST", issues: issues(r.error) } };
  if (String(r.data.vaultId) !== "0") return { status: 400, json: { error: "NOT_SANDBOX" } };
  const vault = await d.repo.getVault("0");
  if (!vault) return { status: 404, json: { error: "UNKNOWN_VAULT" } };
  if (!d.settler) return { status: 503, json: { error: "RELAYER_NOT_CONFIGURED" } };

  const cap = Number(env.REGISTRATIONS_PER_IP_PER_DAY || "3");
  if (!(await d.repo.tryConsumeRate("register", ip, d.now(), cap))) return { status: 429, json: { error: "RATE_LIMITED" } };

  const res = await d.settler.registerFor(getAddress(vault.address) as Address, r.data.toCommit, r.data.wallet);
  if (res.ok) return { status: 202, json: { txHash: res.txHash, toCommit: `0x${r.data.toCommit.toString(16).padStart(64, "0")}`, wallet: r.data.wallet } };
  const mapped = res.errorName ? REGISTER_ERRORS[res.errorName] : undefined;
  if (mapped) return { status: mapped[0], json: { error: mapped[1] } };
  return { status: 502, json: { error: "REGISTER_FAILED", detail: res.errorName ?? "simulation failed" } };
}
