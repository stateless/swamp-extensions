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
import {
  buildCapacityPlan,
  buildDeploymentPlans,
  decodeTokSEstimate,
  footprintGB,
  qualityScore,
  resolveWeights,
} from "./capacity.ts";
import { CapacityArgsSchema, PlanArgsSchema } from "./schemas.ts";

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

// --- capacity -------------------------------------------------------------

const CAP_ENTRIES = [
  EntrySchema.parse({
    id: "hardware-box", kind: "hardware", name: "Box", summary: "h",
    visibility: "public", facets: { hardware: { unifiedMemGB: 128 } },
  }),
  EntrySchema.parse({ // stored footprint → 17GB at q4
    id: "model-a", kind: "model", name: "A", summary: "m", visibility: "public",
    facets: {
      architecture: { params: "30B", nativeContext: 262144 },
      footprint: { quants: [{ quant: "q4", memGB: 17 }] },
    },
  }),
  EntrySchema.parse({ // no footprint → computed from params (~225GB at q4)
    id: "model-big", kind: "model", name: "Big", summary: "m", visibility: "public",
    facets: { architecture: { params: "400B", nativeContext: 262144 } },
  }),
  EntrySchema.parse({
    id: "ap-a-local", kind: "access-path", name: "a-local", summary: "a", visibility: "public",
    relations: [
      { rel: "of-model", target: "model-a" },
      { rel: "served-by", target: "runtime-vllm" },
      { rel: "runs-on", target: "hardware-box" },
    ],
    facets: { recipe: { artifact: { quant: "q4" } }, outcome: { context: { tokens: 200000 }, speed: { genTokS: 30 } } },
  }),
  EntrySchema.parse({
    id: "ap-big-local", kind: "access-path", name: "big-local", summary: "b", visibility: "public",
    relations: [
      { rel: "of-model", target: "model-big" },
      { rel: "served-by", target: "runtime-vllm" },
      { rel: "runs-on", target: "hardware-box" },
    ],
    facets: { recipe: { artifact: { quant: "q4" } }, outcome: { context: { tokens: 200000 }, speed: { genTokS: 12 } } },
  }),
  EntrySchema.parse({
    id: "ap-a-cloud", kind: "access-path", name: "a-cloud", summary: "c", visibility: "public",
    relations: [
      { rel: "of-model", target: "model-a" },
      { rel: "via-provider", target: "provider-openrouter" },
    ],
    facets: { cost: { perMTokOutUsd: 0.5, provenance: { asOf: "x", source: "feed" } } },
  }),
];

Deno.test("footprintGB: stored facet overrides; else params × quant-bits", () => {
  const a = CAP_ENTRIES.find((e) => e.id === "model-a")!;
  const big = CAP_ENTRIES.find((e) => e.id === "model-big")!;
  assertEquals(footprintGB(a, "q4"), 17); // stored
  assertEquals(footprintGB(big, "q4"), Math.round((400 * 4.5) / 8)); // computed = 225
});

Deno.test("capacity: bin-packs against host free memory, ranks local-first", () => {
  const plan = buildCapacityPlan(
    CapacityArgsSchema.parse({ task: "writing", host: "hardware-box" }),
    CAP_ENTRIES,
  );
  assertEquals(plan.hostGB, 128);
  assertEquals(plan.freeGB, 128);
  // a-local fits (17GB ≤ 128) and ranks first (local-first); big-local is unmet (225 > 128)
  assertEquals(plan.recommendations[0].accessPath, "ap-a-local");
  assertEquals(plan.recommendations[0].placement, "local:hardware-box");
  assert(plan.unmet.some((u) => u.includes("ap-big-local")));
  // cloud still listed (prefer-local), after local
  assert(plan.recommendations.some((r) => r.accessPath === "ap-a-cloud"));
});

Deno.test("capacity: co-resident reservation shrinks the fit budget", () => {
  const plan = buildCapacityPlan(
    CapacityArgsSchema.parse({
      task: "writing", host: "hardware-box",
      coresident: [{ label: "agent", reserveGB: 120 }],
    }),
    CAP_ENTRIES,
  );
  assertEquals(plan.freeGB, 8); // 128 - 120
  // a-local (17GB) no longer fits → unmet; no local recs, cloud remains
  assert(plan.unmet.some((u) => u.includes("ap-a-local")));
  assert(!plan.recommendations.some((r) => r.placement.startsWith("local")));
  assert(plan.recommendations.some((r) => r.accessPath === "ap-a-cloud"));
});

