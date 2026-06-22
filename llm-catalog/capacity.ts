/**
 * `capacity` for `@stateless/llm-catalog` — the capability-query consumer.
 *
 * Where `reconcile` GATHERS every config for ONE named model, `capacity` answers
 * an INTENT across ALL models: "given this task + this host + these co-resident
 * reservations + this privacy/cost policy, what should I run, and what spills to
 * cloud?" It returns a small ranked Pareto set — bin-packed against the host's
 * free unified memory, local vs cloud arbitrated — NOT the catalog. The whole
 * filter→fit→rank sweep runs here so a calling agent makes one call and gets the
 * decision back, not 28k of catalog through context.
 *
 * Local and cloud are ranked together so the answer SHOWS the trade; it does not
 * pre-decide it (the catalog gathers, the reader chooses). Footprint = a stored
 * `facets.footprint` quant entry when present (measured/published beats a
 * formula), else computed from verified `params × quant-bits/8` (uniform coverage
 * without duplicating a GB number onto every model).
 *
 * Pure + deterministic for unit testing; the method wraps it with the reads.
 *
 * @module
 */

import type { CapacityArgs, Entry, PlanArgs } from "./schemas.ts";

// quant → effective bits/param (incl. typical quant overhead). One place for the
// footprint-formula constant; stored footprint facets override this.
const QUANT_BITS: Record<string, number> = {
  q2: 2.8,
  q3: 3.4,
  q4: 4.5,
  q5: 5.5,
  q6: 6.5,
  q8: 8,
  fp8: 8,
  fp16: 16,
  bf16: 16,
  int4: 4.3,
  int8: 8,
  mxfp4: 4.25,
  nvfp4: 4.25,
  awq: 4.25,
  gptq: 4.25,
};
// KV-cache GB per 1k ctx tokens, by attention family (rough estimates). Efficient
// designs carry a fraction of full-attention KV: MLA (DeepSeek) and linear/DeltaNet
// (Qwen3.5) are tiny, GQA is moderate, full MHA is heavy. A flat constant would
// wrongly penalise exactly the long-context models that fit.
// deno-lint-ignore no-explicit-any
function kvGbPerK(model: any): number {
  const a = model?.facets?.architecture ?? {};
  const s = `${a.attention ?? ""} ${a.modelType ?? ""}`.toLowerCase();
  if (/deltanet|linear|mamba|ssm/.test(s)) return 0.005;
  if (/mla|dsa|latent|deepseek_v4|glm_moe_dsa/.test(s)) return 0.006;
  if (/gqa|grouped/.test(s)) return 0.03;
  if (/full|dense|mha/.test(s)) return 0.12;
  return 0.05; // unknown → mid estimate
}

/**
 * Effective-bits key for a quant string ("q2-imatrix" → q2, "INT4 (AutoRound)" →
 * int4). For a HYBRID string ("hybrid INT4 + FP8") pick the LOWEST-bit match —
 * an MoE hybrid is dominated by its bulk (the low-bit experts), so the named
 * higher-precision part (a few dense layers) must not drive the estimate.
 */
export function quantKey(quant?: string): string {
  const s = (quant ?? "").toLowerCase();
  let best: string | undefined;
  for (const k of Object.keys(QUANT_BITS)) {
    if (
      s.includes(k) && (best === undefined || QUANT_BITS[k] < QUANT_BITS[best])
    ) {
      best = k;
    }
  }
  return best ?? "q4"; // unknown → assume ~4-bit
}

/** Total params in billions, parsed from "284B" / "1.6T" / "~80B". */
export function parseParamsB(p?: string): number | undefined {
  if (!p) return undefined;
  const m = /([\d.]+)\s*([a-zA-Z]?)/.exec(p.replace("~", ""));
  if (!m) return undefined;
  const n = parseFloat(m[1]);
  if (!isFinite(n)) return undefined;
  return /t/i.test(m[2]) ? n * 1000 : n; // T → in units of B
}

// deno-lint-ignore no-explicit-any
function rel(e: any, name: string): string | undefined {
  return (e.relations ?? []).find((r: { rel: string }) => r.rel === name)
    ?.target;
}

/**
 * Memory (GB) to run `model` at `quant` over `ctxTokens` — a stored footprint
 * facet (override) else computed from verified params × quant-bits/8. MoE: TOTAL
 * params are resident, so `params` (not activeParams) drives weight memory.
 */
export function footprintGB(
  // deno-lint-ignore no-explicit-any
  model: any,
  quant: string | undefined,
  ctxTokens = 0,
): number | undefined {
  const k = quantKey(quant);
  // Prefer a MEASURED kvGbPer1k on the footprint facet; else the attention-class estimate.
  const perK = typeof model?.facets?.footprint?.kvGbPer1k === "number"
    ? model.facets.footprint.kvGbPer1k
    : kvGbPerK(model);
  const kv = (ctxTokens / 1000) * perK;
  const stored: Array<{ quant: string; memGB: number }> | undefined = model
    ?.facets?.footprint?.quants;
  const hit = stored?.find((q) => quantKey(q.quant) === k);
  if (hit && typeof hit.memGB === "number") return Math.round(hit.memGB + kv);
  const pB = parseParamsB(model?.facets?.architecture?.params);
  if (pB === undefined) return undefined;
  return Math.round((pB * QUANT_BITS[k]) / 8 + kv);
}

