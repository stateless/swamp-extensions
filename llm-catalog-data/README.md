# llm-catalog-data

The **public, community-curated dataset** for the
[`@stateless/llm-catalog`](../extensions/models/llm-catalog/) swamp extension —
sourced, generic knowledge about LLMs, runtimes, providers, hardware, and the
recipes that join them.

It is deliberately **separate from the extension package** (not listed in the
manifest's `additionalFiles`), so editing data here never bumps the extension
version. Data evolves by **PRs to this repo**; the extension's `update` method
fetches the assembled artifact. Versioning of the *data* is this repo's git
history; versioning of the *code* is the extension's CalVer — decoupled by
design.

## Consuming (the `update` method)

The assembled, validated dataset is published at:

```
https://raw.githubusercontent.com/stateless/swamp-extensions/main/llm-catalog-data/catalog.json
```

Point an `@stateless/llm-catalog` instance at it and pull:

```bash
swamp model method run <instance> update \
  --input '{"catalogUrl":"https://raw.githubusercontent.com/stateless/swamp-extensions/main/llm-catalog-data/catalog.json"}'
```

`update` is additive and never touches your local/private `entry` data; public
entries land in the separate `catalog-entry` resource. (Set `catalogUrl` in the
instance's `globalArguments` to make it the default.)

## Contributing

**This is the public, community dataset — enrich it by opening a PR to
[`stateless/swamp-extensions`](https://github.com/stateless/swamp-extensions)
under `llm-catalog-data/`.** The model exists; filling it with sourced recipes,
benchmarks, and configs is the ongoing community work.

A contribution is small and self-contained:

1. Edit the right file — a model family file (`models/<family>.yaml`) or a shared
   reference file (`runtimes.yaml`, `providers.yaml`, `hardware.yaml`,
   `techniques.yaml`). New family → new `models/<family>.yaml`.
2. Every entry needs `id`, `kind`, `name`, `summary`, `visibility: public`; every
   claim and volatile outcome needs **`provenance` (`asOf` + `source`)** — no
   source, no entry.
3. Keep it **public + generic** (no owned hostnames/IPs; hardware entries are
   *classes* like `hardware-dgx-spark`, never owned nodes). The `@stateless/llm-catalog`
   `contribute` method sanitises a private fleet measurement into this shape for you.
4. Run the gate locally — CI runs the same on your PR:
   ```bash
   deno run --allow-read --allow-write scripts/assemble.ts
   ```
   It validates every entry against the canonical schema and rejects duplicate
   ids, dangling relations, and the contradiction classes (context-cap,
   divergent-repo, variant/family, format↔runtime).

## Layout

```
models/        per-family files — the contribution unit (a family's variants +
  qwen35.yaml    the access-paths/recipes that serve those models)
  glm.yaml
  gemma4.yaml
  deepseek-v4.yaml
runtimes.yaml  ┐ shared reference entities — small, slow, cross-cutting,
providers.yaml │ referenced BY id from the family files (served-by: runtime-…,
hardware.yaml  │ via-provider: provider-…, runs-on: hardware-…). Defined once, never
techniques.yaml┘ duplicated per family.
scripts/
  assemble.ts  validate + integrity-check + emit catalog.json
catalog.json   generated artifact (do not hand-edit) — what `update` fetches
```

**Placement rule:** an `access-path` lives in the file of the **model it
serves** — a "Qwen on Spark" recipe goes in `models/qwen35.yaml`. So everything
about running a given model is one file, one diff.

## Variants, fine-tunes, quants, packagers

One rule sorts these: **different weights → a new `model` entry; same weights,
different encoding/packaging → an `access-path` artifact, not a new model.**

| thing | example | where it lives |
| --- | --- | --- |
| **variant** | Qwen3.5-35B vs 122B | own `model` entry, `relations: [{ rel: variant-of, target: <family> }]` |
| **fine-tune** | Nemotron Cascade-2 ← Nano-30B base | own `model` entry, `{ rel: finetune-of, target: <base> }` |
| **quant** | Q4_K_M, FP8 | `access-path` → `facets.recipe.artifact.quant` |
| **packager** | Unsloth, bartowski, GGML | `access-path` → `facets.recipe.artifact.packager` + `hfRepo`; quant *scheme* is a `technique` referenced via `{ rel: uses-technique, target: technique-… }` |

**Architecture is quant-independent** — Q4 and FP16 of a model share the same
layers/experts/context. So a `model` entry has **one** authoritative architecture
(verified against the **original** vendor repo's `config.json`, never a
GGUF/quant repo), and the **same model spawns many access-paths** (one per
artifact × runtime × hardware), each with its own `outcome`. The quant quality
tradeoff is a comparison *across access-paths of one model*, never duplicated
model entries. Packager quant schemes (e.g. Unsloth Dynamic `UD-Q*`) live in
`techniques.yaml` so recipes can reference and filter by them.

## Schema

The canonical schema is `EntrySchema` in the extension
(`extensions/models/llm-catalog/schemas.ts`) — six `kind`s (model, runtime,
provider, hardware, technique, access-path) sharing one uniform shape, with an
open `facets` map and a mandatory provenance envelope on claims. See the
extension README and design note `docs/decisions/2026-06-19-0cee6e` for the full
model.
