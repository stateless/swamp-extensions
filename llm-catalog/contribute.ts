/**
 * Sanitiser for `@stateless/llm-catalog`'s `contribute` method — turns a
 * fleet-private entry into a generic, public-shaped one destined for the shared
 * catalog repo. Pure + deterministic so it is unit-testable in isolation; the
 * method wraps it, schema-validates the result, and writes it as a
 * `contribution` resource.
 *
 * The transforms are conservative — anything it can't confidently sanitise is
 * surfaced (e.g. a private source with no attribution), so the method can refuse
 * rather than leak. The GitHub PR review remains the backstop.
 *
 * @module
 */

import type { Entry } from "./schemas.ts";

/** Source substrings that mark a private/fleet measurement. */
const PRIVATE_SOURCE_MARKERS = ["our-fleet-test", "our-fleet", "fleet-test"];

/** Recursively retag private `source` strings; collect any found. */
function retagSources(
  node: unknown,
  attribution: string | undefined,
  found: string[],
): void {
  if (Array.isArray(node)) {
    for (const n of node) retagSources(n, attribution, found);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (
      typeof obj.source === "string" &&
      PRIVATE_SOURCE_MARKERS.some((m) => (obj.source as string).includes(m))
    ) {
      found.push(obj.source as string);
      if (attribution) obj.source = attribution;
    }
    for (const k of Object.keys(obj)) retagSources(obj[k], attribution, found);
  }
}

export interface SanitiseResult {
  /** The sanitised entry (not yet schema-validated — the caller parses it). */
  entry: Entry;
  /** Human-readable list of transforms applied (for logging). */
  actions: string[];
  /** Private sources found; if non-empty and no `attribution`, caller refuses. */
  needsAttribution: string[];
}

/**
 * Sanitise one entry for public contribution.
 *
 * @param entry        the declared (private) entry to contribute
 * @param nodeToClass  owned-node id → public hardware-class id (from `instance-of`)
 * @param attribution  replaces private `source` strings; required if any present
 */
export function sanitiseForContribution(
  entry: Entry,
  nodeToClass: Record<string, string>,
  attribution?: string,
): SanitiseResult {
  const actions: string[] = [];
  // deno-lint-ignore no-explicit-any
  const e: any = structuredClone(entry);

  // 1. Relations: drop external `ref`s + private `instance-of` linkage; remap
  //    owned-node targets to their public hardware class.
  if (Array.isArray(e.relations)) {
    const before = e.relations.length;
    e.relations = e.relations
      // deno-lint-ignore no-explicit-any
      .filter((r: any) =>
        !(r.rel === "ref" && typeof r.target === "string" &&
          r.target.includes(":"))
      )
      // deno-lint-ignore no-explicit-any
      .filter((r: any) => r.rel !== "instance-of")
      // deno-lint-ignore no-explicit-any
      .map((r: any) => {
        if (nodeToClass[r.target]) {
          actions.push(`remap ${r.rel} ${r.target} → ${nodeToClass[r.target]}`);
          return { ...r, target: nodeToClass[r.target] };
        }
        return r;
      });
    if (e.relations.length !== before) {
      actions.push(
        `dropped ${before - e.relations.length} private relation(s)`,
      );
    }
  }

  // 2. Retag private measurement sources to the supplied attribution.
  const found: string[] = [];
  retagSources(e, attribution, found);
  if (found.length && attribution) {
    actions.push(
      `retagged ${found.length} private source(s) → "${attribution}"`,
    );
  }

  // 3. Mark public.
  if (e.visibility !== "public") {
    e.visibility = "public";
    actions.push("visibility → public");
  }

  return {
    entry: e as Entry,
    actions,
    needsAttribution: attribution ? [] : found,
  };
}

/** Build the owned-node → public-class map from a declared entry list. */
export function nodeClassMap(entries: Entry[]): Record<string, string> {
  const map: Record<string, string> = {};
  for (const e of entries) {
    for (const r of e.relations ?? []) {
      if (r.rel === "instance-of") map[e.id] = r.target;
    }
  }
  return map;
}