/** Headline decode tok/s for an access-path: direct genTokS, else best measurement. */
// deno-lint-ignore no-explicit-any
export function decodeTokS(ap: any): number | undefined {
  const oc = ap.facets?.outcome ?? {};
  if (typeof oc.speed?.genTokS === "number") return oc.speed.genTokS;
  if (typeof oc.speed?.decodeTokS === "number") return oc.speed.decodeTokS;
  const ms: Array<Record<string, number>> | undefined = oc.measurements;
  const ds = (ms ?? [])
    .map((m) => m.decodeTokS ?? m.decodeShortTokS)
    .filter((x): x is number => typeof x === "number");
  return ds.length ? Math.max(...ds) : undefined;
}

// ---------------------------------------------------------------------------
// capacity-v2 — workload profiles, quality scoring, throughput estimate, planner
// ---------------------------------------------------------------------------

/**
 * Named workload profiles: a weighted vector over benchmark dimensions + a
 * latency class. The weights say what "good" MEANS for that workload — an agent
 * lives or dies on tool-use (tau2/bfcl) + instruction-following (ifEval/ifBench),
 * whereas reasoning weights GPQA/AIME/HLE. `latency: interactive` workloads care
 * about decode tok/s; `batch` ones tolerate slower throughput for quality.
 * Weights are renormalised over whatever dims a model actually reports, so a
 * partially-benchmarked model still scores (with its `coverage` flagged).
 */
export const WORKLOAD_PROFILES: Record<
  string,
  { latency: "interactive" | "batch"; weights: Record<string, number> }
> = {
  agents: {
    latency: "interactive",
    weights: { tau2Agentic: 0.3, bfcl: 0.3, ifEval: 0.2, ifBench: 0.2 },
  },
  coding: {
    latency: "interactive",
    weights: { sweBenchVerified: 0.45, liveCodeBenchV6: 0.35, ifEval: 0.2 },
  },
  reasoning: {
    latency: "batch",
    weights: { gpqaDiamond: 0.3, aime2025: 0.25, mmluPro: 0.25, hle: 0.2 },
  },
  writing: {
    // long-form quality isn't directly benched — instruction-following + broad
    // knowledge are the best public proxies.
    latency: "batch",
    weights: { ifEval: 0.4, mmluPro: 0.35, mmmlu: 0.25 },
  },
  general: {
    latency: "interactive",
    weights: {
      mmluPro: 0.3,
      gpqaDiamond: 0.25,
      ifEval: 0.25,
      tau2Agentic: 0.2,
    },
  },
};

// Cross-source benchmark equivalences: vendors report the same capability under
// different keys/versions. A profile dim matches the first variant a model has,
// so gpt-oss (tauBenchRetail, no tau2) and Nemotron-Super (LCB v5, no v6) are
// scored fairly instead of penalised for a labelling difference.
const BENCH_SYNONYMS: Record<string, string[]> = {
  tau2Agentic: ["tau2Agentic", "tauBenchRetail", "tau2Telecom"],
  liveCodeBenchV6: ["liveCodeBenchV6", "liveCodeBenchV5", "liveCodeBench"],
  ifEval: ["ifEval", "ifBench"],
  aime2025: ["aime2025", "aime2026", "aime2024"],
};

/** Resolve a profile name + optional override map into a weight vector. */
export function resolveWeights(
  profile?: string,
  profileWeights?: Record<string, number>,
): Record<string, number> | undefined {
  if (profileWeights && Object.keys(profileWeights).length) {
    return profileWeights;
  }
  if (profile && WORKLOAD_PROFILES[profile]) {
    return WORKLOAD_PROFILES[profile].weights;
  }
  return undefined;
}

/** Pull a benchmark value, trying synonym variants in order. */
// deno-lint-ignore no-explicit-any
function benchVal(b: any, key: string): number | undefined {
  for (const k of BENCH_SYNONYMS[key] ?? [key]) {
    if (typeof b?.[k] === "number") return b[k];
  }
  return undefined;
}

export interface QualityScore {
  score: number; // weighted benchmark average over dims the model reports (0-100ish)
  coverage: number; // fraction of the profile's dims the model actually has
  dims: number; // count of dims scored
}

/**
 * Score a model against a weight vector: the weighted average of its benchmark
 * values, renormalised over the dims it reports. A model missing a dim isn't
 * zeroed (that would punish sparse-but-strong cards), but `coverage` exposes how
 * much of the profile it actually answers so a thin score reads as thin.
 */
