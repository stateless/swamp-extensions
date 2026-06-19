/**
 * Zod schemas + inferred types for `@stateless/llm-catalog`.
 *
 * Kept in a separate module (imported by `llm_catalog.ts`, never re-exported
 * from it) so the model's published entrypoint exposes only `model` — which
 * keeps the public API free of "slow types" (Zod's inferred schema/`z.infer`
 * types). Tests import the schemas directly from here.
 *
 * The shape mirrors `@stateless/inventory` deliberately: a **uniform core** with
 * an open `kind`, an open `facets` map (`.catchall`), and open-vocabulary
 * `relations` — so a new subject kind, facet, or edge needs no core edit. The
 * one thing this catalog adds that inventory doesn't need is the **provenance
 * envelope**: inventory records declared truth you own (the record *is* the
 * fact), whereas this records external, decaying, contested knowledge, so every
 * volatile assertion carries `asOf` + `source` + version pins. The durable
 * ENTITY (an entry) is therefore split from the volatile CLAIM about it.
 *
 * See `docs/decisions/2026-06-19-0cee6e-llm-catalog-knowledge-base.md` for the
 * full design (the five subjects, the access-path join, the anti-sprawl rule).
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Provenance — the volatility envelope. Wraps every claim, evaluative edge, and
// volatile facet (outcome, cost). This is what makes "very changeable knowledge"
// honest: a value without `asOf` + `source` is not trustworthy here, and
// `versionPins` records the software/hardware snapshot a finding is valid for
// (a self-host recipe with no CUDA/quant pins is useless-to-dangerous).
// ---------------------------------------------------------------------------

/** When/where a fact was observed, how confident, and what it's pinned to. */
export const ProvenanceSchema = z.object({
  asOf: z.string().min(1).describe(
    "When observed — ISO date preferred (YYYY-MM-DD). Staleness is queryable, " +
      "not guessed.",
  ),
  source: z.string().min(1).describe(
    "Where it came from — a URL, changelog/forum-thread ref, 'our-fleet-test', " +
      "or a benchmark name. A claim with no source is worthless here.",
  ),
  confidence: z.string().optional().describe(
    "Evidence strength — low | medium | high (open).",
  ),
  versionPins: z.record(z.string(), z.string()).optional().describe(
    "The snapshot this is valid for — { cuda, driver, runtime, patch, quant, " +
      "... }. Required in spirit for self-host recipes.",
  ),
  supersededBy: z.string().optional().describe(
    "Id/ref of the claim that replaces this one — so 'best X' is DERIVED as the " +
      "latest un-superseded claim, never a bare rotting field.",
  ),
}).catchall(z.unknown());
export type Provenance = z.infer<typeof ProvenanceSchema>;

// ---------------------------------------------------------------------------
// Claim — a dated, sourced assertion ABOUT an entry. The volatile layer that
// inventory has no analog for; this is where "very changeable" lives.
// ---------------------------------------------------------------------------

/** One dated, sourced assertion attached to an entry. */
export const ClaimSchema = z.object({
  kind: z.string().min(1).describe(
    "What sort of assertion — caveat | recommendation | issue | finding | " +
      "note | compat (open).",
  ),
  body: z.string().min(1).describe("The assertion itself, in plain text."),
  provenance: ProvenanceSchema,
}).catchall(z.unknown());
export type Claim = z.infer<typeof ClaimSchema>;

// ---------------------------------------------------------------------------
// Relation — a directed edge by entry id. Carries BOTH the access-path join
// (an access-path entry → its model/runtime/hardware/provider) and evaluative
// edges (prefer-over, with sourced rationale). Like inventory's relations, but
// edges that decay carry their own provenance.
// ---------------------------------------------------------------------------

