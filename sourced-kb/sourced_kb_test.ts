/**
 * Unit tests for `@stateless/sourced-kb` — the neutral provenance-aware core:
 * a uniform entry across open kinds, a mandatory provenance envelope on claims,
 * open facets, and the contribute publish-gate.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  ClaimSchema,
  EntrySchema,
  GlobalArgsSchema,
  ProvenanceSchema,
  PruneArgsSchema,
} from "./schemas.ts";
import {
  DEFAULT_PRIVATE_SOURCE,
  sanitiseForContribution,
} from "./contribute.ts";

Deno.test("entry: uniform shape across open kinds, defaults applied", () => {
  const e = EntrySchema.parse({
    id: "offering-b2",
    kind: "offering",
    name: "Backblaze B2",
    summary: "Hot object storage, flat per-TB.",
    visibility: "public",
    facets: {
      pricing: {
        currency: "USD",
        perTBMonth: 6.95,
        provenance: { asOf: "2026-06-23", source: "https://backblaze.com" },
      },
    },
  });
  // open vocab kind preserved
  assertEquals(e.kind, "offering");
  // defaults fill in
  assertEquals(e.relations, []);
  assertEquals(e.claims, []);
  assertEquals(e.labels, []);
  // open facet passes through untyped
  assertEquals(
    (e.facets?.pricing as { perTBMonth: number }).perTBMonth,
    6.95,
  );
});

Deno.test("entry: id must be a lowercase slug", () => {
  assertThrows(() =>
    EntrySchema.parse({
      id: "Offering B2",
      kind: "offering",
      name: "x",
      summary: "y",
    })
  );
});

Deno.test("claim: provenance is mandatory", () => {
  // a claim without provenance is rejected — the whole point of the envelope
  assertThrows(() =>
    ClaimSchema.parse({ kind: "note", body: "prices churn" })
  );
  const c = ClaimSchema.parse({
    kind: "caveat",
    body: "egress billed separately",
    provenance: { asOf: "2026-06-23", source: "vendor docs" },
  });
  assertEquals(c.kind, "caveat");
});

Deno.test("provenance: asOf + source both required", () => {
  assertThrows(() => ProvenanceSchema.parse({ asOf: "2026-06-23" }));
  assertThrows(() => ProvenanceSchema.parse({ source: "x" }));
  const p = ProvenanceSchema.parse({
    asOf: "2026-06-23",
    source: "https://example.com/pricing",
    versionPins: { region: "australia-southeast1", currency: "USD" },
  });
  assertEquals(p.versionPins?.region, "australia-southeast1");
});

Deno.test("globalArgs: entries default to empty", () => {
  const g = GlobalArgsSchema.parse({ name: "cloud-backup-pricing" });
  assertEquals(g.entries, []);
});

Deno.test("prune: default status is retired", () => {
  assertEquals(PruneArgsSchema.parse({}).status, "retired");
});

Deno.test("contribute: refuses a private source with no attribution", () => {
  const entry = EntrySchema.parse({
    id: "offering-local",
    kind: "offering",
    name: "local box",
    summary: "measured on our own hardware",
    visibility: "private",
    facets: {
      pricing: {
        perTBMonth: 2,
        provenance: { asOf: "2026-06-23", source: "our-fleet measurement" },
      },
    },
  });
  const res = sanitiseForContribution(entry, DEFAULT_PRIVATE_SOURCE);
  assert(res.needsAttribution.length > 0, "should flag the private source");
});

Deno.test("contribute: retags private source + marks public when attributed", () => {
  const entry = EntrySchema.parse({
    id: "offering-local",
    kind: "offering",
    name: "local box",
    summary: "measured on our own hardware",
    visibility: "private",
    claims: [{
      kind: "finding",
      body: "sustained 1.1 GB/s",
      provenance: { asOf: "2026-06-23", source: "our-fleet measurement" },
    }],
  });
  const res = sanitiseForContribution(
    entry,
    DEFAULT_PRIVATE_SOURCE,
    "community measurement (stateless)",
  );
  assertEquals(res.needsAttribution, []);
  assertEquals(res.entry.visibility, "public");
  assertEquals(
    res.entry.claims[0].provenance.source,
    "community measurement (stateless)",
  );
});

Deno.test("contribute: a clean public source needs no attribution", () => {
  const entry = EntrySchema.parse({
    id: "offering-b2",
    kind: "offering",
    name: "Backblaze B2",
    summary: "vendor-published pricing",
    visibility: "public",
    facets: {
      pricing: {
        perTBMonth: 6.95,
        provenance: { asOf: "2026-06-23", source: "https://www.backblaze.com" },
      },
    },
  });
  const res = sanitiseForContribution(entry, DEFAULT_PRIVATE_SOURCE);
  assertEquals(res.needsAttribution, []);
  assertEquals(res.entry.visibility, "public");
});