export function qualityScore(
  // deno-lint-ignore no-explicit-any
  model: any,
  weights: Record<string, number>,
): QualityScore | undefined {
  const b = model?.facets?.benchmarks ?? {};
  let num = 0, wsum = 0, present = 0;
  const total = Object.keys(weights).length;
  for (const [k, w] of Object.entries(weights)) {
    const v = benchVal(b, k);
    if (typeof v === "number") {
      num += v * w;
      wsum += w;
      present++;
    }
  }
  if (wsum === 0) return undefined;
  return {
    score: Math.round((num / wsum) * 10) / 10,
    coverage: Math.round((present / total) * 100) / 100,
    dims: present,
  };
}

/**
 * Active-params throughput estimate (tok/s) for a model+quant on a host. Decode
 * is memory-bandwidth-bound: each token streams the ACTIVE weights once, so
 * tok/s ≈ bandwidth ÷ (activeParams × bytes/param). MoE sparsity is the lever —
 * a 122B-A10B reads only its 10B active params, so it decodes far faster than a
 * dense 27B. The quant-bit constant already folds in real-world overhead, so the
 * estimate lands near optimised serving (a fresh recipe may run below it). Used
 * only as a FALLBACK when an access-path carries no measured genTokS.
 */
export function decodeTokSEstimate(
  // deno-lint-ignore no-explicit-any
  model: any,
  quant: string | undefined,
  // deno-lint-ignore no-explicit-any
  hw: any,
): number | undefined {
  const bw: number | undefined = hw?.facets?.hardware?.memBandwidthGBs;
  if (typeof bw !== "number") return undefined;
  const a = model?.facets?.architecture ?? {};
  const activeB = parseParamsB(a.activeParams) ?? parseParamsB(a.params);
  if (activeB === undefined) return undefined;
  const bytesPerParam = QUANT_BITS[quantKey(quant)] / 8;
  const gbPerToken = activeB * bytesPerParam;
  if (gbPerToken <= 0) return undefined;
  return Math.round((bw / gbPerToken) * 10) / 10;
}

/** One recommendation row in the plan. */
export interface Recommendation {
  accessPath: string;
  placement: string; // "local:<host>[×N]" | "cloud"
  model?: string;
  quant?: string;
  units?: number;
  needGB?: number;
  fitContext?: number;
  freeAfterGB?: number;
  decodeTokS?: number;
  decodeTokSEstimated?: boolean; // true when tok/s is the bandwidth estimate, not a measurement
  qualityScore?: number; // weighted benchmark average for the requested profile
  qualityCoverage?: number; // fraction of profile dims the model reports
  context?: number;
  perMTokOutUsd?: number;
  confidence?: string;
  source?: string;
}

export interface CapacityPlan {
  task: string;
  host?: string;
  hostUnits: number;
  hostGB?: number; // total across units
  reservedGB: number;
  freeGB?: number;
  recommendations: Recommendation[];
  alsoConsidered: number;
  unmet: string[];
}

// ---------------------------------------------------------------------------
// Endpoint model — run-options come from model.facets.runsOn[] keyed by endpoint
// (the `endpoint` kind factors out the reusable interface). These helpers
// resolve an endpoint and flatten every (model × runsOn) into one candidate.
// ---------------------------------------------------------------------------

// deno-lint-ignore no-explicit-any
function endpointKindOf(ep: any): string {
  return ep?.facets?.endpoint?.kind ??
    (rel(ep, "via-provider") ? "gateway" : "self-host");
}

/** Headline decode tok/s from a runsOn outcome (direct genTokS else measurement). */
// deno-lint-ignore no-explicit-any
function decodeFromOutcome(outcome: any): number | undefined {
  const sp = outcome?.speed ?? {};
  if (typeof sp.genTokS === "number") return sp.genTokS;
  if (typeof sp.decodeTokS === "number") return sp.decodeTokS;
  const ms: Array<Record<string, number>> | undefined = outcome?.measurements;
  const ds = (ms ?? [])
    .map((m) => m.decodeTokS ?? m.decodeShortTokS)
    .filter((x): x is number => typeof x === "number");
  return ds.length ? Math.max(...ds) : undefined;
}

/** A flattened run-option: one model on one endpoint via one runsOn entry. */
export interface RunCandidate {
  // deno-lint-ignore no-explicit-any
  model: any;
  modelId: string;
  // deno-lint-ignore no-explicit-any
  endpoint: any;
  endpointId: string;
  kind: string; // self-host | gateway | rental-substrate
  hardwareId?: string; // self-host: the endpoint's runs-on (undefined = host-agnostic)
  // deno-lint-ignore no-explicit-any
  ro: any; // the runsOn entry
  id: string; // stable label for this operating point
  quant?: string;
  units: number;
  ctx?: number;
  measuredTokS?: number;
}

/** Flatten every model.facets.runsOn[] into resolved candidates (skips rentals — a
 * substrate, not a direct run option). Pure. */
