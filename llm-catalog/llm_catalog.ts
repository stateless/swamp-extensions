/**
 * `@stateless/llm-catalog` — a sourced, versioned knowledge base of LLM-ops
 * knowledge. NOT a control plane for running models: the structured, queryable
 * record that running extensions (a `@keeb/ollama`-class server, an eval
 * producer) READ to decide *which model to run where, with what settings, at
 * what cost*.
 *
 * Six subject kinds — `model`, `runtime`, `provider`, `hardware`, `technique`,
 * and `endpoint` (the HTTP inference interface). A model's run-options live on
 * the model in `facets.runsOn[]` keyed by endpoint, answering both "what settings
 * worked on this hardware" (self-host: model × runtime × hardware × settings) and
 * "cheapest way to reach this model" (gateway: model × provider × price). All are
 * the SAME uniform `entry` shape (open `kind` + open `facets`), mirroring
 * `@stateless/inventory`'s "uniform core, variable depth".
 *
 * **The twist vs inventory.** Inventory records declared truth you own — the
 * record *is* the fact. This records external, decaying, contested knowledge, so
 * provenance is first-class: every volatile assertion is a `claim` (or an
 * evaluative `relation`, or an outcome/cost facet) carrying `asOf` + `source` +
 * `versionPins`. "Best vLLM version" is therefore DERIVED — the latest
 * un-superseded claim — never a bare field that rots silently.
 *
 * **Declarative, not live:** the knowledge lives in `globalArguments.entries`;
 * `apply` materialises one `entry` resource per id (re-running records a new
 * version, so the trend — "we thought X in April, Y in June" — reads back).
 * `prune` soft-retires undeclared entries (status change, not deletion). Read a
 * facet by CEL:
 *   `data.latest("<catalog-instance>", "<entry-id>").attributes.facets.outcome`
 *
 * Schemas live in `./schemas.ts` (imported, not re-exported) so this entrypoint
 * exposes only `model` and stays free of slow types.
 *
 * Design: `docs/decisions/2026-06-19-0cee6e-llm-catalog-knowledge-base.md`.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  CapacityArgsSchema,
  CapacityPlanSchema,
  ContributeArgsSchema,
  DeploymentPlanSchema,
  EntrySchema,
  type GlobalArgs,
  GlobalArgsSchema,
  IngestArgsSchema,
  OperatingPointSchema,
  PlanArgsSchema,
  PricedPathSchema,
  PruneArgsSchema,
  ReconcileArgsSchema,
  ReconciliationSchema,
  SyncArgsSchema,
  UpdateArgsSchema,
} from "./schemas.ts";
import { nodeClassMap, sanitiseForContribution } from "./contribute.ts";
import { type HfConfig, hfConfigUrl, ingestHfConfig } from "./ingest.ts";
import { buildReconciliation } from "./reconcile.ts";
import {
  buildCapacityPlan,
  buildDeploymentPlans,
  buildOperatingPointIndex,
} from "./capacity.ts";
import {
  OPENROUTER_FEED,
  parseOpenRouterFeed,
  refreshGatewayCost,
} from "./sync.ts";

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

/** The `@stateless/llm-catalog` model definition. */
export const model = {
  type: "@stateless/llm-catalog",
  version: "2026.06.22.2",
  globalArguments: GlobalArgsSchema,
  resources: {
    entry: {
      description:
        "A declared catalog entry — a subject (model, runtime, provider, " +
        "hardware, technique, endpoint) — materialised one per id.",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    contribution: {
      description:
        "A sanitised, public-shaped entry produced by `contribute` — the " +
        "PR-ready fragment destined for the shared catalog repo. Same Entry " +
        "shape; inspect with `swamp data get <instance> <id> --json`.",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "catalog-entry": {
      description:
        "A public entry pulled from the shared catalog by `update`. Kept in a " +
        "SEPARATE resource from `entry` so the two writers can't collide: " +
        "`update` only ever writes here (additive), `apply`/`prune` only touch " +
        "`entry`. The merged view is the union; a private `entry` shadows a " +
        "catalog id on collision (local truth wins).",
      schema: EntrySchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "priced-path": {
      description:
        "A gateway run-option (model × endpoint) whose price was refreshed by `sync` from a " +
        "live provider feed. Separate from the curated baseline so re-pulling " +
        "the catalog never clobbers a fresh price; re-running `sync` records a " +
        "new version, so price history reads back as the trend.",
      schema: PricedPathSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    reconciliation: {
      description:
        "A side-by-side comparison of every run-option for one target " +
        "model, produced by `reconcile` — runtimes, quants, results, cost, " +
        "lineage, verification. The GATHER for an agent to reason over; it does " +
        "not pick a winner.",
      schema: ReconciliationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "capacity-plan": {
      description:
        "A ranked recommendation set produced by `capacity` for one inference " +
        "intent (task + host + co-resident reservations + privacy/cost policy): " +
        "candidate run-options bin-packed against the host's free memory, local " +
        "vs cloud arbitrated. The decision material — small, not the catalog.",
      schema: CapacityPlanSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    "operating-point": {
      description:
        "Flat, CEL-pivotable projection — one row per (model × runsOn entry), " +
        "denormalised with endpoint/quant/units, performance (genTokS), price, " +
        "model-level benchmarks, and any config-specific eval. The read-optimised " +
        "view of the embedded runsOn[] source: `swamp data query operating-point " +
        "'<CEL>'` to pivot configs by throughput, quant, endpoint, or eval. " +
        "Regenerated by `apply`, never hand-edited.",
      schema: OperatingPointSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "deployment-plan": {
      description:
        "A Pareto-ranked set of deployment options produced by `plan` for a SET " +
        "of concurrent workloads on a host: one-shared-model vs split-of-" +
        "specialists, each scored on guaranteed quality × throughput × memory " +
        "headroom. Answers 'one big model for everything, or split?' by showing " +
        "the trade — it does not pre-decide it.",
      schema: DeploymentPlanSchema,
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
        // Derived projection: explode runsOn[] into flat operating-point rows
        // (read-optimised pivot surface; source of truth stays the model entries).
        const rows = buildOperatingPointIndex(entries);
        for (const row of rows) {
          handles.push(await ctx.writeResource("operating-point", row.id, row));
        }
        ctx.logger.info(
          "llm-catalog apply: {n} entries + {r} operating-points recorded",
          { n: entries.length, r: rows.length },
        );
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
        let text: string;
        if (/^https?:\/\//.test(url)) {
          ctx.logger.info("fetching catalog {url}", { url });
          const resp = await fetch(url);
          if (!resp.ok) {
            throw new Error(`fetch ${url} failed (${resp.status})`);
          }
          text = await resp.text();
        } else {
          ctx.logger.info("reading catalog {url}", { url });
          text = await Deno.readTextFile(url);
        }
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
        // Accept { entries: [...] } or a bare [...] array.
        const entries = Array.isArray(parsed)
          ? parsed
          : (parsed as { entries?: unknown[] }).entries;
        if (!Array.isArray(entries)) {
          throw new Error(
            `catalog at ${url} must be a JSON array or { entries: [...] }`,
          );
        }
        const declaredIds = new Set(
          ctx.globalArgs.entries.map((e) => e.id),
        );
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
          "llm-catalog update: {n} public entries pulled ({s} shadowed by local)",
          { n: handles.length, s: shadowed },
        );
        return { dataHandles: handles };
      },
    },
    reconcile: {
      description: "Gather every run-option for a target model — across the " +
        "public catalog and local/private entries — into one side-by-side " +
        "`reconciliation` (runtimes, quants, results, cost, lineage, " +
        "verification), sorted fastest-first. A deterministic GATHER for an " +
        "agent to reason over; it does not pick a winner.",
      arguments: ReconcileArgsSchema,
      execute: async (
        args: { model: string; hardware?: string; catalogUrl?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const declared = ctx.globalArgs.entries;
        const declaredIds = new Set(declared.map((e) => e.id));
        const pool = [...declared];
        // Fold in the public catalog (private entries shadow public on id).
        const catalogUrl = args.catalogUrl ?? ctx.globalArgs.catalogUrl;
        if (catalogUrl) {
          const text = /^https?:\/\//.test(catalogUrl)
            ? await (await fetch(catalogUrl)).text()
            : await Deno.readTextFile(catalogUrl);
          const parsed = JSON.parse(text);
          const pub: unknown[] = Array.isArray(parsed)
            ? parsed
            : parsed.entries ?? [];
          for (const raw of pub) {
            const e = EntrySchema.parse(raw);
            if (!declaredIds.has(e.id)) pool.push(e);
          }
        }
        const result = buildReconciliation(args.model, pool, args.hardware);
        const name = `reconcile-${args.model}${
          args.hardware ? `-${args.hardware}` : ""
        }`;
        const handle = await ctx.writeResource("reconciliation", name, result);
        ctx.logger.info(
          "reconcile {model}: {n} config(s) gathered" +
            (args.hardware ? " on {hw}" : ""),
          { model: args.model, n: result.count, hw: args.hardware },
        );
        for (const c of result.configs) {
          ctx.logger.info(
            "  {id}: {access} | {rt}{prov} | {q} | {speed} tok/s | {cost} | {vis}",
            {
              id: c.id,
              access: c.access,
              rt: c.runtime ?? "",
              prov: c.provider ?? "",
              q: c.quant ?? "-",
              speed: c.speed ?? "-",
              cost: c.cost ?? "-",
              vis: c.visibility ?? "",
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },
    sync: {
      description:
        "Refresh gateway prices: fetch a provider pricing feed (default " +
        "OpenRouter /api/v1/models) and update the `cost` facet of declared " +
        "gateway run-options by matching their `providerModelId`. Writes to " +
        "the `priced-path` resource (re-running records a new version → price " +
        "history). The binding is curated; only the volatile price is synced.",
      arguments: SyncArgsSchema,
      execute: async (
        args: { feedUrl?: string; catalogUrl?: string; provider?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const feedUrl = args.feedUrl ?? OPENROUTER_FEED;
        ctx.logger.info("fetching price feed {url}", { url: feedUrl });
        const feedResp = await fetch(feedUrl);
        if (!feedResp.ok) {
          throw new Error(`price feed ${feedUrl} failed (${feedResp.status})`);
        }
        const priceMap = parseOpenRouterFeed(await feedResp.json());
        ctx.logger.info("price feed: {n} models priced", { n: priceMap.size });

        // Read the gateway run-options to refresh (same source as `update`).
        const catalogUrl = args.catalogUrl ?? ctx.globalArgs.catalogUrl;
        if (!catalogUrl) {
          throw new Error(
            "no catalogUrl — set globalArguments.catalogUrl or pass --input catalogUrl=...",
          );
        }
        const text = /^https?:\/\//.test(catalogUrl)
          ? await (await fetch(catalogUrl)).text()
          : await Deno.readTextFile(catalogUrl);
        const parsed = JSON.parse(text);
        const entries: unknown[] = Array.isArray(parsed)
          ? parsed
          : parsed.entries ?? [];

        const asOf = new Date().toISOString().slice(0, 10);
        const all = entries.map((raw) => EntrySchema.parse(raw));
        const endpoints = new Map(
          all.filter((e) => e.kind === "endpoint").map((e) => [e.id, e]),
        );
        const providerOf = (epId: string): string | undefined =>
          (endpoints.get(epId)?.relations ?? []).find((r) =>
            r.rel === "via-provider"
          )?.target;
        const handles: DataHandle[] = [];
        let missing = 0;
        for (const m of all.filter((e) => e.kind === "model")) {
          // deno-lint-ignore no-explicit-any
          const runs: any[] = (m.facets as any)?.runsOn ?? [];
          for (const ro of runs) {
            if (!ro?.providerModelId) continue; // not a gateway run-option
            if (args.provider && providerOf(ro.endpoint) !== args.provider) {
              continue;
            }
            const { priced, found, providerModelId } = refreshGatewayCost(
              m.id,
              ro,
              priceMap,
              asOf,
              feedUrl,
            );
            if (!found) {
              if (providerModelId) {
                ctx.logger.warning(
                  "no price for {id} ({pid}) in the feed — skipped",
                  { id: `${m.id}::${ro.endpoint}`, pid: providerModelId },
                );
                missing++;
              }
              continue;
            }
            handles.push(
              await ctx.writeResource("priced-path", priced!.id, priced!),
            );
            ctx.logger.info("priced {id}: ${in}/${out} per MTok", {
              id: priced!.id,
              in: priced!.perMTokInUsd,
              out: priced!.perMTokOutUsd,
            });
          }
        }
        ctx.logger.info(
          "llm-catalog sync: {n} gateway prices refreshed ({m} not in feed)",
          { n: handles.length, m: missing },
        );
        return { dataHandles: handles };
      },
    },
    ingest: {
      description:
        "Draft a model entry by fetching a HuggingFace config.json (a structured, " +
        "authoritative primary source) and mapping its architecture keys into an " +
        "`architecture` facet (marked `authoritative`). Emits a `contribution` " +
        "DRAFT for human enrichment (params/benchmarks/license/caveats) + PR — " +
        "it does not write to the catalog directly. Automates only the reliable " +
        "structured half; it never invents prose-derived facts.",
      arguments: IngestArgsSchema,
      execute: async (
        args: { repo: string; branch?: string; id?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const url = hfConfigUrl(args.repo, args.branch ?? "main");
        ctx.logger.info("fetching {url}", { url });
        const resp = await fetch(url);
        if (!resp.ok) {
          throw new Error(
            `fetch ${url} failed (${resp.status}) — check the repo/branch and ` +
              `that config.json exists.`,
          );
        }
        let config: HfConfig;
        try {
          config = await resp.json();
        } catch (e) {
          throw new Error(
            `config.json at ${url} is not valid JSON: ${
              e instanceof Error ? e.message : e
            }`,
          );
        }
        const asOf = new Date().toISOString().slice(0, 10);
        const { entry, mapped, gaps } = ingestHfConfig(
          args.repo,
          config,
          asOf,
          args.id,
        );
        const record = EntrySchema.parse(entry);
        const handle = await ctx.writeResource(
          "contribution",
          record.id,
          record,
        );
        ctx.logger.info("ingested {id}: mapped [{mapped}]", {
          id: record.id,
          mapped: mapped.join(", "),
        });
        ctx.logger.info("ENRICH before PR — gaps: {gaps}", {
          gaps: gaps.join("; "),
        });
        return { dataHandles: [handle] };
      },
    },
    contribute: {
      description:
        "Sanitise selected declared entries into generic, public-shaped " +
        "`contribution` resources (drop fleet refs, remap owned nodes to their " +
        "public hardware class, retag private sources, mark public) and " +
        "schema-validate them. Refuses an entry whose private source has no " +
        "`attribution`. The output is the PR-ready fragment for the catalog repo.",
      arguments: ContributeArgsSchema,
      execute: async (
        args: { ids: string[]; attribution?: string },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const declared = ctx.globalArgs.entries;
        const byId = new Map(declared.map((e) => [e.id, e]));
        const nodeToClass = nodeClassMap(declared);
        const handles: DataHandle[] = [];
        for (const id of args.ids) {
          const entry = byId.get(id);
          if (!entry) throw new Error(`unknown entry id "${id}"`);
          if (
            entry.kind === "hardware" && entry.visibility === "private"
          ) {
            ctx.logger.warning(
              "skipping owned node {id} — contribute findings that reference " +
                "the public hardware class, not the node itself",
              { id },
            );
            continue;
          }
          const { entry: san, actions, needsAttribution } =
            sanitiseForContribution(entry, nodeToClass, args.attribution);
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
        ctx.logger.info("llm-catalog contribute: {n} contribution(s) ready", {
          n: handles.length,
        });
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
          // readResource returns the latest version's record.
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
        ctx.logger.info("llm-catalog prune: {n} entry(s) marked {status}", {
          n: handles.length,
          status: removedStatus,
        });
        return { dataHandles: handles };
      },
    },
    capacity: {
      description:
        "Resolve an inference-capacity INTENT (task + host + co-resident " +
        "reservations + privacy/cost policy) into a small ranked Pareto set " +
        "across ALL models — candidate run-options bin-packed against the host's " +
        "free unified memory, local vs cloud arbitrated. The token-efficient " +
        "capability oracle: intent in, the decision out (not the catalog). " +
        "Footprint = a stored footprint facet else computed from verified params.",
      arguments: CapacityArgsSchema,
      execute: async (
        args: {
          task: string;
          profile?: string;
          profileWeights?: Record<string, number>;
          host?: string;
          hostUnits?: number;
          minContext?: number;
          minDecodeTokS?: number;
          privacy?: "local-only" | "prefer-local" | "any";
          maxCostPerMTokOut?: number;
          coresident?: { label: string; reserveGB: number }[];
          topK?: number;
          catalogUrl?: string;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const declared = ctx.globalArgs.entries;
        const declaredIds = new Set(declared.map((e) => e.id));
        const pool = [...declared];
        // Fold in the public catalog (private entries shadow public on id).
        const catalogUrl = args.catalogUrl ?? ctx.globalArgs.catalogUrl;
        if (catalogUrl) {
          const text = /^https?:\/\//.test(catalogUrl)
            ? await (await fetch(catalogUrl)).text()
            : await Deno.readTextFile(catalogUrl);
          const parsed = JSON.parse(text);
          const pub: unknown[] = Array.isArray(parsed)
            ? parsed
            : parsed.entries ?? [];
          for (const raw of pub) {
            const e = EntrySchema.parse(raw);
            if (!declaredIds.has(e.id)) pool.push(e);
          }
        }
        const plan = buildCapacityPlan(
          CapacityArgsSchema.parse(args),
          pool,
        );
        const handle = await ctx.writeResource(
          "capacity-plan",
          `capacity-${args.task}`,
          plan,
        );
        ctx.logger.info(
          "capacity {task} on {host}: {n} rec(s), {free} free, {unmet} unmet",
          {
            task: args.task,
            host: args.host ?? "cloud",
            n: plan.recommendations.length,
            free: plan.freeGB === undefined ? "n/a" : `${plan.freeGB}GB`,
            unmet: plan.unmet.length,
          },
        );
        for (const r of plan.recommendations) {
          ctx.logger.info("  {ap}: {placement} | {q} | {speed} tok/s | {fit}", {
            ap: r.accessPath,
            placement: r.placement,
            q: r.quant ?? r.perMTokOutUsd != null
              ? `$${r.perMTokOutUsd}/MTok`
              : (r.quant ?? "-"),
            speed: r.decodeTokS ?? "-",
            fit: r.needGB != null ? `${r.needGB}GB` : "-",
          });
        }
        return { dataHandles: [handle] };
      },
    },
    plan: {
      description:
        "Deployment planner: given a SET of concurrent workloads (each with a " +
        "quality profile) on a host, enumerate one-shared-model vs split-of-" +
        "specialists deployments and rank them on a Pareto front (guaranteed " +
        "quality × throughput × memory headroom). Gather-don't-pick: returns the " +
        "trade between a single all-rounder and per-task specialists. Throughput " +
        "uses measured genTokS where known, else a bandwidth estimate (flagged).",
      arguments: PlanArgsSchema,
      execute: async (
        args: {
          host: string;
          hostUnits?: number;
          workloads: {
            label: string;
            profile?: string;
            profileWeights?: Record<string, number>;
            minContext?: number;
            minDecodeTokS?: number;
          }[];
          coresident?: { label: string; reserveGB: number }[];
          isolationOverheadGB?: number;
          topK?: number;
          catalogUrl?: string;
        },
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const declared = ctx.globalArgs.entries;
        const declaredIds = new Set(declared.map((e) => e.id));
        const pool = [...declared];
        const catalogUrl = args.catalogUrl ?? ctx.globalArgs.catalogUrl;
        if (catalogUrl) {
          const text = /^https?:\/\//.test(catalogUrl)
            ? await (await fetch(catalogUrl)).text()
            : await Deno.readTextFile(catalogUrl);
          const parsed = JSON.parse(text);
          const pub: unknown[] = Array.isArray(parsed)
            ? parsed
            : parsed.entries ?? [];
          for (const raw of pub) {
            const e = EntrySchema.parse(raw);
            if (!declaredIds.has(e.id)) pool.push(e);
          }
        }
        const result = buildDeploymentPlans(PlanArgsSchema.parse(args), pool);
        const handle = await ctx.writeResource(
          "deployment-plan",
          `plan-${args.workloads.map((w) => w.label).join("+")}`,
          result,
        );
        ctx.logger.info(
          "plan on {host}×{units}: {n} plan(s), {free} free, {unmet} unmet",
          {
            host: args.host,
            units: result.hostUnits,
            n: result.plans.length,
            free: result.freeGB === undefined ? "n/a" : `${result.freeGB}GB`,
            unmet: result.unmet.length,
          },
        );
        for (const p of result.plans) {
          ctx.logger.info("  [{kind}{pareto}] {verdict}", {
            kind: p.kind,
            pareto: p.pareto ? "*" : "",
            verdict: p.verdict,
          });
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
