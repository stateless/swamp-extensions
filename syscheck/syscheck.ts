/**
 * syscheck — fleet node verification framework.
 *
 * A **workflow-scoped** report that evaluates a catalog of tagged verification
 * checks against live probe facts and emits a per-node verdict. It is the
 * *fitness/hygiene* runner of the model in
 * `docs/decisions/2026-06-12-5e8a2d-node-verification-check-taxonomy.md`:
 *
 *   - A **check** is a read-only assertion of state (pass/warn/fail), tagged
 *     `category` (hygiene | fitness | telemetry | drift) × `cadence` × `scope`
 *     (host | pve | gpu | …). It is *not* a process (mutations live in
 *     workflows, e.g. `proxmox-upgrade-*`).
 *   - Checks are **contributed by domains** via {@link CheckProvider}. syscheck
 *     owns the framework; domains (`host`, `proxmox`, future `docker`, …) own
 *     their scoped checks and the *fact contract* (`requires`) they depend on.
 *     This is the abstraction other tools implement — see README "Contributing".
 *   - **Probe once, interpret many:** one probe pass (`host-probe.sh` over
 *     `@swamp/ssh`, plus domain fact-sources) yields facts; many checks of
 *     different categories read them.
 *
 * Reports are advisory (a throw does not fail the run), so the verdict travels
 * in the JSON for downstream consumers: a recurring run, an upgrade-preflight
 * gate, and (per the note) inventory as the results store + diff baseline.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The `hygiene` block emitted by scripts/host-probe.sh (host fact-source). */
const HygieneSchema = z.object({
  cpuVendor: z.string().optional(),
  virt: z.string().optional(),
  microcodePkg: z.string().optional(),
  nonFreeFirmware: z.boolean().optional(),
  newestKernel: z.string().optional(),
}).passthrough();

/** The probe document (one per host) — only the fields checks consume. */
const ProbeSchema = z.object({
  reachable: z.boolean().optional(),
  host: z.string().optional(),
  os: z.string().optional(),
  kernel: z.string().optional(),
  // PVE fact-source (the proxmox contribution). host-probe captures `version`
  // (pveversion) and `storages` (pvesm status); subscription/repo facts come
  // from the proxmox fact-source — see proxmoxProvider.requires.
  proxmox: z.object({
    version: z.string().optional(),
    guestIds: z.string().optional(),
    storages: z.string().optional(),
  }).nullable().optional(),
  hygiene: HygieneSchema.nullable().optional(),
}).passthrough();

/** A `runResult` resource written by the @swamp/ssh exec/script method. */
const RunResultSchema = z.object({
  method: z.string().optional(),
  host: z.string().optional(),
  exitCode: z.number().nullable().optional(),
  stdout: z.string().optional(),
  stderr: z.string().optional(),
}).passthrough();

type Hygiene = z.infer<typeof HygieneSchema>;
type Probe = z.infer<typeof ProbeSchema>;

// ---------------------------------------------------------------------------
// The tagged-check primitive
// ---------------------------------------------------------------------------

/** Verification category — what the check *means* (see the decision note §2). */
type Category = "hygiene" | "fitness" | "telemetry" | "drift";
/** How often the check wants to run (telemetry is the separate high-freq plane). */
type Cadence = "daily" | "weekly" | "monthly";

type CheckStatus = "pass" | "warn" | "fail" | "na";
type CheckResult = {
  status: CheckStatus;
  detail: string;
  remediation?: string;
};

/** Facts a check sees for one node, assembled from the probe. */
type CheckCtx = {
  os: string;
  kernel: string;
  facts: Hygiene;
  /** PVE facts (the proxmox fact-source); absent on non-PVE nodes. */
  pve?: { version?: string; storages?: string };
};

