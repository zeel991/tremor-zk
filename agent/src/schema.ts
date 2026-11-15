import { z } from "zod";

/** BN254 scalar field modulus r. Every public input must be < r. */
export const BN254_R = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

export const MAX_BODY_BYTES = 64 * 1024;
export const MAX_PROOF_BYTES = 24 * 1024; // measured V5 ZK proof: 9,536 bytes
export const MAX_NOTE_CHARS = 280;

const fieldElement = z
  .string()
  .regex(/^(0x[0-9a-fA-F]{1,64}|[0-9]{1,78})$/, "field element must be 0x-hex (≤32 bytes) or decimal")
  .transform((s) => BigInt(s))
  .refine((v) => v < BN254_R, "field element must be < BN254 r");

/**
 * POST /api/claim body, SPEC §8.1. `strictObject` rejects ANY other key, so email bytes
 * (or anything else) can never be accepted by this endpoint (SPEC §10 "PII leakage").
 */
export const ClaimRequestSchema = z.strictObject({
  vaultId: z.union([
    z.string().regex(/^[0-9]{1,20}$/).transform((s) => BigInt(s)),
    z.number().int().nonnegative().max(Number.MAX_SAFE_INTEGER).transform((n) => BigInt(n)),
  ]),
  circuit: z.enum(["rsa2048", "rsa1024"]),
  proof: z
    .string()
    .regex(/^0x([0-9a-fA-F]{2})+$/, "proof must be 0x-hex bytes")
    .refine((s) => (s.length - 2) / 2 >= 64 && (s.length - 2) / 2 <= MAX_PROOF_BYTES, "proof size out of range"),
  pubs: z.array(fieldElement).length(9),
  note: z.string().max(MAX_NOTE_CHARS).optional(),
});

export type ClaimRequest = z.output<typeof ClaimRequestSchema>;

export type ParseResult = { ok: true; value: ClaimRequest } | { ok: false; status: number; error: string; issues?: unknown };

/** Parses the raw body text. Size is checked before JSON.parse. */
export function parseClaimRequest(raw: string): ParseResult {
  if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) return { ok: false, status: 413, error: "BODY_TOO_LARGE" };
  let json: unknown;
  try {
    json = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "INVALID_JSON" };
  }
  const r = ClaimRequestSchema.safeParse(json);
  if (!r.success) {
    return {
      ok: false,
      status: 400,
      error: "INVALID_REQUEST",
      issues: r.error.issues.map((i) => ({ path: i.path.join("."), code: i.code, message: i.message })),
    };
  }
  return { ok: true, value: r.data };
}
