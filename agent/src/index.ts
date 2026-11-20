import { samplePublicKey } from "./sample";
import { getAddress, type Address, type Hex } from "viem";
import type { VaultReader, VaultSettler } from "./chain/reader.js";
import { ViemVaultReader, ViemVaultSettler } from "./chain/viem.js";
import { parseReasons, Repo, type ClaimRow } from "./db.js";
import { agentAddress } from "./eip712.js";
import { KurierClient, type ProofSubmitter } from "./kurier.js";
import { handleClaim, type AgentConfig, type Deps, type Step } from "./pipeline.js";
import { workersAiLlm } from "./policy/llm.js";
import { pollOnce } from "./poller.js";
import { handleRegister, handleSampleReceipt, type SandboxResult } from "./sandbox.js";
import { parseClaimRequest } from "./schema.js";
import { TEMPLATES, templateById } from "./templates.js";
import type { Env } from "./types.js";

export const STATEMENT =
  "Each paid claim carries a zero-knowledge proof (UltraHonk V5_0 ZK, verified by zkVerify) that the merchant's DKIM key signed an email " +
  "to the claimant's registered inbox, stating this merchant, amount, currency and date. The email itself never leaves the claimant's device; " +
  "the agent sees only the 9 public inputs.";

export function configFromEnv(env: Env): AgentConfig {
  return {
    chainId: Number(env.CHAIN_ID),
    vkHashes: JSON.parse(env.VK_HASHES || "{}") as Record<string, Hex>,
    maxSubmissionsPerDay: Number(env.MAX_SUBMISSIONS_PER_DAY || "50"),
    decisionTtlSeconds: Number(env.DECISION_TTL_SECONDS || "3600"),
    pollBatch: Number(env.POLL_BATCH || "10"),
    agentKey: env.AGENT_PRIVATE_KEY ? (env.AGENT_PRIVATE_KEY as Hex) : undefined,
    zkvAggregation: env.ZKV_AGGREGATION ? (getAddress(env.ZKV_AGGREGATION) as Hex) : undefined,
    zkvDomainId: env.ZKV_DOMAIN_ID ? Number(env.ZKV_DOMAIN_ID) : undefined,
  };
}

/** Overridable in tests. */
export interface Factories {
  reader?: (env: Env) => VaultReader;
  settler?: (env: Env) => VaultSettler | null;
  submitter?: (env: Env) => ProofSubmitter | null;
  now?: () => number;
}

export function buildDeps(env: Env, f: Factories = {}): Deps {
  const cfg = configFromEnv(env);
  return {
    repo: new Repo(env.DB),
    reader: f.reader ? f.reader(env) : lazyReader(env, cfg.chainId),
    settler: f.settler ? f.settler(env) : env.RELAYER_PRIVATE_KEY ? new ViemVaultSettler(env.RPC_URL, cfg.chainId, env.RELAYER_PRIVATE_KEY as Hex, multicallOf(env)) : null,
    submitter: f.submitter
      ? f.submitter(env)
      : env.KURIER_API_KEY
        ? new KurierClient({ baseUrl: env.KURIER_BASE_URL, apiKey: env.KURIER_API_KEY, chainId: cfg.chainId })
        : null,
    llm: env.AI ? workersAiLlm(env.AI, env.AI_MODEL) : undefined,
    now: f.now ?? (() => Date.now()),
    newId: () => crypto.randomUUID(),
    cfg,
  };
}

const multicallOf = (env: Env) => (env.MULTICALL3_ADDRESS ? getAddress(env.MULTICALL3_ADDRESS) : undefined);

/** Built on first use so a bad RPC var only fails the routes that read chain state. */
function lazyReader(env: Env, chainId: number): VaultReader {
  let r: ViemVaultReader | undefined;
  const get = () => (r ??= new ViemVaultReader(env.RPC_URL, chainId, multicallOf(env)));
  return {
    snapshot: (v, q) => get().snapshot(v, q),
    overview: (v, t) => get().overview(v, t),
    dkimKeys: (v, h, b) => get().dkimKeys(v, h, b),
    aggregationRoot: (z, dom, id) => get().aggregationRoot(z, dom, id),
  };
}

// ---------- HTTP helpers ----------