/** A directed relationship from this entry to another, by id. */
export const RelationSchema = z.object({
  rel: z.string().min(1).describe(
    "Edge verb — served-by | runs-on | via-provider | uses-technique | " +
      "quantized-as | prefer-over | ref | … (open).",
  ),
  target: z.string().min(1).describe(
    "Entry id this edge points to (or an external slug for `ref`).",
  ),
  rationale: z.string().optional().describe(
    "Why — especially for evaluative edges (prefer-over).",
  ),
  provenance: ProvenanceSchema.optional().describe(
    "Evaluative edges decay — date + source them.",
  ),
}).catchall(z.unknown());
export type Relation = z.infer<typeof RelationSchema>;

// ---------------------------------------------------------------------------
// Facets — layered, optional dimensions. Known facets are typed (light, all
// fields optional, every one `.catchall`); unknown facets pass through. Each
// facet is also the SCOPING/rate-of-change unit: architecture is static
// catalog, outcome/cost are volatile (carry provenance).
// ---------------------------------------------------------------------------

/** Static-tier model architecture facts. They EXPLAIN which recipes work
 * (e.g. MLA / DeltaNet → small KV cache → long context feasible). */
export const ArchitectureFacetSchema = z.object({
  attention: z.string().optional().describe(
    "Attention design — MHA | GQA | MLA | sliding-window | hybrid-deltanet | …",
  ),
  params: z.string().optional().describe("Total parameters, e.g. '122B'."),
  activeParams: z.string().optional().describe(
    "Active params per token for MoE, e.g. '10B' (A10B).",
  ),
  nativeContext: z.number().int().positive().optional().describe(
    "Native context window in tokens (from GGUF metadata, not the model name).",
  ),
  modality: z.array(z.string()).optional().describe(
    "Modalities — text | image | video | audio (open). ASR/diarization/embed " +
      "models live in this catalog too.",
  ),
}).catchall(z.unknown());

/** The outcome Pareto vector — what you optimise over. Volatile: provenance.
 * The `quality` coordinate is where EVALUATION plugs in (task-eval, not PPL). */
export const OutcomeFacetSchema = z.object({
  quality: z.record(z.string(), z.unknown()).optional().describe(
    "Task-eval results — { score, eval, ... }. NOT perplexity (PPL is not a " +
      "quality proxy).",
  ),
  speed: z.record(z.string(), z.unknown()).optional().describe(
    "Throughput — { genTokS, ttftMs, ... }.",
  ),
  footprint: z.record(z.string(), z.unknown()).optional().describe(
    "Memory/size — { vramGB, kvGB, quant, sizeGB, ... }.",
  ),
  context: z.record(z.string(), z.unknown()).optional().describe(
    "Usable context — { tokens, ... } (may be below native; sliding-window caps).",
  ),
  reasoning: z.record(z.string(), z.unknown()).optional().describe(
    "Reasoning overhead — { thinkTokens, thinkPct, ... }. The 'actual cost of " +
      "reasoning' axis (think vs nothink).",
  ),
  provenance: ProvenanceSchema.optional(),
}).catchall(z.unknown());

/** Cost — dual-mode. Gateway paths cost per-token; self-host paths cost
 * capex + opex(power). Volatile: provenance (prices churn weekly). */
export const CostFacetSchema = z.object({
  perMTokInUsd: z.number().nonnegative().optional().describe(
    "Gateway input price, USD per 1M tokens.",
  ),
  perMTokOutUsd: z.number().nonnegative().optional().describe(
    "Gateway output price, USD per 1M tokens.",
  ),
  capexUsd: z.number().nonnegative().optional().describe(
    "Self-host hardware capital cost, USD.",
  ),
  powerW: z.number().nonnegative().optional().describe(
    "Self-host operating power draw in watts (opex input).",
  ),
  provenance: ProvenanceSchema.optional(),
}).catchall(z.unknown());

/** Hardware capability — a hardware-CLASS catalog (distinct from owned fleet;
 * link an owned box via a `ref` relation into @stateless/inventory). */
export const HardwareFacetSchema = z.object({
  compute: z.string().optional().describe(
    "Accelerator stack — cuda | rocm | metal | … (the key self-host signal).",
  ),
  vramGB: z.number().nonnegative().optional(),
  unifiedMemGB: z.number().nonnegative().optional().describe(
    "Unified memory (e.g. GB10 / DGX Spark), GB.",
  ),
  powerW: z.number().nonnegative().optional(),
  clusterable: z.boolean().optional().describe(
    "Can multiple units cluster for a bigger model (e.g. 2× Spark)?",
  ),
}).catchall(z.unknown());

