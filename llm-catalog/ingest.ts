/**
 * `ingest` source-mapping for `@stateless/llm-catalog` — turns a HuggingFace
 * `config.json` (a structured, authoritative primary source) into a draft
 * model `entry`'s architecture facet. Deterministic + pure, so it is unit
 * testable; the method wraps it with the `fetch`.
 *
 * Scope is deliberate: structured → structured is what a sandboxed method does
 * reliably, so `ingest` automates the high-confidence half (architecture from
 * config.json, marked `authoritative`). Prose-derived facts (params total,
 * benchmarks, license nuance, caveats) are NOT invented here — they are left as
 * gaps for human/agent enrichment + the PR review. This mirrors how the GLM-5.2
 * card was built: config.json gave the authoritative architecture; the model
 * card/blog gave the rest.
 *
 * @module
 */

import type { Entry } from "./schemas.ts";

/** Minimal shape of the HF config.json keys we map. */
export interface HfConfig {
  model_type?: string;
  num_hidden_layers?: number;
  hidden_size?: number;
  num_attention_heads?: number;
  vocab_size?: number;
  max_position_embeddings?: number;
  n_routed_experts?: number;
  n_shared_experts?: number;
  num_experts_per_tok?: number;
  torch_dtype?: string;
  [k: string]: unknown;
}

/** Build the canonical HF raw config.json URL for an org/repo. */
export function hfConfigUrl(repo: string, branch = "main"): string {
  return `https://huggingface.co/${repo}/raw/${branch}/config.json`;
}

/** Derive a kebab catalog id from an org/repo (e.g. zai-org/GLM-5.2 → model-glm-5-2). */
export function idFromRepo(repo: string): string {
  const name = repo.split("/").pop() ?? repo;
  const slug = name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  return `model-${slug}`;
}

/** Map a config.json's experts keys to a human "8/token of 256 routed + 1 shared". */
function expertsString(c: HfConfig): string | undefined {
  if (c.n_routed_experts == null && c.num_experts_per_tok == null) {
    return undefined;
  }
  const parts: string[] = [];
  if (c.num_experts_per_tok != null) {
    parts.push(`${c.num_experts_per_tok}/token`);
  }
  if (c.n_routed_experts != null) parts.push(`of ${c.n_routed_experts} routed`);
  if (c.n_shared_experts != null) parts.push(`+ ${c.n_shared_experts} shared`);
  return parts.join(" ");
}

export interface IngestResult {
  /** The draft entry (architecture facet populated; not yet enriched). */
  entry: Entry;
  /** Fields successfully mapped from config.json. */
  mapped: string[];
  /** Known gaps the human/agent must fill before this is catalog-ready. */
  gaps: string[];
}

/**
 * Build a draft model entry from a fetched HF config.json.
 *
 * @param repo    org/repo (for id, name, and the source URL in provenance)
 * @param config  parsed config.json
 * @param asOf    ISO date for provenance (caller stamps — `new Date()` in the method)
 * @param id      optional catalog id override (default derived from repo)
 */
export function ingestHfConfig(
  repo: string,
  config: HfConfig,
  asOf: string,
  id?: string,
): IngestResult {
  const mapped: string[] = [];
  // deno-lint-ignore no-explicit-any
  const arch: Record<string, any> = {};
  const put = (key: string, val: unknown, label: string) => {
    if (val != null && val !== "") {
      arch[key] = val;
      mapped.push(label);
    }
  };

  if (config.model_type) put("modelType", config.model_type, "model_type");
  put("layers", config.num_hidden_layers, "num_hidden_layers");
  put("hidden", config.hidden_size, "hidden_size");
  put("attentionHeads", config.num_attention_heads, "num_attention_heads");
  put("vocab", config.vocab_size, "vocab_size");
  put(
    "nativeContext",
    config.max_position_embeddings,
    "max_position_embeddings",
  );
  const experts = expertsString(config);
  if (experts) {
    arch.experts = experts;
    mapped.push("experts");
  }

  arch.provenance = {
    asOf,
    source: `${hfConfigUrl(repo)} (config.json)`,
    verification: "authoritative",
  };

  // deno-lint-ignore no-explicit-any
  const facets: Record<string, any> = { architecture: arch };
  if (config.torch_dtype) {
    facets.serving = {
      tensorTypes: [config.torch_dtype],
      provenance: {
        asOf,
        source: hfConfigUrl(repo),
        verification: "authoritative",
      },
    };
    mapped.push("torch_dtype");
  }

  const entry: Entry = {
    id: id ?? idFromRepo(repo),
    kind: "model",
    name: repo.split("/").pop() ?? repo,
    summary:
      `Ingested from ${repo} config.json — ENRICH: params/benchmarks/license/caveats`,
    visibility: "public",
    labels: [],
    relations: [],
    claims: [],
    facets,
  };

  // Gaps: things config.json never carries — must be filled from the model card.
  const gaps = [
    "total params (config has per-layer dims, not the headline count)",
    "active params (derive/confirm from the card)",
    "modality, license, release date",
    "published benchmarks",
    "summary + caveats",
  ];

  return { entry, mapped, gaps };
}
