/**
 * assemble.ts — validate + integrity-check + assemble the llm-catalog dataset.
 *
 * Globs the per-family + reference YAML files, validates every entry against the
 * canonical `EntrySchema` (single source of truth, imported from the extension),
 * then checks two things a single-file format can't: duplicate ids across files,
 * and dangling relation targets (a recipe pointing at a model/runtime/hardware
 * id that doesn't exist). Emits one `catalog.json` artifact for `update` to
 * fetch. Exit non-zero on any error — this is the CI gate for contribution PRs.
 *
 * Run:  deno run --allow-read --allow-write scripts/assemble.ts
 *
 * Note: imports the schema by relative path while the dataset lives in the same
 * tree as the extension. When the dataset moves to its own repo, repoint this
 * import at the published extension (jsr/npm) or a pinned vendored copy.
 *
 * @module
 */

import { parse } from "jsr:@std/yaml@1";
import { walk } from "jsr:@std/fs@1/walk";
import { dirname, fromFileUrl, isAbsolute, join, relative } from "jsr:@std/path@1";
import { EntrySchema } from "../../extensions/models/llm-catalog/schemas.ts";

const ROOT = dirname(dirname(fromFileUrl(import.meta.url))); // llm-catalog-data/
const SCRIPTS = join(ROOT, "scripts");

// CLI flags. `--overlay <dir>` layers a PRIVATE overlay dir over the public set
// (sparse — only the extra entries; new ids add, same-id models merge their
// runsOn, contradicting authoritative facts error). `--out <path>` picks the
// output (default: public → catalog.json; overlay → <dir>/catalog.merged.json).
const args = Deno.args;
const overlayDir = (() => {
  const i = args.indexOf("--overlay");
  return i >= 0 ? args[i + 1] : undefined;
})();
const outArg = (() => {
  const i = args.indexOf("--out");
  return i >= 0 ? args[i + 1] : undefined;
})();

interface Loaded {
  id: string;
  file: string;
  // deno-lint-ignore no-explicit-any
  entry: any;
}

const errors: string[] = [];

/** Walk a dir, parse + schema-validate every YAML entry (scripts/ excluded). */
async function loadDir(dir: string): Promise<Loaded[]> {
  const acc: Loaded[] = [];
  for await (const f of walk(dir, { exts: ["yaml", "yml"], includeDirs: false })) {
    if (f.path.startsWith(SCRIPTS)) continue;
    const rel = relative(dir, f.path);
    let docs: unknown;
    try {
      docs = parse(await Deno.readTextFile(f.path));
    } catch (e) {
      errors.push(`${rel}: YAML parse error — ${e instanceof Error ? e.message : e}`);
      continue;
    }
    if (!Array.isArray(docs)) {
      errors.push(`${rel}: top level must be a list of entries`);
      continue;
    }
    docs.forEach((raw, i) => {
      const r = EntrySchema.safeParse(raw);
      if (!r.success) {
        const id = (raw && typeof raw === "object" && "id" in raw)
          ? (raw as { id: string }).id
          : `#${i}`;
        errors.push(
          `${rel} [${id}]: schema — ${r.error.issues.map((x) =>
            `${x.path.join(".")}: ${x.message}`
          ).join("; ")}`,
        );
        return;
      }
      acc.push({ id: r.data.id, file: rel, entry: r.data });
    });
  }
  return acc;
}

// 1. load the public set
const loaded: Loaded[] = await loadDir(ROOT);

