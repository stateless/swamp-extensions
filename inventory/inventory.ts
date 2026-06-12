/**
 * `@stateless/inventory` — a neutral, extensible fleet inventory record.
 *
 * The foundational "what exists and its declared attributes" model. It is the
 * structured, queryable projection of the fleet — **not** a transport, an
 * access layer, or a telemetry store. Consumer abstractions (telemetry,
 * management, config-drift, capacity) are *separate models* that depend on this
 * one, reading a device's facets by CEL:
 *   `data.latest("<inventory-instance>", "<device-id>").attributes.facets.access`
 *
 * **Declarative, not live:** the device list lives in the model's git-tracked
 * `globalArguments.devices`; `apply` materialises one `device` resource per id.
 * Source of truth is the *declared* record — no host need be reachable to
 * record it. (A later `verify` method can diff declared vs probed.)
 *
 * **Reconciliation is a soft status change, not deletion.** `prune` retires
 * stored devices that have dropped out of the declared list by recording a final
 * version with `status: removed` — the record and its version history (the
 * lifecycle trend) survive. There is intentionally no hard delete: inventory
 * remembers what *was*.
 *
 * **Uniform core, variable depth.** An atomic smart plug and a multi-part server
 * are both first-class items validating against the *same* schema. What they
 * share is the core (`id` + `purpose`); their difference in complexity lives in
 * `components` (empty for the plug, rich for the server) and `facets` — never in
 * a different shape.
 *
 * **Extensible in two axes, both deliberate:**
 *   1. *Data* — `facets` is an open map (`.catchall`), and `components` /
 *      `relations` carry open vocabularies, so a new facet (telemetry source,
 *      firmware, warranty…) or field needs **no core edit**.
 *   2. *Behaviour* — new consumers are separate dependent models; swamp's
 *      `export const extension` can also graft methods onto this type later.
 *
 * **Privacy & security (publish-time):** the *extension* (this schema + method)
 * carries no fleet data and is publish-safe. A *populated instance* is a recon
 * map (topology + access paths) and must stay private. Credentials are never
 * embedded — `access.ref` holds only a `${{ vault.get(...) }}` reference and is
 * marked sensitive so swamp redacts it. Published examples use neutral
 * placeholders, never real names/IPs.
 *
 * Schemas live in `./schemas.ts` (imported, not re-exported) so this entrypoint
 * exposes only `model` and stays free of slow types.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  DeviceSchema,
  type GlobalArgs,
  GlobalArgsSchema,
  PruneArgsSchema,
} from "./schemas.ts";

// ---------------------------------------------------------------------------
// Minimal structural typings for the method context (declared locally, never
// imported — the convention every swamp extension follows).
// ---------------------------------------------------------------------------

interface DataHandle {
  name: string;
  specName: string;
  kind: string;
  dataId: string;
  version: number;
}

/** Stored-data metadata as returned by `dataRepository.findAllForModel`. */
interface StoredData {
  name: string;
  version: number;
  tags?: { specName?: string };
}

interface MethodContext {
  globalArgs: GlobalArgs;
  modelType: string;
  modelId: string;
  writeResource: (
    specName: string,
    instanceName: string,
    data: unknown,
  ) => Promise<DataHandle>;
  readResource: (
    instanceName: string,
    version?: number,
  ) => Promise<Record<string, unknown> | null>;
  dataRepository: {
    findAllForModel: (type: string, modelId: string) => Promise<StoredData[]>;
  };
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@stateless/inventory` model definition. */
export const model = {
  type: "@stateless/inventory",
  version: "2026.06.09.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    device: {
      description:
        "A declared inventory item (host, switch, ups, smartplug, …), " +
        "materialised one per device id.",
      schema: DeviceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    apply: {
      description:
        "Materialise each declared device as a `device` resource (one per id). " +
        "Re-running records a new version, so record history is retained.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const devices = ctx.globalArgs.devices;
        const handles: DataHandle[] = [];
        const seen = new Set<string>();
        for (const d of devices) {
          if (seen.has(d.id)) {
            ctx.logger.warning(
              "duplicate device id {id} — the later record overwrites the earlier",
              { id: d.id },
            );
          }
          seen.add(d.id);
          // Re-validate/normalise so defaults (components/relations: []) are applied.
          const record = DeviceSchema.parse(d);
          handles.push(await ctx.writeResource("device", d.id, record));
          ctx.logger.info("recorded {kind} {id}", { kind: d.kind, id: d.id });
        }
        ctx.logger.info("inventory apply: {n} devices recorded", {
          n: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    prune: {
      description:
        "Reconcile: soft-prune stored `device` resources no longer present in " +
        "the declared `devices` list by recording a final version with `status` " +
        "set (default 'removed'). Preserves the full record + version history " +
        "(the trend) rather than deleting; idempotent (skips already-pruned). " +
        "Re-declaring a device + `apply` restores it.",
      arguments: PruneArgsSchema,
      execute: async (
        args: { status?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const removedStatus = args.status ?? "removed";
        const declared = new Set(ctx.globalArgs.devices.map((d) => d.id));
        const all = await ctx.dataRepository.findAllForModel(
          ctx.modelType,
          ctx.modelId,
        );
        // Unique materialised device instance names (specName lives in tags).
        const storedNames = new Set(
          all.filter((d) => d.tags?.specName === "device").map((d) => d.name),
        );
        const handles: DataHandle[] = [];
        for (const name of storedNames) {
          if (declared.has(name)) continue; // still declared — apply owns it
          // readResource returns the latest version's record.
          const record = await ctx.readResource(name);
          if (!record) continue;
          if (record.status === removedStatus) continue; // already pruned (idempotent)
          const updated = DeviceSchema.parse({
            ...record,
            status: removedStatus,
          });
          handles.push(await ctx.writeResource("device", name, updated));
          ctx.logger.info("pruned {id}: status → {status}", {
            id: name,
            status: removedStatus,
          });
        }
        ctx.logger.info("inventory prune: {n} device(s) marked {status}", {
          n: handles.length,
          status: removedStatus,
        });
        return { dataHandles: handles };
      },
    },
  },
};
