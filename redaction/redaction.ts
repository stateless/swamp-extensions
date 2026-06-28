/**
 * `@stateless/redaction` — a deterministic published-surface hygiene gate.
 *
 * A CLASSIFIER, not an LLM eval: it answers "does this artifact contain a
 * forbidden identifier?" with rule-based recognizers — fast, auditable, no model
 * in the hot path. The flagship is `scan`, a HARD GATE (throws on a hit by
 * default) suitable for a publish workflow step, a git pre-push hook, or a
 * Claude Code PreToolUse hook. `redact` remaps detected identifiers to the
 * swamp-blessed documentation placeholders (RFC 5737 IPs, RFC 2606 example.com).
 *
 * Ruleset = built-in GENERIC recognizers (private-range IPv4 full-quad, *.ts.net)
 * + a fleet-aware DENYLIST (owned hostnames / FQDNs / people — matched
 * case-sensitively on word boundaries) + any custom recognizers the instance
 * adds. The denylist is the private part: an instance typically derives it via a
 * CEL view over `@stateless/inventory`, so it grows as the fleet model grows and
 * is never hand-maintained. The generic recognizers carry no fleet knowledge, so
 * a community checkout with no denylist still runs them (correct — outsiders have
 * no fleet names to leak).
 *
 * This is the deterministic ENFORCEMENT that swamp-club Lab 508 proposed but
 * shipped only as advisory (the §8 review dimension + an IPv4-literal warn). The
 * generic patterns are a faithful port of `llm-catalog-data/scripts/assemble.ts
 * §5d`; this generalises that one-off to any text/file set and any consumer.
 *
 * Pure helpers (`buildRecognizers`, `scanText`, `redactText`) are exported for
 * unit testing and direct reuse; the `model` export is the swamp model.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  DeriveDenylistArgsSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  type Hit,
  type Recognizer,
  RedactArgsSchema,
  ScanArgsSchema,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Recognizers (the deterministic ruleset)
// ---------------------------------------------------------------------------

/** Full 4-octet private/CGNAT IPv4 only — a bare "10.3." or version "10.3.2" is */
/** NOT an IP and must not trip the gate. Ported verbatim from assemble.ts §5d. */
const PRIVATE_IPV4_SRC = String
  .raw`\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b`;
const TS_NET_SRC = String.raw`\b[\w-]+\.ts\.net\b`;

/** A compiled recognizer: a named global regex + the placeholder `redact` uses. */
export interface CompiledRecognizer {
  name: string;
  re: RegExp;
  placeholder: string;
}

const escapeForRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Build the effective recognizer set: built-in generics + (optional) a single
 * combined denylist recognizer + any custom recognizers. Fresh RegExp objects
 * each call so callers never share regex state.
 */
export function buildRecognizers(
  denylist: string[] = [],
  custom: Recognizer[] = [],
): CompiledRecognizer[] {
  const recs: CompiledRecognizer[] = [
    {
      name: "private-ipv4",
      re: new RegExp(PRIVATE_IPV4_SRC, "g"),
      placeholder: "192.0.2.0",
    },
    {
      name: "tailnet",
      re: new RegExp(TS_NET_SRC, "gi"),
      placeholder: "host.example.net",
    },
  ];
  // One combined denylist recognizer, case-sensitive, word-boundary anchored, so
  // a tech acronym never trips a similarly-spelled owned name. '#'/blank lines
  // are treated as comments (so an inventory CEL view or a file can feed in raw).
  const terms = denylist
    .map((t) => t.trim())
    .filter((t) => t.length > 0 && !t.startsWith("#"));
  if (terms.length) {
    const src = `\\b(?:${terms.map(escapeForRegex).join("|")})\\b`;
    recs.push({
      name: "denylist",
      re: new RegExp(src, "g"),
      placeholder: "REDACTED",
    });
  }
  for (const c of custom) {
    const flags = c.flags.includes("g") ? c.flags : c.flags + "g";
    recs.push({
      name: c.name,
      re: new RegExp(c.pattern, flags),
      placeholder: c.placeholder,
    });
  }
  return recs;
}

