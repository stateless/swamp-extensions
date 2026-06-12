/**
 * `@stateless/inventory-breakdown` — a grouped summary of a fleet inventory.
 *
 * Device counts by site and by kind, lifecycle flags (degraded / on-shelf /
 * pending / dead), and the open `(verify)` residue. Reads the materialised
 * `device` resources via the data repository, so it reflects the current
 * declared state and excludes soft-pruned (removed/superseded) records.
 *
 * Method-scope: runs after an inventory method (e.g. `apply`). It does not
 * depend on that run's handles — it lists all stored devices — so it is a
 * full current breakdown regardless of which method triggered it.
 *
 * @module
 */

interface DataMeta {
  name: string;
  version: number;
  tags?: { specName?: string };
}

interface ReportDataRepository {
  findAllForModel: (type: string, modelId: string) => Promise<DataMeta[]>;
  getContent: (
    type: string,
    modelId: string,
    name: string,
    version?: number,
  ) => Promise<Uint8Array | null>;
}

interface Device {
  id: string;
  name: string;
  kind: string;
  site?: string;
  make?: string;
  model?: string;
  status?: string;
  facets?: Record<string, unknown>;
}

interface ReportContext {
  modelType: string;
  modelId: string;
  definition: { name: string };
  dataRepository: ReportDataRepository;
}

interface ReportResult {
  markdown: string;
  json: Record<string, unknown>;
}

const SITE_ORDER = ["home", "colo", "10gap", "roaming"];
/** Statuses that mean the record is soft-pruned, not part of the live fleet. */
const INACTIVE = /removed|superseded|decommission/i;
/** Statuses worth surfacing for attention. */
const NEEDS_ATTENTION =
  /dead|degraded|on-shelf|waiting|pending|retiring|fault/i;

function siteRank(site: string): number {
  const i = SITE_ORDER.indexOf(site);
  return i === -1 ? SITE_ORDER.length : i;
}

function countToMap<T>(items: T[], key: (t: T) => string): Map<string, number> {
  const m = new Map<string, number>();
  for (const it of items) {
    const k = key(it);
    m.set(k, (m.get(k) ?? 0) + 1);
  }
  return m;
}

export const report = {
  name: "@stateless/inventory-breakdown",
  description:
    "Grouped fleet breakdown — device counts by site and kind, lifecycle " +
    "flags, and the open `(verify)` residue. Reads the declared `device` records.",
  scope: "method" as const,
  labels: ["inventory", "fleet", "summary"],
  execute: async (context: ReportContext): Promise<ReportResult> => {
    const { modelType, modelId, dataRepository } = context;
    const all = await dataRepository.findAllForModel(modelType, modelId);

    // Latest version per `device` resource.
    const latest = new Map<string, number>();
    for (const d of all) {
      if (d.tags?.specName !== "device") continue;
      const cur = latest.get(d.name);
      if (cur === undefined || d.version > cur) latest.set(d.name, d.version);
    }

    const devices: Device[] = [];
    for (const name of latest.keys()) {
      const raw = await dataRepository.getContent(modelType, modelId, name);
      if (!raw) continue;
      const dev = JSON.parse(new TextDecoder().decode(raw)) as Device;
      if (dev.status && INACTIVE.test(dev.status)) continue; // soft-pruned
      devices.push(dev);
    }

    devices.sort((a, b) =>
      siteRank(a.site ?? "") - siteRank(b.site ?? "") ||
      (a.kind ?? "").localeCompare(b.kind ?? "") ||
      a.id.localeCompare(b.id)
    );

    const bySite = countToMap(devices, (d) => d.site ?? "(unsited)");
    const byKind = countToMap(devices, (d) => d.kind);
    const flagged = devices.filter((d) =>
      d.status && NEEDS_ATTENTION.test(d.status)
    );
    // `(verify…` is the convention for an unconfirmed field worth re-checking.
    const VERIFY = /\(verify/i;
    const verify = devices.flatMap((d) => {
      if (VERIFY.test(d.model ?? "")) {
        return [{ id: d.id, where: `model: ${d.model}` }];
      }
      if (VERIFY.test(JSON.stringify(d.facets ?? {}))) {
        return [{ id: d.id, where: "facets" }];
      }
      return [];
    });

    const sites = [...bySite.keys()].sort((a, b) => siteRank(a) - siteRank(b));
    const md: string[] = [
      `# Inventory breakdown — ${context.definition.name}`,
      "",
      `**${devices.length} active devices** · ${sites.length} sites`,
      "",
      "## By site",
      ...sites.map((s) => `- **${s}** — ${bySite.get(s)}`),
      "",
      "## By kind",
      ...[...byKind.entries()]
        .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
        .map(([k, v]) => `- ${k} × ${v}`),
      "",
      "## Devices",
    ];
    let curSite = "";
    for (const d of devices) {
      const site = d.site ?? "(unsited)";
      if (site !== curSite) {
        curSite = site;
        md.push(`\n**${site}**`);
      }
      const mm = [d.make, d.model].filter(Boolean).join(" ");
      const flag = d.status && NEEDS_ATTENTION.test(d.status) ? " ⚠️" : "";
      md.push(`- \`${d.id}\` (${d.kind})${mm ? ` — ${mm}` : ""}${flag}`);
    }
    if (flagged.length) {
      md.push("", "## ⚠️ Needs attention");
      for (const d of flagged) md.push(`- \`${d.id}\` — ${d.status}`);
    }
    if (verify.length) {
      md.push("", "## `(verify)` residue");
      for (const v of verify) md.push(`- \`${v.id}\` — ${v.where}`);
    }

    return {
      markdown: md.join("\n"),
      json: {
        total: devices.length,
        bySite: Object.fromEntries(bySite),
        byKind: Object.fromEntries(byKind),
        flagged: flagged.map((d) => ({ id: d.id, status: d.status })),
        verify,
        devices: devices.map((d) => ({
          id: d.id,
          kind: d.kind,
          site: d.site,
          status: d.status,
        })),
      },
    };
  },
};