export function enumerateRunOptions(entries: Entry[]): RunCandidate[] {
  // deno-lint-ignore no-explicit-any
  const endpoints = new Map<string, any>(
    entries.filter((e) => e.kind === "endpoint").map((e) => [e.id, e]),
  );
  const out: RunCandidate[] = [];
  for (const m of entries.filter((e) => e.kind === "model")) {
    // deno-lint-ignore no-explicit-any
    const runs: any[] = (m as any).facets?.runsOn ?? [];
    runs.forEach((ro, i) => {
      const ep = endpoints.get(ro?.endpoint);
      if (!ep) return;
      const kind = endpointKindOf(ep);
      if (kind === "rental-substrate") return;
      // deno-lint-ignore no-explicit-any
      const ma: any = (m as any).facets?.architecture ?? {};
      const ctx: number | undefined = ro.outcome?.context?.tokens ??
        ma.extendedContext ?? ma.nativeContext;
      const quantSlug = ro.quant
        ? String(ro.quant).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(
          0,
          24,
        )
        : `r${i}`;
      out.push({
        model: m,
        modelId: m.id,
        endpoint: ep,
        endpointId: ro.endpoint,
        kind,
        hardwareId: rel(ep, "runs-on"),
        ro,
        // index suffix guarantees uniqueness — two configs can share a quant on
        // one endpoint (e.g. int4 at units 2/3/4), and these ids key resources.
        id: `${m.id}::${ro.endpoint}::${quantSlug}#${i}`,
        quant: ro.quant,
        units: typeof ro.units === "number" ? ro.units : 1,
        ctx,
        measuredTokS: decodeFromOutcome(ro.outcome),
      });
    });
  }
  return out;
}

/**
 * Build the plan over the gathered pool. Pure + deterministic. Run-options come
 * from each model's `runsOn[]` (keyed by endpoint). For every candidate: classify
 * local (self-host endpoint) vs cloud (gateway), apply the hard constraints
 * (privacy, context, throughput, cost), fit-check local against the host's free
 * memory (after co-resident reservations), then Pareto-rank.
 */
export function buildCapacityPlan(
  args: CapacityArgs,
  entries: Entry[],
): CapacityPlan {
  const hw = entries.find((e) => e.id === args.host);
  // deno-lint-ignore no-explicit-any
  const hwf: any = (hw as any)?.facets?.hardware ?? {};
  const perUnitGB: number | undefined = hwf.unifiedMemGB;
  // Driver/firmware permanently reserves memory (e.g. GB10 ~22GB) — usable < installed.
  const reservedPerUnit: number = typeof hwf.driverReservedGB === "number"
    ? hwf.driverReservedGB
    : 0;
  const hostUnits = args.hostUnits ?? 1;
  const hostGB = perUnitGB === undefined
    ? undefined
    : (perUnitGB - reservedPerUnit) * hostUnits;
  const reserved = (args.coresident ?? []).reduce(
    (s, c) => s + (c.reserveGB ?? 0),
    0,
  );
  const freeGB = hostGB === undefined ? undefined : hostGB - reserved;
  const weights = resolveWeights(args.profile, args.profileWeights);

  const recs: Recommendation[] = [];
  const unmet: string[] = [];

  for (const cand of enumerateRunOptions(entries)) {
    const model = cand.model;
    const isCloud = cand.kind === "gateway";
    const isLocal = cand.kind === "self-host";
    if (!isCloud && !isLocal) continue;

    // hard gate: privacy
    if (args.privacy === "local-only" && isCloud) continue;

    const ctx = cand.ctx;
    if (args.minContext && typeof ctx === "number" && ctx < args.minContext) {
      continue;
    }

    if (isLocal) {
      // a self-host endpoint serves THIS host if it pins this hardware, or is
      // host-agnostic (no runs-on, e.g. llama.cpp runs on whatever you ask about).
      if (args.host && cand.hardwareId && cand.hardwareId !== args.host) {
        continue;
      }
      // node-count gate: a recipe needing more units than the host has is out.
      if (cand.units > hostUnits) {
        unmet.push(
          `${cand.id}: needs ${cand.units} units, host has ${hostUnits}`,
        );
        continue;
      }
      const quant = cand.quant;
      // Measured genTokS wins; else the bandwidth estimate fills the gap so a
      // model with no benchmarked recipe still gets a throughput figure.
      const measuredTokS = cand.measuredTokS;
      const tokS = measuredTokS ?? decodeTokSEstimate(model, quant, hw);
      if (args.minDecodeTokS && tokS && tokS < args.minDecodeTokS) continue;
      const q = weights ? qualityScore(model, weights) : undefined;
      // KV is budgeted at the context this recipe SERVES (or the user's minContext),
      // never zero — a fit with no context allowance is not a real operating point.
      const fitCtx = args.minContext ?? ctx ?? 0;
      const need = footprintGB(model, quant, fitCtx);
      const fits = freeGB === undefined || need === undefined || need <= freeGB;
      if (!fits) {
        unmet.push(
          `${cand.id}: needs ~${need}GB @${fitCtx} ctx, ${freeGB}GB free after ${reserved}GB reserved`,
        );
        continue;
      }
      recs.push({
        accessPath: cand.id,
        placement: `local:${args.host ?? cand.hardwareId ?? "?"}${
          cand.units > 1 ? `×${cand.units}` : ""
        }`,
        model: model.id,
        quant,
        units: cand.units,
        needGB: need,
        fitContext: fitCtx,
        freeAfterGB: need !== undefined && freeGB !== undefined
          ? freeGB - need
          : undefined,
        decodeTokS: tokS,
        decodeTokSEstimated: measuredTokS === undefined && tokS !== undefined,
        qualityScore: q?.score,
        qualityCoverage: q?.coverage,
        context: ctx,
        confidence: cand.ro.outcome?.provenance?.confidence,
        source: cand.ro.outcome?.provenance?.source,
      });
    } else {
      // cloud (gateway) — price lives on the runsOn entry's cost facet
      const cost: number | undefined = cand.ro.cost?.perMTokOutUsd;
      if (
        args.maxCostPerMTokOut != null && cost != null &&
        cost > args.maxCostPerMTokOut
      ) continue;
      const q = weights ? qualityScore(model, weights) : undefined;
      recs.push({
        accessPath: cand.id,
        placement: "cloud",
        model: model.id,
        perMTokOutUsd: cost,
        qualityScore: q?.score,
        qualityCoverage: q?.coverage,
        context: ctx,
        source: cand.ro.cost?.provenance?.source,
      });
    }
  }

  // Pareto rank: prefer local (unless privacy=any) → then, if a profile was
  // given, higher qualityScore → higher throughput → lower cost. Without a
  // profile, throughput leads as before. Deterministic and explainable.
  const localFirst = args.privacy !== "any";
  recs.sort((a, b) => {
    const aLocal = a.placement.startsWith("local");
    const bLocal = b.placement.startsWith("local");
    if (localFirst && aLocal !== bLocal) return aLocal ? -1 : 1;
    if (weights) {
      // Coverage-discounted: a high score on a benchmark the model barely
      // reports shouldn't outrank a substantiated one (the thin-coverage trap).
      const eff = (r: Recommendation) =>
        (r.qualityScore ?? 0) * (r.qualityCoverage ?? 0);
      const dq = eff(b) - eff(a);
      if (dq !== 0) return dq;
    }
    return (b.decodeTokS ?? 0) - (a.decodeTokS ?? 0) ||
      (a.perMTokOutUsd ?? 1e9) - (b.perMTokOutUsd ?? 1e9);
  });

  return {
    task: args.task,
    host: args.host,
    hostUnits,
    hostGB,
    reservedGB: reserved,
    freeGB,
    recommendations: recs.slice(0, args.topK),
    alsoConsidered: recs.length,
    unmet,
  };
}

