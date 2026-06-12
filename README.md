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
| `@stateless/proxmox` | `2026.06.12.1` | [`proxmox/`](proxmox/) | [registry](https://swamp-club.com/extensions/@stateless/proxmox) | Transport-neutral Proxmox VE lifecycle (QEMU/LXC) over REST or `pvesh`-over-SSH. |
| `@stateless/review` | `2026.06.12.7` | [`review/`](review/) | [registry](https://swamp-club.com/extensions/@stateless/review) | Human-in-the-loop review canvas — curation grids, markdown editor+preview doc review, approve/revise/reject publish gates. |
| `@stateless/syscheck` | `2026.06.12.2` | [`syscheck/`](syscheck/) | [registry](https://swamp-club.com/extensions/@stateless/syscheck) | Fleet node verification — tagged checks (category × cadence × scope) contributed by domains via a `CheckProvider` contract. |

Each extension's directory holds its `manifest.yaml`, source, `README.md`, and
`LICENSE.txt`. The registry bundle is authoritative; this monorepo mirrors the
clean, publish-safe source.
