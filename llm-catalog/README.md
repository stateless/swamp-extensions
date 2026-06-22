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

Six **subjects**, all the same shape (`kind` is open; variation lives in
`facets` / `claims` / `relations`):

| `kind`      | what it is                                          | key facets                                                         |
| ----------- | --------------------------------------------------- | ------------------------------------------------------------------ |
| `model`     | the LLM (and ASR/diarization/embed — open modality) | `architecture`, `footprint`, `benchmarks`, **`runsOn[]`** (run-options) |
| `runtime`   | self-host engine (llama.cpp, vllm, ollama)          | `formats` (loadable artifact formats)                              |
| `provider`  | the org behind a gateway/marketplace (OpenRouter, DigitalOcean, Vast) | `api`                              |
| `hardware`  | accelerator/box **class** (DGX Spark/GB10, …)       | `hardware` (compute, unified-mem, driverReserved, memBandwidth, power) |
| `technique` | KV-compression, quant scheme, speculative decoding  | sourced tradeoff `claims`                                          |
| `endpoint`  | an **HTTP inference interface** (vllm-dgx-spark, digitalocean) | `endpoint` (transport, kind), `pricing` (basis), `serves` (rule) |

### Endpoint + `runsOn` (the model-centric core)

The **endpoint** is the reusable interface — a runtime on hardware (`served-by` +
`runs-on`) or a gateway (`via-provider`). It owns what every run shares: the
transport, the **cost basis** (`owned-amortized` · `free` · `per-token` ·
`per-gpu-hour`), and the model **filter** (`serves.rule`: self-host = *fits-hardware*,
computed; gateway = *listed*).

A model's run-options live **on the model**, in **`facets.runsOn[]`**, keyed by
endpoint — so "given this model, how/where do I run it" is answerable in one file.
Each entry is a self-contained operating point:

- **Self-host:** `{ endpoint, quant, units, techniques, config, outcome }` — the
  measured recipe. Performance-determining fields (`quant`, `units`, build
  `versionPins`) are **never** defaulted (two recipes on the same endpoint can
  differ in quant, node-count, and vLLM commit — that's what makes one 52 and
  another 56 tok/s).
- **Gateway:** `{ endpoint, cost }` — the per-model price.

Two tiers: **generic** facts (vendor `benchmarks`, stable `defaults{}` like max
context / tool format) sit on the model; **specific** facts (a recipe's measured
`outcome`, its config eval) sit on the `runsOn` entry.

The **`outcome`** is a Pareto vector you optimise over:
`quality · speed · footprint · cost · context`. **`quality`** is where
**evaluation** plugs in — task-eval, **not** perplexity. `apply` also explodes
every `runsOn[]` into a flat **`operating-point`** resource (one row per config)
— the read-optimised surface to pivot configs by throughput, quant, or eval.

### The anti-sprawl rule

The reusable interface is the `endpoint`; the model only lists what *varies* per
run (or, for self-host, nothing — the fit is *computed* from footprint vs the
endpoint's hardware). So coverage scales with endpoints + measured points, not
models × places. Every new axis still lands in **subject / facet / claim** — ask
which, and the `.catchall` facet map + open vocab slot it in with no redesign.

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

    - id: endpoint-llamacpp
      kind: endpoint
      name: llama.cpp (local GGUF)
      summary: host-agnostic OpenAI-compatible endpoint
      relations:
        - { rel: served-by, target: runtime-llamacpp }
      facets:
        endpoint: { transport: openai-compat, kind: self-host }
        pricing: { basis: owned-amortized }
        serves: { rule: fits-hardware }

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
        benchmarks: { tau2Agentic: 81.2, ifEval: 91.9 } # vendor (generic)
        runsOn: # run-options, keyed by endpoint (the join, embedded)
          - endpoint: endpoint-llamacpp
            quant: Q8_0
            techniques: [technique-gguf-kquant]
            config: { flags: { reasoningBudget: 0 }, sampling: { temp: 0.8 } }
            outcome:
              speed: { genTokS: 27 }
              context: { tokens: 210000 }
              quality: { score: "10/10", eval: "T9 stage2 nothink" } # config-specific
              provenance:
                asOf: "2026-04-17"
                source: "our-fleet-test (re-verify)"
                versionPins: { quant: Q8_0, runtime: "llama.cpp@2026-04-13" }
```

### Querying (CEL)

`apply` materialises one `entry` per declared entry **and** one flat
`operating-point` per run-option — the latter is the pivot surface (denormalised,
so no nested-array filtering):

```bash
# pivot run-options by measured/estimated throughput (perf across configs)
swamp data query 'modelName == "llm-kb" && specName == "operating-point"' \
  --select '{"model": attributes.model, "endpoint": attributes.endpoint,
             "quant": attributes.quant, "tokS": attributes.genTokS}'

# compare a model's quants vs its eval (eval across configs)
swamp data query 'modelName == "llm-kb" && specName == "operating-point"
                  && attributes.model == "model-qwen35-122b"' \
  --select '{"quant": attributes.quant, "tokS": attributes.genTokS,
             "tau2": attributes.benchmarks.tau2Agentic}'
```

## Methods

| Method       | Description                                                                                                  |
| ------------ | ----------------------------------------------------------------------------------------------------------- |
| `apply`      | Materialise each declared entry as an `entry` resource + explode `runsOn[]` into flat `operating-point` rows; re-run = versioned trend. |
| `capacity`   | Resolve a single intent (task + host + profile + policy) into a ranked Pareto set across all models — fit + quality + throughput. |
| `plan`       | Deployment planner over a SET of concurrent workloads — one-shared-model vs split-of-specialists on a Pareto front. |
| `reconcile`  | Gather every run-option for a model — public + private — into one comparison to reason over.                |
| `update`     | Pull the public catalog (`catalogUrl`) into a separate `catalog-entry` resource — additive, never clobbers private `entry` data. |
| `sync`       | Refresh gateway prices from a live feed (default OpenRouter) by matching `providerModelId`.                 |
| `ingest`     | Draft a model entry from a HuggingFace `config.json` — authoritative architecture, gaps flagged.            |
| `contribute` | Sanitise a private fleet entry into a generic, public-shaped `contribution` (refuses un-attributed leaks).  |
| `prune`      | Soft-retire stored entries no longer declared (status change, no hard delete; idempotent).                  |

## Public dataset & contributing

The model **definitions, recipes, and benchmarks** are a **separate public
dataset**, not bundled in this extension (so data changes never bump the
extension version). It lives at
[`stateless/swamp-extensions` -> `llm-catalog-data/`](https://github.com/stateless/swamp-extensions/tree/main/llm-catalog-data)
and is pulled with `update`:

```bash
swamp model method run <instance> update \
  --input '{"catalogUrl":"https://raw.githubusercontent.com/stateless/swamp-extensions/main/llm-catalog-data/catalog.json"}'
```

**Contributions welcome** — open a PR to `llm-catalog-data/` (one file per model
under `models/<family>/`, with run-options embedded in `runsOn[]` keyed by an
`endpoint`; every claim needs `asOf` + `source`; CI runs `assemble.ts` to validate
schema, ids, references, and contradiction classes). See that directory's README
for the full guide; the `contribute` method turns a private fleet measurement
into a PR-ready, sanitised entry.

## Privacy & security

- The **extension carries no data** and is publish-safe. A **populated instance**
  mixes public knowledge with **fleet-private empirical results** (your own
  hardware throughput) — treat it as private. Public entries pulled by `update`
  stay in a separate `catalog-entry` resource.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