// 1b. overlay merge (private layer over public). Sparse: only deltas. new id →
//     add; same-id model → union runsOn (+ overlay facets override, relations/
//     claims union); contradicting AUTHORITATIVE architecture fact → conflict.
let merged = 0, added = 0;
if (overlayDir) {
  const odir = isAbsolute(overlayDir) ? overlayDir : join(Deno.cwd(), overlayDir);
  const pubById = new Map(loaded.map((l) => [l.id, l]));
  for (const o of await loadDir(odir)) {
    const pub = pubById.get(o.id);
    if (!pub) {
      loaded.push({ ...o, file: `overlay:${o.file}` });
      added++;
      continue;
    }
    if (pub.entry.kind !== "model" || o.entry.kind !== "model") {
      errors.push(
        `overlay conflict [${o.id}]: in public (${pub.entry.kind}) and overlay (${o.entry.kind}) — only same-id models merge`,
      );
      continue;
    }
    // deno-lint-ignore no-explicit-any
    const pa: any = pub.entry.facets?.architecture ?? {};
    // deno-lint-ignore no-explicit-any
    const oa: any = o.entry.facets?.architecture ?? {};
    for (const k of ["params", "activeParams", "nativeContext", "attention", "vocab", "hfRepo"]) {
      if (oa[k] != null && pa[k] != null && oa[k] !== pa[k]) {
        errors.push(
          `overlay conflict [${o.id}]: architecture.${k} = ${JSON.stringify(oa[k])} (overlay) vs ${JSON.stringify(pa[k])} (public)`,
        );
      }
    }
    // merge: public scalars win; facets shallow-merged with runsOn UNIONed.
    pub.entry = {
      ...pub.entry,
      facets: {
        ...pub.entry.facets,
        ...o.entry.facets,
        runsOn: [
          ...(pub.entry.facets?.runsOn ?? []),
          ...(o.entry.facets?.runsOn ?? []),
        ],
      },
      relations: [...(pub.entry.relations ?? []), ...(o.entry.relations ?? [])],
      claims: [...(pub.entry.claims ?? []), ...(o.entry.claims ?? [])],
    };
    pub.file = `${pub.file}+overlay`;
    merged++;
  }
}

// 3. duplicate ids across files
const byId = new Map<string, string>();
for (const l of loaded) {
  const prev = byId.get(l.id);
  if (prev) errors.push(`duplicate id "${l.id}" in ${l.file} (already in ${prev})`);
  else byId.set(l.id, l.file);
}

// 4. referential integrity — every internal relation target must resolve.
//    Targets with a "ns:slug" prefix (e.g. inventory:owned-node) are external; skip.
for (const l of loaded) {
  for (const rel of l.entry.relations ?? []) {
    const t: string = rel.target;
    if (t.includes(":")) continue; // external ref
    if (!byId.has(t)) {
      errors.push(`${l.file} [${l.id}]: dangling relation ${rel.rel} → "${t}"`);
    }
  }
}

// 5b. contradiction detection — conflicting facts must not coexist unflagged,
//     because an LLM consuming the catalog repeats them as ground truth.
const modelById = new Map(
  loaded.filter((l) => l.entry.kind === "model").map((l) => [l.id, l.entry]),
);

// 5b-i. context-cap: an access-path's stated context must not exceed the native
//       context of the model it serves (e.g. 256k claimed on a 128k-cap model).
for (const l of loaded) {
  if (l.entry.kind !== "access-path") continue;
  const ofModel = (l.entry.relations ?? []).find((r) =>
    r.rel === "of-model"
  )?.target;
  // deno-lint-ignore no-explicit-any
  const model: any = ofModel ? modelById.get(ofModel) : undefined;
  const nativeCtx = model?.facets?.architecture?.nativeContext;
  const extendedCtx = model?.facets?.architecture?.extendedContext;
  const apCtx = l.entry.facets?.outcome?.context?.tokens;
  // An access-path may exceed nativeContext ONLY if it declares the context-extension
  // technique AND stays within the model's verified extendedContext ceiling (e.g.
  // DeepSeek-V4 is native 65536, YaRN-extended to 1M — the vLLM recipe runs 1M).
  const usesExtension = (l.entry.relations ?? []).some((r) =>
    r.rel === "uses-technique" && r.target === "technique-context-extension"
  );
  const cap = (usesExtension && typeof extendedCtx === "number") ? extendedCtx : nativeCtx;
  if (typeof cap === "number" && typeof apCtx === "number" && apCtx > cap) {
    const how = cap === extendedCtx ? "extended context" : "native context";
    errors.push(
      `${l.file} [${l.id}]: context ${apCtx} exceeds ${ofModel} ${how} ${cap}`,
    );
  }
}

// 5b-ii. same hfRepo, divergent architecture — one repo can't have two shapes.
const byRepo = new Map<string, { id: string; sig: string }>();
for (const l of loaded) {
  // deno-lint-ignore no-explicit-any
  const a: any = l.entry.facets?.architecture;
  if (!a?.hfRepo) continue;
  const sig = JSON.stringify({
    layers: a.layers,
    hidden: a.hidden,
    experts: a.experts,
    nativeContext: a.nativeContext,
    vocab: a.vocab,
  });
  const prev = byRepo.get(a.hfRepo);
  if (prev && prev.sig !== sig) {
    errors.push(
      `hfRepo "${a.hfRepo}" has divergent architecture across ${prev.id} and ${l.id}`,
    );
  } else if (!prev) byRepo.set(a.hfRepo, { id: l.id, sig });
}

