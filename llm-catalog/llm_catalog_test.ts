/**
 * Unit tests for `@stateless/llm-catalog` schemas — the validation surface that
 * guarantees a uniform core across the five subject kinds + the access-path
 * join, a mandatory provenance envelope on claims, and straightforward facet
 * extension. Examples use real-but-historical MODEL-corpus data, `asOf`-stamped.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  ClaimSchema,
  EntrySchema,
  FacetsSchema,
  GlobalArgsSchema,
  ProvenanceSchema,
  PruneArgsSchema,
} from "./schemas.ts";
import { nodeClassMap, sanitiseForContribution } from "./contribute.ts";
import { idFromRepo, ingestHfConfig } from "./ingest.ts";
import { parseOpenRouterFeed, refreshGatewayCost } from "./sync.ts";
import { buildReconciliation } from "./reconcile.ts";

Deno.test("reconcile: gather + compare every config for a target", () => {
  const entries = [
    EntrySchema.parse({
      id: "ap-self", kind: "access-path", name: "self", summary: "s",
      visibility: "public",
      relations: [
        { rel: "of-model", target: "model-x" },
        { rel: "served-by", target: "runtime-vllm" },
        { rel: "runs-on", target: "hardware-spark" },
      ],
      facets: { recipe: { artifact: { quant: "FP8" } }, outcome: { speed: { genTokS: 38 }, provenance: { asOf: "x", source: "s", verification: "cited" } } },
    }),
    EntrySchema.parse({
      id: "ap-gw", kind: "access-path", name: "gw", summary: "s",
      visibility: "public",
      relations: [
        { rel: "of-model", target: "model-x" },
        { rel: "via-provider", target: "provider-openrouter" },
      ],
      facets: { cost: { perMTokInUsd: 0.2, perMTokOutUsd: 1.0, provenance: { asOf: "x", source: "feed", verification: "authoritative" } } },
    }),
    EntrySchema.parse({ // different model — excluded
      id: "ap-other", kind: "access-path", name: "o", summary: "s",
      visibility: "public",
      relations: [{ rel: "of-model", target: "model-y" }],
    }),
  ];
  const r = buildReconciliation("model-x", entries);
  assertEquals(r.count, 2); // model-y excluded
  assertEquals(r.configs[0].id, "ap-self"); // fastest first (38 > gateway's undefined)
  assertEquals(r.configs[0].access, "self-host");
  assertEquals(r.configs[0].runtime, "runtime-vllm");
  assertEquals(r.configs[0].quant, "FP8");
  const gw = r.configs.find((c) => c.id === "ap-gw")!;
  assertEquals(gw.access, "gateway");
  assertEquals(gw.cost, "$0.2/$1 per MTok");
  // hardware filter scopes it:
  assertEquals(buildReconciliation("model-x", entries, "hardware-spark").count, 1);
});

Deno.test("sync: parse OpenRouter feed → per-MTok prices", () => {
  const map = parseOpenRouterFeed({
    data: [
      { id: "z-ai/glm-5.2-20260616", pricing: { prompt: "0.0000012", completion: "0.0000041" } },
      { id: "deepseek/deepseek-v4-flash", pricing: { prompt: "0.00000009", completion: "0.00000018" } },
      { id: "broken/no-pricing" }, // skipped — no pricing
    ],
  });
  assertEquals(map.get("z-ai/glm-5.2-20260616"), { inUsd: 1.2, outUsd: 4.1 });
  assertEquals(map.get("deepseek/deepseek-v4-flash"), { inUsd: 0.09, outUsd: 0.18 });
  assertEquals(map.has("broken/no-pricing"), false);
});

Deno.test("sync: refresh a gateway access-path's cost from the price map", () => {
  const ap = EntrySchema.parse({
    id: "ap-glm-52-openrouter",
    kind: "access-path",
    name: "GLM-5.2 via OpenRouter",
    summary: "gateway",
    visibility: "public",
    relations: [
      { rel: "of-model", target: "model-glm-52" },
      { rel: "via-provider", target: "provider-openrouter" },
    ],
    facets: { api: { providerModelId: "z-ai/glm-5.2-20260616" } },
  });
  const map = parseOpenRouterFeed({
    data: [{ id: "z-ai/glm-5.2-20260616", pricing: { prompt: "0.0000012", completion: "0.0000041" } }],
  });
  const { entry, found } = refreshGatewayCost(ap, map, "2026-06-19", "feed");
  assert(found);
  const cost = entry!.facets!.cost as Record<string, unknown>;
  assertEquals(cost.perMTokInUsd, 1.2);
  assertEquals(cost.perMTokOutUsd, 4.1);
  assertEquals(
    (cost.provenance as { verification: string }).verification,
    "authoritative",
  );
  EntrySchema.parse(entry); // refreshed entry still validates
});

Deno.test("sync: a non-gateway or unpriced path is left alone", () => {
  const selfHost = EntrySchema.parse({
    id: "ap-x",
    kind: "access-path",
    name: "x",
    summary: "self-host",
    visibility: "public",
    relations: [{ rel: "served-by", target: "runtime-llamacpp" }],
  });
  assertEquals(refreshGatewayCost(selfHost, new Map(), "2026-06-19", "f").found, false);
});

Deno.test("ingest maps a HF config.json → authoritative architecture facet", () => {
  // The real GLM-5.2 config.json values.
  const { entry, mapped, gaps } = ingestHfConfig(
    "zai-org/GLM-5.2",
    {
      model_type: "glm_moe_dsa",
      num_hidden_layers: 78,
      hidden_size: 6144,
      num_attention_heads: 64,
      vocab_size: 154880,
      max_position_embeddings: 1048576,
      n_routed_experts: 256,
      n_shared_experts: 1,
      num_experts_per_tok: 8,
    },
    "2026-06-19",
  );
  assertEquals(entry.id, "model-glm-5-2");
  const a = entry.facets?.architecture as Record<string, unknown>;
  assertEquals(a.modelType, "glm_moe_dsa");
  assertEquals(a.layers, 78);
  assertEquals(a.nativeContext, 1048576);
  assertEquals(a.experts, "8/token of 256 routed + 1 shared");
  assertEquals(
    (a.provenance as { verification: string }).verification,
    "authoritative",
  );
  assert(mapped.includes("num_hidden_layers"));
  assert(gaps.length > 0); // params/benchmarks/license left for enrichment
  EntrySchema.parse(entry); // the draft validates
});

Deno.test("ingest idFromRepo slugifies org/repo", () => {
  assertEquals(idFromRepo("zai-org/GLM-5.2"), "model-glm-5-2");
  assertEquals(idFromRepo("google/gemma-4-26B-it"), "model-gemma-4-26b-it");
});

const FLEET_ENTRIES = [
  EntrySchema.parse({
    id: "hardware-node1-gb10",
    kind: "hardware",
    name: "node1",
    summary: "owned node",
    visibility: "private",
    relations: [
      { rel: "ref", target: "inventory:node1" },
      { rel: "instance-of", target: "hardware-dgx-spark" },
    ],
  }),
  EntrySchema.parse({
    id: "ap-x-gb10",
    kind: "access-path",
    name: "X @ node1",
    summary: "our-fleet result",
    visibility: "private",
    relations: [
      { rel: "of-model", target: "model-x" },
      { rel: "runs-on", target: "hardware-node1-gb10" },
    ],
    facets: {
      outcome: {
        speed: { genTokS: 27 },
        provenance: { asOf: "2026-04-17", source: "our-fleet-test (MODEL T9)" },
      },
    },
  }),
];

Deno.test("contribute sanitiser: remaps node→class, drops fleet refs, marks public", () => {
  const map = nodeClassMap(FLEET_ENTRIES);
  assertEquals(map["hardware-node1-gb10"], "hardware-dgx-spark");
  const { entry, needsAttribution } = sanitiseForContribution(
    FLEET_ENTRIES[1],
    map,
    "community measurement (your-handle)",
  );
  // runs-on was remapped from the owned node to the public class:
  assert(entry.relations.some((r) => r.rel === "runs-on" && r.target === "hardware-dgx-spark"));
  assertEquals(entry.visibility, "public");
  // private source retagged → no outstanding attribution need:
  assertEquals(needsAttribution.length, 0);
  assertEquals(
    (entry.facets?.outcome as { provenance: { source: string } }).provenance
      .source,
    "community measurement (your-handle)",
  );
  // sanitised result still validates as an Entry:
  EntrySchema.parse(entry);
});

Deno.test("contribute sanitiser: refuses (flags) a private source with no attribution", () => {
  const map = nodeClassMap(FLEET_ENTRIES);
  const { needsAttribution } = sanitiseForContribution(FLEET_ENTRIES[1], map);
  assert(needsAttribution.length > 0); // method throws on this
});

Deno.test("core-only entry parses; relations/claims/labels default to []", () => {
  const rt = EntrySchema.parse({
    id: "runtime-llamacpp",
    kind: "runtime",
    name: "llama.cpp",
    summary: "Primary self-host inference engine",
  });
  assertEquals(rt.relations, []);
  assertEquals(rt.claims, []);
  assertEquals(rt.labels, []);
  assertEquals(rt.facets, undefined);
});

Deno.test("model subject carries an architecture facet (static catalog tier)", () => {
  const m = EntrySchema.parse({
    id: "model-qwen35-35b",
    kind: "model",
    name: "Qwen3.5-35B-A3B",
    summary: "MoE; strong agentic scores; barrier-to-mid candidate",
    facets: {
      architecture: {
        attention: "hybrid-deltanet",
        params: "35B",
        activeParams: "3B",
        nativeContext: 262144,
        modality: ["text", "image", "video"],
      },
    },
  });
  assertEquals(m.facets?.architecture?.activeParams, "3B");
  assertEquals(m.facets?.architecture?.nativeContext, 262144);
});

Deno.test("access-path join: relations wire model×runtime×hardware + outcome facet", () => {
  const ap = EntrySchema.parse({
    id: "ap-qwen35-35b-q8-llamacpp-gb10",
    kind: "access-path",
    name: "Qwen3.5-35B-A3B Q8 on llama.cpp @ GB10",
    summary: "Self-host path; T9 nothink pass",
    relations: [
      { rel: "of-model", target: "model-qwen35-35b" },
      { rel: "served-by", target: "runtime-llamacpp" },
      { rel: "runs-on", target: "hardware-node1-gb10" },
    ],
    facets: {
      serving: { flags: { reasoningBudget: 0 }, sampling: { temp: 0.8 } },
      outcome: {
        speed: { genTokS: 27 },
        footprint: { vramGB: 48, quant: "Q8_0" },
        context: { tokens: 210000 },
        quality: { score: "10/10", eval: "T9 stage2 nothink" },
        provenance: {
          asOf: "2026-04-17",
          source: "MODEL corpus REGISTRY.md (historical — re-verify)",
          confidence: "medium",
          versionPins: { quant: "Q8_0", runtime: "llama.cpp@2026-04-13" },
        },
      },
    },
  });
  assertEquals(ap.relations.length, 3);
  assertEquals(ap.facets?.outcome?.speed?.genTokS as unknown, 27);
  assertEquals(ap.facets?.outcome?.provenance?.asOf, "2026-04-17");
});

Deno.test("claim requires provenance (asOf + source) — the envelope is mandatory", () => {
  const ok = ClaimSchema.parse({
    kind: "caveat",
    body: "Ollama retired for eval: num_predict does not cap think tokens, hangs.",
    provenance: { asOf: "2026-04-13", source: "MODEL OPS_NOTES" },
  });
  assertEquals(ok.kind, "caveat");
  // missing provenance is rejected:
  assertThrows(() =>
    ClaimSchema.parse({ kind: "caveat", body: "no provenance here" })
  );
  // provenance missing source is rejected:
  assertThrows(() =>
    ProvenanceSchema.parse({ asOf: "2026-04-13" })
  );
});

Deno.test("evaluative prefer-over edge carries rationale + provenance", () => {
  const hw = EntrySchema.parse({
    id: "hardware-dgx-spark",
    kind: "hardware",
    name: "DGX Spark (GB10)",
    summary: "Unified-memory inference box; CUDA; clusterable",
    relations: [
      {
        rel: "prefer-over",
        target: "hardware-strix-halo",
        rationale: "Direct NVIDIA CUDA support, clustering, 60-80W draw.",
        provenance: { asOf: "2026-06-19", source: "r/LocalLLM thread" },
      },
    ],
    facets: {
      hardware: { compute: "cuda", unifiedMemGB: 128, powerW: 70, clusterable: true },
    },
  });
  assertEquals(hw.relations[0].rel, "prefer-over");
  assertEquals(hw.facets?.hardware?.clusterable, true);
});

Deno.test("provider entry: api facet with openai-compat + compat caveats", () => {
  const p = EntrySchema.parse({
    id: "provider-bedrock-mantle",
    kind: "provider",
    name: "Amazon Bedrock Mantle",
    summary: "OpenAI-spec endpoint fronting many non-GPT models",
    facets: {
      api: {
        apiSpec: "openai-compat",
        compatCaveats: ["Some models may not support all OpenAI API features."],
      },
    },
  });
  assertEquals(p.facets?.api?.apiSpec, "openai-compat");
});

Deno.test("unknown facet passes through (the extension seam)", () => {
  const facets = FacetsSchema.parse({
    architecture: { params: "122B" },
    // a facet that has no typed schema yet (a future dimension):
    licensing: { license: "apache-2.0", commercialOk: true },
  });
  assertEquals(facets.architecture?.params, "122B");
  const lic = (facets as Record<string, unknown>).licensing as Record<
    string,
    unknown
  >;
  assertEquals(lic.commercialOk, true);
});

Deno.test("open vocab: novel kind and relation verb are accepted", () => {
  const e = EntrySchema.parse({
    id: "technique-snapkv",
    kind: "technique", // KV-compression method
    name: "SnapKV",
    summary: "KV-cache compression",
    relations: [{ rel: "applies-to-arch", target: "model-qwen35-35b" }],
  });
  assertEquals(e.kind, "technique");
  assertEquals(e.relations[0].rel, "applies-to-arch");
});

Deno.test("visibility is a closed vocab (public|private); junk rejected", () => {
  assertEquals(
    EntrySchema.parse({
      id: "model-x",
      kind: "model",
      name: "X",
      summary: "y",
      visibility: "public",
    }).visibility,
    "public",
  );
  assertThrows(() =>
    EntrySchema.parse({
      id: "model-x",
      kind: "model",
      name: "X",
      summary: "y",
      visibility: "secret", // not in the enum
    })
  );
});

Deno.test("invalid id slug is rejected", () => {
  assertThrows(() =>
    EntrySchema.parse({
      id: "Model One", // spaces + uppercase
      kind: "model",
      name: "x",
      summary: "y",
    })
  );
});

Deno.test("missing required core field (summary) is rejected", () => {
  assertThrows(() =>
    EntrySchema.parse({ id: "model-x", kind: "model", name: "X" })
  );
});

Deno.test("prune args: status defaults to 'retired' and accepts overrides", () => {
  assertEquals(PruneArgsSchema.parse({}).status, "retired");
  assertEquals(
    PruneArgsSchema.parse({ status: "graveyard" }).status,
    "graveyard",
  );
});

Deno.test("global args: entries default to [] and accept a catalog", () => {
  assertEquals(GlobalArgsSchema.parse({ name: "llm-kb" }).entries, []);
  const parsed = GlobalArgsSchema.parse({
    name: "llm-kb",
    entries: [
      { id: "runtime-llamacpp", kind: "runtime", name: "llama.cpp", summary: "engine" },
      { id: "runtime-ollama", kind: "runtime", name: "Ollama", summary: "engine" },
    ],
  });
  assertEquals(parsed.entries.length, 2);
});
