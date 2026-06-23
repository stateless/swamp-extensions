/**
 * `@stateless/table-report` — a generic "data table" report for any swamp model.
 *
 * Renders a model's materialised resource data as markdown tables — a
 * dataview-style view primitive, so you don't hand-write a bespoke report per
 * catalogue. Two modes:
 *
 *   - **Declared views** — put a `tableViews` tag on the model (a JSON array of
 *     `ViewSpec`): pick the resource `spec`, the `columns` (label → content path),
 *     an optional `where` filter, `sort`, and `limit`. The tag lives in the
 *     model's free-form `tags` map, so it works on ANY model type with no schema
 *     change.
 *   - **Auto** — with no `tableViews` tag, render one table per resource spec
 *     with auto-detected scalar columns (id/name/kind/status/visibility + facet
 *     leaves). Zero config.
 *
 * Paths are **content-relative** (e.g. `facets.pricing.perTBMonth`, `kind`) —
 * note this differs from `swamp data query --select`, which prefixes
 * `attributes.`. Filtering is scalar-equality only; for full CEL predicates use
 * `swamp data query`. The report sandbox has no CEL evaluator, so this covers the
 * common select/eq case, not arbitrary CEL.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** A single declared table view (one entry of the `tableViews` tag). */
export interface ViewSpec {
  /** Heading for the table (defaults to `spec`). */
  title?: string;
  /** Resource spec name to render (e.g. `entry`). */
  spec: string;
  /** Scalar-equality filter, AND across keys: `{ kind: "offering" }`. */
  where?: Record<string, unknown>;
  /** Column label → content path. Omit for auto-detected columns. */
  columns?: Record<string, string>;
  /** Sort by a content path. */
  sort?: { by: string; dir?: "asc" | "desc" };
  /** Cap the number of rows. */
  limit?: number;
}

/** A materialised resource's content object. */
export type Rec = Record<string, unknown>;

/** Light runtime schema for a declared view (defaults applied, extras ignored). */
const ViewSchema = z.object({
  title: z.string().optional(),
  spec: z.string().min(1),
  where: z.record(z.string(), z.unknown()).optional(),
  columns: z.record(z.string(), z.string()).optional(),
  sort: z.object({ by: z.string(), dir: z.enum(["asc", "desc"]).optional() })
    .optional(),
  limit: z.number().int().positive().optional(),
}).passthrough();

/** Dot-path lookup into a record's content. Returns undefined if any hop misses. */
export function getPath(obj: unknown, path: string): unknown {
  return path.split(".").reduce<unknown>(
    (acc, k) => (acc && typeof acc === "object") ? (acc as Rec)[k] : undefined,
    obj,
  );
}

/** Format a value for a markdown table cell (pipe/newline-safe). */
export function fmtCell(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "string") return v.replace(/\|/g, "\\|").replace(/\n/g, " ");
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (Array.isArray(v)) {
    return v.map((x) => (x && typeof x === "object") ? "{…}" : String(x)).join(
      ", ",
    );
  }
  return "{…}";
}

const isScalar = (v: unknown): boolean =>
  v === null || ["string", "number", "boolean"].includes(typeof v);

/** Auto-detect a sensible column set (label → path) from a set of records. */
export function autoColumns(
  records: Rec[],
  maxCols = 12,
): Record<string, string> {
  const cols: Record<string, string> = {};
  // id + name lead (the identity columns), when present.
  for (const k of ["id", "name"]) {
    if (records.some((r) => isScalar(r[k]))) cols[k] = k;
  }
  // then EVERY other top-level scalar field (first-seen order) — so the view is
  // generic, not biased to any one model's shape (an inventory `site`/`location`
  // is auto-picked the same as a catalogue `kind`).
  for (const r of records) {
    if (Object.keys(cols).length >= maxCols) break;
    for (const [k, v] of Object.entries(r)) {
      if (k === "id" || k === "name" || k in cols) continue;
      if (isScalar(v)) {
        if (Object.keys(cols).length >= maxCols) break;
        cols[k] = k;
      }
    }
  }
  // then facet scalar leaves (facets.<facet>.<key>), if room.
  const facetLeaves = new Set<string>();
  for (const r of records) {
    const facets = r.facets;
    if (facets && typeof facets === "object" && !Array.isArray(facets)) {
      for (const [fk, fv] of Object.entries(facets as Rec)) {
        if (fv && typeof fv === "object" && !Array.isArray(fv)) {
          for (const [k, v] of Object.entries(fv as Rec)) {
            if (isScalar(v)) facetLeaves.add(`facets.${fk}.${k}`);
          }
        }
      }
    }
  }
  for (const p of facetLeaves) {
    if (Object.keys(cols).length >= maxCols) break;
    const label = p.replace(/^facets\./, ""); // label without the facets. prefix
    if (!(label in cols)) cols[label] = p;
  }
  return cols;
}

function matchesWhere(r: Rec, where?: Record<string, unknown>): boolean {
  if (!where) return true;
  return Object.entries(where).every(([path, val]) => getPath(r, path) === val);
}

/** A rendered table: title + headers + string-cell rows. */
export interface RenderedTable {
  title: string;
  headers: string[];
  rows: string[][];
  count: number;
}