Deno.test("capacity: node-count gate rules out multi-unit recipes on a single host", () => {
  const entries = [
    EntrySchema.parse({
      id: "hardware-box", kind: "hardware", name: "Box", summary: "h",
      visibility: "public", facets: { hardware: { unifiedMemGB: 128 } },
    }),
    EntrySchema.parse({
      id: "model-c", kind: "model", name: "C", summary: "m", visibility: "public",
      facets: { architecture: { params: "120B", nativeContext: 131072 } },
    }),
    EntrySchema.parse({ // 2-unit cluster recipe (units: 2)
      id: "ap-c-2x", kind: "access-path", name: "c2x", summary: "a", visibility: "public",
      relations: [
        { rel: "of-model", target: "model-c" },
        { rel: "served-by", target: "runtime-vllm" },
        { rel: "runs-on", target: "hardware-box" },
      ],
      facets: { recipe: { artifact: { quant: "fp8" }, hardware: { units: 2 } }, outcome: { context: { tokens: 131072 } } },
    }),
    EntrySchema.parse({ // Ray cluster by config string (no units) → inferred ≥2
      id: "ap-c-ray", kind: "access-path", name: "cray", summary: "a", visibility: "public",
      relations: [
        { rel: "of-model", target: "model-c" },
        { rel: "served-by", target: "runtime-vllm" },
        { rel: "runs-on", target: "hardware-box" },
      ],
      facets: { recipe: { artifact: { quant: "int4" }, hardware: { config: "Ray cluster (multi-node)" } }, outcome: { context: { tokens: 131072 } } },
    }),
  ];
  // single host (hostUnits defaults to 1): both multi-unit recipes ruled out
  const solo = buildCapacityPlan(CapacityArgsSchema.parse({ task: "t", host: "hardware-box" }), entries);
  assertEquals(solo.recommendations.length, 0);
  assert(solo.unmet.some((u) => u.includes("ap-c-2x") && u.includes("2 units")));
  assert(solo.unmet.some((u) => u.includes("ap-c-ray")));
  // give it 2 units: the 2× recipe now fits (total budget 256GB)
  const cluster = buildCapacityPlan(CapacityArgsSchema.parse({ task: "t", host: "hardware-box", hostUnits: 2 }), entries);
  assertEquals(cluster.hostGB, 256);
  assert(cluster.recommendations.some((r) => r.accessPath === "ap-c-2x" && r.units === 2));
});

Deno.test("capacity: driver-reserved memory shrinks the usable budget", () => {
  const entries = [
    EntrySchema.parse({
      id: "hardware-gb10", kind: "hardware", name: "GB10", summary: "h",
      visibility: "public", facets: { hardware: { unifiedMemGB: 128, driverReservedGB: 22 } },
    }),
  ];
  const plan = buildCapacityPlan(CapacityArgsSchema.parse({ task: "t", host: "hardware-gb10" }), entries);
  assertEquals(plan.hostGB, 106); // 128 installed - 22 driver-reserved
});

Deno.test("capacity: privacy local-only drops every cloud path", () => {
  const plan = buildCapacityPlan(
    CapacityArgsSchema.parse({ task: "writing", host: "hardware-box", privacy: "local-only" }),
    CAP_ENTRIES,
  );
  assert(plan.recommendations.every((r) => r.placement.startsWith("local")));
  assert(!plan.recommendations.some((r) => r.accessPath === "ap-a-cloud"));
});

// ── capacity-v2: profiles, throughput estimate, deployment planner ──────────