// ---------------------------------------------------------------------------
// Deployment planner — multi-workload placement on a Pareto front
// ---------------------------------------------------------------------------

/** Per-workload assignment within a deployment plan. */
export interface PlanWorkload {
  label: string;
  model?: string;
  accessPath?: string;
  quant?: string;
  qualityScore?: number;
  qualityCoverage?: number;
  decodeTokS?: number;
  decodeTokSEstimated?: boolean;
  needGB?: number;
  context?: number;
}

/** One enumerated deployment — a single shared model or a split of specialists. */
export interface DeploymentOption {
  kind: "shared" | "split";
  models: string[];
  totalGB?: number;
  freeAfterGB?: number;
  minQuality?: number; // the bottleneck workload's RAW benchmark score
  avgQuality?: number;
  effMinQuality?: number; // coverage-discounted (score×coverage) — what ranking/Pareto use
  effAvgQuality?: number;
  minDecodeTokS?: number; // slowest member (shared: the one stream serving all)
  workloads: PlanWorkload[];
  pareto?: boolean;
  verdict: string;
}

export interface DeploymentPlanResult {
  host: string;
  hostUnits: number;
  hostGB?: number;
  reservedGB: number;
  freeGB?: number;
  plans: DeploymentOption[];
  alsoConsidered: number; // total enumerated plans before the topK slice (no silent cap)
  unmet: string[];
}

const isNum = (x: unknown): x is number => typeof x === "number";
const avg = (xs: number[]) =>
  xs.length
    ? Math.round((xs.reduce((s, x) => s + x, 0) / xs.length) * 10) / 10
    : undefined;

/**
 * Enumerate deployment plans for a SET of concurrent workloads on a host and
 * rank them on a Pareto front. The real question a single box poses — "one big
 * model for everything, or split into specialists?" — has no single right
 * answer, so this GATHERS both: a shared plan (one model serves all; one
 * footprint, max context headroom, no per-server isolation overhead, but a
 * compromise on every task) and a split plan (each workload gets its best model
 * for its profile, but pays N footprints + N isolation overheads out of the same
 * unified pool). Pure + deterministic.
 */