/** One verification check. Tagged so a runner can select by category/cadence/scope. */
type Check = {
  id: string;
  title: string;
  category: Category;
  cadence: Cadence;
  /** Node class this check is about — a TAG, not an extension boundary. */
  scope: string;
  /** Provenance: where the check was mined from. */
  source: string;
  /** Fine live gate; false ⇒ `na` (e.g. x86-only, bare-metal-only, PVE-only). */
  appliesTo: (c: CheckCtx) => boolean;
  evaluate: (c: CheckCtx) => CheckResult;
};

// ---------------------------------------------------------------------------
// The contribution abstraction — what syscheck asks FROM a domain tool.
// A domain (`host`, `proxmox`, future `@stateless/docker`, …) exports one of
// these: its scope, the facts it needs gathered (the fact contract), and its
// tagged checks. syscheck owns the framework; the domain owns its checks+facts.
// This is the template other tools implement — see README "Contributing".
// ---------------------------------------------------------------------------
type CheckProvider = {
  /** Domain identity, e.g. "host" | "proxmox" | "docker". */
  domain: string;
  /** Scope tag every check here carries (host | pve | gpu | container | …). */
  scope: string;
  description: string;
  /**
   * Fact contract — the keys this domain's checks read, and where they come
   * from. syscheck guarantees a check only runs once its `requires` facts are
   * present; absent facts ⇒ the check `appliesTo`-gates to `na`. A domain
   * supplies facts either via the shared host probe or its own fact-source
   * (a probe step / model method), documented here.
   */
  requires: string[];
  checks: Check[];
};

const X86_VENDORS = new Set(["AuthenticAMD", "GenuineIntel"]);
function microcodePkgFor(vendor: string | undefined): string {
  if (vendor === "AuthenticAMD") return "amd64-microcode";
  if (vendor === "GenuineIntel") return "intel-microcode";
  return "";
}
function isDebianFamily(os: string): boolean {
  return /debian|proxmox/i.test(os);
}

/**
 * `host` provider — host-OS / apt good-practice, over `scripts/host-probe.sh`.
 * Applies to every node (the `host` scope); checks self-gate by arch/virt/os.
 */
const hostProvider: CheckProvider = {
  domain: "host",
  scope: "host",
  description:
    "Host-OS / apt hygiene & fitness, over scripts/host-probe.sh (@swamp/ssh).",
  requires: [
    "hygiene.cpuVendor",
    "hygiene.virt",
    "hygiene.microcodePkg",
    "hygiene.nonFreeFirmware",
    "hygiene.newestKernel",
    "kernel",
  ],
  checks: [
    {
      id: "cpu-microcode",
      title: "CPU microcode package installed",
      category: "fitness",
      cadence: "weekly",
      scope: "host",
      source: "pve8to9",
      appliesTo: (c) =>
        c.facts.virt === "none" && X86_VENDORS.has(c.facts.cpuVendor ?? ""),
      evaluate: (c) => {
        const want = microcodePkgFor(c.facts.cpuVendor);
        const have = (c.facts.microcodePkg ?? "").trim();
        if (have) return { status: "pass", detail: `installed: ${have}` };
        return {
          status: "warn",
          detail: `${want} not installed — missing CPU security/bug microcode`,
          remediation:
            `enable the 'non-free-firmware' apt component, then \`apt install ${want}\``,
        };
      },
    },
    {
      id: "non-free-firmware-repo",
      title: "non-free-firmware apt component enabled",
      category: "hygiene",
      cadence: "daily",
      scope: "host",
      source: "pve8to9",
      appliesTo: (c) => c.facts.virt === "none" && isDebianFamily(c.os),
      evaluate: (c) => {
        if (c.facts.nonFreeFirmware === true) {
          return { status: "pass", detail: "enabled" };
        }
        return {
          status: "warn",
          detail:
            "disabled — firmware/microcode packages are uninstallable until enabled",
          remediation:
            "add 'non-free-firmware' to the bookworm components in /etc/apt/sources.list*, then `apt update`",
        };
      },
    },
    {
      id: "reboot-pending-kernel",
      title: "running the newest installed kernel",
      category: "fitness",
      cadence: "daily",
      scope: "host",
      source: "pve8to9",
      appliesTo: (c) => !!c.facts.newestKernel && !!c.kernel,
      evaluate: (c) => {
        const newest = c.facts.newestKernel!;
        if (newest === c.kernel) {
          return {
            status: "pass",
            detail: `running newest kernel ${c.kernel}`,
          };
        }
        return {
          status: "warn",
          detail:
            `newer kernel ${newest} installed than running ${c.kernel} — reboot pending`,
          remediation:
            "reboot during a maintenance window to activate the new kernel (and pending microcode)",
        };
      },
    },
  ],
};

