/**
 * Zod schemas + inferred types for `@stateless/sourced-kb`.
 *
 * This is the **domain-neutral core** generalised out of `@stateless/llm-catalog`:
 * the uniform, provenance-aware record and the declarative apply/update/prune/
 * contribute lifecycle, with NO domain facets baked in. `llm-catalog` keeps its
 * typed facets (architecture/outcome/cost/…) and its compute methods
 * (capacity/plan/reconcile/sync/ingest); this extension keeps only what is true
 * of *any* sourced knowledge base.
 *
 * The shape mirrors `@stateless/inventory` deliberately: a **uniform core** with
 * an open `kind`, an open `facets` map, and open-vocabulary `relations` — so a
 * new subject kind, facet, or edge needs no core edit. The one thing this base
 * adds that inventory doesn't need is the **provenance envelope**: inventory
 * records declared truth you own (the record *is* the fact), whereas this records
 * external, decaying, contested knowledge, so every volatile assertion can carry
 * `asOf` + `source` + version pins. The durable ENTITY (an entry) is split from
 * the volatile CLAIM about it.
 *
 * Kept in a separate module (imported by `sourced_kb.ts`, never re-exported from
 * it) so the model's published entrypoint exposes only `model` — which keeps the
 * public API free of "slow types" (Zod's inferred schema types). Tests import the
 * schemas directly from here.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Provenance — the volatility envelope. Wraps every claim, evaluative edge, and
// volatile facet. This is what makes "very changeable knowledge" honest: a value
// without `asOf` + `source` is not trustworthy here, and `versionPins` records
// the snapshot a finding is valid for.
// ---------------------------------------------------------------------------

/** When/where a fact was observed, how confident, and what it's pinned to. */
export const ProvenanceSchema = z.object({
  asOf: z.string().min(1).describe(
    "When observed — ISO date preferred (YYYY-MM-DD). Staleness is queryable, " +
      "not guessed.",
  ),
  source: z.string().min(1).describe(
    "Where it came from — a URL, changelog/forum-thread ref, a measurement " +
      "label, or a benchmark name. A claim with no source is worthless here.",
  ),
  confidence: z.string().optional().describe(
    "Evidence strength — low | medium | high (open).",
  ),
  versionPins: z.record(z.string(), z.string()).optional().describe(
    "The snapshot this is valid for — { region, currency, sku, runtime, ... }. " +
      "Whatever a reader needs to know the claim is still the same thing.",
  ),
  supersededBy: z.string().optional().describe(
    "Id/ref of the claim that replaces this one — so 'current X' is DERIVED as " +
      "the latest un-superseded claim, never a bare rotting field.",
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
// Relation — a directed edge by entry id. Carries both structural joins (an
// entry → a related entry) and evaluative edges (prefer-over, with sourced
// rationale). Like inventory's relations, but edges that decay carry their own
// provenance.
// ---------------------------------------------------------------------------

/** A directed relationship from this entry to another, by id. */
export const RelationSchema = z.object({
  rel: z.string().min(1).describe(
    "Edge verb — offered-by | via-provider | prefer-over | ref | … (open).",
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
// Entry — the record. One uniform shape for every subject kind, exactly like
// inventory's single Device. `kind` discriminates (open vocab); the variation
// lives in `facets`, `claims`, and `relations`, never in a different shape.
//
// `facets` is a fully OPEN map here (the neutral core knows no domains). A
// consuming catalog layers its own dimensions in by convention — and, by that
// same convention, a volatile facet embeds a `provenance` envelope.
// ---------------------------------------------------------------------------

/** A single knowledge-base entry — every subject kind, the same shape. */
export const EntrySchema = z.object({
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be a lowercase slug (a-z, 0-9, hyphens)",
  ).describe(
    "Stable slug; the resource key and relation target. Kind-prefix by " +
      "convention to keep ids unique + readable (provider-…, offering-…).",
  ),
  kind: z.string().min(1).describe(
    "What this entry is — open vocabulary the consuming catalog defines.",
  ),
  name: z.string().min(1).describe("Human-facing name."),
  summary: z.string().min(1).describe(
    "Why this entry exists / what it is — its role in the catalog.",
  ),
  status: z.string().optional().describe(
    "Lifecycle note — active | retired | graveyard | needs-fetch | … (open). " +
      "A removed entry becomes a final version with status set, never a hard " +
      "delete.",
  ),
  visibility: z.enum(["public", "private"]).optional().describe(
    "Contribution gate (closed vocab, deliberately). `public` = generic, " +
      "sourced, anonymisable → eligible to flow to a shared catalog repo. " +
      "`private` = local-only (owned/measured facts) → never leaves the local " +
      "instance. Unset is treated as private (fail-safe).",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Free-form tags for filtering.",
  ),
  relations: z.array(RelationSchema).default([]).describe(
    "Structural joins + evaluative edges (prefer-over) + cross-refs (ref).",
  ),
  claims: z.array(ClaimSchema).default([]).describe(
    "Dated, sourced assertions about this entry — the volatile knowledge layer.",
  ),
  facets: z.record(z.string(), z.unknown()).optional().describe(
    "Open, layered dimensions the consuming catalog defines (e.g. `pricing`). " +
      "A volatile facet embeds a `provenance` envelope by convention.",
  ),
});
export type Entry = z.infer<typeof EntrySchema>;

// ---------------------------------------------------------------------------
// Global arguments + method arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this knowledge base."),
  entries: z.array(EntrySchema).default([]).describe(
    "The declared (private/local) knowledge base — one record per subject. " +
      "Materialised by `apply` into the `entry` resource.",
  ),
  catalogUrl: z.string().optional().describe(
    "Source of the public dataset for `update` — an https raw URL of the " +
      "assembled catalog.json, or a local file path. Public entries land in the " +
      "separate `catalog-entry` resource (never clobbering local `entry` data).",
  ),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `update` — pull the public catalog into `catalog-entry`. */
export const UpdateArgsSchema = z.object({
  catalogUrl: z.string().optional().describe(
    "Override the instance's `catalogUrl` for this run.",
  ),
});
export type UpdateArgs = z.infer<typeof UpdateArgsSchema>;

/** Arguments for `prune` — the soft-retire status for undeclared entries. */
export const PruneArgsSchema = z.object({
  status: z.string().min(1).default("retired").describe(
    "Status to set on stored entries no longer in `entries` (soft prune). " +
      "E.g. retired | graveyard | removed.",
  ),
});
export type PruneArgs = z.infer<typeof PruneArgsSchema>;

/** Arguments for `contribute` — which entries to sanitise for the public catalog. */
export const ContributeArgsSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).describe(
    "Declared entry ids to sanitise + emit as public `contribution` resources.",
  ),
  attribution: z.string().optional().describe(
    "Replaces private/local source labels (e.g. 'community measurement " +
      "(your-handle)'). REQUIRED if any selected entry carries a source flagged " +
      "private — the method refuses rather than leak an un-attributed local fact.",
  ),
  privateSourcePattern: z.string().optional().describe(
    "Regex (string) marking a source as private/local and so needing " +
      "`attribution` before it can be contributed. Default: matches " +
      "'our-fleet', 'local', 'private', or 'measurement' (case-insensitive).",
  ),
});
export type ContributeArgs = z.infer<typeof ContributeArgsSchema>;
