/**
 * Unit tests for @stateless/table-report — the generic data-table view core.
 *
 * @module
 */
import { assert, assertEquals } from "jsr:@std/assert";
import {
  applyView,
  autoColumns,
  buildReport,
  fmtCell,
  getPath,
  parseViews,
  type Rec,
  renderTable,
} from "./table_report.ts";

const RECS: Rec[] = [
  { id: "a", kind: "offering", name: "Alpha", facets: { pricing: { perTBMonth: 12, currency: "USD" } } },
  { id: "b", kind: "offering", name: "Beta", facets: { pricing: { perTBMonth: 3, currency: "USD" } } },
  { id: "p", kind: "provider", name: "Prov", facets: {} },
];

Deno.test("getPath: dot-path lookup, undefined on miss", () => {
  assertEquals(getPath(RECS[0], "facets.pricing.perTBMonth"), 12);
  assertEquals(getPath(RECS[0], "facets.nope.x"), undefined);
  assertEquals(getPath(RECS[0], "kind"), "offering");
});

Deno.test("fmtCell: scalars, arrays, objects, pipe-safety", () => {
  assertEquals(fmtCell(6.95), "6.95");
  assertEquals(fmtCell(null), "");
  assertEquals(fmtCell(["x", "y"]), "x, y");
  assertEquals(fmtCell({ a: 1 }), "{…}");
  assertEquals(fmtCell("a|b"), "a\\|b");
});

Deno.test("autoColumns: id/kind/name + facet scalar leaves", () => {
  const cols = autoColumns(RECS);
  assertEquals(cols.id, "id");
  assertEquals(cols.kind, "kind");
  // facet leaf label drops the facets. prefix
  assertEquals(cols["pricing.perTBMonth"], "facets.pricing.perTBMonth");
});

Deno.test("applyView: where-filter + column project + sort + limit", () => {
  const t = applyView(RECS, {
    spec: "entry",
    where: { kind: "offering" },
    columns: { id: "id", "$/TB": "facets.pricing.perTBMonth" },
    sort: { by: "facets.pricing.perTBMonth", dir: "asc" },
    limit: 1,
  });
  assertEquals(t.headers, ["id", "$/TB"]);
  assertEquals(t.count, 1); // limit
  assertEquals(t.rows[0], ["b", "3"]); // cheapest first, provider filtered out
});

Deno.test("applyView: desc sort + missing values sort last", () => {
  const t = applyView(RECS, {
    spec: "entry",
    columns: { id: "id", p: "facets.pricing.perTBMonth" },
    sort: { by: "facets.pricing.perTBMonth", dir: "desc" },
  });
  assertEquals(t.rows.map((r) => r[0]), ["a", "b", "p"]); // 12, 3, then missing
});

Deno.test("parseViews: JSON tag → ViewSpec[]; invalid → []", () => {
  const v = parseViews('[{"spec":"entry","columns":{"id":"id"}}]');
  assertEquals(v.length, 1);
  assertEquals(v[0].spec, "entry");
  assertEquals(parseViews("not json"), []);
  assertEquals(parseViews(undefined), []);
  // a bare object is accepted as a single view
  assertEquals(parseViews('{"spec":"entry"}').length, 1);
  // a malformed view (no spec) is dropped
  assertEquals(parseViews('[{"columns":{}}]'), []);
});

Deno.test("buildReport: declared mode renders the requested view", () => {
  const bySpec = new Map<string, Rec[]>([["entry", RECS]]);
  const { markdown, json } = buildReport(bySpec, [{
    title: "Offerings",
    spec: "entry",
    where: { kind: "offering" },
    columns: { id: "id", "$/TB": "facets.pricing.perTBMonth" },
    sort: { by: "facets.pricing.perTBMonth", dir: "asc" },
  }]);
  assert(markdown.includes("### Offerings (2)"));
  assert(markdown.includes("| id | $/TB |"));
  assert(markdown.indexOf("| b | 3 |") < markdown.indexOf("| a | 12 |")); // sorted
  assertEquals((json as { mode: string }).mode, "declared");
});

Deno.test("buildReport: auto mode renders a table per spec with auto columns", () => {
  const bySpec = new Map<string, Rec[]>([
    ["entry", RECS],
    ["other", [{ id: "z", kind: "thing" }]],
  ]);
  const { markdown, json } = buildReport(bySpec, []);
  assert(markdown.includes("Auto-rendered 2 resource spec(s)"));
  assert(markdown.includes("### entry"));
  assert(markdown.includes("### other"));
  assertEquals((json as { mode: string }).mode, "auto");
});

Deno.test("renderTable: empty rows + no-columns are handled", () => {
  assert(renderTable({ title: "T", headers: ["a"], rows: [], count: 0 }).includes("_(no rows)_"));
  assert(renderTable({ title: "T", headers: [], rows: [], count: 0 }).includes("_(no columns)_"));
});