/**
 * `proxmox` provider — the abstraction syscheck requires FROM `@stateless/proxmox`.
 * Scope `pve`; checks gate themselves to PVE nodes (`pve.version` present). The
 * fact contract below names what proxmox must supply: `pve.version` is already
 * in the host probe (pveversion); the richer facts come from the proxmox
 * fact-source (`_lib/proxmox/node.ts` nodeStatus / `pvesh`) once wired — until
 * then, checks needing them stay `na`. This is the model `@stateless/docker`
 * et al. follow: declare a scope, a fact contract, and tagged checks.
 */
const proxmoxProvider: CheckProvider = {
  domain: "proxmox",
  scope: "pve",
  description:
    "Proxmox VE node checks. Fact-source: host-probe pveversion + pvesm status now; @stateless/proxmox node.ts/pvesh for the rest.",
  requires: [
    "proxmox.version            (have — host-probe pveversion)",
    "proxmox.storages           (have — host-probe `pvesm status`)",
    "proxmox.subscriptionActive (TODO — proxmox fact-source: pvesh /nodes/<n>/subscription)",
    "proxmox.enterpriseRepo     (TODO — proxmox/host fact-source: apt sources)",
  ],
  checks: [
    {
      id: "pve-version-detected",
      title: "PVE version reported",
      category: "fitness",
      cadence: "weekly",
      scope: "pve",
      source: "syscheck",
      appliesTo: (c) => !!c.pve?.version,
      evaluate: (c) => {
        const v = c.pve!.version!;
        const m = v.match(/(\d+\.\d+)/);
        return m
          ? { status: "pass", detail: `PVE ${m[1]} (${v})` }
          : { status: "warn", detail: `unparseable pveversion: ${v}` };
      },
    },
    {
      id: "pve-storage-active",
      title: "PVE storages active",
      category: "fitness",
      cadence: "daily",
      scope: "pve",
      source: "pve8to9",
      // Needs the `storages` fact (pvesm status); na on nodes without it.
      appliesTo: (c) => !!c.pve?.storages,
      evaluate: (c) => {
        const pairs = (c.pve!.storages ?? "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean)
          .map((s) => {
            const i = s.lastIndexOf(":");
            return { name: s.slice(0, i), status: s.slice(i + 1) };
          });
        // "inactive" = enabled but unreachable (e.g. a PBS target timing out);
        // "disabled" is intentional and not a fault.
        const inactive = pairs.filter((p) => p.status === "inactive").map((p) =>
          p.name
        );
        if (inactive.length) {
          return {
            status: "warn",
            detail: `enabled but inactive: ${
              inactive.join(", ")
            } — storage/backup target unreachable`,
            remediation:
              "check the storage backend / network (e.g. PBS reachability, mount, credentials)",
          };
        }
        const active = pairs.filter((p) => p.status === "active").length;
        return { status: "pass", detail: `${active} storage(s) active` };
      },
    },
    // Subscription/repo-match checks land here once the proxmox fact-source
    // supplies the remaining `requires`. See README "Contributing" + the note.
  ],
};

/** Registered providers. A domain plugs in by adding its provider here. */
const PROVIDERS: CheckProvider[] = [hostProvider, proxmoxProvider];

/** The flat catalog (each check tagged with its provider domain). */
const CATALOG: Array<Check & { domain: string }> = PROVIDERS.flatMap((p) =>
  p.checks.map((c) => ({ ...c, domain: p.domain }))
);

type Verdict = "pass" | "warn" | "fail";

type NodeFinding = {
  id: string;
  title: string;
  status: CheckStatus;
  detail: string;
  remediation?: string;
  domain: string;
  scope: string;
  category: Category;
  cadence: Cadence;
  source: string;
};

/** Roll the catalog over one node's live facts. Pure — unit-tested directly. */
function evaluateNode(
  probe: Probe,
): { verdict: Verdict; checks: NodeFinding[] } {
  const ctx: CheckCtx = {
    os: probe.os ?? "",
    kernel: probe.kernel ?? "",
    facts: probe.hygiene ?? {},
    pve: probe.proxmox ?? undefined,
  };
  const checks: NodeFinding[] = [];
  for (const chk of CATALOG) {
    const base = {
      id: chk.id,
      title: chk.title,
      domain: chk.domain,
      scope: chk.scope,
      category: chk.category,
      cadence: chk.cadence,
      source: chk.source,
    };
    if (!chk.appliesTo(ctx)) {
      checks.push({ ...base, status: "na", detail: "not applicable" });
      continue;
    }
    checks.push({ ...base, ...chk.evaluate(ctx) });
  }
  const verdict: Verdict = checks.some((c) => c.status === "fail")
    ? "fail"
    : checks.some((c) => c.status === "warn")
    ? "warn"
    : "pass";
  return { verdict, checks };
}

const ICON: Record<CheckStatus, string> = {
  pass: "✅",
  warn: "⚠️",
  fail: "❌",
  na: "·",
};
const VERDICT_ICON: Record<Verdict, string> = {
  pass: "✅ pass",
  warn: "⚠️ warn",
  fail: "❌ fail",
};

type StepExecution = {
  jobName: string;
  stepName: string;
  modelType: string;
  modelId: string;
  methodName: string;
  status: string;
  globalArgs?: Record<string, unknown>;
  dataHandles?: Array<{ name: string; specName?: string; version?: number }>;
};

type HostDecl = { name?: string };

/** syscheck report definition (workflow scope). */
export const report = {
  name: "@stateless/syscheck",
  description:
    "Fleet node verification — runs a catalog of tagged checks (category × cadence × scope) contributed by domains (host, proxmox, …) against the probe, and reports a per-node pass/warn/fail verdict.",
  scope: "workflow" as const,
  labels: ["audit", "fleet", "verification", "best-practice"],
  execute: async (context: {
    workflowName?: string;
    stepExecutions?: StepExecution[];
    dataRepository: {
      getContent: (
        type: string,
        id: string,
        name: string,
        version?: number,
      ) => Promise<Uint8Array | null>;
    };
    logger?: { info: (msg: string, props?: Record<string, unknown>) => void };
  }) => {
    const steps = context.stepExecutions ?? [];
    const probeByHost = new Map<string, Probe | null>();
    const declared = new Set<string>();

    for (const step of steps) {
      const gh = step.globalArgs?.hosts;
      if (Array.isArray(gh)) {
        for (const h of gh as HostDecl[]) if (h?.name) declared.add(h.name);
      }
      for (const handle of step.dataHandles ?? []) {
        if (handle.specName !== "runResult") continue;
        let raw: Uint8Array | null;
        try {
          raw = await context.dataRepository.getContent(
            step.modelType,
            step.modelId,
            handle.name,
            handle.version,
          );
        } catch {
          continue;
        }
        if (!raw) continue;
        let rr: z.infer<typeof RunResultSchema>;
        try {
          rr = RunResultSchema.parse(JSON.parse(new TextDecoder().decode(raw)));
        } catch {
          continue;
        }
        const host = rr.host ??
          handle.name.replace(/^run-(?:script|exec)-/, "");
        declared.add(host);
        const reachable = rr.exitCode === 0 && !!rr.stdout;
        let probe: Probe | null = null;
        if (reachable) {
          try {
            probe = ProbeSchema.parse(JSON.parse(rr.stdout!));
          } catch {
            probe = null;
          }
        }
        if (probe && (probe.hygiene || probe.host)) {
          probeByHost.set(host, probe);
        } else if (!probeByHost.has(host)) {
          probeByHost.set(host, null);
        }
      }
    }

    const allHosts = [...new Set([...declared, ...probeByHost.keys()])].sort();

    const rows: string[] = [];
    const details: string[] = [];
    const jsonNodes: Array<Record<string, unknown>> = [];
    let passed = 0, warned = 0, failed = 0, unreachable = 0;

    for (const name of allHosts) {
      const probe = probeByHost.get(name) ?? null;
      if (!probe) {
        unreachable++;
        rows.push(`| ${name} | 🔌 unreachable | — | — | — |`);
        details.push(
          `\n### ${name}\n- 🔌 unreachable — no usable probe result (verdict stale)`,
        );
        jsonNodes.push({ name, reachable: false, verdict: null, checks: [] });
        continue;
      }
      const { verdict, checks } = evaluateNode(probe);
      if (verdict === "fail") failed++;
      else if (verdict === "warn") warned++;
      else passed++;

      const nPass = checks.filter((c) => c.status === "pass").length;
      const nWarn = checks.filter((c) => c.status === "warn").length;
      const nFail = checks.filter((c) => c.status === "fail").length;
      rows.push(
        `| ${name} | ${
          VERDICT_ICON[verdict]
        } | ${nPass} | ${nWarn} | ${nFail} |`,
      );

      details.push(`\n### ${name} — ${VERDICT_ICON[verdict]}`);
      for (const c of checks) {
        const rem = c.remediation && c.status !== "pass" && c.status !== "na"
          ? ` — _${c.remediation}_`
          : "";
        details.push(
          `- ${
            ICON[c.status]
          } **${c.title}** \`[${c.scope}·${c.category}·${c.cadence}]\`: ${c.detail}${rem}`,
        );
      }

      jsonNodes.push({ name, reachable: true, verdict, checks });
    }

    context.logger?.info(
      "syscheck: {nodes} nodes — {passed} pass, {warned} warn, {failed} fail, {unreachable} unreachable",
      { nodes: allHosts.length, passed, warned, failed, unreachable },
    );

    const markdown = [
      `# syscheck — fleet node verification`,
      ``,
      `Nodes: **${allHosts.length}** · ✅ ${passed} pass · ⚠️ ${warned} warn · ❌ ${failed} fail · 🔌 ${unreachable} unreachable`,
      `Catalog: **${CATALOG.length}** checks from **${PROVIDERS.length}** providers (${
        PROVIDERS.map((p) => p.domain).join(", ")
      }).`,
      ``,
      `| node | verdict | ✅ | ⚠️ | ❌ |`,
      `| ---- | ------- | -- | -- | -- |`,
      ...rows,
      ...details,
    ].join("\n");

    return {
      markdown,
      json: {
        nodes: allHosts.length,
        passed,
        warned,
        failed,
        unreachable,
        providers: PROVIDERS.map((p) => ({
          domain: p.domain,
          scope: p.scope,
          requires: p.requires,
          checks: p.checks.map((c) => c.id),
        })),
        catalog: CATALOG.map((c) => ({
          id: c.id,
          title: c.title,
          domain: c.domain,
          scope: c.scope,
          category: c.category,
          cadence: c.cadence,
          source: c.source,
        })),
        nodeResults: jsonNodes,
      },
    };
  },
};
