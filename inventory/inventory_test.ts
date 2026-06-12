/**
 * Unit tests for `@stateless/inventory` schemas — the validation surface that
 * guarantees a uniform core across granularities and straightforward facet
 * extension. Examples use neutral placeholders only.
 *
 * @module
 */

import { assert, assertEquals, assertThrows } from "jsr:@std/assert";
import {
  DeviceSchema,
  FacetsSchema,
  GlobalArgsSchema,
  PruneArgsSchema,
} from "./schemas.ts";

Deno.test("core-only atomic item parses; component/relation default to []", () => {
  const plug = DeviceSchema.parse({
    id: "plug-1",
    name: "Smart plug",
    kind: "smartplug",
    purpose: "Meter a workstation's power draw",
  });
  assertEquals(plug.components, []);
  assertEquals(plug.relations, []);
  assertEquals(plug.facets, undefined);
});

Deno.test("composite system carries rich components + relations", () => {
  const host = DeviceSchema.parse({
    id: "host-1",
    name: "Compute host",
    kind: "host",
    purpose: "Virtualisation node",
    components: [
      { type: "cpu", spec: "N-core CPU" },
      { type: "ram", spec: "RAM", qty: 2 },
      { type: "disk", spec: "NVMe SSD", ref: "disk-host-1-nvme0" },
    ],
    relations: [
      { rel: "fedBy", target: "ups-1" },
      { rel: "hosts", target: "guest-1" },
    ],
  });
  assertEquals(host.components.length, 3);
  assertEquals(host.components[2].ref, "disk-host-1-nvme0");
  assertEquals(host.relations[0], { rel: "fedBy", target: "ups-1" });
});

Deno.test("full facets parse; access ref is preserved (redaction is swamp's job)", () => {
  const dev = DeviceSchema.parse({
    id: "switch-1",
    name: "Core switch",
    kind: "switch",
    purpose: "PoE access switch",
    relations: [{ rel: "fedBy", target: "ups-1" }],
    facets: {
      access: {
        methods: [
          { kind: "routeros-cli", target: "host-1.example" },
          { kind: "snmp", ref: "${{ vault.get('net', 'snmp_community') }}" },
        ],
      },
      power: { ratedW: 22, drawEstW: 35 },
      network: { addresses: [{ kind: "ipv4", value: "203.0.113.2" }] },
      management: { actions: ["poe-toggle", "reboot"] },
      config: { vlanMode: "trunk" },
    },
  });
  assertEquals(dev.facets?.power?.drawEstW, 35);
  assertEquals(dev.facets?.access?.methods.length, 2);
  assert(dev.facets?.access?.methods[1].ref?.includes("vault.get"));
});

Deno.test("unknown facet passes through (the extension seam)", () => {
  const facets = FacetsSchema.parse({
    power: { ratedW: 900 },
    // a facet that does not yet have a typed schema (e.g. a future consumer):
    changelog: [{ at: "2026-01-01", change: "commissioned" }],
  });
  // Known facet typed:
  assertEquals(facets.power?.ratedW, 900);
  // Unknown facet retained verbatim:
  const log = (facets as Record<string, unknown>).changelog as Array<
    Record<string, unknown>
  >;
  assertEquals(log[0].change, "commissioned");
});

Deno.test("firmware facet: os/bios/bmc + open component, vendor+product required", () => {
  const facets = FacetsSchema.parse({
    firmware: {
      os: { vendor: "Proxmox", product: "Proxmox VE", version: "8.4" },
      bios: {
        vendor: "Supermicro",
        product: "H13SAE-MF",
        version: "2.6",
        releaseDate: "2026-01-21",
      },
      // open component beyond os/bios/bmc — still validated as a firmware entry:
      cpld: { vendor: "Lattice", product: "MachXO" },
    },
  });
  assertEquals(facets.firmware?.os?.version, "8.4");
  assertEquals(facets.firmware?.bios?.releaseDate, "2026-01-21");
  // vendor + product are required (so a checker can resolve the upstream feed):
  assertThrows(() =>
    FacetsSchema.parse({ firmware: { os: { product: "RouterOS" } } })
  );
  // an open firmware component must also be a full entry, not a bare string:
  assertThrows(() => FacetsSchema.parse({ firmware: { routeros: "7.22" } }));
});

Deno.test("interfaces facet: NIC list with mac + physical uplink", () => {
  const facets = FacetsSchema.parse({
    interfaces: [
      {
        name: "eno1",
        mac: "00:11:22:33:44:55",
        speed: "1GbE",
        role: "LAN1 → bridge0",
      },
      {
        name: "nic",
        mac: "00:aa:bb:cc:dd:ee",
        uplink: { device: "switch-1", port: 47 },
      },
    ],
  });
  assertEquals(facets.interfaces?.length, 2);
  assertEquals(facets.interfaces?.[1].uplink?.device, "switch-1");
  assertEquals(facets.interfaces?.[1].uplink?.port, 47);
  // name is required on each interface:
  assertThrows(() =>
    FacetsSchema.parse({ interfaces: [{ mac: "00:11:22:33:44:55" }] })
  );
});

Deno.test("open vocabularies: novel kind and relation are accepted", () => {
  const dev = DeviceSchema.parse({
    id: "pdu-1",
    name: "Rack PDU",
    kind: "pdu", // not in the documented list — still fine
    purpose: "Metered rack power distribution",
    relations: [{ rel: "powers", target: "host-1" }], // novel rel verb
  });
  assertEquals(dev.kind, "pdu");
  assertEquals(dev.relations[0].rel, "powers");
});

Deno.test("invalid id slug is rejected", () => {
  assertThrows(() =>
    DeviceSchema.parse({
      id: "Plug One", // spaces + uppercase
      name: "x",
      kind: "smartplug",
      purpose: "y",
    })
  );
});

Deno.test("missing required core field (purpose) is rejected", () => {
  assertThrows(() =>
    DeviceSchema.parse({
      id: "ups-1",
      name: "UPS",
      kind: "ups",
      // purpose omitted
    })
  );
});

Deno.test("prune args: status defaults to 'removed' and accepts overrides", () => {
  assertEquals(PruneArgsSchema.parse({}).status, "removed");
  assertEquals(PruneArgsSchema.parse({ status: "retired" }).status, "retired");
});

Deno.test("global args: devices default to [] and accept a fleet", () => {
  assertEquals(GlobalArgsSchema.parse({ name: "fleet" }).devices, []);
  const parsed = GlobalArgsSchema.parse({
    name: "fleet",
    devices: [
      { id: "ups-1", name: "UPS", kind: "ups", purpose: "ride-through" },
      { id: "host-1", name: "Host", kind: "host", purpose: "compute" },
    ],
  });
  assertEquals(parsed.devices.length, 2);
});
