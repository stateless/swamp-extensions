/**
 * Zod schemas for `@stateless/redaction` — kept out of the entrypoint so the
 * model file stays free of slow types (the convention every swamp extension
 * follows). The shapes are deliberately small: a ruleset (denylist + custom
 * recognizers), a scan result (clean + hits), and the method argument schemas.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** A custom recognizer the instance contributes beyond the built-in generics. */
export const RecognizerSchema = z.object({
  name: z.string().min(1),
  /** A JS regex SOURCE string (compiled at runtime); anchor it yourself. */
  pattern: z.string().min(1),
  /** Regex flags (without `g` — the engine adds it). Default case-sensitive. */
  flags: z.string().default(""),
  /** Replacement used by `redact`; defaults to a generic token. */
  placeholder: z.string().default("REDACTED"),
});
export type Recognizer = z.infer<typeof RecognizerSchema>;

/** One offending occurrence. */
export const HitSchema = z.object({
  file: z.string().optional(), // absent for inline `text` scans
  line: z.number().int().nonnegative(),
  rule: z.string(), // "private-ipv4" | "tailnet" | "denylist" | custom name
  match: z.string(),
});
export type Hit = z.infer<typeof HitSchema>;

/** The result resource a `scan` writes (clean = no hits). */
export const ScanResultSchema = z.object({
  clean: z.boolean(),
  hitCount: z.number().int().nonnegative(),
  hits: z.array(HitSchema).default([]),
  scanned: z.number().int().nonnegative().default(0), // files (0 for inline text)
});
export type ScanResult = z.infer<typeof ScanResultSchema>;

/** Instance config: the ruleset. The denylist is the fleet-aware private part — */
/** an instance typically derives it via CEL over @stateless/inventory.          */
export const GlobalArgsSchema = z.object({
  name: z.string(),
  /** Owned identifiers (hostnames, FQDNs, people). Matched case-sensitively on */
  /** word boundaries. Keep in a PRIVATE instance; never publish the values.    */
  denylist: z.array(z.string()).default([]),
  /** Extra recognizers (e.g. internal TLDs, cloud account-id patterns).        */
  recognizers: z.array(RecognizerSchema).default([]),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

export const ScanArgsSchema = z.object({
  /** Files or directories to scan (directories walked recursively).            */
  paths: z.array(z.string()).optional(),
  /** Inline text to scan (in addition to / instead of paths).                  */
  text: z.string().optional(),
  /** Denylist terms to ADD for this run (augments the instance denylist).      */
  denylist: z.array(z.string()).optional(),
  /** Hard-gate behaviour: throw on any hit (default). false = advisory report. */
  failOnHit: z.boolean().default(true),
  /** Result instance name (re-run = new version = audit trail).                */
  label: z.string().default("scan"),
});

export const RedactArgsSchema = z.object({
  text: z.string(),
  denylist: z.array(z.string()).optional(),
});
