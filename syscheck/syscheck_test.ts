import { createReportTestContext } from "jsr:@systeminit/swamp-testing";
import { assert, assertEquals } from "jsr:@std/assert";
import { report } from "./syscheck.ts";

const MODEL_TYPE = "@swamp/ssh";
const MODEL_ID = "inv1";
const KERNEL = "6.8.12-9-pve";
const PVE = {
  version: "pve-manager/8.4.1/abc",
  storages: "local:active;local-zfs:active;",
};

type Hygiene = {
  cpuVendor?: string;
  virt?: string;
  microcodePkg?: string;
  nonFreeFirmware?: boolean;
  newestKernel?: string;
};

function probeDoc(
  host: string,
  hygiene: Hygiene,
  opts?: { kernel?: string; pve?: { version: string; storages?: string } | null },
) {
  return {
    reachable: true,
    host,
    os: "Debian GNU/Linux 12 (bookworm)",
    kernel: opts?.kernel ?? KERNEL,
    proxmox: opts?.pve === undefined ? PVE : opts.pve,
    hygiene,
  };
}

function runResult(host: string, probe: unknown, opts?: { exitCode?: number }) {
  const rr = {
    method: "script",
    host,
    exitCode: opts?.exitCode ?? 0,
    stdout: JSON.stringify(probe),
    stderr: "",
  };
  const content = new TextEncoder().encode(JSON.stringify(rr));
  const name = `run-script-${host}`;
  const tags = { type: "resource", specName: "runResult" };
  return {
    handle: {
      name,
      specName: "runResult",
      kind: "resource" as const,
      dataId: name,
      version: 1,
      size: content.length,
      tags,
      metadata: {
        contentType: "application/json",
        lifetime: "infinite",
        garbageCollection: 10,
        streaming: false,
        tags,
        ownerDefinition: {
          ownerType: "workflow-step" as const,
          ownerRef: "probe-host",
        },
      },
    },
    artifact: {
      modelType: MODEL_TYPE,
      modelId: MODEL_ID,
      data: {
        name,
        kind: "resource" as const,
        dataId: name,
        version: 1,
        size: content.length,
        contentType: "application/json",
      },
      content,
    },
  };
}

function makeContext(
  results: Array<ReturnType<typeof runResult>>,
  declaredHosts?: Array<{ name: string }>,
) {
  const { context } = createReportTestContext({
    scope: "workflow",
    workflowName: "syscheck",
    workflowStatus: "succeeded",
    stepExecutions: [
      {
        jobName: "probe",
        stepName: "probe-host",
        modelName: "proxmox-inventory",
        modelType: MODEL_TYPE,
        methodName: "script",
        status: "succeeded",
        dataHandles: results.map((r) => r.handle),
        methodArgs: {},
        modelId: MODEL_ID,
        globalArgs: declaredHosts ? { hosts: declaredHosts } : {},
      },
    ] as never,
    dataArtifacts: results.map((r) => r.artifact),
  });
  return context;
}

type NodeResult = {
  name: string;
  reachable: boolean;
  verdict: string | null;
  checks: Array<{ id: string; status: string; scope: string; category: string }>;
};
type Json = {
  nodes: number;
  passed: number;
  warned: number;
  failed: number;
  unreachable: number;
  providers: Array<{ domain: string; scope: string }>;
  catalog: Array<{ id: string }>;
  nodeResults: NodeResult[];
};

function statusOf(node: NodeResult, id: string): string {
  return node.checks.find((c) => c.id === id)?.status ?? "missing";
}

Deno.test("syscheck: AMD bare metal missing microcode → warn", async () => {
  const r = runResult(
    "amd1",
    probeDoc("amd1", {
      cpuVendor: "AuthenticAMD",
      virt: "none",
      microcodePkg: "",
      nonFreeFirmware: false,
      newestKernel: KERNEL,
    }),
  );
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;

  assertEquals(json.warned, 1);
  assertEquals(json.passed, 0);
  const node = json.nodeResults.find((n) => n.name === "amd1")!;
  assertEquals(node.verdict, "warn");
  assertEquals(statusOf(node, "cpu-microcode"), "warn");
  assertEquals(statusOf(node, "non-free-firmware-repo"), "warn");
  assertEquals(statusOf(node, "reboot-pending-kernel"), "pass");
});

Deno.test("syscheck: Intel PVE node, fully fit → pass", async () => {
  const r = runResult(
    "intel1",
    probeDoc("intel1", {
      cpuVendor: "GenuineIntel",
      virt: "none",
      microcodePkg: "intel-microcode 3.20250311.1",
      nonFreeFirmware: true,
      newestKernel: KERNEL,
    }),
  );
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;

  assertEquals(json.passed, 1);
  assertEquals(json.warned, 0);
  const node = json.nodeResults.find((n) => n.name === "intel1")!;
  assertEquals(node.verdict, "pass");
  assertEquals(statusOf(node, "cpu-microcode"), "pass");
});