/** Scan text line-by-line; returns every hit with a 1-based line number. */
export function scanText(
  text: string,
  recognizers: CompiledRecognizer[],
  file?: string,
): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    for (const r of recognizers) {
      for (const m of lines[i].matchAll(r.re)) {
        hits.push({ file, line: i + 1, rule: r.name, match: m[0] });
      }
    }
  }
  return hits;
}

/** Remap every recognized identifier to its placeholder. */
export function redactText(
  text: string,
  recognizers: CompiledRecognizer[],
): string {
  let out = text;
  for (const r of recognizers) out = out.replace(r.re, r.placeholder);
  return out;
}

// ---------------------------------------------------------------------------
// Denylist derivation (build the fleet-aware tier FROM existing data)
// ---------------------------------------------------------------------------

/** A source-NEUTRAL record. A caller normalises its own model (e.g. an inventory */
/** device) into this shape; redaction stays decoupled from any one schema. */
export interface DerivationRecord {
  hostname?: string;
  fqdns?: string[];
  users?: string[];
}
export interface DeriveOpts {
  /** Already-known denylist terms — used only to compute what's NEW. */
  current?: string[];
  /** id substrings that signal a product/model name, not an owned hostname. */
  productHints?: string[];
  /** ssh users too generic to denylist (root/admin/…). */
  genericUsers?: string[];
}

const DEFAULT_PRODUCT_HINTS = [
  "ups",
  "switch",
  "canyon",
  "edgerouter",
  "cyberpower",
  "eaton",
  "tapo",
  "crs",
  "rb40",
  "spare",
  "gap-",
];
const DEFAULT_GENERIC_USERS = ["root", "admin", "user", "ubuntu", "ec2-user"];

/** Registrable-ish domain: keep the last 2–3 labels (handles `co.nz`). */
export function domainOf(fqdn: string): string | null {
  const parts = fqdn.split(".");
  if (parts.length < 2) return null;
  const sld = new Set(["co", "org", "net", "gov", "ac"]);
  if (parts.length >= 3 && sld.has(parts.at(-2)!)) {
    return parts.slice(-3).join(".");
  }
  return parts.slice(-2).join(".");
}

/**
 * Derive denylist candidates from normalised records. Splits into an
 * UNAMBIGUOUS tier (FQDNs + their domains + non-generic users — safe to add) and
 * a REVIEW tier (hostnames, after filtering product names — a human confirms the
 * owned ones, since inventory ids mix real hostnames with product names like
 * `rb4011`). `*.ts.net` FQDNs are
 * dropped (a generic recognizer already covers them). Pure + deterministic.
 */
export function deriveDenylist(
  records: DerivationRecord[],
  opts: DeriveOpts = {},
): {
  unambiguous: string[];
  review: string[];
  newUnambiguous: string[];
  newReview: string[];
} {
  const productHints = opts.productHints ?? DEFAULT_PRODUCT_HINTS;
  const genericUsers = new Set(opts.genericUsers ?? DEFAULT_GENERIC_USERS);
  const current = new Set(opts.current ?? []);

  const fqdns = new Set<string>();
  const domains = new Set<string>();
  const users = new Set<string>();
  const hosts = new Set<string>();

  for (const r of records) {
    const h = r.hostname;
    if (
      h && /^[a-z0-9][a-z0-9-]*$/.test(h) &&
      !productHints.some((p) => h.includes(p))
    ) hosts.add(h);
    for (const f of r.fqdns ?? []) {
      if (!f || f.endsWith(".ts.net")) continue;
      fqdns.add(f);
      const d = domainOf(f);
      if (d) domains.add(d);
    }
    for (const u of r.users ?? []) {
      if (u && !genericUsers.has(u)) users.add(u);
    }
  }

  const unambiguous = [...fqdns, ...domains, ...users].sort();
  const review = [...hosts].sort();
  return {
    unambiguous,
    review,
    newUnambiguous: unambiguous.filter((t) => !current.has(t)),
    newReview: review.filter((t) => !current.has(t)),
  };
}