export function buildDeploymentPlans(
  args: PlanArgs,
  entries: Entry[],
): DeploymentPlanResult {
  const hw = entries.find((e) => e.id === args.host);
  // deno-lint-ignore no-explicit-any
  const hwf: any = (hw as any)?.facets?.hardware ?? {};
  const perUnitGB: number | undefined = hwf.unifiedMemGB;
  const reservedPerUnit: number = typeof hwf.driverReservedGB === "number"
    ? hwf.driverReservedGB
    : 0;
  const hostUnits = args.hostUnits ?? 1;
  const hostGB = perUnitGB === undefined
    ? undefined
    : (perUnitGB - reservedPerUnit) * hostUnits;
  const reserved = (args.coresident ?? []).reduce(
    (s, c) => s + (c.reserveGB ?? 0),
    0,
  );
  const budget = hostGB === undefined ? undefined : hostGB - reserved;
  const iso = args.isolationOverheadGB ?? 2;
  const unmet: string[] = [];

  const wls = args.workloads.map((w) => ({
    label: w.label,
    weights: resolveWeights(w.profile, w.profileWeights),
    minContext: w.minContext,
    minDecodeTokS: w.minDecodeTokS,
  }));

  // Candidate self-host run-options on this host (from runsOn[], node-gate applied).
  // Gateways and rentals are not deployment members — this is about placing models
  // on owned hardware. Host-agnostic endpoints (no runs-on, e.g. llama.cpp) qualify.
  interface Cand {
    apId: string;
    modelId: string;
    // deno-lint-ignore no-explicit-any
    modelEntry: any;
    quant?: string;
    reqUnits: number;
    ctx?: number;
    tokS?: number;
    tokSEstimated: boolean;
  }
  const cands: Cand[] = [];
  for (const c of enumerateRunOptions(entries)) {
    if (c.kind !== "self-host") continue;
    if (c.hardwareId && c.hardwareId !== args.host) continue;
    if (c.units > hostUnits) continue;
    const tokS = c.measuredTokS ?? decodeTokSEstimate(c.model, c.quant, hw);
    cands.push({
      apId: c.id,
      modelId: c.modelId,
      modelEntry: c.model,
      quant: c.quant,
      reqUnits: c.units,
      ctx: c.ctx,
      tokS,
      tokSEstimated: c.measuredTokS === undefined && tokS !== undefined,
    });
  }

  const plans: DeploymentOption[] = [];

  // ── SHARED: one model serves every workload ──────────────────────────────
  const maxMinCtx = Math.max(0, ...wls.map((w) => w.minContext ?? 0));
  const byModel = new Map<string, Cand[]>();
  for (const c of cands) {
    const arr = byModel.get(c.modelId) ?? [];
    arr.push(c);
    byModel.set(c.modelId, arr);
  }
  for (const [modelId, list] of byModel) {
    // Must satisfy every workload's context floor; pick the fastest such recipe.
    const feasible = list
      .filter((c) =>
        !wls.some((w) => w.minContext && (c.ctx ?? 0) < w.minContext)
      )
      .sort((a, b) => (b.tokS ?? 0) - (a.tokS ?? 0));
    const c = feasible[0];
    if (!c) continue;
    if (wls.some((w) => w.minDecodeTokS && (c.tokS ?? 0) < w.minDecodeTokS)) {
      continue;
    }
    const serveCtx = maxMinCtx > 0 ? maxMinCtx : (c.ctx ?? 0);
    const need = footprintGB(c.modelEntry, c.quant, serveCtx);
    if (need !== undefined && budget !== undefined && need > budget) {
      unmet.push(
        `shared ${modelId}: ~${need}GB @${serveCtx} ctx > ${budget}GB`,
      );
      continue;
    }
    const perWl: PlanWorkload[] = wls.map((w) => {
      const q = w.weights ? qualityScore(c.modelEntry, w.weights) : undefined;
      return {
        label: w.label,
        model: modelId,
        accessPath: c.apId,
        quant: c.quant,
        qualityScore: q?.score,
        qualityCoverage: q?.coverage,
        decodeTokS: c.tokS,
        decodeTokSEstimated: c.tokSEstimated,
        needGB: need,
        context: serveCtx,
      };
    });
    const qs = perWl.map((p) => p.qualityScore).filter(isNum);
    const effs = perWl.map((p) =>
      (p.qualityScore ?? 0) * (p.qualityCoverage ?? 0)
    );
    plans.push({
      kind: "shared",
      models: [modelId],
      totalGB: need,
      freeAfterGB: need !== undefined && budget !== undefined
        ? Math.round(budget - need)
        : undefined,
      minQuality: qs.length ? Math.min(...qs) : undefined,
      avgQuality: avg(qs),
      effMinQuality: effs.length
        ? Math.round(Math.min(...effs) * 10) / 10
        : undefined,
      effAvgQuality: avg(effs),
      minDecodeTokS: c.tokS,
      workloads: perWl,
      verdict: "",
    });
  }

  // ── SPLIT: a specialist per workload, co-resident single-unit servers ─────
  // Split members must be single-unit (reqUnits==1): N servers share the unified
  // pool, so a multi-unit recipe can only exist as a shared plan that consumes
  // the cluster. Each member budgets its own KV; isolation overhead × (N-1).
  const perWlCands = wls.map((w) => {
    const scored = cands
      .filter((c) => c.reqUnits === 1)
      .filter((c) => !w.minContext || (c.ctx ?? 0) >= w.minContext)
      .filter((c) => !w.minDecodeTokS || (c.tokS ?? 0) >= w.minDecodeTokS)
      .map((c) => {
        const serveCtx = w.minContext ?? c.ctx ?? 0;
        const need = footprintGB(c.modelEntry, c.quant, serveCtx);
        const q = w.weights ? qualityScore(c.modelEntry, w.weights) : undefined;
        return { c, serveCtx, need, q };
      })
      .filter((x) => x.need !== undefined);
    // Coverage-discounted effective quality drives the pick (substantiated > lucky).
    const eff = (s: typeof scored[number]) =>
      (s.q?.score ?? 0) * (s.q?.coverage ?? 0);
    // Dedup by model: keep its best (eff quality, then smallest footprint).
    const best = new Map<string, typeof scored[number]>();
    for (const s of scored) {
      const prev = best.get(s.c.modelId);
      const better = !prev || eff(s) > eff(prev) ||
        (eff(s) === eff(prev) && (s.need ?? 1e9) < (prev.need ?? 1e9));
      if (better) best.set(s.c.modelId, s);
    }
    return [...best.values()].sort((a, b) =>
      eff(b) - eff(a) || (a.need ?? 1e9) - (b.need ?? 1e9)
    );
  });

  if (wls.length >= 2 && perWlCands.every((a) => a.length)) {
    // Bounded cartesian search over each workload's top candidates. A box runs a
    // handful of workloads, so the product is tiny; exact-search beats greedy
    // (which can pick a higher-footprint downgrade). Members must be DISTINCT
    // models — two workloads on the same model is a shared plan, not a split.
    const capped = perWlCands.map((a) => a.slice(0, 6));
    let combos: number[][] = [[]];
    for (const arr of capped) {
      const next: number[][] = [];
      for (const combo of combos) {
        for (let i = 0; i < arr.length; i++) next.push([...combo, i]);
      }
      combos = next;
    }
    let chosen: typeof capped[number] | null = null;
    let bestKey = [-1, -1, Infinity]; // [effMin, effAvg, total] — maximise, then minimise total
    let anyFit = false;
    for (const combo of combos) {
      const pick = combo.map((j, i) => capped[i][j]);
      if (new Set(pick.map((s) => s.c.modelId)).size < wls.length) continue;
      const t = pick.reduce((s, p) => s + (p.need ?? 0), 0) +
        iso * (wls.length - 1);
      if (budget !== undefined && t > budget) continue;
      anyFit = true;
      const effs = pick.map((s) => (s.q?.score ?? 0) * (s.q?.coverage ?? 0));
      const effMin = Math.min(...effs);
      const effAvgV = effs.reduce((a, b) => a + b, 0) / effs.length;
      if (
        effMin > bestKey[0] ||
        (effMin === bestKey[0] &&
          (effAvgV > bestKey[1] || (effAvgV === bestKey[1] && t < bestKey[2])))
      ) {
        bestKey = [effMin, effAvgV, t];
        chosen = pick;
      }
    }
    if (chosen) {
      const t = bestKey[2];
      const sel = chosen;
      const perWl: PlanWorkload[] = sel.map((s, i) => ({
        label: wls[i].label,
        model: s.c.modelId,
        accessPath: s.c.apId,
        quant: s.c.quant,
        qualityScore: s.q?.score,
        qualityCoverage: s.q?.coverage,
        decodeTokS: s.c.tokS,
        decodeTokSEstimated: s.c.tokSEstimated,
        needGB: s.need,
        context: s.serveCtx,
      }));
      const qs = perWl.map((p) => p.qualityScore).filter(isNum);
      const effs = perWl.map((p) =>
        (p.qualityScore ?? 0) * (p.qualityCoverage ?? 0)
      );
      const ts = perWl.map((p) => p.decodeTokS).filter(isNum);
      plans.push({
        kind: "split",
        models: sel.map((s) => s.c.modelId),
        totalGB: Math.round(t),
        freeAfterGB: budget !== undefined ? Math.round(budget - t) : undefined,
        minQuality: qs.length ? Math.min(...qs) : undefined,
        avgQuality: avg(qs),
        effMinQuality: effs.length
          ? Math.round(Math.min(...effs) * 10) / 10
          : undefined,
        effAvgQuality: avg(effs),
        minDecodeTokS: ts.length ? Math.min(...ts) : undefined,
        workloads: perWl,
        verdict: "",
      });
    } else {
      unmet.push(
        anyFit
          ? `split: no distinct-model combination fits ${budget}GB budget`
          : `split: no combination fits ${budget}GB budget`,
      );
    }
  }

  // Pareto flag over (effAvgQuality↑, minDecodeTokS↑, freeAfterGB↑): a plan is
  // dominated if another is ≥ on all three and > on at least one. Quality is the
  // coverage-discounted figure so a thinly-benchmarked plan can't dominate.
  const dims = (
    p: DeploymentOption,
  ) => [p.effAvgQuality ?? -1, p.minDecodeTokS ?? -1, p.freeAfterGB ?? -1];
  for (const p of plans) {
    p.pareto = !plans.some((o) => {
      if (o === p) return false;
      const a = dims(o), b = dims(p);
      return a.every((x, i) => x >= b[i]) && a.some((x, i) => x > b[i]);
    });
  }

  // Rank: guaranteed (coverage-discounted) quality first, then avg, then headroom.
  plans.sort((a, b) =>
    (b.effMinQuality ?? -1) - (a.effMinQuality ?? -1) ||
    (b.effAvgQuality ?? -1) - (a.effAvgQuality ?? -1) ||
    (b.freeAfterGB ?? -1) - (a.freeAfterGB ?? -1)
  );

  for (const p of plans) {
    const mq = p.minQuality !== undefined
      ? `min-quality ${p.minQuality}`
      : "quality n/a";
    const ts = p.minDecodeTokS !== undefined
      ? `${p.minDecodeTokS} tok/s${
        p.workloads.some((w) => w.decodeTokSEstimated) ? "*" : ""
      }`
      : "tok/s n/a";
    if (p.kind === "shared") {
      p.verdict =
        `One ${p.models[0]} serves all ${p.workloads.length} workloads — ` +
        `${p.totalGB}GB, ${p.freeAfterGB}GB headroom, no isolation overhead; ${mq}, ${ts} ` +
        `(one stream shared across concurrent load).`;
    } else {
      p.verdict =
        `${p.workloads.length} specialists (${p.models.join(" + ")}) — ` +
        `${p.totalGB}GB incl. ${iso}GB×${p.workloads.length - 1} isolation, ` +
        `${p.freeAfterGB}GB headroom; ${mq}, slowest ${ts}.`;
    }
  }

  return {
    host: args.host,
    hostUnits,
    hostGB,
    reservedGB: reserved,
    freeGB: budget,
    plans: plans.slice(0, args.topK),
    alsoConsidered: plans.length,
    unmet,
  };
}

