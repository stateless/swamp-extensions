# swamp-extensions

Public source for the `@stateless/*` [swamp](https://github.com/swamp-club/swamp)
extensions. Distribution is via the swamp registry — install with
`swamp extension pull @stateless/<name>`; this repo is the readable source and
issue tracker.

## Extensions

| Extension | Dir | What it does |
| --- | --- | --- |
| `@stateless/inventory` | [`inventory/`](inventory/) | Foundational fleet inventory record — uniform core + extensible facets. |
| `@stateless/proxmox` | [`proxmox/`](proxmox/) | Transport-neutral Proxmox VE lifecycle (QEMU/LXC) over REST or `pvesh`-over-SSH. |
| `@stateless/syscheck` | [`syscheck/`](syscheck/) | Fleet node verification — tagged checks (category × cadence × scope) contributed by domains via a `CheckProvider` contract. |

Each extension's directory holds its `manifest.yaml`, source, `README.md`, and
`LICENSE.txt`. The registry bundle is authoritative; this monorepo mirrors the
clean, publish-safe source.
