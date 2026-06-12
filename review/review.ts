/**
 * `@stateless/review` — a human-in-the-loop review canvas.
 *
 * Serves a local web form a human gates/edits while the agent (terminal
 * client, workflow, or chat session) keeps working — an additional
 * collaboration surface, not a blocking prompt. Three intended uses:
 *
 *   1. **Curate a long candidate list** (`mode: list`) — items grouped with a
 *      configurable option-scale + comment per row. App migrations, resource
 *      pruning, security-finding triage, cleanup approvals.
 *   2. **Review/comment a generated doc** (`mode: doc`) — markdown editor on
 *      the left, live preview on the right; the human edits free-form and the
 *      agent diffs the web-save against git/its own copy.
 *   3. **Pre-publish gate** — `mode: doc` with an `optionScale` (e.g.
 *      approve/revise/reject) renders a verdict row; a workflow serves the
 *      artifact, the human eyeballs it, `collect` returns the verdict before
 *      anything is pushed.
 *
 * **Detached, not blocking:** `serve` spawns a self-contained Python-stdlib
 * server (`server_py.txt` — the registry only allows .txt for non-TS assets; it is plain Python) and returns immediately with the URL. The
 * human saves whenever; `collect` reads the result from disk later — it works
 * even after the server dies. `stop` kills the server (verified by cmdline
 * before kill); `status` health-checks it.
 *
 * **Durability:** every Save dual-writes `<name>.json` (structured) +
 * `<name>.md` (readable; in doc mode the edited doc itself) + a timestamped
 * `<name>.log.md` append-log into `outDir` — a save can never silently lose
 * prior state. `collect` additionally records the result into the swamp data
 * model so workflows consume it via
 * `data.latest("<instance>", "result-<name>")`.
 *
 * **Security scope:** secure private networks ONLY. The per-session URL token
 * is an abuse/CSRF guard, not internet-grade auth; the token is deliberately
 * visible (the operator must open the URL). Do not expose the port publicly.
 *
 * @module
 */

import { z } from "npm:zod@4";
import {
  GlobalArgsSchema,
  NameArgsSchema,
  ResultSchema,
  ServeArgsSchema,
  SessionSchema,
} from "./schemas.ts";
import type { GlobalArgs, ServeArgs, Session } from "./schemas.ts";

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
  extensionFile: (relPath: string) => string;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
}