// 5b-iii. variant ↔ family: invariant fields (attention, vocab) must agree when
//         both state them (a variant overriding the family design is a red flag).
for (const l of loaded) {
  if (l.entry.kind !== "model") continue;
  const parentId = (l.entry.relations ?? []).find((r) =>
    r.rel === "variant-of"
  )?.target;
  const parent = parentId ? modelById.get(parentId) : undefined;
  if (!parent) continue;
  // deno-lint-ignore no-explicit-any
  const ca: any = l.entry.facets?.architecture ?? {};
  // deno-lint-ignore no-explicit-any
  const pa: any = (parent as any).facets?.architecture ?? {};
  for (const f of ["attention", "vocab"]) {
    if (ca[f] != null && pa[f] != null && ca[f] !== pa[f]) {
      errors.push(
        `variant ${l.id} ${f}=${JSON.stringify(ca[f])} conflicts with family ${parentId} ${f}=${JSON.stringify(pa[f])}`,
      );
    }
  }
}

// 5b-iv. format ↔ runtime: a config's weight format must be loadable by the
//        runtime serving it (gguf→llama.cpp/ollama, safetensors→vLLM, mlx→mlx).
const runtimeFormats = new Map<string, string[]>();
for (const l of loaded) {
  if (l.entry.kind !== "runtime") continue;
  // deno-lint-ignore no-explicit-any
  const fmts = (l.entry.facets as any)?.formats;
  if (Array.isArray(fmts)) runtimeFormats.set(l.id, fmts);
}
for (const l of loaded) {
  if (l.entry.kind !== "access-path") continue;
  // deno-lint-ignore no-explicit-any
  const fmt = (l.entry.facets as any)?.recipe?.artifact?.format;
  const rt = (l.entry.relations ?? []).find((r) => r.rel === "served-by")?.target;
  const supported = rt ? runtimeFormats.get(rt) : undefined;
  if (fmt && supported && !supported.includes(fmt)) {
    errors.push(
      `${l.file} [${l.id}]: artifact format "${fmt}" not loadable by ${rt} (loads ${supported.join("/")})`,
    );
  }
}

// 5c. endpoint model (the `runsOn` embedded operating points). Endpoints factor
//     out the reusable interface; a model's run-options live on it, keyed by
//     endpoint. Validate the same invariants the access-path checks enforce:
//     endpoint resolves, context within cap, artifact format loadable by the
//     endpoint's runtime. Runs ALONGSIDE the access-path checks (transition-safe).
const endpointById = new Map(
  loaded.filter((l) => l.entry.kind === "endpoint").map((l) => [l.id, l.entry]),
);
// runtime served by each endpoint (self-host), for the format-compat check.
const endpointRuntime = new Map<string, string | undefined>();
for (const [id, ep] of endpointById) {
  endpointRuntime.set(
    id,
    (ep.relations ?? []).find((r) => r.rel === "served-by")?.target,
  );
}
for (const l of loaded) {
  if (l.entry.kind !== "model") continue;
  // deno-lint-ignore no-explicit-any
  const a: any = l.entry.facets?.architecture ?? {};
  // deno-lint-ignore no-explicit-any
  const runsOn: any[] = (l.entry.facets as any)?.runsOn ?? [];
  for (const ro of runsOn) {
    if (ro?.endpoint && !endpointById.has(ro.endpoint)) {
      errors.push(
        `${l.file} [${l.id}]: runsOn endpoint "${ro.endpoint}" does not resolve`,
      );
    }
    const roCtx = ro?.outcome?.context?.tokens;
    const usesExt = Array.isArray(ro?.techniques) &&
      ro.techniques.includes("technique-context-extension");
    const cap = (usesExt && typeof a.extendedContext === "number")
      ? a.extendedContext
      : a.nativeContext;
    if (typeof cap === "number" && typeof roCtx === "number" && roCtx > cap) {
      errors.push(
        `${l.file} [${l.id}]: runsOn[${ro.endpoint}] context ${roCtx} exceeds cap ${cap}`,
      );
    }
    const rt = ro?.endpoint ? endpointRuntime.get(ro.endpoint) : undefined;
    const supported = rt ? runtimeFormats.get(rt) : undefined;
    if (ro?.format && supported && !supported.includes(ro.format)) {
      errors.push(
        `${l.file} [${l.id}]: runsOn format "${ro.format}" not loadable by ${rt} (loads ${supported.join("/")})`,
      );
    }
  }
}

