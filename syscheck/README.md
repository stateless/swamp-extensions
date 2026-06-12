# @stateless/syscheck — fleet node verification

A verification framework for the fleet: a catalog of **tagged checks** run on a
cadence and scored into a per-node **pass / warn / fail** verdict. It sits
*above* the domains — `host`, `proxmox`, future `@stateless/docker` — each of
which **contributes** its checks and facts through one contract. syscheck owns
the framework; domains own their checks.

Design rationale and the full taxonomy live in the project's design notes
(node verification-check taxonomy).

## The model in one screen

- A **check** is a *read-only assertion of state* → `pass`/`warn`/`fail`. It is
  **not** a process; mutations (apt full-upgrade, reboot, install) live in
  workflows. A check's `remediation` just *names* the process. verify → act → verify.
- Every check is **tagged**: `category` (hygiene · fitness · telemetry · drift)
  × `cadence` (daily/weekly/monthly) × `scope` (host · pve · gpu · container · …).
  `scope` is a per-check tag, **not** an extension boundary — that's why one
  framework covers PVE nodes *and* a GPU box *and* a plain VM.
- **Probe once, interpret many.** One probe pass yields facts; many checks of
  different categories read them.

## Pieces

- **`syscheck` workflow** — runs a read-only host probe (inlined in the
  workflow) across the selected hosts over `@swamp/ssh`, then the report
  evaluates the catalog.
  `swamp workflow run @stateless/syscheck [--input hosts=<host>]`.
- **`syscheck.ts` report** (`@stateless/syscheck`, workflow scope) — the catalog
  + the evaluator + the verdict (markdown + JSON; JSON is the gate/diff contract).

## The probe contract (the portable interface)

A check never depends on *how* a fact was gathered — only on the **fact key**.
The probe emits one JSON object per host; checks read keys from it. **That JSON
shape is the portable contract; the probe is a host-specific *adapter*** — ship a
reference one, rewrite it locally for exotic hosts. A conformant probe in any
language works, and a missing key just gates its checks to `na`, never an error
(the reference `host-probe.sh` is self-detecting: absent tool → empty field).

Fact keys the reference probe emits (checks that read them):

| key | type | example | read by |
| --- | --- | --- | --- |
| `os` | string | `Debian GNU/Linux 12` | non-free-firmware |
| `kernel` | string | `6.8.12-9-pve` | reboot-pending |
| `hygiene.cpuVendor` | string | `AuthenticAMD` | cpu-microcode |
| `hygiene.virt` | string | `none` / `kvm` | microcode, non-free (bare-metal gate) |
| `hygiene.microcodePkg` | string | `amd64-microcode 3.x` / `""` | cpu-microcode |
| `hygiene.nonFreeFirmware` | bool | `true` / `false` | non-free-firmware |
| `hygiene.newestKernel` | string | `6.8.12-10-pve` | reboot-pending |
| `proxmox.version` | string | `pve-manager/8.4.1/…` | pve-version-detected |
| `proxmox.storages` | string | `local:active;pbs:inactive;` | pve-storage-active |

A new check adds its key here + to the probe; a new probe just emits these keys.
Each `CheckProvider.requires` is the machine-readable version of this table.

## Contributing checks — the contract every domain implements

A domain plugs in by exporting a **`CheckProvider`** and registering it in
`PROVIDERS`:

```ts
type CheckProvider = {
  domain: string;      // "host" | "proxmox" | "docker" | …
  scope: string;       // the scope tag every check here carries
  description: string;
  requires: string[];  // FACT CONTRACT — the fact keys these checks read, and where they come from
  checks: Check[];     // each tagged: category × cadence × scope, + appliesTo + evaluate
};
```

Three things syscheck asks of a domain:

1. **A scope tag** — what class of node these checks are about (`pve`, `gpu`,
   `container`). syscheck resolves *which machines* a scope applies to from
   `@stateless/inventory` facets.
2. **A fact contract (`requires`)** — the facts the checks read, and their
   source: either the **shared host probe** (`host-probe.sh`) or the **domain's
   own fact-source** (a probe step / model method the domain exposes). A check
   whose facts are absent `appliesTo`-gates to `na` — it never guesses.
3. **Tagged checks** — `appliesTo(facts)` (the live gate) + `evaluate(facts)` →
   `pass/warn/fail` (+ `remediation`).

**To add a check:** append a `Check` to a provider (+ a fact to `host-probe.sh`'s
`hygiene` block if it needs one). **To add a domain:** export a `CheckProvider`
and add it to `PROVIDERS`.

### Worked example — the `host` provider (built)

`domain: "host"`, `scope: "host"`, fact-source `scripts/host-probe.sh`. Checks:
`cpu-microcode` (fitness), `non-free-firmware-repo` (hygiene), `reboot-pending-kernel`
(fitness). Applies to every node; checks self-gate by arch / virt / os-family —
which is why a non-x86 host or a VM come out correctly `na`/`warn`.

### Worked example — the `proxmox` provider (the abstraction syscheck requires from `@stateless/proxmox`)

`domain: "proxmox"`, `scope: "pve"`. This is the template a domain tool follows.
Its **fact contract** names exactly what `@stateless/proxmox` must supply:

| fact key | source | status |
| --- | --- | --- |
| `proxmox.version` | host probe (`pveversion`) | ✅ have → `pve-version-detected` |
| `proxmox.storages` | host probe (`pvesm status`) | ✅ have → **`pve-storage-active`** (warns on an enabled-but-inactive store — e.g. a PBS target timing out) |
| `proxmox.subscriptionActive` | proxmox fact-source — `pvesh /nodes/<n>/subscription` | ⬜ to wire → enables `pve-subscription` |
| `proxmox.enterpriseRepo` | apt sources (host probe) | ⬜ to wire → enables `pve-repo-correct` (enterprise vs no-subscription) |

