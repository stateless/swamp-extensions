/**
 * Zod schemas + inferred types for `@stateless/inventory`.
 *
 * Kept in a separate module (imported by `inventory.ts`, never re-exported from
 * it) so the model's published entrypoint exposes only `model` — which keeps the
 * public API free of "slow types" (Zod's inferred schema/`z.infer` types).
 * Tests import the schemas directly from here.
 *
 * @module
 */

import { z } from "npm:zod@4";

// ---------------------------------------------------------------------------
// Components — a device's moving parts. Open vocabulary + passthrough so a part
// can carry extra detail, or be promoted to a first-class item later via `ref`.
// ---------------------------------------------------------------------------

/** One physical/logical part of a device (cpu, ram, disk, psu, nic, gpu, …). */
export const ComponentSchema = z.object({
  type: z.string().min(1).describe(
    "Component class — cpu | ram | disk | psu | nic | gpu | … (open).",
  ),
  spec: z.string().min(1).describe(
    "Free-form spec, e.g. 'N-core CPU', 'RAM', or 'NVMe SSD'.",
  ),
  qty: z.number().int().positive().optional().describe(
    "Count, when the same part repeats (e.g. multiple identical DIMMs).",
  ),
  ref: z.string().min(1).optional().describe(
    "Device id, when this part is promoted to its own first-class item " +
      "(e.g. a disk tracked for warranty/SMART).",
  ),
}).catchall(z.unknown());
export type Component = z.infer<typeof ComponentSchema>;

// ---------------------------------------------------------------------------
// Relations — the item's purpose-in-the-larger-system, as a lightweight graph
// by device id. Consumer-agnostic, so it lives in the core (not a facet).
// ---------------------------------------------------------------------------

/** A directed relationship from this device to another, by id. */
export const RelationSchema = z.object({
  rel: z.string().min(1).describe(
    "Relationship — fedBy | meters | hosts | partOf | uplinkTo | … (open).",
  ),
  target: z.string().min(1).describe("Device id this relation points to."),
}).catchall(z.unknown());
export type Relation = z.infer<typeof RelationSchema>;

// ---------------------------------------------------------------------------
// Facets — layered, optional dimensions. The `.catchall` on the facet map is the
// straightforward-extension seam: add a new facet without touching the core.
// ---------------------------------------------------------------------------

/** One way to reach a device. `ref` is a vault reference, never a literal. */
export const AccessMethodSchema = z.object({
  kind: z.string().min(1).describe(
    "Transport — ssh | routeros-cli | snmp | nut | rest | … (open).",
  ),
  target: z.string().optional().describe(
    "Address/host/endpoint for this method (may be a placeholder if published).",
  ),
  ref: z.string().optional().meta({ sensitive: true }).describe(
    "Credential reference ONLY — supply via `${{ vault.get('<vault>','<key>') }}`. " +
      "Never embed a literal secret.",
  ),
}).catchall(z.unknown());
export type AccessMethod = z.infer<typeof AccessMethodSchema>;

/** How to reach a device (zero or more methods). */
export const AccessFacetSchema = z.object({
  methods: z.array(AccessMethodSchema).default([]),
}).catchall(z.unknown());

/** Power characteristics. *Who feeds it* is a core `relations` fedBy edge. */
export const PowerFacetSchema = z.object({
  ratedW: z.number().nonnegative().optional().describe(
    "Nameplate/rated power in watts.",
  ),
  drawEstW: z.number().nonnegative().optional().describe(
    "Estimated/typical draw in watts (until metered).",
  ),
  psu: z.string().optional().describe("PSU description, if notable."),
}).catchall(z.unknown());

/** A network address/identifier. */
export const NetworkAddressSchema = z.object({
  kind: z.string().min(1).describe(
    "ipv4 | ipv6 | mac | hostname | fqdn | … (open).",
  ),
  value: z.string().min(1),
}).catchall(z.unknown());

/** Network presence. */
export const NetworkFacetSchema = z.object({
  addresses: z.array(NetworkAddressSchema).default([]),
  links: z.array(z.string()).optional().describe(
    "Free-form links (dashboards, docs, BMC, …).",
  ),
}).catchall(z.unknown());

/** Supported management operations (declared capability, not actions run here). */
export const ManagementFacetSchema = z.object({
  actions: z.array(z.string()).default([]).describe(
    "Supported actions — power-cycle | reboot | poe-toggle | … (open).",
  ),
}).catchall(z.unknown());

/**
 * One version-tracked firmware/OS component — the release-currency input.
 * `vendor` + `product` are required so a scheduled checker can resolve the
 * upstream release feed; the rest is what to compare against it.
 */
export const FirmwareEntrySchema = z.object({
  vendor: z.string().min(1).describe(
    "Who ships it — Supermicro | MikroTik | Proxmox | Ubiquiti | Canonical | …",
  ),
  product: z.string().min(1).describe(
    "Product the version applies to — 'Proxmox VE', 'RouterOS', 'H13SAE-MF'.",
  ),
  version: z.string().optional().describe("Running version/build."),
  releaseDate: z.string().optional().describe(
    "When the running version was released (ISO date preferred) — for currency checks.",
  ),
  eol: z.string().optional().describe(
    "End-of-life date/marker for the running version or series.",
  ),
  channel: z.string().optional().describe(
    "Release channel/train, if relevant — stable | LTS | no-subscription | …",
  ),
}).catchall(z.unknown());
export type FirmwareEntry = z.infer<typeof FirmwareEntrySchema>;