/** Serving knobs — runtime + flags + sampling. The self-host `settings` of an
 * access-path; highly model- and runtime-version-specific (pin via provenance). */
export const ServingFacetSchema = z.object({
  flags: z.record(z.string(), z.unknown()).optional().describe(
    "Serving flags — e.g. { reasoningBudget: 0, cacheTypeK: 'bf16' }.",
  ),
  sampling: z.record(z.string(), z.unknown()).optional().describe(
    "Sampling params — { temp, top_p, top_k, presence_penalty, ... }.",
  ),
}).catchall(z.unknown());

/** Provider/gateway access spec — the OpenAI-compat lingua franca + caveats. */
export const ApiFacetSchema = z.object({
  apiSpec: z.string().optional().describe(
    "Wire protocol — openai-compat | anthropic-native | bedrock-classic | …",
  ),
  endpoint: z.string().optional().describe(
    "Base URL / endpoint (may be a placeholder).",
  ),
  compatCaveats: z.array(z.string()).optional().describe(
    "Which features of the spec actually work on this path — the 'switching the " +
      "model id isn't guaranteed to work' knowledge.",
  ),
}).catchall(z.unknown());

/**
 * The facet map. Known facets are typed; unknown facets pass through
 * (`.catchall`) so a new dimension layers on with no schema surgery — the
 * straightforward-extension seam.
 */
export const FacetsSchema = z.object({
  architecture: ArchitectureFacetSchema.optional(),
  outcome: OutcomeFacetSchema.optional(),
  cost: CostFacetSchema.optional(),
  hardware: HardwareFacetSchema.optional(),
  serving: ServingFacetSchema.optional(),
  api: ApiFacetSchema.optional(),
}).catchall(z.unknown());
export type Facets = z.infer<typeof FacetsSchema>;

// ---------------------------------------------------------------------------
// Entry — the record. One uniform shape for all five subject kinds AND the
// access-path join, exactly like inventory's single Device. `kind` discriminates
// (open vocab); the variation lives in `facets`, `claims`, and `relations`,
// never in a different shape.
// ---------------------------------------------------------------------------

/** A single catalog entry — a subject or an access-path, all the same shape. */
export const EntrySchema = z.object({
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be a lowercase slug (a-z, 0-9, hyphens)",
  ).describe(
    "Stable slug; the resource key and relation target. Kind-prefix by " +
      "convention to keep ids unique + readable (model-…, hw-…, ap-…).",
  ),
  kind: z.string().min(1).describe(
    "What this entry is — model | runtime | provider | hardware | technique | " +
      "access-path (open vocabulary).",
  ),
  name: z.string().min(1).describe("Human-facing name."),
  summary: z.string().min(1).describe(
    "Why this entry exists / what it is — its role in the catalog.",
  ),
  status: z.string().optional().describe(
    "Lifecycle note — active | retired | graveyard | … (open). A removed model " +
      "becomes a final version with status set, never a hard delete.",
  ),
  visibility: z.enum(["public", "private"]).optional().describe(
    "Contribution gate (closed vocab, deliberately). `public` = generic, " +
      "sourced, anonymisable → eligible to flow to the shared catalog repo. " +
      "`private` = fleet-specific (owned nodes, our-fleet measurements) → never " +
      "leaves the local instance. Unset is treated as private (fail-safe).",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Free-form tags for filtering.",
  ),
  relations: z.array(RelationSchema).default([]).describe(
    "Joins (access-path → model/runtime/hardware/provider) + evaluative edges " +
      "(prefer-over) + cross-refs (ref into @stateless/inventory).",
  ),
  claims: z.array(ClaimSchema).default([]).describe(
    "Dated, sourced assertions about this entry — the volatile knowledge layer.",
  ),
  facets: FacetsSchema.optional(),
});
export type Entry = z.infer<typeof EntrySchema>;