interface MethodResult {
  dataHandles: DataHandle[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Output paths for a session, all rooted in the model's outDir. */
export function sessionPaths(outDir: string, name: string): {
  specPath: string;
  savePath: string;
  mdPath: string;
  logPath: string;
  serverLogPath: string;
} {
  return {
    specPath: `${outDir}/.review.${name}.spec.json`,
    savePath: `${outDir}/${name}.json`,
    mdPath: `${outDir}/${name}.md`,
    logPath: `${outDir}/${name}.log.md`,
    serverLogPath: `${outDir}/.review.${name}.server.log`,
  };
}

/**
 * Is `pid` alive AND one of OUR servers for this spec? Reads
 * `/proc/<pid>/cmdline` and requires both the server script name and the
 * exact spec path — never trust a recycled pid (verify before kill).
 */
export async function pidMatchesSession(
  pid: number,
  specPath: string,
): Promise<boolean> {
  try {
    const raw = await Deno.readTextFile(`/proc/${pid}/cmdline`);
    const argv = raw.split("\0");
    return argv.some((a) => a.endsWith("server_py.txt")) &&
      argv.includes(specPath);
  } catch {
    return false; // no such pid (or not linux-procfs) → treat as not ours
  }
}

/**
 * Identity-checked liveness: /ping must answer 200 **with this session's
 * token** and report this session's name. This is the primary liveness/identity
 * mechanism — it works from sandboxed method runtimes where /proc is
 * unreadable, and a token+name match can't be a stranger's process.
 */
async function pingSession(
  port: number,
  token: string,
  name: string,
): Promise<boolean> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${port}/ping?t=${encodeURIComponent(token)}`,
      { signal: AbortSignal.timeout(1500) },
    );
    if (!res.ok) {
      await res.body?.cancel();
      return false;
    }
    const j = await res.json() as { name?: string };
    return j.name === name;
  } catch {
    return false;
  }
}

/** Poll the server's /ping until it answers or the deadline passes. */
async function waitForPing(url: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const res = await fetch(url, { signal: AbortSignal.timeout(1000) });
      await res.body?.cancel();
      if (res.ok) return true;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  return false;
}

/**
 * Stop a session's server: token-authenticated POST /shutdown (the polite,
 * sandbox-safe path), wait for the port to drop, and only then fall back to a
 * cmdline-verified SIGTERM. Returns true when the server is down.
 */
async function shutdownSession(session: Session): Promise<boolean> {
  try {
    const res = await fetch(
      `http://127.0.0.1:${session.port}/shutdown?t=${
        encodeURIComponent(session.token)
      }`,
      { method: "POST", signal: AbortSignal.timeout(2000) },
    );
    await res.body?.cancel();
  } catch {
    // not answering — maybe already down
  }
  const deadline = Date.now() + 4000;
  while (Date.now() < deadline) {
    if (!(await pingSession(session.port, session.token, session.name))) {
      return true;
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  // Last resort — only signal a pid we can positively verify as ours.
  if (await pidMatchesSession(session.pid, session.specPath)) {
    Deno.kill(session.pid, "SIGTERM");
    return true;
  }
  return false;
}

/** Spawn the bundled server detached and wait until it answers /ping. */
async function spawnServer(
  ctx: MethodContext,
  opts: {
    name: string;
    specPath: string;
    serverLogPath: string;
    bind: string;
    port: number;
    token: string;
  },
): Promise<number> {
  const serverPy = ctx.extensionFile("server_py.txt");
  const child = new Deno.Command("python3", {
    args: [
      serverPy,
      "--spec",
      opts.specPath,
      "--bind",
      opts.bind,
      "--port",
      String(opts.port),
      "--token",
      opts.token,
    ],
    stdin: "null",
    stdout: "null",
    stderr: "null",
  }).spawn();
  const pid = child.pid;
  child.unref();

  const pingUrl = `http://127.0.0.1:${opts.port}/ping?t=${opts.token}`;
  if (!(await waitForPing(pingUrl, 5000))) {
    let tail = "";
    try {
      const log = await Deno.readTextFile(opts.serverLogPath);
      tail = log.trim().split("\n").slice(-3).join(" | ");
    } catch { /* no server log yet */ }
    throw new Error(
      `review server for '${opts.name}' did not answer on port ${opts.port} ` +
        `(port in use? python3 missing?). server log: ${tail || "<empty>"}`,
    );
  }
  return pid;
}

/** Mode-dependent result summary: disposition counts, or doc size/verdict. */
export function summarize(
  mode: "list" | "doc",
  data: Record<string, unknown>,
  optionScale: string[],
): Record<string, number | string> {
  if (mode === "list") {
    const items = Array.isArray(data.items) ? data.items : [];
    const counts: Record<string, number | string> = { total: items.length };
    const scale = optionScale.length ? optionScale : [
      ...new Set(
        items.map((i) =>
          String((i as { disposition?: string }).disposition ?? "")
        ),
      ),
    ];
    for (const v of scale) {
      counts[v] = items.filter(
        (i) => (i as { disposition?: string }).disposition === v,
      ).length;
    }
    return counts;
  }
  const files = Array.isArray(data.files) ? data.files : [];
  if (files.length > 0) {
    const enc = new TextEncoder();
    const out: Record<string, number | string> = {
      files: files.length,
      bytes: files.reduce(
        (n, f) =>
          n + enc.encode(String((f as { content?: string }).content ?? ""))
            .length,
        0,
      ),
      verdict: typeof data.verdict === "string" ? data.verdict : "",
    };
    for (const v of optionScale) {
      out[v] = files.filter(
        (f) => (f as { verdict?: string }).verdict === v,
      ).length;
    }
    return out;
  }
  const content = typeof data.content === "string" ? data.content : "";
  return {
    bytes: new TextEncoder().encode(content).length,
    lines: content.length === 0 ? 0 : content.split("\n").length,
    verdict: typeof data.verdict === "string" ? data.verdict : "",
  };
}

function nowIso(): string {
  return new Date().toISOString();
}

async function readSession(
  ctx: MethodContext,
  name: string,
): Promise<Session | null> {
  const raw = await ctx.readResource(`session-${name}`);
  if (!raw) return null;
  const parsed = SessionSchema.safeParse(raw);
  return parsed.success ? parsed.data : null;
}

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