const V2_ENTRIES = [
  EntrySchema.parse({
    id: "hardware-spark2", kind: "hardware", name: "Spark2", summary: "h",
    visibility: "public",
    facets: { hardware: { unifiedMemGB: 128, driverReservedGB: 22, memBandwidthGBs: 273 } },
  }),
  EntrySchema.parse({ // small agent specialist (MoE, 3B active, fast)
    id: "model-agent", kind: "model", name: "Agent", summary: "m", visibility: "public",
    facets: {
      architecture: { params: "35B", activeParams: "3B", nativeContext: 262144, attention: "gqa" },
      footprint: { kvGbPer1k: 0.02, quants: [{ quant: "int4", memGB: 19 }] },
      benchmarks: { tau2Agentic: 84, bfcl: 75, ifEval: 94, ifBench: 78 },
    },
  }),
  EntrySchema.parse({ // big all-rounder (MoE, 10B active)
    id: "model-allrounder", kind: "model", name: "All", summary: "m", visibility: "public",
    facets: {
      architecture: { params: "122B", activeParams: "10B", nativeContext: 262144 },
      footprint: { kvGbPer1k: 0.10, quants: [{ quant: "int4", memGB: 71 }] },
      benchmarks: { tau2Agentic: 79, bfcl: 72, ifEval: 93, ifBench: 76, mmluPro: 87, gpqaDiamond: 87 },
    },
  }),
  EntrySchema.parse({ // dense writing specialist — strong IF, but slow (dense → no activeParams)
    id: "model-writer", kind: "model", name: "Writer", summary: "m", visibility: "public",
    facets: {
      architecture: { params: "27B", nativeContext: 200000, attention: "dense" },
      footprint: { kvGbPer1k: 0.02, quants: [{ quant: "int4", memGB: 15 }] },
      benchmarks: { ifEval: 95, mmluPro: 85, mmmlu: 85 },
    },
  }),
  EntrySchema.parse({
    id: "ap-agent", kind: "access-path", name: "agent", summary: "a", visibility: "public",
    relations: [{ rel: "of-model", target: "model-agent" }, { rel: "runs-on", target: "hardware-spark2" }],
    facets: { recipe: { artifact: { quant: "int4" }, hardware: { units: 1 } }, outcome: { context: { tokens: 262144 }, speed: { genTokS: 90 } } },
  }),
  EntrySchema.parse({
    id: "ap-allrounder", kind: "access-path", name: "all", summary: "a", visibility: "public",
    relations: [{ rel: "of-model", target: "model-allrounder" }, { rel: "runs-on", target: "hardware-spark2" }],
    facets: { recipe: { artifact: { quant: "int4" }, hardware: { units: 1 } }, outcome: { context: { tokens: 262144 }, speed: { genTokS: 52 } } },
  }),
  EntrySchema.parse({ // NO measured genTokS → throughput must be estimated
    id: "ap-writer", kind: "access-path", name: "writer", summary: "a", visibility: "public",
    relations: [{ rel: "of-model", target: "model-writer" }, { rel: "runs-on", target: "hardware-spark2" }],
    facets: { recipe: { artifact: { quant: "int4" }, hardware: { units: 1 } }, outcome: { context: { tokens: 200000 } } },
  }),
];

Deno.test("decodeTokSEstimate: bandwidth ÷ active-params×bytes (MoE sparsity drives speed)", () => {
  const hw = V2_ENTRIES.find((e) => e.id === "hardware-spark2")!;
  const all = V2_ENTRIES.find((e) => e.id === "model-allrounder")!; // 10B active
  const writer = V2_ENTRIES.find((e) => e.id === "model-writer")!; // 27B dense
  // 273 / (10 × 4.3/8) ≈ 50.8 — near the measured 52 for the optimised recipe.
  const estAll = decodeTokSEstimate(all, "int4", hw)!;
  assert(estAll > 48 && estAll < 54, `allrounder est ${estAll}`);
  // dense 27B: 273 / (27 × 4.3/8) ≈ 18.8 — far SLOWER despite being smaller total.
  const estWriter = decodeTokSEstimate(writer, "int4", hw)!;
  assert(estWriter > 17 && estWriter < 21, `writer est ${estWriter}`);
  assert(estAll > estWriter); // the sparsity inversion: bigger MoE beats smaller dense
});

