# @stateless/sourced-kb

A **domain-neutral, sourced, versioned knowledge base / catalogue** for swamp —
the provenance-aware core generalised out of
[`@stateless/llm-catalog`](../llm-catalog/). Use it whenever you need to
consolidate **external, decaying, contested knowledge** (pricing, vendor specs,
benchmark results, compatibility notes) in a way that stays honest as the facts
rot.

It is the shared spine *beneath* a domain **catalogue**, not a replacement for
one. `llm-catalog` keeps its typed facets (architecture/outcome/cost) and compute
methods (capacity/plan/sync); this extension keeps only what is true of *any*
sourced KB — so a new catalogue is an *instance*, not a fork.

## Use cases

`sourced-kb` is the substrate for any **catalogue of external, decaying
knowledge** — anywhere you'd otherwise let facts rot in a spreadsheet or a stale
wiki. A consuming catalogue is just an *instance* of this type whose entries
carry that domain's `kind`s and `facets`:

- **LLM-ops catalogue** — models, runtimes, providers, hardware, endpoints + their
  measured cost/throughput (the original [`@stateless/llm-catalog`](../llm-catalog/),
  built on this pattern).
- **Cloud / storage pricing** — providers × offerings × $/unit, egress, minimums,
  region; prices churn weekly, so every figure carries `asOf` + `source`.
- **Vendor / product spec sheets** — hardware, SaaS tiers, API limits — vendor
  facts that drift between releases.
- **Benchmark results** — scores keyed to a versioned harness + dataset, never a
  bare number.
- **Compatibility / support matrices** — "X works on Y as of version Z", with the
  pin that makes it true.
- **Advisories** — CVEs, deprecations, EOL dates — dated, sourced, supersedable.

The common thread: **external, contested, time-sensitive knowledge that needs
provenance to stay honest**, plus a **public/private overlay** so owned/measured
facts stay local while generic ones can be contributed upstream.

## The model

One uniform `entry` record — the same shape for every subject `kind`, exactly
like [`@stateless/inventory`](../inventory/)'s single Device. The variation lives
in open `facets`, `claims`, and `relations`, never in a different shape:

```yaml
id: offering-b2                 # stable lowercase slug; the resource key + relation target
kind: offering                  # open vocabulary the consuming catalog defines
name: Backblaze B2
summary: Flat per-TB hot object storage.
visibility: public              # public → eligible to contribute; private → local-only (fail-safe default)
labels: [object-storage, s3-compat]
relations:                      # structural joins + evaluative edges, by id
  - { rel: offered-by, target: provider-backblaze }
claims:                         # dated, sourced assertions — the volatile layer
  - kind: caveat
    body: Egress free up to 3× stored, then $0.01/GB.
    provenance: { asOf: 2026-06-23, source: "https://www.backblaze.com/cloud-storage/pricing" }
facets:                         # open, domain-defined dimensions
  pricing:
    currency: USD
    perTBMonth: 6.95
    minimumTB: 1
    provenance: { asOf: 2026-06-23, source: "https://www.backblaze.com/cloud-storage/pricing" }
```

### The provenance envelope

The one thing this adds over inventory: every **volatile** assertion carries a
`provenance` block — `asOf` (when), `source` (where), optional `confidence`,
`versionPins` (the snapshot it's valid for — region, currency, sku…), and
`supersededBy`. A value without a date + source is not trustworthy here, so
"current price" is *derived* as the latest un-superseded claim, never a bare
field that rots silently. The durable **entity** (an entry) is split from the
volatile **claim** about it.

## Lifecycle (declarative)

| Method       | What it does                                                                                                   |
| ------------ | ------------------------------------------------------------------------------------------------------------- |
| `apply`      | Materialise each declared `entries[]` item as an `entry` resource (one per id). Re-run = new version = trend.  |
| `update`     | Pull a public catalog.json from `catalogUrl` into the **separate** `catalog-entry` resource (additive; a local `entry` shadows a public id). |
| `prune`      | Soft-retire stored entries no longer declared (records a final version with `status`, default `retired`). Idempotent. |
| `contribute` | Sanitise selected entries into PR-ready public `contribution` fragments — marks public, retags private sources to an `attribution`, and **refuses** to leak an un-attributed private source. |

The merged read is `entry ∪ catalog-entry`; local truth wins on id collision.

## Usage

```bash
# A consuming catalog is just an instance of this type.
swamp model @stateless/sourced-kb create cloud-backup-pricing \
  --global-arg name=cloud-backup-pricing

# Declare entries in the model YAML's globalArguments.entries, then:
swamp model method run cloud-backup-pricing apply

# Query a facet by CEL (the read-optimised path):
swamp data query 'modelName == "cloud-backup-pricing" && specName == "entry"' \
  --select '{ "id": id, "perTBMonth": attributes.facets.pricing.perTBMonth }'

# Pull a shared public dataset alongside local entries:
swamp model method run cloud-backup-pricing update --input catalogUrl=https://…/catalog.json

# Prepare local entries for a public PR:
swamp model method run cloud-backup-pricing contribute \
  --input ids:json='["offering-b2"]' --input attribution="community (your-handle)"
```

## Resources

- `entry` — the declared knowledge base (written by `apply`/`prune`).
- `catalog-entry` — public entries pulled by `update` (kept separate so the two
  writers never collide).
- `contribution` — sanitised public fragments produced by `contribute`.

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
