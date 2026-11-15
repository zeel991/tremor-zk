import { keccak256, stringToBytes, type Hex } from "viem";
import { z } from "zod";

export const WEEKDAYS = ["MON", "TUE", "WED", "THU", "FRI", "SAT", "SUN"] as const;
export type Weekday = (typeof WEEKDAYS)[number];

const minorUnits = z.number().int().positive().max(1e12);

/**
 * One rule per template/category (SPEC §8.3). Caps are in minor units of `currency`.
 * A rule applies to a claim when the currency matches AND either `templateIds` lists the
 * claim's template, or `templateIds` is absent and `category` matches the template's category.
 */
export const RuleSchema = z.strictObject({
  category: z.enum(["transport", "meals", "shopping", "test"]),
  templateIds: z.array(z.number().int().nonnegative()).min(1).optional(),
  currency: z.union([z.literal(356), z.literal(840)]),
  maxPerClaim: minorUnits.optional(),
  maxPerDay: minorUnits.optional(),
  maxPerMonth: minorUnits.optional(),
  weekdays: z.array(z.enum(WEEKDAYS)).min(1).max(7).optional(), // absent = any day
  noteRequired: z.boolean(),
  notePurpose: z.string().min(1).max(200).optional(), // what a required note must show, e.g. "office supplies"
});

export const PolicySchema = z.strictObject({
  version: z.literal(1),
  timezoneOffsetMinutes: z.number().int().min(-720).max(840), // day/month/weekday boundaries; IST = 330
  rules: z.array(RuleSchema).min(1).max(50),
});

export type Rule = z.infer<typeof RuleSchema>;
export type Policy = z.infer<typeof PolicySchema>;

/** Deterministic JSON: object keys sorted recursively, no whitespace. Arrays keep their order. */
export function canonicalJson(v: unknown): string {
  if (v === null || typeof v !== "object") {
    if (typeof v === "number" && !Number.isFinite(v)) throw new Error("non-finite number");
    return JSON.stringify(v);
  }
  if (Array.isArray(v)) return `[${v.map(canonicalJson).join(",")}]`;
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).filter((k) => o[k] !== undefined).sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonicalJson(o[k])}`).join(",")}}`;
}

/** policyHash = keccak256(utf8(canonical JSON)), signed into every Decision (SPEC §8.3, §19.4). */
export function policyHash(p: Policy): Hex {
  return keccak256(stringToBytes(canonicalJson(p)));
}

export function parsePolicy(json: unknown): { ok: true; policy: Policy } | { ok: false; errors: string[] } {
  const r = PolicySchema.safeParse(json);
  if (r.success) return { ok: true, policy: r.data };
  return { ok: false, errors: r.error.issues.map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`) };
}
