/**
 * `reconcile` for `@stateless/llm-catalog` — a deterministic GATHER of every
 * run-option for a target model, across the public catalog and the private/
 * declared entries. Under the endpoint model the options live in the model's
 * `facets.runsOn[]` (keyed by endpoint), so reconcile flattens those into the
 * side-by-side comparison — runtime/provider, quant, results, cost, lineage,
 * verification — for a consuming agent to REASON over "which config should I
 * run" and why results differ. The method gathers; the judgement stays with the
 * reader (the catalog can't and shouldn't pick for you).
 *
 * Pure + deterministic for unit testing; the method wraps it with the reads.
 *
 * @module
 */

import type { Entry } from "./schemas.ts";

// deno-lint-ignore no-explicit-any
function rel(e: any, name: string): string | undefined {
  return (e.relations ?? []).find((r: { rel: string }) => r.rel === name)
    ?.target;
}

// deno-lint-ignore no-explicit-any
function endpointKindOf(ep: any): string {
  return ep?.facets?.endpoint?.kind ??
    (rel(ep, "via-provider") ? "gateway" : "self-host");
}

/** One config row in the comparison. */
export interface ConfigSummary {
  id: string;
  access: "self-host" | "gateway";
  endpoint?: string;
  runtime?: string;
  provider?: string;
  quant?: string;
  hardware?: string;
  units?: number;
  speed?: number;
  quality?: unknown;
  cost?: string;
  verification?: string;
  lineage: string[];
  visibility?: string;
  source?: string;
}

/** Project one runsOn operating point (+ its resolved endpoint) into a row. */
export function summarizeConfig(
  modelId: string,
  // deno-lint-ignore no-explicit-any
  ro: any,
  // deno-lint-ignore no-explicit-any
  endpoint: any,
  visibility?: string,
): ConfigSummary {
  const outcome = ro.outcome ?? {};
  const cost = ro.cost ?? {};
  const prov = outcome.provenance ?? cost.provenance ?? {};
  const kind = endpoint ? endpointKindOf(endpoint) : "self-host";
  const isGateway = kind === "gateway";
  const hwId = endpoint ? rel(endpoint, "runs-on") : undefined;
  const units = typeof ro.units === "number" ? ro.units : undefined;
  const quantSlug = ro.quant
    ? String(ro.quant).toLowerCase().replace(/[^a-z0-9]+/g, "-").slice(0, 24)
    : "gw";
  return {
    id: `${modelId}::${ro.endpoint}::${quantSlug}`,
    access: isGateway ? "gateway" : "self-host",
    endpoint: ro.endpoint,
    runtime: endpoint ? rel(endpoint, "served-by") : undefined,
    provider: endpoint ? rel(endpoint, "via-provider") : undefined,
    quant: ro.quant,
    hardware: hwId ? `${hwId}${units ? ` ×${units}` : ""}` : undefined,
    units,
    speed: typeof outcome.speed?.genTokS === "number"
      ? outcome.speed.genTokS
      : undefined,
    quality: outcome.quality ?? "unverified",
    cost: cost.perMTokInUsd != null
      ? `$${cost.perMTokInUsd}/$${cost.perMTokOutUsd} per MTok`
      : undefined,
    verification: prov.verification,
    lineage: ro.replicates ? [`replicates→${ro.replicates}`] : [],
    visibility,
    source: prov.source,
  };
}

export interface Reconciliation {
  target: string;
  hardware?: string;
  count: number;
  configs: ConfigSummary[];
}

/**
 * Gather all run-options for `target` (filtered to `hardware` if given) from the
 * model's `runsOn[]` — across every entry that declares this model id (private
 * shadows/augments public) — and return them as a sorted comparison (fastest
 * self-host first; gateways and unmeasured configs after).
 */
export function buildReconciliation(
  target: string,
  entries: Entry[],
  hardware?: string,
): Reconciliation {
  // deno-lint-ignore no-explicit-any
  const endpoints = new Map<string, any>(
    entries.filter((e) => e.kind === "endpoint").map((e) => [e.id, e]),
  );
  const configs: ConfigSummary[] = [];
  for (const e of entries) {
    if (e.kind !== "model" || e.id !== target) continue;
    // deno-lint-ignore no-explicit-any
    const runs: any[] = (e as any).facets?.runsOn ?? [];
    for (const ro of runs) {
      const ep = endpoints.get(ro?.endpoint);
      if (hardware && rel(ep, "runs-on") !== hardware) continue;
      configs.push(summarizeConfig(target, ro, ep, e.visibility));
    }
  }
  configs.sort((a, b) => (b.speed ?? -1) - (a.speed ?? -1));
  return { target, hardware, count: configs.length, configs };
}