/**
 * Version-tracked firmware/OS for a device — the occasional-change tier read by
 * the release-currency consumer. Known slots (os/bios/bmc) are typed; any other
 * component (routeros, uefi, cpld, …) passes through as the same entry shape.
 */
export const FirmwareFacetSchema = z.object({
  os: FirmwareEntrySchema.optional(),
  bios: FirmwareEntrySchema.optional(),
  bmc: FirmwareEntrySchema.optional(),
}).catchall(FirmwareEntrySchema);

/** A network interface + its physical cabling (NIC ↔ mac ↔ switch-port). */
export const InterfaceSchema = z.object({
  name: z.string().min(1).describe(
    "Interface name — eno1 | enp35s0 | wifi | bmc | …",
  ),
  mac: z.string().optional().describe("MAC address."),
  speed: z.string().optional().describe("Link speed, e.g. '1GbE', '10GbE'."),
  role: z.string().optional().describe(
    "What this NIC is for / its bridge or subnet mapping.",
  ),
  spec: z.string().optional().describe("Hardware spec, e.g. 'Intel I210 GbE'."),
  uplink: z.object({
    device: z.string().min(1).describe(
      "Device id this NIC plugs into (e.g. a switch).",
    ),
    port: z.union([z.string(), z.number()]).optional().describe(
      "Port/label on the uplink device.",
    ),
  }).catchall(z.unknown()).optional().describe(
    "Physical cabling — what this NIC connects to.",
  ),
}).catchall(z.unknown());
export type Interface = z.infer<typeof InterfaceSchema>;

/**
 * The facet map. Known facets are typed; unknown facets pass through
 * (`.catchall`) so a new dimension can be layered on with no schema surgery.
 */
export const FacetsSchema = z.object({
  access: AccessFacetSchema.optional(),
  power: PowerFacetSchema.optional(),
  network: NetworkFacetSchema.optional(),
  config: z.record(z.string(), z.unknown()).optional().describe(
    "Declared/desired config (frequent-change tier) — the drift consumer reads this.",
  ),
  management: ManagementFacetSchema.optional(),
  firmware: FirmwareFacetSchema.optional().describe(
    "Version-tracked firmware/OS (os/bios/bmc/…) — the release-currency consumer reads this.",
  ),
  interfaces: z.array(InterfaceSchema).optional().describe(
    "Network interfaces + physical cabling (NIC ↔ mac ↔ switch-port).",
  ),
}).catchall(z.unknown());
export type Facets = z.infer<typeof FacetsSchema>;

// ---------------------------------------------------------------------------
// Device — the record. Stable core + extensible facets. This same schema is the
// materialised resource shape (declared == recorded for v1).
// ---------------------------------------------------------------------------

/** A single inventory item — atomic or composite, all the same shape. */
export const DeviceSchema = z.object({
  id: z.string().regex(
    /^[a-z0-9][a-z0-9-]*$/,
    "id must be a lowercase slug (a-z, 0-9, hyphens)",
  ).describe("Stable slug; the resource key and relation target."),
  name: z.string().min(1).describe("Human-facing name."),
  kind: z.string().min(1).describe(
    "host | switch | router | ups | pdu | smartplug | nas | gpu-host | " +
      "desktop | other (open vocabulary).",
  ),
  purpose: z.string().min(1).describe("Why this item exists — its role."),
  site: z.string().optional().describe(
    "Site/location group (e.g. home, colo).",
  ),
  location: z.string().optional().describe("Finer placement (rack, room)."),
  make: z.string().optional(),
  model: z.string().optional(),
  status: z.string().optional().describe(
    "Lifecycle note — active | in-waiting | retiring | … (open).",
  ),
  components: z.array(ComponentSchema).default([]).describe(
    "Moving parts; empty for atomic items, rich for systems.",
  ),
  relations: z.array(RelationSchema).default([]).describe(
    "This item's place in the larger system (fedBy, meters, hosts, …).",
  ),
  facets: FacetsSchema.optional(),
});
export type Device = z.infer<typeof DeviceSchema>;

// ---------------------------------------------------------------------------
// Global arguments + method arguments
// ---------------------------------------------------------------------------

export const GlobalArgsSchema = z.object({
  name: z.string().min(1).describe("Instance label for this inventory."),
  devices: z.array(DeviceSchema).default([]).describe(
    "The declared fleet — one record per item.",
  ),
});
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Arguments for `prune` — the soft-retire status to apply to undeclared devices. */
export const PruneArgsSchema = z.object({
  status: z.string().min(1).default("removed").describe(
    "Status to set on stored devices no longer in `devices` (soft prune). " +
      "E.g. removed | retired | decommissioned.",
  ),
});
export type PruneArgs = z.infer<typeof PruneArgsSchema>;