// ---------------------------------------------------------------------------
// File walking (scan over a path set)
// ---------------------------------------------------------------------------

const SKIP_DIRS = new Set([".git", "node_modules", ".swamp"]);
const MAX_BYTES = 5_000_000;

async function* walk(path: string): AsyncGenerator<string> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(path);
  } catch {
    return;
  }
  if (info.isFile) {
    yield path;
    return;
  }
  if (!info.isDirectory) return;
  for await (const e of Deno.readDir(path)) {
    if (e.isDirectory && SKIP_DIRS.has(e.name)) continue;
    yield* walk(`${path}/${e.name}`);
  }
}

/**
 * Walk `paths` (files or dirs), scan every readable text file, and return the
 * hits plus a count of files scanned. Shared by the `scan` method and the CLI /
 * hook entry so there is ONE implementation. Skips `.git`/`node_modules`/`.swamp`,
 * files > 5 MB, and binaries (non-UTF-8 reads).
 */
export async function scanPaths(
  paths: string[],
  recognizers: CompiledRecognizer[],
  ignore: string[] = [],
): Promise<{ hits: Hit[]; scanned: number }> {
  const hits: Hit[] = [];
  let scanned = 0;
  for (const root of paths) {
    for await (const file of walk(root)) {
      // baseline: skip files an `.redactionignore` exempts (e.g. a scanner's own
      // test corpus, which must legitimately contain the patterns it detects).
      if (ignore.some((ig) => ig && file.includes(ig))) continue;
      let info: Deno.FileInfo;
      try {
        info = await Deno.stat(file);
      } catch {
        continue;
      }
      if (info.size > MAX_BYTES) continue;
      let content: string;
      try {
        content = await Deno.readTextFile(file); // throws on binary/non-utf8
      } catch {
        continue;
      }
      scanned++;
      hits.push(...scanText(content, recognizers, file));
    }
  }
  return { hits, scanned };
}

// ---------------------------------------------------------------------------
// Method context (declared locally — the convention every swamp extension uses)
// ---------------------------------------------------------------------------

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}
interface MethodContext {
  globalArgs: GlobalArgs;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<DataHandle>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}
