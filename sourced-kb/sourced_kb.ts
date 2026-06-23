/**
 * `@stateless/sourced-kb` — a domain-neutral, sourced, versioned knowledge base.
 *
 * The provenance-aware core generalised out of `@stateless/llm-catalog`: a
 * uniform `entry` record (open `kind` + open `facets` + `claims` + `relations`),
 * a mandatory-in-spirit provenance envelope on every volatile assertion, a
 * public/private overlay, and a declarative lifecycle — `apply` materialises the
 * declared entries (re-running records a new version, so the trend reads back),
 * `update` folds in a public catalog without clobbering local truth, `prune`
 * soft-retires undeclared entries, and `contribute` sanitises selected entries
 * into PR-ready public fragments.
 *
 * It knows NO domain: there are no typed facets and no compute methods. A
 * consuming catalog (LLM-ops, cloud-storage pricing, …) is just an *instance* of
 * this type whose `entries` carry whatever `kind`s and `facets` that domain
 * defines. `llm-catalog` keeps its own typed facets + capacity/plan/sync — this
 * is the shared spine beneath that kind of catalog, not a replacement for it.
 *
 * Read a facet by CEL:
 *   `data.latest("<instance>", "<entry-id>").attributes.facets.pricing`
 *
 * Schemas live in `./schemas.ts` (imported, not re-exported) so this entrypoint
 * exposes only `model` and stays free of slow types.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  ContributeArgsSchema,
  EntrySchema,
  type GlobalArgs,
  GlobalArgsSchema,
  PruneArgsSchema,
  UpdateArgsSchema,
} from "./schemas.ts";
import {
  DEFAULT_PRIVATE_SOURCE,
  sanitiseForContribution,
} from "./contribute.ts";

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

/** Read + parse a catalog.json from an https URL or a local path. */
async function loadCatalog(url: string): Promise<unknown[]> {
  const text = /^https?:\/\//.test(url)
    ? await (async () => {
      const resp = await fetch(url);
      if (!resp.ok) throw new Error(`fetch ${url} failed (${resp.status})`);
      return await resp.text();
    })()
    : await Deno.readTextFile(url);
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (e) {
    throw new Error(
      `catalog at ${url} is not valid JSON: ${
        e instanceof Error ? e.message : e
      }`,
    );
  }
  const entries = Array.isArray(parsed)
    ? parsed
    : (parsed as { entries?: unknown[] }).entries;
  if (!Array.isArray(entries)) {
    throw new Error(
      `catalog at ${url} must be a JSON array or { entries: [...] }`,
    );
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@stateless/sourced-kb` model definition. */
export const model = {
  type: "@stateless/sourced-kb",
  version: "2026.06.23.2",
  // Default report: every instance gets a generic data-table view of its
  // entries (auto-tables, or curated via a `tableViews` tag). Override
  // per-instance with `reports.skip`; domain reports stay opt-in via `require`.
  reports: ["@stateless/table-report"],
  globalArguments: GlobalArgsSchema,
  resources: {
    entry: {
      description:
        "A declared knowledge-base entry — materialised one per id by `apply`. " +
        "Re-running records a new version, so the knowledge trend is retained.",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "catalog-entry": {
      description:
        "A public entry pulled from a shared catalog by `update`. Kept in a " +
        "SEPARATE resource from `entry` so the two writers can't collide: " +
        "`update` only ever writes here (additive), `apply`/`prune` only touch " +
        "`entry`. The merged view is the union; a private `entry` shadows a " +
        "catalog id on collision (local truth wins).",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    contribution: {
      description:
        "A sanitised, public-shaped entry produced by `contribute` — the " +
        "PR-ready fragment destined for a shared catalog repo. Same Entry " +
        "shape; inspect with `swamp data get <instance> <id> --json`.",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    apply: {
      description:
        "Materialise each declared entry as an `entry` resource (one per id). " +
        "Re-running records a new version, so the knowledge trend is retained.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const entries = ctx.globalArgs.entries;
        const handles: DataHandle[] = [];
        const seen = new Set<string>();
        for (const e of entries) {
          if (seen.has(e.id)) {
            ctx.logger.warning(
              "duplicate entry id {id} — the later record overwrites the earlier",
              { id: e.id },
            );
          }
          seen.add(e.id);
          // Re-validate/normalise so defaults (relations/claims/labels: []) apply.
          const record = EntrySchema.parse(e);
          handles.push(await ctx.writeResource("entry", e.id, record));
          ctx.logger.info("recorded {kind} {id}", { kind: e.kind, id: e.id });
        }
        ctx.logger.info("sourced-kb apply: {n} entries recorded", {
          n: entries.length,
        });
        return { dataHandles: handles };
      },
    },
    update: {
      description:
        "Pull the public catalog (assembled catalog.json) from `catalogUrl` and " +
        "materialise each entry into the `catalog-entry` resource — ADDITIVE and " +
        "scoped: it never writes `entry`, so it cannot clobber local/private " +
        "data, and a private `entry` with the same id shadows the public one " +
        "(skipped). The merged read is `entry` ∪ `catalog-entry`.",
      arguments: UpdateArgsSchema,
      execute: async (
        args: { catalogUrl?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const url = args.catalogUrl ?? ctx.globalArgs.catalogUrl;
        if (!url) {
          throw new Error(
            "no catalogUrl — set globalArguments.catalogUrl or pass " +
              "--input catalogUrl=<https-url-or-local-path>",
          );
        }
        ctx.logger.info("loading catalog {url}", { url });
        const entries = await loadCatalog(url);
        const declaredIds = new Set(ctx.globalArgs.entries.map((e) => e.id));
        const handles: DataHandle[] = [];
        let shadowed = 0;
        for (const raw of entries) {
          const record = EntrySchema.parse(raw);
          if (declaredIds.has(record.id)) {
            shadowed++;
            continue; // a local private entry owns this id — don't overwrite
          }
          handles.push(
            await ctx.writeResource("catalog-entry", record.id, record),
          );
        }
        ctx.logger.info(
          "sourced-kb update: {n} public entries pulled ({s} shadowed by local)",
          { n: handles.length, s: shadowed },
        );
        return { dataHandles: handles };
      },
    },
    prune: {
      description:
        "Reconcile: soft-prune stored `entry` resources no longer present in " +
        "the declared `entries` list by recording a final version with `status` " +
        "set (default 'retired'). Preserves the full record + version history " +
        "(the trend) rather than deleting; idempotent (skips already-pruned). " +
        "Re-declaring an entry + `apply` restores it.",
      arguments: PruneArgsSchema,
      execute: async (
        args: { status?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const removedStatus = args.status ?? "retired";
        const declared = new Set(ctx.globalArgs.entries.map((e) => e.id));
        const all = await ctx.dataRepository.findAllForModel(
          ctx.modelType,
          ctx.modelId,
        );
        // Unique materialised entry instance names (specName lives in tags).
        const storedNames = new Set(
          all.filter((d) => d.tags?.specName === "entry").map((d) => d.name),
        );
        const handles: DataHandle[] = [];
        for (const name of storedNames) {
          if (declared.has(name)) continue; // still declared — apply owns it
          const record = await ctx.readResource(name);
          if (!record) continue;
          if (record.status === removedStatus) continue; // already pruned (idempotent)
          const updated = EntrySchema.parse({
            ...record,
            status: removedStatus,
          });
          handles.push(await ctx.writeResource("entry", name, updated));
          ctx.logger.info("pruned {id}: status → {status}", {
            id: name,
            status: removedStatus,
          });
        }
        ctx.logger.info("sourced-kb prune: {n} entry(s) marked {status}", {
          n: handles.length,
          status: removedStatus,
        });
        return { dataHandles: handles };
      },
    },
    contribute: {
      description:
        "Sanitise selected declared entries into generic, public-shaped " +
        "`contribution` resources (mark public, retag private/local sources via " +
        "`attribution`) and schema-validate them. Refuses an entry whose source " +
        "is flagged private when no `attribution` is given — the publish gate. " +
        "The output is the PR-ready fragment for a shared catalog repo.",
      arguments: ContributeArgsSchema,
      execute: async (
        args: {
          ids: string[];
          attribution?: string;
          privateSourcePattern?: string;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const declared = ctx.globalArgs.entries;
        const byId = new Map(declared.map((e) => [e.id, e]));
        const privateRe = args.privateSourcePattern
          ? new RegExp(args.privateSourcePattern, "i")
          : DEFAULT_PRIVATE_SOURCE;
        const handles: DataHandle[] = [];
        for (const id of args.ids) {
          const entry = byId.get(id);
          if (!entry) throw new Error(`unknown entry id "${id}"`);
          const { entry: san, actions, needsAttribution } =
            sanitiseForContribution(entry, privateRe, args.attribution);
          if (needsAttribution.length) {
            throw new Error(
              `"${id}" carries private source(s) [${
                needsAttribution.join(", ")
              }] — pass attribution=... to contribute it (refusing to leak).`,
            );
          }
          const record = EntrySchema.parse(san);
          handles.push(
            await ctx.writeResource("contribution", record.id, record),
          );
          ctx.logger.info("contribution {id}: {actions}", {
            id: record.id,
            actions: actions.join("; ") || "(no transforms needed)",
          });
        }
        ctx.logger.info("sourced-kb contribute: {n} contribution(s) ready", {
          n: handles.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
