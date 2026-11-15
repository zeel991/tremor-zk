import { templateById } from "../templates.js";
import type { Decision, ReasonCode } from "../types.js";
import { WEEKDAYS, type Policy, type Rule } from "./schema.js";

export type NoteVerdict = "fits" | "does_not_fit" | "unsure";

export interface ClaimFacts {
  templateId: number;
  amountMinor: bigint;
  currency: number;
  sentAt: bigint; // unix seconds
  note?: string;
}

/** Earlier APPROVED claims by the same employee (same vault, same to_commit). */
export interface PriorClaim {
  templateId: number;
  amountMinor: bigint;
  currency: number;
  sentAt: bigint;
}

export interface Evaluation {
  decision: Decision;
  reasons: ReasonCode[];
  ruleIndex: number | null;
}

const REJECTING: ReadonlySet<ReasonCode> = new Set(["CATEGORY_NOT_ALLOWED", "OVER_CAP", "NOTE_REQUIRED", "UNKNOWN_TEMPLATE"]);
const DAY = 86400n;

function ruleMatches(rule: Rule, templateId: number, currency: number): boolean {
  if (rule.currency !== currency) return false;
  if (rule.templateIds) return rule.templateIds.includes(templateId);
  return templateById(templateId)?.category === rule.category;
}

/** Template-specific rules win over category rules; ties go to the first in the list. */
export function findRule(policy: Policy, templateId: number, currency: number): number | null {
  let best: number | null = null;
  policy.rules.forEach((r, i) => {
    if (!ruleMatches(r, templateId, currency)) return;
    if (best === null || (r.templateIds && !policy.rules[best]!.templateIds)) best = i;
  });
  return best;
}

function localDay(sentAt: bigint, tzMinutes: number): bigint {
  const t = sentAt + BigInt(tzMinutes) * 60n;
  return t >= 0n ? t / DAY : (t - DAY + 1n) / DAY;
}

function localMonth(sentAt: bigint, tzMinutes: number): string {
  const d = new Date(Number(localDay(sentAt, tzMinutes) * DAY) * 1000);
  return `${d.getUTCFullYear()}-${d.getUTCMonth()}`;
}

function localWeekday(sentAt: bigint, tzMinutes: number) {
  const d = new Date(Number(localDay(sentAt, tzMinutes) * DAY) * 1000);
  return WEEKDAYS[(d.getUTCDay() + 6) % 7]!; // JS 0=Sun → MON-first index
}

/**
 * Deterministic policy evaluation on the proof's revealed fields (SPEC §8.3).
 * The only LLM-derived input is `noteVerdict`, and it can only keep or lower the outcome:
 * anything but "fits" on a note-required rule yields FLAG, never APPROVE.
 */
export function evaluatePolicy(policy: Policy, claim: ClaimFacts, history: PriorClaim[], noteVerdict?: NoteVerdict): Evaluation {
  const reasons = new Set<ReasonCode>();
  const tpl = templateById(claim.templateId);
  if (!tpl) return { decision: "REJECT", reasons: ["UNKNOWN_TEMPLATE"], ruleIndex: null };

  const idx = findRule(policy, claim.templateId, claim.currency);
  if (idx === null) return { decision: "REJECT", reasons: ["CATEGORY_NOT_ALLOWED"], ruleIndex: null };
  const rule = policy.rules[idx]!;
  const tz = policy.timezoneOffsetMinutes;

  if (rule.weekdays && !rule.weekdays.includes(localWeekday(claim.sentAt, tz))) reasons.add("CATEGORY_NOT_ALLOWED");

  if (rule.maxPerClaim !== undefined && claim.amountMinor > BigInt(rule.maxPerClaim)) reasons.add("OVER_CAP");

  const same = history.filter((h) => findRule(policy, h.templateId, h.currency) === idx);
  if (rule.maxPerDay !== undefined) {
    const day = localDay(claim.sentAt, tz);
    const used = same.filter((h) => localDay(h.sentAt, tz) === day).reduce((a, h) => a + h.amountMinor, 0n);
    if (used + claim.amountMinor > BigInt(rule.maxPerDay)) reasons.add("OVER_CAP");
  }
  if (rule.maxPerMonth !== undefined) {
    const month = localMonth(claim.sentAt, tz);
    const used = same.filter((h) => localMonth(h.sentAt, tz) === month).reduce((a, h) => a + h.amountMinor, 0n);
    if (used + claim.amountMinor > BigInt(rule.maxPerMonth)) reasons.add("OVER_CAP");
  }

  if (rule.noteRequired) {
    if (!claim.note || claim.note.trim() === "") reasons.add("NOTE_REQUIRED");
    else if (noteVerdict !== "fits") reasons.add("NOTE_MISMATCH"); // does_not_fit, unsure, or no verdict → FLAG
  }

  const list = [...reasons];
  const decision: Decision = list.some((r) => REJECTING.has(r)) ? "REJECT" : list.length ? "FLAG" : "APPROVE";
  return { decision, reasons: list, ruleIndex: idx };
}
