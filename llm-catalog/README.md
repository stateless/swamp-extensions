# @stateless/llm-catalog

A **sourced, versioned knowledge base of LLM-ops knowledge** for
[swamp](https://github.com/systeminit/swamp) — **not** a control plane for
running models. It is the structured, CEL-queryable record that running
extensions (a `@keeb/ollama`-class server, an eval producer, a routing layer)
**read** to decide _which model to run where, with what settings, at what cost_.

It deliberately reuses `@stateless/inventory`'s bones (uniform core + open
`facets`, declarative `apply` → one resource per id, re-apply = versioned trend)
and adds the one thing a knowledge base needs that an owned-fleet record does
not: a **provenance envelope** on every volatile assertion.

## Why a catalog, not a manager

`@stateless/inventory` records _declared truth you own_ — you own the box, so the
record _is_ the fact. This catalog records _external, decaying, contested_
knowledge ("best vLLM version", "settings that worked on a Spark", "cheapest
provider for GLM"). So two things become first-class:

1. **Provenance is mandatory.** Every claim carries `asOf` + `source`
   (+ `versionPins`, `confidence`, `supersededBy`). A claim with no source is
   worthless here.
2. **The durable ENTITY splits from the volatile CLAIM about it.** A `model`
   entry is stable; what we believe about its best quant this month is not.

**The move:** never store `best = "vllm 0.6.x"` as a bare field — it rots
silently. Store dated, sourced observations; the consumer _derives_ "best" as the
latest un-superseded claim. Re-`apply` records a new version, so the trend reads
back for free.

## The model — one uniform `entry`, six kinds

Five **subjects** + one **join**, all the same shape (`kind` is open; variation
lives in `facets` / `claims` / `relations`):

| `kind`        | what it is                                          | key facets                                                       |
| ------------- | --------------------------------------------------- | ---------------------------------------------------------------- |
| `model`       | the LLM (and ASR/diarization/embed — open modality) | `architecture` (attention, MoE active/total, native ctx, modality) |
| `runtime`     | self-host engine (llama.cpp, vllm, ollama)          | `serving` (flags, sampling)                                      |
| `provider`    | hosted gateway (OpenRouter, Bedrock Mantle, …)      | `api` (apiSpec, endpoint, compatCaveats)                         |
| `hardware`    | accelerator/box **class** (DGX Spark/GB10, …)       | `hardware` (compute, vram/unified-mem, power, clusterable)       |
| `technique`   | KV-compression, quant scheme, speculative decoding  | sourced tradeoff `claims`                                        |
| `access-path` | the **join** answering the operational questions    | `outcome`, `cost`, `serving` (+ `relations` to the subjects)     |

### The `access-path` join (the crown jewel)

One record answers both operational questions, differing only by which subjects
its `relations` point at:

- **Self-host:** `model × runtime × hardware × settings → outcome`
- **Gateway:** `model × provider × apiSpec → outcome`

The **`outcome`** facet is a Pareto vector you optimise over:
`quality · speed · footprint · cost · context · reasoning-overhead`. The
**`quality`** coordinate is where **evaluation** plugs in — task-eval results,
**not** perplexity (PPL is not a quality proxy). **`cost`** is dual-mode: gateway
paths cost per-token; self-host paths cost capex + opex(power).

### The anti-sprawl rule

Every new axis lands in exactly one of three slots — **subject / facet / claim**
— so the subject list stays small (6) while the knowledge stays infinitely
extensible. When a new dimension appears you don't redesign; you ask "subject,
facet, or claim?" and it slots in (the `.catchall` facet map + open vocab make
it a no-op).

## Usage

```bash
swamp model create @stateless/llm-catalog llm-kb
# edit globalArguments.entries, then:
swamp model method run llm-kb apply
```

### Example `globalArguments` (abridged)

```yaml
globalArguments:
  name: llm-kb
  entries:
    - id: hardware-node1-gb10
      kind: hardware
      name: node1 — DGX Spark (GB10)
      summary: Unified-memory inference node; CUDA; clusterable
      relations:
        - { rel: ref, target: "inventory:node1" } # links to @stateless/inventory
      facets:
        hardware: { compute: cuda, unifiedMemGB: 128, powerW: 70, clusterable: true }

    - id: model-qwen35-35b
      kind: model
      name: Qwen3.5-35B-A3B
      summary: MoE; strong agentic (TAU2) scores
      facets:
        architecture:
          attention: hybrid-deltanet # → low KV cache → long context feasible
          params: "35B"
          activeParams: "3B"
          nativeContext: 262144
          modality: [text, image, video]

    - id: ap-qwen35-35b-q8-llamacpp-gb10
      kind: access-path
      name: Qwen3.5-35B-A3B Q8 · llama.cpp @ GB10
      summary: Self-host path; T9 nothink 10/10
      relations:
        - { rel: of-model, target: model-qwen35-35b }
        - { rel: served-by, target: runtime-llamacpp }
        - { rel: runs-on, target: hardware-node1-gb10 }
      facets:
        serving: { flags: { reasoningBudget: 0 }, sampling: { temp: 0.8 } }
        outcome:
          speed: { genTokS: 27 }
          footprint: { vramGB: 48, quant: Q8_0 }
          context: { tokens: 210000 }
          quality: { score: "10/10", eval: "T9 stage2 nothink" }
          provenance:
            asOf: "2026-04-17"
            source: "MODEL corpus REGISTRY.md (historical — re-verify)"
            versionPins: { quant: Q8_0, runtime: "llama.cpp@2026-04-13" }
```

### Querying (CEL)

Materialised `entry` resources are queryable server-side (null-safe via `has()`):

```bash
# all access-paths and their measured throughput
swamp data query 'modelName == "llm-kb" && specName == "entry"' \
  --select '{"id": attributes.id,
             "kind": attributes.kind,
             "tokS": has(attributes.facets) && has(attributes.facets.outcome)
                     && has(attributes.facets.outcome.speed)
                     ? attributes.facets.outcome.speed.genTokS : 0}'

# every model that runs on a given hardware node (via access-path relations)
swamp data query 'modelName == "llm-kb" && specName == "entry"' \
  --select '{"id": attributes.id,
             "onGb10": attributes.relations.exists(r, r.rel == "runs-on" && r.target == "hardware-node1-gb10")}'
```

## Methods

| Method  | Description                                                                                                                       |
| ------- | -------------------------------------------------------------------------------------------------------------------------------- |
| `apply` | Materialise each declared entry as an `entry` resource (one per id). Re-running records a new version, retaining the trend.       |
| `prune` | Soft-retire stored entries no longer declared (records a final version with `status`, default `retired`). No hard delete; idempotent. |

## Privacy & security

- The **extension carries no data** and is publish-safe. A **populated instance**
  mixes public knowledge (changelogs, public benchmarks) with **fleet-private
  empirical results** (your own hardware throughput) — treat a populated catalog
  as private.
- Bulk catalog/pricing is better **referenced or synced** (LiteLLM cost map,
  OpenRouter `/models`, vendor recipe threads) than hand-maintained; a `sync`
  method is a deliberate follow-up, not v1.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