// ---------------------------------------------------------------------------
// Operating-point flat index — the query/pivot projection
// ---------------------------------------------------------------------------

/**
 * One flat, denormalised row per (model × runsOn entry). The embedded `runsOn[]`
 * is the SOURCE OF TRUTH (authored, eyeball-able); this is the read-optimised
 * projection so `swamp data query operating-point '<CEL>'` can pivot across all
 * configs by any field — performance (genTokS), price, quant, endpoint — without
 * filtering nested arrays. `benchmarks` carries the model-level (vendor) eval;
 * `configEval` carries a recipe's own measured eval, kept separate so the two
 * tiers are never conflated. Generated by `apply`, never hand-edited.
 */
export interface OperatingPointRow {
  id: string;
  model: string;
  family?: string;
  endpoint: string;
  endpointKind: string;
  quant?: string;
  units: number;
  techniques: string[];
  context?: number;
  genTokS?: number;
  genTokSEstimated?: boolean;
  needGB?: number;
  perMTokInUsd?: number;
  perMTokOutUsd?: number;
  // deno-lint-ignore no-explicit-any
  benchmarks?: any; // model-level (vendor) eval — evalScope "model"
  // deno-lint-ignore no-explicit-any
  configEval?: any; // recipe-specific measured eval — evalScope "config"
  asOf?: string;
  source?: string;
}

