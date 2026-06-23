# @stateless/table-report

A **generic data-table report** for any swamp model — render a model's
materialised resource data as markdown tables, *dataview-style*, instead of
hand-writing a bespoke report per model. Point it at any model, get tables.

## Two modes

**Declared views** — put a `tableViews` tag on the model. It's a JSON array of
view specs, and because it lives in the model's free-form `tags` map it works on
**any** model type with no schema change:

```yaml
# in the model definition
tags:
  tableViews: '[{"title":"Offerings by $/TB","spec":"entry","where":{"kind":"offering"},"columns":{"id":"id","$/TB":"facets.pricing.perTBMonth","ccy":"facets.pricing.currency"},"sort":{"by":"facets.pricing.perTBMonth","dir":"asc"},"limit":10}]'
reports:
  require:
    - "@stateless/table-report"
```

renders:

```
### Offerings by $/TB (10)

| id | $/TB | ccy |
| --- | --- | --- |
| offering-hetzner-bx | 1.74 | EUR |
| offering-scaleway-glacier | 2 | EUR |
| …
```

**Auto** — with no `tableViews` tag, the report renders one table per resource
spec with auto-detected scalar columns (`id`/`name`/`kind`/`status`/`visibility`
plus facet leaves). Zero config — useful just to *see* a model's data.

## View spec

| Field     | Meaning                                                              |
| --------- | -------------------------------------------------------------------- |
| `spec`    | Resource spec name to render (e.g. `entry`). **Required.**           |
| `title`   | Table heading (defaults to `spec`).                                  |
| `columns` | `{ label: contentPath }`. Omit for auto-detected columns.           |
| `where`   | Scalar-equality filter, AND across keys: `{ kind: "offering" }`.     |
| `sort`    | `{ by: contentPath, dir: "asc" \| "desc" }`. Missing values sort last. |
| `limit`   | Cap the number of rows.                                             |

## Paths & the CEL relationship

Column and filter paths are **content-relative** — `facets.pricing.perTBMonth`,
`kind`, `id` — i.e. relative to the stored resource content. Note this differs
from `swamp data query --select`, which prefixes `attributes.` (the report reads
the content object directly).

Filtering is **scalar-equality only** — the report sandbox has no CEL evaluator,
so this covers the common select + equality-filter case, not arbitrary CEL
predicates. For richer queries, use `swamp data query '<CEL>' --select '{…}'`;
this report is the *rendered-view* half of that pair.

## Usage

```bash
# Add the tag + require the report on a model (see above), then run any method:
swamp model method run <model> <method>

# Read the rendered tables:
swamp report get @stateless/table-report --model <model> --markdown
```

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