Deno.test("syscheck: proxmox provider — pve check passes on a PVE node, N/A off it", async () => {
  const pve = runResult(
    "pvehost",
    probeDoc("pvehost", { cpuVendor: "GenuineIntel", virt: "none", nonFreeFirmware: true, newestKernel: KERNEL }),
  );
  const bare = runResult(
    "barehost",
    probeDoc("barehost", { cpuVendor: "GenuineIntel", virt: "none", nonFreeFirmware: true, newestKernel: KERNEL }, { pve: null }),
  );
  const json = (await report.execute(makeContext([pve, bare]) as never))
    .json as unknown as Json;

  const pveNode = json.nodeResults.find((n) => n.name === "pvehost")!;
  assertEquals(statusOf(pveNode, "pve-version-detected"), "pass");
  const bareNode = json.nodeResults.find((n) => n.name === "barehost")!;
  assertEquals(statusOf(bareNode, "pve-version-detected"), "na");
  // proxmox provider is registered + the pve check carries scope=pve
  assert(json.providers.some((p) => p.domain === "proxmox" && p.scope === "pve"));
  assertEquals(
    pveNode.checks.find((c) => c.id === "pve-version-detected")?.scope,
    "pve",
  );
});

Deno.test("syscheck: proxmox provider — inactive storage → warn", async () => {
  const r = runResult(
    "pbsdown",
    probeDoc(
      "pbsdown",
      {
        cpuVendor: "GenuineIntel",
        virt: "none",
        microcodePkg: "intel-microcode 3.x",
        nonFreeFirmware: true,
        newestKernel: KERNEL,
      },
      {
        pve: {
          version: "pve-manager/8.4.1/abc",
          storages: "local:active;local-zfs:active;pbs:inactive;",
        },
      },
    ),
  );
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;
  const node = json.nodeResults.find((n) => n.name === "pbsdown")!;
  assertEquals(statusOf(node, "pve-storage-active"), "warn");
  assertEquals(node.verdict, "warn");
});

Deno.test("syscheck: VM → host firmware checks N/A, pve N/A", async () => {
  const r = runResult(
    "vm1",
    probeDoc(
      "vm1",
      { cpuVendor: "GenuineIntel", virt: "kvm", microcodePkg: "", nonFreeFirmware: false, newestKernel: KERNEL },
      { pve: null },
    ),
  );
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;

  const node = json.nodeResults.find((n) => n.name === "vm1")!;
  assertEquals(statusOf(node, "cpu-microcode"), "na");
  assertEquals(statusOf(node, "non-free-firmware-repo"), "na");
  assertEquals(statusOf(node, "pve-version-detected"), "na");
  assertEquals(node.verdict, "pass");
});

Deno.test("syscheck: newer kernel installed → reboot-pending warn", async () => {
  const r = runResult(
    "intel2",
    probeDoc("intel2", {
      cpuVendor: "GenuineIntel",
      virt: "none",
      microcodePkg: "intel-microcode 3.x",
      nonFreeFirmware: true,
      newestKernel: "6.8.12-10-pve",
    }),
  );
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;

  const node = json.nodeResults.find((n) => n.name === "intel2")!;
  assertEquals(statusOf(node, "reboot-pending-kernel"), "warn");
  assertEquals(node.verdict, "warn");
});

Deno.test("syscheck: declared host with no probe result → unreachable", async () => {
  const good = runResult(
    "intel1",
    probeDoc("intel1", {
      cpuVendor: "GenuineIntel",
      virt: "none",
      microcodePkg: "intel-microcode 3.x",
      nonFreeFirmware: true,
      newestKernel: KERNEL,
    }),
  );
  const context = makeContext([good], [{ name: "intel1" }, { name: "downhost" }]);
  const result = await report.execute(context as never);
  const json = result.json as unknown as Json;

  assertEquals(json.unreachable, 1);
  const down = json.nodeResults.find((n) => n.name === "downhost")!;
  assertEquals(down.reachable, false);
  assertEquals(down.verdict, null);
  assert(result.markdown.includes("syscheck"));
});

Deno.test("syscheck: failed probe (non-zero exit) → unreachable", async () => {
  const r = runResult("brokenhost", { junk: true }, { exitCode: 1 });
  const json = (await report.execute(makeContext([r]) as never))
    .json as unknown as Json;
  assertEquals(json.unreachable, 1);
  assertEquals(json.nodeResults[0].reachable, false);
});
