/**
 * operating-points.ts — emit the flat operating-point index as a JSON array, the
 * query surface for DuckDB / ad-hoc SQL. One row per (model × runsOn) and per
 * measured-point, denormalised: endpoint/quant/units, genTokS (measured or
 * estimated), needGB, price, model-level benchmarks, config eval, and the overlay
 * tags visibility (public|private) + origin (runsOn|measured-point).
 *
 * Run:  deno run --allow-read --allow-write scripts/operating-points.ts \
 *         <catalog.json> <out.json>
 * Then: duckdb -c "SELECT * FROM read_json('<out.json>') ORDER BY genTokS DESC"
 *
 * @module
 */
import { buildOperatingPointIndex } from "../../extensions/models/llm-catalog/capacity.ts";

const inPath = Deno.args[0] ?? "catalog.json";
const outPath = Deno.args[1] ?? "operating-points.json";
const cat = JSON.parse(await Deno.readTextFile(inPath));
const rows = buildOperatingPointIndex(cat.entries ?? cat);
await Deno.writeTextFile(outPath, JSON.stringify(rows, null, 2) + "\n");
console.log(`✓ ${rows.length} operating-points → ${outPath}`);