/** Explode every model.runsOn[] into flat, CEL-pivotable rows. Pure. */
export function buildOperatingPointIndex(
  entries: Entry[],
): OperatingPointRow[] {
  // deno-lint-ignore no-explicit-any
  const hwById = new Map<string, any>(
    entries.filter((e) => e.kind === "hardware").map((e) => [e.id, e]),
  );
  const rows: OperatingPointRow[] = [];
  for (const c of enumerateRunOptions(entries)) {
    const hw = c.hardwareId ? hwById.get(c.hardwareId) : undefined;
    const measured = c.measuredTokS;
    const genTokS = measured ??
      (hw ? decodeTokSEstimate(c.model, c.quant, hw) : undefined);
    const ro = c.ro;
    rows.push({
      id: c.id,
      model: c.modelId,
      family: rel(c.model, "variant-of"),
      endpoint: c.endpointId,
      endpointKind: c.kind,
      quant: c.quant,
      units: c.units,
      techniques: ro.techniques ?? [],
      context: c.ctx,
      genTokS,
      genTokSEstimated: measured === undefined && genTokS !== undefined,
      needGB: footprintGB(c.model, c.quant, c.ctx ?? 0),
      perMTokInUsd: ro.cost?.perMTokInUsd,
      perMTokOutUsd: ro.cost?.perMTokOutUsd,
      benchmarks: c.model.facets?.benchmarks,
      configEval: ro.outcome?.quality ?? ro.benchmarks,
      asOf: ro.outcome?.provenance?.asOf ?? ro.cost?.provenance?.asOf,
      source: ro.outcome?.provenance?.source ?? ro.cost?.provenance?.source,
    });
  }
  return rows;
}