/** Filter → project → sort → limit a record set per a view spec. */
export function applyView(records: Rec[], view: ViewSpec): RenderedTable {
  let rows = records.filter((r) => matchesWhere(r, view.where));
  const cols = view.columns && Object.keys(view.columns).length
    ? view.columns
    : autoColumns(rows);
  const headers = Object.keys(cols);
  const paths = Object.values(cols);
  if (view.sort) {
    const { by, dir = "asc" } = view.sort;
    rows = [...rows].sort((a, b) => {
      const av = getPath(a, by);
      const bv = getPath(b, by);
      const am = av === undefined || av === null;
      const bm = bv === undefined || bv === null;
      if (am || bm) return am && bm ? 0 : am ? 1 : -1; // missing always last
      const c = (typeof av === "number" && typeof bv === "number")
        ? av - bv
        : String(av).localeCompare(String(bv));
      return dir === "desc" ? -c : c;
    });
  }
  if (typeof view.limit === "number") rows = rows.slice(0, view.limit);
  return {
    title: view.title ?? view.spec,
    headers,
    rows: rows.map((r) => paths.map((p) => fmtCell(getPath(r, p)))),
    count: rows.length,
  };
}

/** Render one table to markdown. */
export function renderTable(t: RenderedTable): string {
  if (!t.headers.length) return `### ${t.title}\n\n_(no columns)_`;
  const head = `| ${t.headers.join(" | ")} |`;
  const sep = `| ${t.headers.map(() => "---").join(" | ")} |`;
  if (!t.rows.length) {
    return `### ${t.title} (0)\n\n${head}\n${sep}\n_(no rows)_`;
  }
  const body = t.rows.map((r) => `| ${r.join(" | ")} |`).join("\n");
  return `### ${t.title} (${t.count})\n\n${head}\n${sep}\n${body}`;
}

/** Parse the `tableViews` tag (a JSON array of ViewSpec); [] on absent/invalid. */
export function parseViews(raw: unknown): ViewSpec[] {
  if (typeof raw !== "string" || !raw.trim()) return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return [];
  }
  const arr = Array.isArray(parsed) ? parsed : [parsed];
  const out: ViewSpec[] = [];
  for (const v of arr) {
    const r = ViewSchema.safeParse(v);
    if (r.success) out.push(r.data as ViewSpec);
  }
  return out;
}

/** Build the markdown + json report from records grouped by spec + the views. */
export function buildReport(
  bySpec: Map<string, Rec[]>,
  views: ViewSpec[],
): { markdown: string; json: Record<string, unknown> } {
  const tables: RenderedTable[] = views.length
    ? views.map((v) => applyView(bySpec.get(v.spec) ?? [], v))
    : [...bySpec.entries()].sort(([a], [b]) => a.localeCompare(b))
      .map(([spec, recs]) => applyView(recs, { spec, title: spec }));

  const markdown = [
    `# Data tables`,
    ``,
    views.length
      ? `${views.length} declared view(s) (from the \`tableViews\` tag).`
      : `Auto-rendered ${tables.length} resource spec(s) — add a \`tableViews\` tag to curate columns/filter/sort.`,
    ``,
    ...tables.map(renderTable),
    ``,
    `> Generic table view. Column paths are **content-relative** (e.g. \`facets.pricing.perTBMonth\`, \`kind\`) — unlike \`swamp data query --select\`, which prefixes \`attributes.\`. Filtering is scalar-equality only; for full CEL predicates use \`swamp data query\`.`,
  ].join("\n");

  return {
    markdown,
    json: {
      mode: views.length ? "declared" : "auto",
      tables: tables.map((t) => ({
        title: t.title,
        count: t.count,
        headers: t.headers,
      })),
    },
  };
}

interface ReportContext {
  modelType: string;
  modelId: string;
  definition?: { tags?: Record<string, string> };
  dataHandles: Array<{ name: string; specName: string; version: number }>;
  dataRepository: {
    getContent: (
      type: string,
      id: string,
      name: string,
      version?: number,
    ) => Promise<Uint8Array | null>;
  };
  logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
}

/** table-report report definition. */
export const report = {
  name: "@stateless/table-report",
  description:
    "Render a model's resource data as markdown tables — a generic, dataview-" +
    "style view for any swamp model. Declare a `tableViews` tag (JSON: [{spec, " +
    "columns, where, sort, limit}]) for curated views, or get an auto-table per " +
    "resource spec with zero config. Content-relative paths; scalar-eq filters.",
  scope: "method" as const,
  labels: ["view", "table", "report", "generic", "dataview"],
  execute: async (context: ReportContext) => {
    const bySpec = new Map<string, Rec[]>();
    for (const h of context.dataHandles ?? []) {
      let raw: Uint8Array | null;
      try {
        raw = await context.dataRepository.getContent(
          context.modelType,
          context.modelId,
          h.name,
          h.version,
        );
      } catch {
        continue;
      }
      if (!raw) continue;
      let rec: Rec;
      try {
        rec = JSON.parse(new TextDecoder().decode(raw));
      } catch {
        continue;
      }
      const arr = bySpec.get(h.specName) ?? [];
      arr.push(rec);
      bySpec.set(h.specName, arr);
    }
    const views = parseViews(context.definition?.tags?.tableViews);
    const { markdown, json } = buildReport(bySpec, views);
    context.logger?.info("table-report: {n} spec(s), {v} declared view(s)", {
      n: bySpec.size,
      v: views.length,
    });
    return { markdown, json };
  },
};
