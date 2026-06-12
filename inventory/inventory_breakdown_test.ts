/**
 * Unit tests for the `@stateless/inventory-breakdown` report. The report only
 * reads `dataRepository` + `definition.name`, so a hand-built mock context is
 * enough — no execution harness required. Neutral placeholder devices only.
 *
 * @module
 */

import { assert, assertEquals } from "jsr:@std/assert";
import { report } from "./inventory_breakdown.ts";

interface FakeDevice {
  id: string;
  name: string;
  kind: string;
  site?: string;
  make?: string;
  model?: string;
  status?: string;
  facets?: Record<string, unknown>;
}

/** Build a mock report context over a set of (device, version) records. */
function mockContext(devices: Array<FakeDevice & { version?: number }>) {
  const enc = new TextEncoder();
  const byName = new Map<string, FakeDevice>();
  const metas = devices.map((d) => {
    byName.set(d.id, d);
    return { name: d.id, version: d.version ?? 1, tags: { specName: "device" } };
  });
  // a non-device artifact that must be ignored:
  metas.push({ name: "report-noise", version: 1, tags: { specName: "summary" } });
  return {
    modelType: "@stateless/inventory",
    modelId: "test-model-id",
    definition: { name: "testfleet" },
    dataRepository: {
      findAllForModel: () => Promise.resolve(metas),
      getContent: (_t: string, _m: string, name: string) =>
        Promise.resolve(
          byName.has(name) ? enc.encode(JSON.stringify(byName.get(name))) : null,
        ),
    },
  };
}

Deno.test("breakdown: counts, grouping, and JSON shape", async () => {
  const ctx = mockContext([
    { id: "ups-1", name: "UPS", kind: "ups", site: "home", status: "active" },
    { id: "host-1", name: "Host", kind: "host", site: "home", status: "active" },
    { id: "host-2", name: "Host2", kind: "host", site: "colo", status: "active" },
  ]);
  const r = await report.execute(ctx);
  assertEquals(r.json.total, 3);
  assertEquals((r.json.bySite as Record<string, number>).home, 2);
  assertEquals((r.json.bySite as Record<string, number>).colo, 1);
  assertEquals((r.json.byKind as Record<string, number>).host, 2);
  assert(r.markdown.includes("# Inventory breakdown — testfleet"));
  assert(r.markdown.includes("**3 active devices**"));
});

Deno.test("breakdown: soft-pruned (removed/superseded) records are excluded", async () => {
  const ctx = mockContext([
    { id: "live", name: "Live", kind: "host", site: "home", status: "active" },
    { id: "gone", name: "Gone", kind: "host", site: "home", status: "removed" },
    { id: "old", name: "Old", kind: "host", site: "home", status: "superseded-by-x" },
  ]);
  const r = await report.execute(ctx);
  assertEquals(r.json.total, 1);
  assert(!r.markdown.includes("`gone`"));
  assert(!r.markdown.includes("`old`"));
});

Deno.test("breakdown: flags needs-attention statuses", async () => {
  const ctx = mockContext([
    { id: "ok", name: "OK", kind: "host", site: "home", status: "active" },
    { id: "bat", name: "UPS", kind: "ups", site: "colo", status: "degraded — DEAD BATTERY" },
    { id: "shelf", name: "Spare", kind: "router", site: "home", status: "on-shelf (pending)" },
  ]);
  const r = await report.execute(ctx);
  const flagged = r.json.flagged as Array<{ id: string }>;
  assertEquals(flagged.map((f) => f.id).sort(), ["bat", "shelf"]);
  assert(r.markdown.includes("## ⚠️ Needs attention"));
});

Deno.test("breakdown: detects (verify) residue in model and facets", async () => {
  const ctx = mockContext([
    { id: "m", name: "M", kind: "nas", site: "home", status: "active", model: "AS5404T (verify)" },
    {
      id: "f",
      name: "F",
      kind: "host",
      site: "colo",
      status: "active",
      facets: { firmware: { os: { vendor: "X", product: "Y", version: "8.x (verify point release)" } } },
    },
    { id: "clean", name: "C", kind: "host", site: "home", status: "active", model: "Known-1" },
  ]);
  const r = await report.execute(ctx);
  const verify = r.json.verify as Array<{ id: string; where: string }>;
  assertEquals(verify.map((v) => v.id).sort(), ["f", "m"]);
});