Deno.test("qualityScore: weighted average, renormalised, with coverage + synonyms", () => {
  const w = resolveWeights("agents")!;
  const agent = V2_ENTRIES.find((e) => e.id === "model-agent")!;
  const writer = V2_ENTRIES.find((e) => e.id === "model-writer")!;
  const qa = qualityScore(agent, w)!;
  assertEquals(qa.coverage, 1); // all 4 agent dims present
  assert(qa.score > 80 && qa.score < 86);
  // writer only has ifEval of the agent dims → thin coverage, score = that lone dim
  const qw = qualityScore(writer, w)!;
  assertEquals(qw.coverage, 0.25);
  assertEquals(qw.score, 95);
  // synonym: a card reporting tauBenchRetail (not tau2Agentic) still scores the tau2 dim
  const syn = qualityScore(
    { facets: { benchmarks: { tauBenchRetail: 67.8 } } },
    { tau2Agentic: 1 },
  )!;
  assertEquals(syn.score, 67.8);
});

Deno.test("capacity: a profile ranks local recs by quality, fills estimated tok/s", () => {
  const plan = buildCapacityPlan(
    CapacityArgsSchema.parse({ task: "agentwork", host: "hardware-spark2", profile: "agents" }),
    V2_ENTRIES,
  );
  // model-agent outscores the all-rounder on the agents profile → ranks first
  assertEquals(plan.recommendations[0].model, "model-agent");
  assert((plan.recommendations[0].qualityScore ?? 0) > 80);
  // the writer path had no measured genTokS → estimate filled in + flagged
  const wr = plan.recommendations.find((r) => r.accessPath === "ap-writer")!;
  assert(wr.decodeTokS && wr.decodeTokS > 17 && wr.decodeTokS < 21);
  assertEquals(wr.decodeTokSEstimated, true);
});

Deno.test("plan: enumerates shared vs split on a Pareto front", () => {
  const result = buildDeploymentPlans(
    PlanArgsSchema.parse({
      host: "hardware-spark2",
      workloads: [
        { label: "writing", profile: "writing", minContext: 32768 },
        { label: "agents", profile: "agents", minContext: 32768 },
      ],
    }),
    V2_ENTRIES,
  );
  assertEquals(result.freeGB, 106); // 128 - 22 driver
  const shared = result.plans.find((p) => p.kind === "shared");
  const split = result.plans.find((p) => p.kind === "split");
  // shared: the all-rounder serves BOTH (only model strong on both profiles & fits)
  assert(shared, "expected a shared plan");
  assertEquals(shared!.models, ["model-allrounder"]);
  assertEquals(shared!.workloads.length, 2);
  // split: a specialist per workload — agent model for agents, writer for writing
  assert(split, "expected a split plan");
  assertEquals(split!.models.length, 2);
  assert(split!.models.includes("model-agent"));
  assert(split!.models.includes("model-writer"));
  // split pays isolation overhead (one extra server) → totalGB includes +2
  assert((split!.totalGB ?? 0) > 0);
  // every returned plan actually fits the budget
  assert(result.plans.every((p) => (p.freeAfterGB ?? 0) >= 0));
  // at least one plan is on the Pareto front
  assert(result.plans.some((p) => p.pareto));
});

Deno.test("plan: a very tight budget rules out the split, a small shared survives", () => {
  const result = buildDeploymentPlans(
    PlanArgsSchema.parse({
      host: "hardware-spark2",
      // squeeze so two co-resident servers can't both fit, but one small model can
      coresident: [{ label: "other", reserveGB: 76 }],
      workloads: [
        { label: "writing", profile: "writing", minContext: 200000 },
        { label: "agents", profile: "agents", minContext: 200000 },
      ],
    }),
    V2_ENTRIES,
  );
  assertEquals(result.freeGB, 30); // 106 - 76
  // split (writer ~19 + agent ~23 + iso 2 ≈ 44) exceeds 30 → ruled out, reported
  assert(!result.plans.some((p) => p.kind === "split"));
  assert(result.unmet.some((u) => u.includes("split")));
  // a small single shared model still fits and serves both (compromised but viable)
  assert(result.plans.some((p) => p.kind === "shared"));
  assert(result.plans.every((p) => (p.freeAfterGB ?? 0) >= 0));
});
