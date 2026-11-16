/**
 * Sample receipts from the ReceiptProof test merchant (template 100, SPEC §3 "Run with our sample
 * receipt"). A byte-for-byte port of circuits/js/lib/dkim.mjs `signEmail` (rsa-sha256,
 * relaxed/relaxed) to WebCrypto, so it runs in the Worker. RSASSA-PKCS1-v1_5 is deterministic,
 * so for the same key and inputs both produce identical .eml bytes (tested).
 */

export function canonBodyRelaxed(body: string): string {
  let lines = body.replace(/\r?\n/g, "\r\n").split("\r\n");
  lines = lines.map((l) => l.replace(/[ \t]+/g, " ").replace(/ +$/, ""));
  while (lines.length && lines[lines.length - 1] === "") lines.pop();
  return lines.length ? lines.join("\r\n") + "\r\n" : "";
}

export function canonHeaderRelaxed(name: string, value: string): string {
  return name.toLowerCase().trim() + ":" + value.replace(/\r?\n[ \t]+/g, " ").replace(/[ \t]+/g, " ").trim();
}

const b64 = (u8: Uint8Array) => btoa(String.fromCharCode(...u8));
const utf8 = (s: string) => new TextEncoder().encode(s);

export async function importPkcs8Pem(pem: string): Promise<CryptoKey> {
  if (!pem.includes("BEGIN PRIVATE KEY")) throw new Error("SAMPLE_DKIM_PRIVATE_KEY must be a PKCS8 PEM (BEGIN PRIVATE KEY)");
  const der = Uint8Array.from(atob(pem.replace(/-----(BEGIN|END) PRIVATE KEY-----/g, "").replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  return crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, false, ["sign"]);
}

export interface SignInput {
  headers: [string, string][];
  body: string;
  domain: string;
  selector: string;
  privateKey: CryptoKey;
}

/** Same algorithm and byte layout as dkim.mjs signEmail. Returns the raw RFC 5322 message. */
export async function signEmail({ headers, body, domain, selector, privateKey }: SignInput): Promise<string> {
  const cbody = canonBodyRelaxed(body);
  const bh = b64(new Uint8Array(await crypto.subtle.digest("SHA-256", utf8(cbody))));
  const signedNames = headers.map(([n]) => n.toLowerCase());
  const dkimValueNoSig = `v=1; a=rsa-sha256; c=relaxed/relaxed; d=${domain}; s=${selector}; h=${signedNames.join(":")}; bh=${bh}; b=`;
  const canonHeaders =
    headers.map(([n, v]) => canonHeaderRelaxed(n, v)).join("\r\n") + "\r\n" + canonHeaderRelaxed("DKIM-Signature", dkimValueNoSig);
  const sig = new Uint8Array(await crypto.subtle.sign("RSASSA-PKCS1-v1_5", privateKey, utf8(canonHeaders)));
  return (
    [`DKIM-Signature: ${dkimValueNoSig}${b64(sig)}`, ...headers.map(([n, v]) => `${n}: ${v}`)].join("\r\n") +
    "\r\n\r\n" +
    body.replace(/\r?\n/g, "\r\n")
  );
}

const DAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const p2 = (n: number) => String(n).padStart(2, "0");

/** RFC 5322 date in UTC, e.g. `Sat, 15 Nov 2026 10:12:33 +0000` (day not zero-padded, like the fixtures). */
export function rfc5322Date(ms: number): string {
  const d = new Date(ms);
  return `${DAYS[d.getUTCDay()]}, ${d.getUTCDate()} ${MONTHS[d.getUTCMonth()]} ${d.getUTCFullYear()} ${p2(d.getUTCHours())}:${p2(d.getUTCMinutes())}:${p2(d.getUTCSeconds())} +0000`;
}

/** Plain address only: no display name, no CR/LF, ASCII, and ≤ 124 bytes (the commit circuit's limit). */
export const EMAIL_RE = /^[A-Za-z0-9._%+-]{1,64}@[A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})+$/;
export const MAX_TO_LEN = 124;

export const SAMPLE_TEMPLATE_ID = 100;
export const SAMPLE_MIN_INR = 1;
export const SAMPLE_MAX_INR = 50;
export const SAMPLE_DEFAULT_INR = 49;

/** Amount in INR (1–50, at most 2 decimals) → paise, or null if invalid. */
export function sampleAmountMinor(amount: unknown): number | null {
  if (amount === undefined) return SAMPLE_DEFAULT_INR * 100;
  if (typeof amount !== "number" || !Number.isFinite(amount) || amount < SAMPLE_MIN_INR || amount > SAMPLE_MAX_INR) return null;
  const minor = Math.round(amount * 100);
  return Math.abs(amount * 100 - minor) < 1e-6 ? minor : null;
}

const FILLER =
  "Thanks for your order at the Tremor Test Merchant. This is a sample receipt signed with our own test domain's DKIM key; it is not from a real merchant.\n";

export interface SampleInput {
  to: string;
  amountMinor: number;
  nowMs: number;
  id: string; // random, used for order number and Message-ID
  domain: string;
  selector: string;
  privateKey: CryptoKey;
}

export function sampleHeadersAndBody({ to, amountMinor, nowMs, id, domain }: Omit<SampleInput, "privateKey" | "selector">) {
  const amount = `${Math.floor(amountMinor / 100)}.${p2(amountMinor % 100)}`;
  const headers: [string, string][] = [
    ["From", `Tremor Test Merchant <receipts@${domain}>`],
    ["To", to],
    ["Subject", "Your ReceiptProof sample receipt"],
    ["Date", rfc5322Date(nowMs)],
    ["Message-ID", `<sample-${id}@${domain}>`],
  ];
  const body = `Hello,\n\n${FILLER}\nOrder #RP-${id.slice(0, 8).toUpperCase()}\nAmount paid: INR ${amount}\nPaid with card ending 4242.\n\nTremor Test Merchant\n`;
  return { headers, body };
}

export async function buildSampleReceipt(i: SampleInput): Promise<string> {
  const { headers, body } = sampleHeadersAndBody(i);
  return signEmail({ headers, body, domain: i.domain, selector: i.selector, privateKey: i.privateKey });
}

/** Public half of the sample-receipt DKIM key, for in-browser verification (the sandbox has no DNS record). */
export async function samplePublicKey(pem: string): Promise<{ modulus: string; bits: number }> {
  const b64 = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  const der = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const key = await crypto.subtle.importKey("pkcs8", der, { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" }, true, ["sign"]);
  const jwk = (await crypto.subtle.exportKey("jwk", key)) as JsonWebKey;
  const n = Uint8Array.from(atob(jwk.n!.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(jwk.n!.length / 4) * 4, "=")), (c) => c.charCodeAt(0));
  return { modulus: "0x" + Array.from(n, (b) => b.toString(16).padStart(2, "0")).join(""), bits: n.length * 8 };
}
