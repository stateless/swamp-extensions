/**
 * Sanitiser for `@stateless/sourced-kb`'s `contribute` method — turns a
 * local/private entry into a generic, public-shaped one destined for a shared
 * catalog repo. Pure + deterministic so it is unit-testable in isolation; the
 * method wraps it, schema-validates the result, and writes it as a
 * `contribution` resource.
 *
 * Domain-neutral: it does not know about fleet nodes or hardware classes (that
 * remap lives in a consuming catalog). It does the two transforms true of *any*
 * sourced KB — retag sources flagged private to a supplied attribution, and mark
 * the entry public — and refuses (rather than leaks) when a private source has
 * no attribution. The GitHub PR review remains the backstop.
 *
 * @module
 */

import type { Entry } from "./schemas.ts";

/**
 * Default regex marking a `source` as private/local — our-fleet-style
 * measurements, anything self-labelled local/private, or a bare "measurement".
 * Override per-call via `contribute`'s `privateSourcePattern`.
 */
export const DEFAULT_PRIVATE_SOURCE =
  /our-fleet|(^|[^a-z])local|private|measurement/i;

/** Recursively retag private `source` strings; collect any found. */
function retagSources(
  node: unknown,
  privateRe: RegExp,
  attribution: string | undefined,
  found: string[],
): void {
  if (Array.isArray(node)) {
    for (const n of node) retagSources(n, privateRe, attribution, found);
    return;
  }
  if (node && typeof node === "object") {
    const obj = node as Record<string, unknown>;
    if (typeof obj.source === "string" && privateRe.test(obj.source)) {
      found.push(obj.source);
      if (attribution) obj.source = attribution;
    }
    for (const k of Object.keys(obj)) {
      retagSources(obj[k], privateRe, attribution, found);
    }
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
 * @param privateRe    regex flagging a `source` as private/local
 * @param attribution  replaces flagged `source` strings; required if any present
 */
export function sanitiseForContribution(
  entry: Entry,
  privateRe: RegExp,
  attribution?: string,
): SanitiseResult {
  const actions: string[] = [];
  // deno-lint-ignore no-explicit-any
  const e: any = structuredClone(entry);

  // 1. Retag private/local measurement sources to the supplied attribution.
  const found: string[] = [];
  retagSources(e, privateRe, attribution, found);
  if (found.length && attribution) {
    actions.push(
      `retagged ${found.length} private source(s) → "${attribution}"`,
    );
  }

  // 2. Mark public.
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
