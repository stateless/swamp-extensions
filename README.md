# swamp-extensions

Public source for the `@stateless/*` [swamp](https://github.com/swamp-club/swamp)
extensions. Distribution is via the swamp registry — install with
`swamp extension pull @stateless/<name>`; this repo is the readable source and
issue tracker.

Maintained by **[stateless](https://swamp-club.com/u/stateless)** — see the
[swamp profile](https://swamp-club.com/u/stateless) for all published extensions.

## Extensions

| Extension | Source | Registry | What it does |
| --- | --- | --- | --- |
| `@stateless/inventory` | [`inventory/`](inventory/) | [registry](https://swamp-club.com/extensions/@stateless/inventory) | Foundational fleet inventory record — uniform core + extensible facets. |
| `@stateless/proxmox` | [`proxmox/`](proxmox/) | [registry](https://swamp-club.com/extensions/@stateless/proxmox) | Transport-neutral Proxmox VE lifecycle (QEMU/LXC) over REST or `pvesh`-over-SSH. |
| `@stateless/syscheck` | [`syscheck/`](syscheck/) | [registry](https://swamp-club.com/extensions/@stateless/syscheck) | Fleet node verification — tagged checks (category × cadence × scope) contributed by domains via a `CheckProvider` contract. |

Each extension's directory holds its `manifest.yaml`, source, `README.md`, and
`LICENSE.txt`. The registry bundle is authoritative; this monorepo mirrors the
clean, publish-safe source.