/** The `@stateless/review` model definition. */
export const model = {
  type: "@stateless/review",
  version: "2026.06.12.4",
  globalArguments: GlobalArgsSchema,
  resources: {
    session: {
      description:
        "A canvas session — URL/token/pid of the served form and its output paths.",
      schema: SessionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    result: {
      description:
        "A collected review result — the human's saved decisions/edits plus a summary.",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    serve: {
      description:
        "Start (detached) the review canvas for one session and record its URL. " +
        "Idempotent per name: an already-running session is reused — run " +
        "`restart` instead to replace it (e.g. after changing the spec).",
      arguments: ServeArgsSchema,
      execute: async (
        args: ServeArgs,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const { outDir, bind } = ctx.globalArgs;
        const port = args.port ?? ctx.globalArgs.port;
        const paths = sessionPaths(outDir, args.name);

        // Reuse an existing live server for this name (ensure-exists).
        const existing = await readSession(ctx, args.name);
        if (
          existing &&
          await pingSession(existing.port, existing.token, existing.name)
        ) {
          ctx.logger.info(
            "already serving '{name}' — reusing. Open: {url} (run restart to replace)",
            { name: args.name, url: existing.url },
          );
          const handle = await ctx.writeResource(
            "session",
            `session-${args.name}`,
            { ...existing, status: "serving", updatedAt: nowIso() },
          );
          return { dataHandles: [handle] };
        }

        // Resolve doc content (inline wins; otherwise read the file).
        let content = args.content;
        if (
          args.mode === "doc" && !content && args.files.length === 0
        ) {
          content = await Deno.readTextFile(args.contentPath);
        }
        // Resolve the multi-file "directory" — paths are read at serve time.
        const files = [];
        for (const f of args.files) {
          files.push({
            name: f.name,
            title: f.title || f.name,
            content: f.content || await Deno.readTextFile(f.path),
          });
        }

        await Deno.mkdir(outDir, { recursive: true });
        const spec = {
          name: args.name,
          title: args.title || args.name,
          mode: args.mode,
          outDir,
          optionScale: args.optionScale,
          contexts: args.contexts,
          items: args.items,
          content,
          files,
          instructions: args.instructions,
        };
        await Deno.writeTextFile(paths.specPath, JSON.stringify(spec, null, 2));

        const token = crypto.randomUUID().replaceAll("-", "");
        const pid = await spawnServer(ctx, {
          name: args.name,
          specPath: paths.specPath,
          serverLogPath: paths.serverLogPath,
          bind,
          port,
          token,
        });

        const host = bind === "0.0.0.0" ? Deno.hostname() : bind;
        const url = `http://${host}:${port}/?t=${token}`;
        const session: Session = {
          name: args.name,
          mode: args.mode,
          title: spec.title,
          url,
          token,
          pid,
          port,
          bind,
          outDir,
          ...paths,
          status: "serving",
          startedAt: nowIso(),
          updatedAt: nowIso(),
        };
        const handle = await ctx.writeResource(
          "session",
          `session-${args.name}`,
          session,
        );
        ctx.logger.info("serving '{name}' ({mode}) — open: {url}", {
          name: args.name,
          mode: args.mode,
          url,
        });
        return { dataHandles: [handle] };
      },
    },

    status: {
      description:
        "Health-check a session: server alive? has the human saved yet? " +
        "Records the refreshed session state.",
      arguments: NameArgsSchema,
      execute: async (
        args: z.infer<typeof NameArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const session = await readSession(ctx, args.name);
        if (!session) {
          throw new Error(`no session '${args.name}' — run serve first`);
        }
        const alive = await pingSession(
          session.port,
          session.token,
          session.name,
        );
        let savedAt = "";
        try {
          const stat = await Deno.stat(session.savePath);
          savedAt = stat.mtime?.toISOString() ?? "";
        } catch { /* not saved yet */ }
        const status = alive
          ? "serving"
          : (session.status === "stopped" ? "stopped" : "dead");
        ctx.logger.info(
          "'{name}': server {state}, save {save}",
          {
            name: args.name,
            state: alive
              ? `alive (pid ${session.pid}) — ${session.url}`
              : status,
            save: savedAt ? `present (${savedAt})` : "absent (not saved yet)",
          },
        );
        const handle = await ctx.writeResource(
          "session",
          `session-${args.name}`,
          { ...session, status, updatedAt: nowIso() },
        );
        return { dataHandles: [handle] };
      },
    },

    collect: {
      description:
        "Read the human's saved result from disk and record it as a `result` " +
        "resource (works even after the server has stopped). Throws if the " +
        "human has not saved yet.",
      arguments: NameArgsSchema,
      execute: async (
        args: z.infer<typeof NameArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const { outDir } = ctx.globalArgs;
        const paths = sessionPaths(outDir, args.name);
        let raw: string;
        try {
          raw = await Deno.readTextFile(paths.savePath);
        } catch {
          throw new Error(
            `no save for '${args.name}' at ${paths.savePath} — ` +
              "the human hasn't hit Save yet (check status)",
          );
        }
        const data = JSON.parse(raw) as Record<string, unknown>;
        const session = await readSession(ctx, args.name);
        const mode = (data.mode === "doc" || session?.mode === "doc")
          ? "doc" as const
          : "list" as const;
        // Recover the scale from the spec for stable summary keys.
        let optionScale: string[] = [];
        try {
          const spec = JSON.parse(await Deno.readTextFile(paths.specPath));
          if (Array.isArray(spec.optionScale)) optionScale = spec.optionScale;
        } catch { /* spec gone — summarize from data alone */ }

        const result = {
          name: args.name,
          mode,
          collectedAt: nowIso(),
          savedAt: typeof data.savedAt === "string" ? data.savedAt : "",
          verdict: typeof data.verdict === "string" ? data.verdict : "",
          notes: typeof data.notes === "string" ? data.notes : "",
          summary: summarize(mode, data, optionScale),
          data,
          savePath: paths.savePath,
          mdPath: paths.mdPath,
        };
        const handle = await ctx.writeResource(
          "result",
          `result-${args.name}`,
          result,
        );
        ctx.logger.info("collected '{name}': {summary}", {
          name: args.name,
          summary: JSON.stringify(result.summary),
        });
        return { dataHandles: [handle] };
      },
    },

    stop: {
      description:
        "Stop a session's server via its token-authenticated /shutdown " +
        "endpoint (cmdline-verified SIGTERM only as fallback). Saved " +
        "artifacts stay on disk — collect still works afterwards.",
      arguments: NameArgsSchema,
      execute: async (
        args: z.infer<typeof NameArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const session = await readSession(ctx, args.name);
        if (!session) {
          throw new Error(`no session '${args.name}' — nothing to stop`);
        }
        if (await pingSession(session.port, session.token, session.name)) {
          if (!(await shutdownSession(session))) {
            throw new Error(
              `'${args.name}' is still answering on port ${session.port} and ` +
                `pid ${session.pid} could not be verified as ours — ` +
                `stop it manually (fuser -k ${session.port}/tcp)`,
            );
          }
          ctx.logger.info("stopped '{name}'", { name: args.name });
        } else {
          ctx.logger.warning(
            "'{name}' server already gone — recording stopped",
            { name: args.name },
          );
        }
        const handle = await ctx.writeResource(
          "session",
          `session-${args.name}`,
          { ...session, status: "stopped", updatedAt: nowIso() },
        );
        return { dataHandles: [handle] };
      },
    },

    restart: {
      description:
        "Stop (if running) and start a session's server again from its saved " +
        "spec — same URL/token/port, so open browser tabs keep working. Use " +
        "after a server-code update or a wedged server; re-run serve to " +
        "change the spec itself.",
      arguments: NameArgsSchema,
      execute: async (
        args: z.infer<typeof NameArgsSchema>,
        ctx: MethodContext,
      ): Promise<MethodResult> => {
        const session = await readSession(ctx, args.name);
        if (!session) {
          throw new Error(`no session '${args.name}' — run serve first`);
        }
        try {
          await Deno.stat(session.specPath);
        } catch {
          throw new Error(
            `spec ${session.specPath} is gone — re-run serve to recreate it`,
          );
        }
        if (await pingSession(session.port, session.token, session.name)) {
          if (!(await shutdownSession(session))) {
            throw new Error(
              `'${args.name}' would not shut down on port ${session.port} — ` +
                `stop it manually (fuser -k ${session.port}/tcp), then retry`,
            );
          }
        }
        const pid = await spawnServer(ctx, {
          name: session.name,
          specPath: session.specPath,
          serverLogPath: session.serverLogPath,
          bind: session.bind,
          port: session.port,
          token: session.token,
        });
        const handle = await ctx.writeResource(
          "session",
          `session-${args.name}`,
          {
            ...session,
            pid,
            status: "serving",
            startedAt: nowIso(),
            updatedAt: nowIso(),
          },
        );
        ctx.logger.info("restarted '{name}' — open: {url}", {
          name: args.name,
          url: session.url,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
