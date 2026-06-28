/**
 * `redaction` CLI — the fast scan entry the git pre-push and Claude Code
 * PreToolUse hooks call (no swamp-runtime spin-up in the hot path; same pure
 * recognizers as the model `scan` method). Exits 1 (+ prints hits) on a leak,
 * 0 when clean — the hard gate.
 *
 *   deno run --allow-read cli.ts [--deny <file>] [--text <str>] <path...>
 *
 * `--deny <file>` loads owned identifiers (one per line, '#' comments) — the
 * fleet-aware tier. Absent → generic recognizers only (correct for a community
 * checkout with no fleet names to leak). The denylist is ideally a CEL export of
 * `@stateless/inventory`; a static file is the bootstrap.
 *
 * @module
 */

import { buildRecognizers, scanPaths, scanText } from "./redaction.ts";
import type { Hit } from "./schemas.ts";

function parse(argv: string[]) {
  const paths: string[] = [];
  const ignore: string[] = [];
  let denyFile: string | undefined;
  let text: string | undefined;
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--deny") denyFile = argv[++i];
    else if (a === "--text") text = argv[++i];
    else if (a === "--ignore") ignore.push(argv[++i]);
    else paths.push(a);
  }
  return { paths, ignore, denyFile, text };
}

/** Baseline patterns: --ignore flags + a `.redactionignore` in cwd and in each */
/** scanned directory (one substring/path per line, '#' comments). */
const SKIP = new Set([".git", "node_modules", ".swamp"]);

/** Recursively collect every `.redactionignore` under a directory (gitignore-style */
/** nesting), so a whole-tree scan honours a subdir/extension's own baseline. */
async function findIgnoreFiles(root: string, out: string[]): Promise<void> {
  let info: Deno.FileInfo;
  try {
    info = await Deno.stat(root);
  } catch {
    return;
  }
  if (info.isFile) {
    out.push(
      `${root.split("/").slice(0, -1).join("/") || "."}/.redactionignore`,
    );
    return;
  }
  if (!info.isDirectory) return;
  out.push(`${root}/.redactionignore`);
  for await (const e of Deno.readDir(root)) {
    if (e.isDirectory && !SKIP.has(e.name)) {
      await findIgnoreFiles(`${root}/${e.name}`, out);
    }
  }
}

async function loadIgnore(paths: string[], extra: string[]): Promise<string[]> {
  const out = [...extra];
  const cand: string[] = [".redactionignore"];
  for (const p of paths) await findIgnoreFiles(p, cand);
  for (const f of new Set(cand)) {
    try {
      out.push(
        ...(await Deno.readTextFile(f)).split("\n")
          .map((s) => s.trim()).filter((s) => s && !s.startsWith("#")),
      );
    } catch { /* absent → no baseline from here */ }
  }
  return out;
}

async function loadDeny(file?: string): Promise<string[]> {
  if (!file) return [];
  try {
    return (await Deno.readTextFile(file)).split("\n");
  } catch {
    return []; // missing denylist → generic tier only
  }
}

async function main() {
  const { paths, ignore, denyFile, text } = parse(Deno.args);
  const recs = buildRecognizers(await loadDeny(denyFile));
  const ignores = await loadIgnore(paths, ignore);
  const hits: Hit[] = [];
  if (text !== undefined) hits.push(...scanText(text, recs, "<text>"));
  if (paths.length) hits.push(...(await scanPaths(paths, recs, ignores)).hits);

  if (hits.length === 0) {
    console.error("redaction: CLEAN");
    Deno.exit(0);
  }
  console.error(`redaction: HALT — ${hits.length} forbidden identifier(s):`);
  for (const h of hits.slice(0, 50)) {
    console.error(`  ${h.file ?? "<text>"}:${h.line} [${h.rule}] ${h.match}`);
  }
  if (hits.length > 50) console.error(`  … and ${hits.length - 50} more`);
  console.error(
    "Sanitise to a public class / RFC 5737 placeholder before shipping.",
  );
  Deno.exit(1);
}

if (import.meta.main) await main();
