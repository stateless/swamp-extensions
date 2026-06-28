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

## Publishing (data → public mirror)

The dataset others fetch is the `catalog.json` committed to the
[`stateless/swamp-extensions`](https://github.com/stateless/swamp-extensions)
monorepo under `llm-catalog-data/`. Publishing is **never a raw file copy** — it
goes through the anonymization gate, because the public mirror must carry no
owned/fleet identifiers.

```bash
# 1. Regenerate + GATE. assemble.ts runs the schema/contradiction checks AND the
#    anonymization gate (section 5d) — it REFUSES to write a catalog.json that
#    contains a private/CGNAT IPv4, a *.ts.net host, or any owned identifier on
#    the private denylist. A schema-valid but un-sanitised entry fails HERE, not
#    in review. (The list of owned names lives in a private file — see below — so
#    this script never itself enumerates the fleet.)
deno run --allow-read --allow-write scripts/assemble.ts

# 2. Belt-and-suspenders: the gate above scans catalog ENTRIES; also scan the
#    non-YAML files that ride along (README, artifacts/) against the same private
#    denylist + generic IP/tailnet patterns. Must print nothing.
DENY=../redaction.private/forbidden-identifiers.txt
# private-RANGE IPv4 only (full quad) — 0.0.0.0/public IPs in serve commands are fine
PRIV='\b(10(\.[0-9]{1,3}){3}|192\.168(\.[0-9]{1,3}){2}|172\.(1[6-9]|2[0-9]|3[01])(\.[0-9]{1,3}){2}|100\.(6[4-9]|[7-9][0-9]|1[01][0-9]|12[0-7])(\.[0-9]{1,3}){2})\b'
grep -rEnI -f <(grep -v '^#' "$DENY" | sed '/^$/d') \
  -e "$PRIV" -e '\.ts\.net' \
  README.md artifacts/ && echo "HALT — identifier in publish set" || echo "clean"

# 3. Sync ONLY the public tree into the monorepo clone and push. The private
#    overlay (llm-catalog-data.private/, incl. the denylist) is a SIBLING dir and
#    is never copied.
rsync -a --delete --exclude='.swamp/' \
  ./ /home/swamp/swamp-extensions/llm-catalog-data/
cd /home/swamp/swamp-extensions && git add llm-catalog-data/ \
  && git commit && git push
```

**The private denylist.** Owned hostnames and people are listed in
`redaction.private/forbidden-identifiers.txt` (the private overlay tree,
never published). The full name-gate runs only where that file is present (our
pre-publish build); a community CI checkout without it still enforces the generic
IP/tailnet patterns — correct, since outsiders have no fleet names to leak.

**If the gate halts:** **sanitise the source**, never bypass the gate. Remap an
owned node to its public hardware *class* (e.g. `hardware-dgx-spark`, "a DGX
Spark"), retag a private source as a public/community attribution, and move the
private measurement to the overlay (`--overlay`) — which is gitignored and exempt
from the gate. Private fleet numbers belong in the overlay artifact, never in the
public entry.

## Contributing

**This is the public, community dataset — enrich it by opening a PR to
[`stateless/swamp-extensions`](https://github.com/stateless/swamp-extensions)
under `llm-catalog-data/`.** The model exists; filling it with sourced recipes,
benchmarks, and configs is the ongoing community work.

A contribution is small and self-contained:

1. Edit the right file — a per-model file (`models/<family>/<model>.yaml`) or a
   shared reference file (`endpoints.yaml`, `runtimes.yaml`, `providers.yaml`,
   `hardware.yaml`, `techniques.yaml`). New model → new
   `models/<family>/<model>.yaml`.
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

## Evaluating & testing a model (checklist)

Run this **before** you record a `runsOn[]` operating point — most entries are
worthless or misleading if a setup step was skipped. Each item names the field
or `technique` it feeds.

**Setup correctness (do first — a wrong setup invalidates every number below):**

- [ ] **Chat template preserves prior reasoning blocks.** Many stock templates
      strip thinking each turn, mutating the prompt prefix so the KV-cache
      prefix can't be reused → full recompute every turn (large multi-turn
      regression). Verify before timing anything. → `technique-preserve-thinking-template`
      (e.g. llama.cpp `--chat-template-file`; cf. qwen36 `preserve_thinking`).
- [ ] **Runtime/build is known-good and pinned.** Bad runtime = silently bad
      outputs (e.g. Gemma 4 GGUF on CUDA 13.2). Record the build under
      `outcome.provenance.versionPins` and any `runtime-…`/`endpoint-…` ref.
- [ ] **Sampling = vendor recommendation** before judging quality (temp/top-p/
      top-k/min-p). → model `config.sampling` (family-level) or `runsOn[].command`.
- [ ] **Thinking mode is what you intend** (on/off) and you know **where the
      answer lands** — some runtimes split reasoning into a separate field
      (`reasoning_content` vs `content`). → `config.thinking`.

**Measurement (one `runsOn[]` outcome per quant × endpoint × config):**

- [ ] **Throughput is sustained, not burst.** Measure at thermal steady state —
      laptops heat-soak and drop (e.g. ~25→~13 tok/s). Note the **hardware class**
      (never an owned node). → `outcome.speed` (+ `asOf`, `confidence`).
- [ ] **Context: measured max vs hard cap.** Record the context you actually ran
      and the model's cap separately. If you see gibberish at large KV, try a KV
      quant. → `outcome.context`, `technique-kv-quant-bf16`.
- [ ] **Footprint basis is explicit** — weights-only vs +KV+activations. State
      `basis`; a number without it isn't comparable. → `facets.footprint.basis`.
- [ ] **Quality is task-based, not PPL/published-bench.** Perplexity/KLD is a
      poor proxy for chat/code quality; run your own task evals, especially
      across quants. → `runsOn[].outcome` notes, `technique-gguf-kquant`.

**Recording:**

- [ ] **Every outcome has provenance** (`asOf` + `source`, `confidence` for
      anecdote). Single-source/unreproduced numbers get `confidence: medium` and
      a "not our fleet" note — don't launder anecdote into fact.
- [ ] **Public + generic** — sanitise fleet measurements to a `runsOn` operating
      point (hardware *class*, no hostnames/IPs); the `contribute` method does this.
- [ ] **Gate passes:** `deno run --allow-read --allow-write scripts/assemble.ts`.

## Layout

```
models/        ONE FILE PER MODEL under a family dir — the contribution unit;
  qwen35/        each model carries its run-options in facets.runsOn[]
    qwen3.5-122b.yaml
    qwen3.5-35b.yaml
  minimax/
    minimax-m2.5.yaml
endpoints.yaml ┐ shared reference entities — small, slow, cross-cutting,
runtimes.yaml  │ referenced BY id (runsOn[].endpoint → endpoint-…; endpoints
providers.yaml │ carry served-by: runtime-…, via-provider: provider-…,
hardware.yaml  │ runs-on: hardware-…). Defined once, never duplicated per model.
techniques.yaml┘
artifacts/     vendored reproducibility blobs a recipe depends on (chat
  templates/     templates, configs) — small, text, referenced by relative path
    gemma4-e4b-retain.jinja   from a runsOn[].note/command; upstream URL stays in
                              provenance.source. Vendor when link-rot would break
                              the recipe; metadata still lives in YAML, not here.
scripts/
  assemble.ts  validate + integrity-check + emit catalog.json
catalog.json   generated artifact (do not hand-edit) — what `update` fetches
```

**Placement rule:** a model's run-options live **on the model**, in
`facets.runsOn[]` keyed by an `endpoint` — so everything about running a given
model is one file, one diff. The reusable interface (runtime × hardware, or a
gateway) is an `endpoint` entry in `endpoints.yaml`, referenced by id.

## Variants, fine-tunes, quants, packagers

One rule sorts these: **different weights → a new `model` entry; same weights,
different encoding/packaging → a `runsOn[]` operating point, not a new model.**

| thing | example | where it lives |
| --- | --- | --- |
| **variant** | Qwen3.5-35B vs 122B | own `model` entry/file, `relations: [{ rel: variant-of, target: <family> }]` |
| **fine-tune** | Nemotron Cascade-2 ← Nano-30B base | own `model` entry, `{ rel: finetune-of, target: <base> }` |
| **quant / config** | Q4_K_M, FP8, a tuned recipe | a `facets.runsOn[]` entry (`quant`, `units`, `techniques`, `config`, `outcome`) keyed by `endpoint` |
| **packager** | Unsloth, bartowski | `runsOn[].download` (`hfRepo` + `packager`); the quant *scheme* is a `technique` via `techniques: [technique-…]` |

**Architecture is quant-independent** — Q4 and FP16 of a model share the same
layers/experts/context. So a `model` entry has **one** authoritative architecture
(verified against the **original** vendor repo's `config.json`, never a
GGUF/quant repo), and the **same model carries many `runsOn[]` operating points**
(one per quant × endpoint × config), each self-contained with its own `outcome`.
The quant quality tradeoff is a comparison *across a model's runsOn entries*,
never duplicated model entries. Packager quant schemes (e.g. Unsloth Dynamic
`UD-Q*`) live in `techniques.yaml` so recipes can reference and filter by them.

## Schema

The canonical schema is `EntrySchema` in the extension
(`extensions/models/llm-catalog/schemas.ts`) — six `kind`s (model, runtime,
provider, hardware, technique, endpoint) sharing one uniform shape, with an
open `facets` map and a mandatory provenance envelope on claims. See the
extension README and design note `docs/decisions/2026-06-19-0cee6e` for the full
model.