interface MethodResult {
  dataHandles: DataHandle[];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@stateless/redaction` model definition. */
export const model = {
  type: "@stateless/redaction",
  version: "2026.06.28.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    "scan-result": {
      description:
        "The result of a `scan` (clean + hits). Re-running records a new " +
        "version, so the hygiene trend reads back. `clean: false` means a " +
        "forbidden identifier was found; `scan` also THROWS by default so a " +
        "workflow/hook step fails (the hard gate).",
      schema: z.object({
        clean: z.boolean(),
        hitCount: z.number(),
        hits: z.array(z.object({
          file: z.string().optional(),
          line: z.number(),
          rule: z.string(),
          match: z.string(),
        })),
        scanned: z.number(),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 50,
    },
    "redaction-result": {
      description: "The redacted text produced by `redact`.",
      schema: z.object({ redacted: z.string() }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    denylist: {
      description:
        "Denylist candidates derived by `deriveDenylist` from normalised source " +
        "records (e.g. an inventory CEL view). `unambiguous` = FQDNs/domains/users " +
        "(safe to use); `review` = hostnames a human confirms. A gate instance can " +
        "CEL-reference this resource's `unambiguous` as its denylist.",
      schema: z.object({
        unambiguous: z.array(z.string()),
        review: z.array(z.string()),
        newUnambiguous: z.array(z.string()),
        newReview: z.array(z.string()),
      }),
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    scan: {
      description:
        "Deterministically scan files/dirs and/or inline text for forbidden " +
        "identifiers (private-range IPv4, *.ts.net, the instance denylist, and " +
        "any custom recognizers). Writes a `scan-result` and, by default, " +
        "THROWS on any hit (the hard gate). Pass failOnHit=false for an advisory " +
        "report. RFC 5737 doc IPs / example.com placeholders pass clean.",
      arguments: ScanArgsSchema,
      execute: async (
        args: z.infer<typeof ScanArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const denylist = [
          ...(ctx.globalArgs.denylist ?? []),
          ...(args.denylist ?? []),
        ];
        const recs = buildRecognizers(
          denylist,
          ctx.globalArgs.recognizers ?? [],
        );
        const hits: Hit[] = [];
        if (args.text !== undefined) hits.push(...scanText(args.text, recs));
        const walked = await scanPaths(args.paths ?? [], recs);
        hits.push(...walked.hits);
        const scanned = walked.scanned;

        const result = {
          clean: hits.length === 0,
          hitCount: hits.length,
          hits,
          scanned,
        };
        const handle = await ctx.writeResource(
          "scan-result",
          args.label,
          result,
        );

        if (result.clean) {
          ctx.logger.info("redaction scan: CLEAN ({n} files scanned)", {
            n: scanned,
          });
        } else {
          ctx.logger.warning(
            "redaction scan: {h} hit(s) across {n} file(s)/inline text",
            { h: hits.length, n: scanned },
          );
          if (args.failOnHit) {
            const sample = hits.slice(0, 5).map((x) =>
              `${x.file ?? "<text>"}:${x.line} [${x.rule}] "${x.match}"`
            ).join("; ");
            throw new Error(
              `redaction gate HALT — ${hits.length} forbidden identifier(s): ` +
                `${sample}${hits.length > 5 ? " …" : ""}. ` +
                `Sanitise to a public class / RFC 5737 placeholder before shipping.`,
            );
          }
        }
        return { dataHandles: [handle] };
      },
    },
    redact: {
      description:
        "Return `text` with every recognized identifier remapped to its " +
        "placeholder (RFC 5737 / example.com / a denylist token). Writes a " +
        "`redaction-result` resource.",
      arguments: RedactArgsSchema,
      execute: async (
        args: z.infer<typeof RedactArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const denylist = [
          ...(ctx.globalArgs.denylist ?? []),
          ...(args.denylist ?? []),
        ];
        const recs = buildRecognizers(
          denylist,
          ctx.globalArgs.recognizers ?? [],
        );
        const redacted = redactText(args.text, recs);
        const handle = await ctx.writeResource("redaction-result", "redact", {
          redacted,
        });
        return { dataHandles: [handle] };
      },
    },
    deriveDenylist: {
      description:
        "Build the fleet-aware denylist FROM existing data: take source-NEUTRAL " +
        "records ({hostname, fqdns, users} — a caller normalises e.g. an " +
        "@stateless/inventory CEL view into this shape) and split into an " +
        "UNAMBIGUOUS tier (FQDNs/domains/users, safe to use as the denylist) and a " +
        "REVIEW tier (hostnames, product names filtered, a human confirms). Writes " +
        "a `denylist` resource a gate instance can CEL-reference. The fleet model " +
        "becomes the denylist source — it grows as inventory grows.",
      arguments: DeriveDenylistArgsSchema,
      execute: async (
        args: z.infer<typeof DeriveDenylistArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const result = deriveDenylist(args.records, {
          current: args.current,
          productHints: args.productHints,
          genericUsers: args.genericUsers,
        });
        const handle = await ctx.writeResource("denylist", "denylist", result);
        ctx.logger.info(
          "deriveDenylist: {u} unambiguous ({nu} new), {r} review ({nr} new)",
          {
            u: result.unambiguous.length,
            nu: result.newUnambiguous.length,
            r: result.review.length,
            nr: result.newReview.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