function corsHeaders(req: Request, env: Env): Record<string, string> {
  const origin = req.headers.get("origin");
  const allowed = (env.ALLOWED_ORIGINS || "").split(",").map((s) => s.trim()).filter(Boolean);
  const h: Record<string, string> = { vary: "Origin" };
  if (origin && (allowed.includes(origin) || allowed.includes("*"))) {
    h["access-control-allow-origin"] = origin;
    h["access-control-allow-methods"] = "GET, POST, OPTIONS";
    h["access-control-allow-headers"] = "content-type, accept";
    h["access-control-max-age"] = "86400";
  }
  return h;
}

const replacer = (_k: string, v: unknown) => (typeof v === "bigint" ? v.toString() : v);

function json(body: unknown, status: number, cors: Record<string, string>): Response {
  return new Response(JSON.stringify(body, replacer), { status, headers: { "content-type": "application/json", ...cors } });
}

function shortHex(h: string): string {
  return `${h.slice(0, 8)}…${h.slice(-4)}`;
}

/** Public projection: no note, no proof, no full inbox commitment. */
function publicClaim(c: ClaimRow, detail: boolean) {
  const base = {
    id: c.id,
    vaultId: c.vault_id,
    templateId: c.template_id,
    merchant: templateById(c.template_id)?.merchant ?? null,
    amountMinor: c.amount_minor,
    currency: c.currency,
    sentAt: c.sent_at,
    employee: shortHex(c.to_commit),
    decision: c.decision,
    reasons: parseReasons(c.reasons),
    status: c.status,
    kurierStatus: c.kurier_status,
    zkvTx: c.zkv_tx,
    aggregationId: c.aggregation_id,
    baseTx: c.base_tx,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
  if (!detail) return base;
  return {
    ...base,
    explanation: c.explanation,
    kurierJob: c.kurier_job,
    policyHash: c.policy_hash,
    vkHash: c.vk_hash,
    pubs: JSON.parse(c.pubs) as string[],
    retries: c.retries,
    aggregation: c.agg_path ? { leaf: c.agg_leaf, index: c.agg_index, leafCount: c.agg_leaf_count, path: JSON.parse(c.agg_path) } : null,
    agentSig: c.agent_sig,
  };
}

// ---------- routes ----------

export async function handleRequest(req: Request, env: Env, ctx: ExecutionContext, f: Factories = {}): Promise<Response> {
  const cors = corsHeaders(req, env);
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  const url = new URL(req.url);
  const path = url.pathname.replace(/\/+$/, "") || "/";
  const d = buildDeps(env, f);

  try {
    if (req.method === "POST" && path === "/api/claim") {
      if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415, cors);
      const parsed = parseClaimRequest(await req.text());
      if (!parsed.ok) return json({ error: parsed.error, issues: parsed.issues }, parsed.status, cors);

      if ((req.headers.get("accept") || "").includes("application/x-ndjson")) {
        const { readable, writable } = new TransformStream<Uint8Array, Uint8Array>();
        const w = writable.getWriter();
        const enc = new TextEncoder();
        const write = (o: unknown) => w.write(enc.encode(JSON.stringify(o, replacer) + "\n"));
        ctx.waitUntil(
          (async () => {
            try {
              const r = await handleClaim(parsed.value, d, (s: Step) => void write(s));
              await write({ step: "result", httpStatus: r.httpStatus, ...r.body });
            } catch {
              await write({ step: "result", httpStatus: 500, error: "INTERNAL" });
            } finally {
              await w.close();
            }
          })(),
        );
        return new Response(readable, { status: 200, headers: { "content-type": "application/x-ndjson", ...cors } });
      }
      const r = await handleClaim(parsed.value, d);
      return json(r.body, r.httpStatus, cors);
    }

    if (req.method === "POST" && (path === "/api/sample-receipt" || path === "/api/register")) {
      if (!(req.headers.get("content-type") || "").includes("application/json")) return json({ error: "UNSUPPORTED_MEDIA_TYPE" }, 415, cors);
      const ip = req.headers.get("cf-connecting-ip") ?? "unknown";
      const raw = await req.text();
      const r: SandboxResult = path === "/api/sample-receipt" ? await handleSampleReceipt(raw, ip, env, d) : await handleRegister(raw, ip, env, d);
      if (r.eml !== undefined) {
        return new Response(r.eml, {
          status: r.status,
          headers: { "content-type": "message/rfc822", "content-disposition": 'attachment; filename="receiptproof-sample.eml"', "cache-control": "no-store", ...cors },
        });
      }
      return json(r.json ?? {}, r.status, cors);
    }

    if (req.method !== "GET") return json({ error: "METHOD_NOT_ALLOWED" }, 405, cors);

    if (path === "/api/sandbox-key") {
      if (!env.SAMPLE_DKIM_PRIVATE_KEY || !env.SAMPLE_DKIM_DOMAIN || !env.SAMPLE_DKIM_SELECTOR) return json({ error: "SAMPLE_NOT_CONFIGURED" }, 503, cors);
      const k = await samplePublicKey(env.SAMPLE_DKIM_PRIVATE_KEY);
      return new Response(JSON.stringify({ domain: env.SAMPLE_DKIM_DOMAIN, selector: env.SAMPLE_DKIM_SELECTOR, ...k }), {
        status: 200, headers: { "content-type": "application/json", "cache-control": "public, max-age=300", ...cors },
      });
    }

    const m = path.match(/^\/api\/claim\/([0-9a-fA-F-]{36})$/);
    if (m) {
      const c = await d.repo.getClaim(m[1]!);
      return c ? json(publicClaim(c, true), 200, cors) : json({ error: "NOT_FOUND" }, 404, cors);
    }

    if (path === "/api/recent") {
      const rows = await d.repo.recent(50);
      return json({ claims: rows.map((c) => publicClaim(c, false)) }, 200, cors);
    }

    const v = path.match(/^\/api\/vault\/([0-9]{1,20})$/);
    if (v) {
      const vault = await d.repo.getVault(v[1]!);
      if (!vault) return json({ error: "NOT_FOUND" }, 404, cors);
      const ids = Object.keys(TEMPLATES).map(Number);
      const vaultAddr = getAddress(vault.address) as Address;
      let chain: Awaited<ReturnType<VaultReader["overview"]>> | null = null;
      try {
        chain = await d.reader.overview(vaultAddr, ids);
      } catch {
        chain = null;
      }
      // DKIM keys come from the vault's own storage (authoritative for payouts, SPEC §7.2): candidates
      // from the D1 index plus KeyProposed events, each read back via dkimKey(pubkeyHash).
      let dkimKeys: unknown[] | null = null;
      try {
        const known = (await d.repo.listKeys()).map((k) => BigInt(k.pubkey_hash));
        const fromBlock = env.KEY_LOGS_FROM_BLOCK ? BigInt(env.KEY_LOGS_FROM_BLOCK) : undefined;
        dkimKeys = await d.reader.dkimKeys(vaultAddr, known, fromBlock);
      } catch {
        dkimKeys = null; // never fall back to unverified data
      }
      return json(
        {
          id: vault.id,
          address: vault.address,
          policyText: vault.policy_text,
          policy: JSON.parse(vault.policy_json),
          policyHash: vault.policy_hash,
          paused: chain?.paused ?? null,
          usdcBalance: chain?.usdcBalance ?? null,
          employeeDailyCap: chain?.employeeDailyCap ?? null,
          merchants: chain
            ? chain.merchants.filter((x) => x.active).map((x) => ({ ...x, merchant: templateById(x.templateId)?.merchant ?? null }))
            : null,
          dkimKeys,
        },
        200,
        cors,
      );
    }

    if (path === "/api/agent") {
      return json(
        {
          agent: d.cfg.agentKey ? agentAddress(d.cfg.agentKey) : null,
          chainId: d.cfg.chainId,
          acceptedVkHashes: d.cfg.vkHashes,
          proofSystem: { proofType: "ultrahonk", version: "V5_0", variant: "ZK" },
          statement: STATEMENT,
        },
        200,
        cors,
      );
    }

    if (path === "/health") {
      const now = d.now();
      return json(
        {
          ok: true,
          time: new Date(now).toISOString(),
          usage: {
            submissionsToday: await d.repo.submissionsToday(now),
            maxSubmissionsPerDay: d.cfg.maxSubmissionsPerDay,
            decisionsLast24h: await d.repo.decisionCounts(now),
          },
          configured: { kurier: !!d.submitter, relayer: !!d.settler, agentKey: !!d.cfg.agentKey, ai: !!d.llm },
        },
        200,
        cors,
      );
    }

    return json({ error: "NOT_FOUND" }, 404, cors);
  } catch {
    // Never echo internals (could include URLs that carry the Kurier key).
    return json({ error: "INTERNAL" }, 500, cors);
  }
}

export default {
  fetch(req: Request, env: Env, ctx: ExecutionContext) {
    return handleRequest(req, env, ctx);
  },
  async scheduled(_ev: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(pollOnce(buildDeps(env)).then(() => undefined));
  },
} satisfies ExportedHandler<Env>;