So "what syscheck needs from proxmox" is concrete: a **node fact-source** that
surfaces those PVE facts (node-local `pvesm`/`pvesh`, or the request builders in
`_lib/proxmox/node.ts`), and the `pve`-scoped check definitions that read them.
Checks stay `na` until their facts are supplied — documented, not stubbed. Two
are wired (`pve-version-detected`, `pve-storage-active`); the subscription/repo
checks await the remaining facts.

### Template for the next tool — `@stateless/docker` (illustrative)

To bring container hosts under the same fitness sweep, `@stateless/docker` would
export a provider exactly like proxmox's:

- `domain: "docker"`, `scope: "container"`.
- **fact-source:** `docker info` / `docker ps --format` / `docker image ls`
  (a docker probe step or model method).
- **fact contract (`requires`):** `docker.serverVersion`, `docker.storageDriver`,
  `docker.containers[].restartPolicy`, `docker.containers[].health`,
  `docker.images[].digestVsRemote`.
- **checks (examples):** `docker-engine-current` (hygiene), `restart-policy-set`
  (fitness), `healthcheck-present` (fitness), `image-up-to-date` (hygiene),
  `storage-driver-overlay2` (fitness).

Same shape, different scope and fact-source. That's the point: syscheck doesn't
know about Docker or Proxmox — it knows about `CheckProvider`s.

## Where results live (not here)

syscheck is **cache/sync, not a data owner.** Per the decision note: the
per-machine **results** belong in `@stateless/inventory` (a health facet) — which
becomes the **diff baseline** (so a newly-added check's first verdict stands out,
and regressions are visible). Applicability is **derived** from inventory facets;
a future *build-your-own-checklist* workflow composes per-machine checklists from
your inventory × the available checks. Check *logic* stays code here; *checklist*
+ *results* are data in inventory.

## Potential checks — the use-case catalog

Candidates to grow into, mined from `pve8to9` + general sysadmin practice. Each
is a **read-only assertion** (the `remediation`/paired **process** stays in a
workflow). Tagged `[scope · category · cadence]`. Implemented ones marked ✅.
`pve8to9` itself stays the comprehensive point-in-time *upgrade* exam; syscheck
is its extracted evergreen subset, run on a cadence.

**Updates / kernel**
- ✅ `cpu-microcode` `[host·fitness·weekly]` · ✅ `non-free-firmware-repo` `[host·hygiene·daily]` · ✅ `reboot-pending-kernel` `[host·fitness·daily]`
- updates available (count) `[host·hygiene·weekly]` ↔ *apt full-upgrade*
- **security** updates pending `[host·hygiene·daily]`
- unattended-upgrades enabled **& last-run recent** `[host·hygiene·daily]` — *verifies the automation itself*
- dpkg not half-configured / no held-broken pkgs `[host·hygiene·weekly]`

**Storage**
- ✅ `pve-storage-active` `[pve·fitness·daily]` (enabled-but-inactive store, e.g. PBS down)
- zpool ONLINE `[host·fitness·daily]` · pool capacity <80% `[host·fitness·daily]` · scrub recent & error-free `[host·fitness·weekly]`
- root//var//boot fill % `[host·fitness·daily]` · inode exhaustion `[host·fitness·weekly]`
- SMART healthy + wearout/reallocated trend `[host·fitness·weekly]` ↔ *replace disk*
- expected mountpoints present `[host·fitness·daily]` (the pve8to9 CT-mount failures)
- snapshot freshness `[host·fitness·daily]` — *already in `@stateless/snapshot-health`*

**Backups**
- last successful backup per guest recent `[pve·fitness·daily]` — *an upgrade-gate freshness check* ↔ *run backup*
- PBS/restic target reachable `[host·fitness·daily]` · retention policy sane `[host·hygiene·monthly]`

**Services / time / certs**
- core daemons active (pveproxy/pvedaemon/pvestatd/pve-cluster) `[pve·fitness·daily]`
- `systemctl --failed` == 0 `[host·fitness·daily]` · sshd reachable `[host·fitness·daily]`
- NTP synced, offset small `[host·fitness·daily]`
- TLS cert expiry (node + any edge/reverse-proxy) `[host·hygiene·weekly]` · cert RSA size `[host·hygiene·monthly]` ↔ *renew*

**Security / config hygiene**
- boot invariant present (a required kernel cmdline flag, e.g. `pcie_aspm`) `[host·fitness·daily]` — *host-verify checks the declared one; this checks live*
- sshd hardening (no root pw-login) `[host·hygiene·weekly]` · firewall enabled `[host·hygiene·weekly]`
- unexpected listening ports `[host·hygiene·weekly]` · auth-failure spike `[host·hygiene·daily]`

**Proxmox** `[pve]`
- pveversion currency `[weekly]` · subscription/repo correct (enterprise vs no-subscription) `[weekly]`
- guest machine-versions current `[monthly]` · running-guest count vs expected `[daily]`

**GPU** `[gpu]`
- nvidia driver loaded/version `[daily]` · ECC/XID errors `[daily]` · temp/throttle `[daily]` · fabric-mgr/persistenced up `[daily]`

**Capacity** (note: continuous metrics are *telemetry* — the separate high-freq plane, not this pass/fail sweep)
- load / mem-pressure / swap `[host·telemetry]` · thermal throttle `[host·telemetry]`

**Automation-health** — "is the *process* doing its job?" (catches silent automation failure)
- unattended-upgrades ran · sanoid ran · backup job ran · cron alive `[host·hygiene·daily]`
