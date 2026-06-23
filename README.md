# swamp-extensions

Public source for the `@stateless/*` [swamp](https://github.com/swamp-club/swamp)
extensions. Distribution is via the swamp registry — install with
`swamp extension pull @stateless/<name>`; this repo is the readable source and
issue tracker.

Maintained by **[stateless](https://swamp-club.com/u/stateless)** — see the
[swamp profile](https://swamp-club.com/u/stateless) for all published extensions.

## Extensions

| Extension | Version | Source | Registry | What it does |
| --- | --- | --- | --- | --- |
| `@stateless/inventory` | `2026.06.12.1` | [`inventory/`](inventory/) | [registry](https://swamp-club.com/extensions/@stateless/inventory) | Foundational fleet inventory record — uniform core + extensible facets. |
| `@stateless/llm-catalog` | `2026.06.23.1` | [`llm-catalog/`](llm-catalog/) | [registry](https://swamp-club.com/extensions/@stateless/llm-catalog) | Sourced, versioned knowledge base of LLM-ops knowledge (models, runtimes, providers, hardware, techniques + access-path recipes) — read to decide which model to run where, at what cost. |
| `@stateless/proxmox` | `2026.06.12.1` | [`proxmox/`](proxmox/) | [registry](https://swamp-club.com/extensions/@stateless/proxmox) | Transport-neutral Proxmox VE lifecycle (QEMU/LXC) over REST or `pvesh`-over-SSH. |
| `@stateless/review` | `2026.06.17.2` | [`review/`](review/) | [registry](https://swamp-club.com/extensions/@stateless/review) | Human-in-the-loop review canvas — curation grids, markdown editor+preview doc review, approve/revise/reject publish gates. |
| `@stateless/sourced-kb` | `2026.06.23.1` | [`sourced-kb/`](sourced-kb/) | [registry](https://swamp-club.com/extensions/@stateless/sourced-kb) | Domain-neutral, sourced, versioned catalogue/KB core — provenance-aware uniform record (`asOf` + `source` on every volatile claim) + `apply`/`update`/`prune`/`contribute` lifecycle with a public/private overlay; the spine beneath `llm-catalog` and any catalogue of decaying external knowledge (pricing, specs, benchmarks, compat, advisories). |
| `@stateless/syscheck` | `2026.06.12.2` | [`syscheck/`](syscheck/) | [registry](https://swamp-club.com/extensions/@stateless/syscheck) | Fleet node verification — tagged checks (category × cadence × scope) contributed by domains via a `CheckProvider` contract. |
| `@stateless/table-report` | `2026.06.23.1` | [`table-report/`](table-report/) | [registry](https://swamp-club.com/extensions/@stateless/table-report) | Generic dataview-style data-table report — render any model's resource data as markdown tables via a `tableViews` tag (curated columns/filter/sort) or zero-config auto-tables. The view half of swamp's query→render pair. |

Each extension's directory holds its `manifest.yaml`, source, `README.md`, and
`LICENSE.txt`. The registry bundle is authoritative; this monorepo mirrors the
clean, publish-safe source.