// 5d. ANONYMIZATION GATE (public build only) — the catalog.json shipped to the
//     public mirror must carry NO owned/fleet identifiers. An LLM consuming it
//     would otherwise surface private hostnames/IPs/people as fact. The overlay
//     build (--overlay → private catalog.merged.json) is EXEMPT: it deliberately
//     holds fleet measurements and never leaves the private tree. This is the gate
//     whose absence once let an owned hostname/owner-name reach the public mirror
//     — schema-valid but un-sanitised. Sanitise to a public CLASS (e.g. a hardware
//     class entry, "a DGX Spark") and a public/community attribution; private
//     measurements ride the overlay, not the public entry. Edit cautiously: a
//     too-broad pattern fails on legitimate prose — anchor on IPs and the private
//     denylist's unambiguously-owned names.
if (!overlayDir) {
  // GENERIC structural patterns — inherently private but NOT identity-revealing,
  // so safe to ship in this (published) script. Full 4-octet quad only: a bare
  // "10.3." or a version "10.3.2" is NOT an IP and must not trip the gate.
  const checks: Array<[string, RegExp]> = [
    ["private IPv4", /\b(?:10(?:\.\d{1,3}){3}|192\.168(?:\.\d{1,3}){2}|172\.(?:1[6-9]|2\d|3[01])(?:\.\d{1,3}){2}|100\.(?:6[4-9]|[7-9]\d|1[01]\d|12[0-7])(?:\.\d{1,3}){2})\b/],
    ["tailnet host", /\b[\w-]+\.ts\.net\b/i],
  ];
  // SPECIFIC owned identifiers (fleet hostnames, people) are loaded from a PRIVATE
  // file so this published script never itself enumerates the fleet. The list
  // lives in the private overlay tree (never rsync'd to the public mirror). One
  // term per line, '#' comments; matched CASE-SENSITIVELY on word boundaries so a
  // tech acronym never trips a similarly-spelled name. Absent (community CI) →
  // generic patterns only, which is correct: outsiders have no fleet names to leak.
  const denyPath = join(ROOT, "..", "llm-catalog-data.private", "forbidden-identifiers.txt");
  try {
    const terms = (await Deno.readTextFile(denyPath))
      .split("\n").map((s) => s.trim()).filter((s) => s && !s.startsWith("#"));
    if (terms.length) {
      const esc = terms.map((t) => t.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
      checks.push(["owned identifier", new RegExp(`\\b(?:${esc.join("|")})\\b`)]);
      console.log(`  anonymization gate: generic patterns + ${terms.length} private denylist terms`);
    }
  } catch {
    console.log(`  anonymization gate: generic patterns only (no private denylist found)`);
  }
  for (const l of loaded) {
    const hay = JSON.stringify(l.entry);
    for (const [label, re] of checks) {
      const m = hay.match(re);
      if (m) {
        errors.push(
          `${l.file} [${l.id}]: anonymization gate — ${label} "${m[0]}" must not ship public; sanitise to a public class/attribution (overlay holds private measurements)`,
        );
      }
    }
  }
}

// 5. report + emit
const kinds = loaded.reduce((m, l) => {
  m[l.entry.kind] = (m[l.entry.kind] ?? 0) + 1;
  return m;
}, {} as Record<string, number>);

if (errors.length) {
  console.error(`✗ assemble failed — ${errors.length} issue(s):`);
  for (const e of errors) console.error(`  - ${e}`);
  Deno.exit(1);
}

const entries = loaded.map((l) => l.entry).sort((a, b) =>
  a.id < b.id ? -1 : a.id > b.id ? 1 : 0
);
// Default output: public → catalog.json; overlay → <overlayDir>/catalog.merged.json
// (a private, gitignored artifact — NEVER overwrite the public catalog.json).
const out = outArg
  ? (isAbsolute(outArg) ? outArg : join(Deno.cwd(), outArg))
  : overlayDir
  ? join(isAbsolute(overlayDir) ? overlayDir : join(Deno.cwd(), overlayDir), "catalog.merged.json")
  : join(ROOT, "catalog.json");
await Deno.writeTextFile(out, JSON.stringify({ entries }, null, 2) + "\n");

const overlayNote = overlayDir
  ? ` (overlay: +${added} added, ${merged} merged)`
  : "";
console.log(
  `✓ ${loaded.length} entries valid, refs resolve, no dup ids — wrote ${relative(Deno.cwd(), out)}${overlayNote}`,
);
console.log(`  kinds: ${Object.entries(kinds).map(([k, n]) => `${k}=${n}`).join(", ")}`);
