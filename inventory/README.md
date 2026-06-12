# @stateless/inventory

A **neutral, extensible fleet inventory** model for
[swamp](https://github.com/systeminit/swamp) — the foundational record of _what
exists and its declared attributes_.

It is deliberately **not** a transport, an access layer, or a telemetry store.
Consumer abstractions (telemetry, management, config-drift, capacity) are
_separate models_ that depend on this one, reading a device's facets by CEL:

```
data.latest("<inventory-instance>", "<device-id>").attributes.facets.access
```

## Design

**Declarative, not live.** The device list lives in the model's
`globalArguments.devices`; `apply` materialises one `device` resource per id.
The source of truth is the _declared_ record — no host need be reachable to
record it.

**Uniform core, variable depth.** An atomic smart plug and a multi-part server
are both first-class items validating against the _same_ schema. What they share
is the core (`id` + `purpose`); their difference in complexity lives in
`components` (empty for the plug, rich for the server) and `facets` — never in a
different shape.

**Extensible in two axes, both deliberate:**

1. **Data** — `facets` is an open map (`catchall`), and `components` /
   `relations` carry open vocabularies, so a new facet (telemetry source,
   firmware, warranty…) or field needs **no core edit**.
2. **Behaviour** — new consumers are separate dependent models; swamp's
   `export const extension` can also graft methods onto this type later.

### Record shape

| Field                     | Purpose                                                                                                                        |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `id`                      | Stable slug; the resource key and relation target                                                                              |
| `name`, `kind`, `purpose` | Identity (`kind` is an open vocabulary: `host \| switch \| router \| ups \| pdu \| smartplug \| nas \| …`)                     |
| `components[]`            | A device's moving parts (`{ type, spec, qty?, ref? }`) — `ref` promotes a part to its own item                                 |
| `relations[]`             | The item's place in the larger system (`{ rel, target }`: `fedBy \| meters \| hosts \| uplinkTo \| …`)                         |
| `facets`                  | Optional, layered dimensions — `access`, `power`, `network`, `config`, `management`, `firmware`, `interfaces`, plus any custom |

### Facets by rate-of-change

Facets double as the **scoping unit**: a consumer reads only the slice it needs,
so the boundary that decides _"how often does this change / get re-verified"_ is
also the query boundary. Roughly:

| Tier                  | Rate                               | Facets                     |
| --------------------- | ---------------------------------- | -------------------------- |
| identity              | static (verify on physical change) | core fields + `components` |
| firmware / cabling    | occasional (scheduled check)       | `firmware`, `interfaces`   |
| os / network / config | frequent (drift target)            | `config`, `network`        |

- **`firmware`** — version-tracked components (`os`, `bios`, `bmc`, … open) as
  `{ vendor, product, version?, releaseDate?, eol?, channel? }`. `vendor` +
  `product` are required so a scheduled **release-currency** check can resolve
  the upstream feed and flag "update available / behind / EOL".
- **`interfaces`** — network interfaces + physical cabling:
  `{ name, mac?, speed?, role?, spec?, uplink?: { device, port } }`. `uplink`
  ties a NIC to the device/port it plugs into.

## Usage

```bash
swamp model create @stateless/inventory fleet
# edit globalArguments.devices, then:
swamp model method run fleet apply
```

### Example `globalArguments`

```yaml
globalArguments:
  name: fleet
  devices:
    - id: ups-1
      name: Rack UPS
      kind: ups
      purpose: Battery ride-through for the rack
      facets:
        power: { ratedW: 900 }
        access:
          methods:
            - { kind: nut, target: "usb (host)" }

    - id: host-1
      name: Compute host
      kind: host
      purpose: Virtualisation node
      components:
        - { type: cpu, spec: "8c/16t" }
        - { type: ram, spec: "64 GB" }
        - { type: disk, spec: "2 TB NVMe" }
      relations:
        - { rel: fedBy, target: ups-1 }
      facets:
        access:
          methods:
            - { kind: ssh, target: "host-1.example" }
            - { kind: rest, ref: "${{ vault.get('infra', 'api_token') }}" }
        power: { drawEstW: 100 }
        network:
          addresses:
            - { kind: ipv4, value: "203.0.113.10" }
        firmware:
          os: { vendor: Debian, product: Debian, version: "12" }
          bios: {
            vendor: ExampleCorp,
            product: "MB-X1",
            version: "2.6",
            releaseDate: "2026-01-21",
          }
        interfaces:
          - {
              name: eth0,
              mac: "00:00:5e:00:53:01",
              speed: "1GbE",
              uplink: { device: switch-1, port: 12 },
            }

    - id: plug-1
      name: Smart plug
      kind: smartplug
      purpose: Meter host-1's power draw
      relations:
        - { rel: meters, target: host-1 }
```

### Querying (CEL)

The materialised `device` resources are queryable server-side. Use `--select`
with CEL (null-safe via `has()`), which is more robust than projecting
client-side:

```bash
# list
swamp data query 'modelName == "fleet" && specName == "device"' \
  --select '{"id": attributes.id, "kind": attributes.kind}'

# dependency graph — everything fed by a given UPS
swamp data query 'modelName == "fleet" && specName == "device"' \
  --select '{"id": attributes.id,
             "onUps": attributes.relations.exists(r, r.rel == "fedBy" && r.target == "ups-1")}'

# capacity — estimated draw per device
swamp data query 'modelName == "fleet" && specName == "device"' \
  --select '{"id": attributes.id,
             "draw": has(attributes.facets) && has(attributes.facets.power)
                     ? attributes.facets.power.drawEstW : 0}'
```

## Privacy & security

- The **extension carries no fleet data** and is publish-safe. A **populated
  instance** is a recon map (topology + access paths) — treat it as private.
- **Credentials are never embedded.** `access.ref` holds only a
  `${{ vault.get(...) }}` reference and is marked sensitive so swamp redacts it.
- Published examples use neutral placeholders and
  [TEST-NET](https://datatracker.ietf.org/doc/html/rfc5737) addresses, never
  real names or IPs.

## Methods

| Method  | Description                                                                                                                                                                                                                                                                                                                              |
| ------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `apply` | Materialise each declared device as a `device` resource (one per id). Re-running records a new version, so record history (the trend) is retained.                                                                                                                                                                                       |
| `prune` | Reconcile: soft-retire stored devices no longer in `devices` by recording a final version with `status` set (default `removed`, configurable via `--input status=retired`). **No hard delete** — the record + version history survive, so the lifecycle (`active → removed → active` on re-declare) reads back as the trend. Idempotent. |

### Lifecycle

`apply` is additive/idempotent; `prune` is the deliberate reconcile. A device's
arc is recorded as the version history of its `device` resource:

```
apply (declared)        → v1 status: active
apply (re-run)          → v2 status: active
prune (dropped from list) → v3 status: removed
apply (re-declared)     → v4 status: active
```

## License

MIT — see [LICENSE.txt](./LICENSE.txt).
