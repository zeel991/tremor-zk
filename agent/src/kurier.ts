import type { Hex } from "viem";

export const KURIER_TESTNET = "https://api-testnet.kurier.xyz/api/v1";
export const KURIER_MAINNET = "https://api.kurier.xyz/api/v1";

/** Happy-path job statuses, in order (SPEC §8.2 step 5). */
export const JOB_PROGRESS = ["Queued", "Valid", "Submitted", "IncludedInBlock", "Finalized", "AggregationPending", "Aggregated"] as const;
export type JobProgress = (typeof JOB_PROGRESS)[number];

/**
 * Kurier's swagger (v1.36.0) types `status` as a free string. These names are the
 * known failure states; anything matching /fail|error|reject/i is treated the same.
 * [VERIFY] against a real failed job.
 */
export const JOB_FAILURE = ["Failed", "AggregationFailed", "Rejected", "Error"] as const;

export function isFailureStatus(s: string): boolean {
  return (JOB_FAILURE as readonly string[]).includes(s) || /fail|error|reject/i.test(s);
}

export interface JobStatus {
  jobId: string;
  status: string;
  txHash?: string | null;
  aggregationId?: number | null;
  statement?: string | null;
  aggregationDetails?: {
    root?: string;
    leaf?: string;
    leafIndex?: number;
    numberOfLeaves?: number;
    merkleProof?: string[];
  } | null;
  aggregationPublished?: { destinationChainId?: number; destinationTxHash?: string; createdAt?: string } | null;
  errorDetails?: unknown;
}

export interface SubmitInput {
  proof: Hex;
  publicSignals: Hex[];
  vkHash: Hex;
}

export interface SubmitResult {
  jobId: string;
  optimisticVerify?: "success" | "failed";
}

/** Anything that can take a proof to zkVerify and report on it. */
export interface ProofSubmitter {
  submit(input: SubmitInput): Promise<SubmitResult>;
  status(jobId: string): Promise<JobStatus>;
}

/** Error that never carries the API key (Kurier puts it in the URL path). */
export class KurierError extends Error {
  constructor(
    public readonly httpStatus: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = "KurierError";
  }
}

export interface KurierOptions {
  baseUrl: string;
  apiKey: string;
  chainId: number;
  fetch?: typeof fetch;
}

/** Kurier relayer client, UltraHonk V5_0 ZK (SPEC §8.2 step 4). */
export class KurierClient implements ProofSubmitter {
  private readonly base: string;
  private readonly key: string;
  private readonly chainId: number;
  private readonly f: typeof fetch;

  constructor(o: KurierOptions) {
    if (!o.apiKey) throw new Error("KURIER_API_KEY secret is not set");
    this.base = o.baseUrl.replace(/\/+$/, "");
    this.key = o.apiKey;
    this.chainId = o.chainId;
    this.f = o.fetch ?? fetch.bind(globalThis);
  }

  static readonly proofOptions = { version: "V5_0", variant: "ZK" } as const;

  private async call<T>(method: "GET" | "POST", path: string, body?: unknown): Promise<T> {
    let res: Response;
    try {
      res = await this.f(`${this.base}${path}`, {
        method,
        headers: body ? { "content-type": "application/json", accept: "application/json" } : { accept: "application/json" },
        body: body ? JSON.stringify(body) : undefined,
      });
    } catch {
      throw new KurierError(0, "NETWORK", "Kurier request failed");
    }
    const text = await res.text();
    let json: Record<string, unknown> = {};
    try {
      json = text ? JSON.parse(text) : {};
    } catch {
      /* non-JSON body */
    }
    if (!res.ok) {
      const code = typeof json.code === "string" ? json.code : `HTTP_${res.status}`;
      const msg = typeof json.message === "string" ? json.message : typeof json.error === "string" ? json.error : `Kurier HTTP ${res.status}`;
      throw new KurierError(res.status, code, this.scrub(msg));
    }
    return json as T;
  }

  private scrub(s: string): string {
    return s.split(this.key).join("***").slice(0, 300);
  }

  /** Registers the VK once; the returned vkHash must equal keccak256(0x03 ‖ vk) (SPEC §7.1 step 8). */
  async registerVk(vk: Hex): Promise<{ vkHash: Hex }> {
    const r = await this.call<{ vkHash?: string }>("POST", `/register-vk/${encodeURIComponent(this.key)}`, {
      proofType: "ultrahonk",
      proofOptions: KurierClient.proofOptions,
      vk,
    });
    if (!r.vkHash) throw new KurierError(200, "NO_VKHASH", "register-vk returned no vkHash");
    return { vkHash: r.vkHash as Hex };
  }

  async submit({ proof, publicSignals, vkHash }: SubmitInput): Promise<SubmitResult> {
    const r = await this.call<{ jobId?: string; optimisticVerify?: "success" | "failed"; error?: string | null }>(
      "POST",
      `/submit-proof/${encodeURIComponent(this.key)}`,
      {
        proofType: "ultrahonk",
        proofOptions: KurierClient.proofOptions,
        vkRegistered: true,
        chainId: this.chainId,
        proofData: { proof, publicSignals, vk: vkHash },
      },
    );
    if (!r.jobId) throw new KurierError(200, "NO_JOB", this.scrub(r.error ?? "submit-proof returned no jobId"));
    return { jobId: r.jobId, optimisticVerify: r.optimisticVerify };
  }

  async status(jobId: string): Promise<JobStatus> {
    if (!/^[0-9a-fA-F-]{36}$/.test(jobId)) throw new KurierError(400, "BAD_JOB_ID", "jobId is not a UUID");
    return this.call<JobStatus>("GET", `/job-status/${encodeURIComponent(this.key)}/${jobId}`);
  }
}

/**
 * Fallback path (SPEC §8.2 step 4): submit directly with zkverifyjs ≥ 3.4.0,
 * `verify().ultrahonk({ version: V5_0, variant: ZK })`, aggregation domain 2, from an
 * account funded with test VFY.
 *
 * TODO: this cannot run inside a Worker (zkverifyjs needs a long-lived WebSocket to a
 * zkVerify node, a substrate signer and far more than 10 ms CPU). It would run from a
 * CLI (e.g. `scripts/zkv-submit.ts`, not built) that reads APPROVED-but-unsubmitted
 * claims from the agent API, submits them, and posts the job/aggregation data back.
 * This stub only fixes the interface so the pipeline can switch submitters.
 */
export class ZkVerifyJsSubmitter implements ProofSubmitter {
  async submit(_input: SubmitInput): Promise<SubmitResult> {
    throw new Error("ZkVerifyJsSubmitter is a stub: direct zkverifyjs submission runs from a CLI, not the Worker");
  }
  async status(_jobId: string): Promise<JobStatus> {
    throw new Error("ZkVerifyJsSubmitter is a stub: direct zkverifyjs submission runs from a CLI, not the Worker");
  }
}
