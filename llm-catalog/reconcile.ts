/**
 * `reconcile` for `@stateless/llm-catalog` — a deterministic GATHER of every
 * config (access-path) for a target (a model, optionally pinned to a hardware),
 * across the public catalog and the private/declared entries. It produces the
 * side-by-side comparison material — runtimes, quants, results, cost, lineage,
 * verification — so a consuming agent can REASON over "which config should I
 * run" and why results differ. The method does the gather; the judgement stays
 * with the reader (the catalog can't and shouldn't pick for you).
 *
 * Pure + deterministic for unit testing; the method wraps it with the reads.
 *
 * @module
 */

import type { Entry } from "./schemas.ts";

// deno-lint-ignore no-explicit-any
function rel(ap: any, name: string): string | undefined {
  return (ap.relations ?? []).find((r: { rel: string }) => r.rel === name)
    ?.target;
}
// deno-lint-ignore no-explicit-any
function lineage(ap: any): string[] {
  const verbs = ["supersedes", "replicates", "alt-config-of", "finetune-of"];
  return (ap.relations ?? [])
    .filter((r: { rel: string }) => verbs.includes(r.rel))
    .map((r: { rel: string; target: string }) => `${r.rel}→${r.target}`);
}

/** One config row in the comparison. */
export interface ConfigSummary {
  id: string;
  access: "self-host" | "gateway";
  runtime?: string;
  provider?: string;
  quant?: string;
  hardware?: string;
  speed?: number;
  quality?: unknown;
  cost?: string;
  verification?: string;
  lineage: string[];
  visibility?: string;
  source?: string;
}

/** Project one access-path entry into a comparison row. */
export function summarizeConfig(ap: Entry): ConfigSummary {
  // deno-lint-ignore no-explicit-any
  const f: any = ap.facets ?? {};
  const recipe = f.recipe ?? {};
  const outcome = f.outcome ?? {};
  const cost = f.cost ?? {};
  const prov = outcome.provenance ?? cost.provenance ?? {};
  const runsOn = rel(ap, "runs-on");
  const hw = runsOn
    ? `${runsOn}${recipe.hardware?.units ? ` ×${recipe.hardware.units}` : ""}${
      recipe.hardware?.config ? ` (${recipe.hardware.config})` : ""
    }`
    : undefined;
  const isGateway = !!rel(ap, "via-provider");
  return {
    id: ap.id,
    access: isGateway ? "gateway" : "self-host",
    runtime: rel(ap, "served-by"),
    provider: rel(ap, "via-provider"),
    quant: recipe.artifact?.quant ?? outcome.footprint?.quant,
    hardware: hw,
    speed: typeof outcome.speed?.genTokS === "number"
      ? outcome.speed.genTokS
      : undefined,
    quality: outcome.quality ?? "unverified",
    cost: cost.perMTokInUsd != null
      ? `$${cost.perMTokInUsd}/$${cost.perMTokOutUsd} per MTok`
      : undefined,
    verification: prov.verification,
    lineage: lineage(ap),
    visibility: ap.visibility,
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
 * Gather all access-paths for `target` (filtered to `hardware` if given) and
 * return them as a sorted comparison (fastest self-host first; gateways and
 * unmeasured configs after).
 */
export function buildReconciliation(
  target: string,
  entries: Entry[],
  hardware?: string,
): Reconciliation {
  const configs = entries
    .filter((e) =>
      e.kind === "access-path" &&
      (e.relations ?? []).some((r) =>
        r.rel === "of-model" && r.target === target
      ) &&
      (!hardware ||
        (e.relations ?? []).some((r) =>
          r.rel === "runs-on" && r.target === hardware
        ))
    )
    .map(summarizeConfig)
    .sort((a, b) => (b.speed ?? -1) - (a.speed ?? -1));
  return { target, hardware, count: configs.length, configs };
}