// ---------------------------------------------------------------------------
// Global arguments + method arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this catalog."),
  entries: z.array(EntrySchema).default([]).describe(
    "The declared (private/local) knowledge base — one record per " +
      "subject/access-path. Materialised by `apply` into the `entry` resource.",
  ),
  catalogUrl: z.string().optional().describe(
    "Source of the public dataset for `update` — an https raw URL of the " +
      "assembled catalog.json, or a local file path. Public entries land in the " +
      "separate `catalog-entry` resource (never clobbering local `entry` data).",
  ),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `update` — pull the public catalog into the `catalog-entry` resource. */
export const UpdateArgsSchema = z.object({
  catalogUrl: z.string().optional().describe(
    "Override the instance's `catalogUrl` for this run.",
  ),
});
export type UpdateArgs = z.infer<typeof UpdateArgsSchema>;

/** Arguments for `reconcile` — gather all configs for a target into a comparison. */
export const ReconcileArgsSchema = z.object({
  model: z.string().min(1).describe(
    "The `of-model` target id to gather every access-path/config for.",
  ),
  hardware: z.string().optional().describe(
    "Optional `runs-on` filter (a hardware id) to scope to one platform.",
  ),
  catalogUrl: z.string().optional().describe(
    "Public catalog source to include alongside local/private entries " +
      "(https URL or local path); defaults to the instance `catalogUrl`.",
  ),
});
export type ReconcileArgs = z.infer<typeof ReconcileArgsSchema>;

/** A reconciliation comparison — the gathered configs for one target. */
export const ReconciliationSchema = z.object({
  target: z.string(),
  hardware: z.string().optional(),
  count: z.number().int().nonnegative(),
  configs: z.array(z.object({ id: z.string() }).catchall(z.unknown())),
}).catchall(z.unknown());

/** Arguments for `sync` — refresh gateway prices from a provider feed. */
export const SyncArgsSchema = z.object({
  feedUrl: z.string().optional().describe(
    "Pricing feed (default OpenRouter /api/v1/models). Maps providerModelId → price.",
  ),
  catalogUrl: z.string().optional().describe(
    "Where the gateway access-paths to refresh are read from (https URL or local " +
      "path of the assembled catalog.json); defaults to the instance `catalogUrl`.",
  ),
  provider: z.string().optional().describe(
    "Only refresh access-paths whose `via-provider` target equals this id " +
      "(e.g. prov-openrouter).",
  ),
});
export type SyncArgs = z.infer<typeof SyncArgsSchema>;

/** Arguments for `ingest` — draft a model entry from a HuggingFace config.json. */
export const IngestArgsSchema = z.object({
  repo: z.string().min(1).describe(
    "HuggingFace org/repo, e.g. 'zai-org/GLM-5.2'. The authoritative config.json " +
      "is fetched from its raw URL.",
  ),
  branch: z.string().optional().describe("Git branch (default 'main')."),
  id: z.string().optional().describe(
    "Catalog entry id override (default derived from the repo name).",
  ),
});
export type IngestArgs = z.infer<typeof IngestArgsSchema>;

/** Arguments for `contribute` — which entries to sanitise for the public catalog. */
export const ContributeArgsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).describe(
    "Declared entry ids to sanitise + emit as public `contribution` resources.",
  ),
  attribution: z.string().optional().describe(
    "Replaces private `our-fleet-test` sources (e.g. 'community measurement " +
      "(your-handle)'). REQUIRED if any selected entry carries a private source — " +
      "the method refuses rather than leak an un-attributed fleet measurement.",
  ),
});
export type ContributeArgs = z.infer<typeof ContributeArgsSchema>;

/** Arguments for `prune` — the soft-retire status to apply to undeclared entries. */
export const PruneArgsSchema = z.object({
  status: z.string().min(1).default("retired").describe(
    "Status to set on stored entries no longer in `entries` (soft prune). " +
      "E.g. retired | graveyard | removed.",
  ),
});
export type PruneArgs = z.infer<typeof PruneArgsSchema>;
