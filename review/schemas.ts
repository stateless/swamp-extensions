/**
 * Zod schemas for `@stateless/review` — kept out of the entrypoint so the
 * model export stays free of slow types.
 *
 * @module
 */

import { z } from "npm:zod@4";

/** A short filesystem-safe session slug (becomes the output file basename). */
export const NameSchema = z
  .string()
  .regex(
    /^[a-z0-9][a-z0-9._-]*$/,
    "lowercase slug: letters/digits then [a-z0-9._-]",
  );

/** One candidate row in a list-mode session. */
export const ItemSchema = z.object({
  /** Display name — also the identity key when prefilling from a prior save. */
  name: z.string().min(1),
  /** Section heading the item is grouped under (rendered in input order). */
  group: z.string().default(""),
  /** Free-text metadata shown beside the name (origin, target, size, …). */
  meta: z.string().default(""),
  /** Prefilled disposition — must be a value from the session's optionScale. */
  recommendation: z.string().default(""),
  /** Reviewer-facing hint rendered inline (italic). */
  note: z.string().default(""),
  /** Prefilled context — must be a value from the session's contexts. */
  context: z.string().default(""),
});

/** One file in a multi-file doc session (the "directory" listing). */
export const FileSchema = z
  .object({
    /** File slug — keys the per-file output `<session>.<name>.md`. */
    name: NameSchema,
    /** Display title in the directory listing (defaults to the name). */
    title: z.string().default(""),
    /** Markdown content, inline. */
    content: z.string().default(""),
    /** Or a file path to read the markdown from at serve time. */
    path: z.string().default(""),
  })
  .check((ctx) => {
    if (!ctx.value.content && !ctx.value.path) {
      ctx.issues.push({
        code: "custom",
        message: "file needs content or path",
        input: ctx.value.name,
        path: ["content"],
      });
    }
  });

/** Model-instance configuration: where the canvas binds and writes. */
export const GlobalArgsSchema = z.object({
  /**
   * Directory where session artifacts are written (`<name>.json`, `<name>.md`,
   * `<name>.log.md`, plus dot-prefixed spec/server-log files). This is the
   * on-disk collaboration point the agent diffs/collects from.
   *
   * MUST be absolute. A relative outDir resolves against the detached server's
   * working directory — not the caller's — which silently buries saves in a
   * stray `tmp/` (the CWD split-brain bug). Be deliberate: pass an explicit
   * absolute directory.
   */
  outDir: z
    .string()
    .min(1)
    .refine((p) => p.startsWith("/"), {
      message:
        "outDir must be an ABSOLUTE path — a relative outDir resolves against " +
        "the detached server's working directory and silently buries saves " +
        "(the tmp/ split-brain). Pass an explicit absolute directory.",
    }),
  /** Listen address. Default binds the LAN — private networks only. */
  bind: z.string().default("0.0.0.0"),
  /** Default listen port (a serve call may override per-session). */
  port: z.number().int().min(1).max(65535).default(8800),
});

/** Arguments for `serve` — one review session described declaratively. */
export const ServeArgsSchema = z
  .object({
    /** Session slug — keys the output files and the stored resources. */
    name: NameSchema,
    /** Page title (defaults to the name). */
    title: z.string().default(""),
    /** Canvas mode: curation grid or markdown editor+preview. */
    mode: z.enum(["list", "doc"]),
    /** list mode: the candidate rows to gate. */
    items: z.array(ItemSchema).default([]),
    /**
     * The option scale rendered as radios. list mode default:
     * keep/decide/drop. doc mode: optional — when set it renders a verdict
     * row (e.g. approve/revise/reject) for publish gates.
     */
    optionScale: z.array(z.string().min(1)).default([]),
    /** list mode: optional secondary per-item select (e.g. usage contexts). */
    contexts: z.array(z.string().min(1)).default([]),
    /** doc mode: the markdown to review, inline. */
    content: z.string().default(""),
    /** doc mode: or a file path to read the markdown from. */
    contentPath: z.string().default(""),
    /**
     * doc mode: MULTIPLE files to review. Renders a directory listing above
     * the editor — each file gets a per-file verdict (when optionScale is
     * set) + comment, so the listing doubles as a checklist over the files.
     */
    files: z.array(FileSchema).default([]),
    /**
     * doc mode: ALSO persist each edited doc to a co-located
     * `<source>.webcanvas.md` sidecar (in addition to the outDir artifacts,
     * which stay the system of record). Lets the human's edits land beside the
     * source they came from, and a re-`serve` resume from the sidecar.
     * Requires real source paths to sit beside — set `path`/`contentPath`, not
     * inline `content`. Off by default.
     */
    sidecar: z.boolean().default(false),
    /** Legend text shown in the bottom bar (defaults derived from the mode). */
    instructions: z.string().default(""),
    /** Override the model's default port for this session. */
    port: z.number().int().min(1).max(65535).optional(),
  })
  .check((ctx) => {
    const v = ctx.value;
    if (v.mode === "list" && v.items.length === 0) {
      ctx.issues.push({
        code: "custom",
        message: "list mode requires at least one item",
        input: v.items,
        path: ["items"],
      });
    }
    if (
      v.mode === "doc" && !v.content && !v.contentPath && v.files.length === 0
    ) {
      ctx.issues.push({
        code: "custom",
        message: "doc mode requires content, contentPath, or files",
        input: v.content,
        path: ["content"],
      });
    }
    if (v.sidecar) {
      if (v.mode !== "doc") {
        ctx.issues.push({
          code: "custom",
          message: "sidecar is doc-mode only",
          input: v.mode,
          path: ["sidecar"],
        });
      }
      // A sidecar must sit beside a real source file — inline content has no
      // source path to co-locate against.
      const inlineFiles = v.files.length > 0 && v.files.some((f) => !f.path);
      const inlineSingle = v.files.length === 0 && !v.contentPath;
      if (inlineFiles || inlineSingle) {
        ctx.issues.push({
          code: "custom",
          message: "sidecar requires source paths to write beside — use path/" +
            "contentPath, not inline content",
          input: v.sidecar,
          path: ["sidecar"],
        });
      }
    }
  });

/** Arguments for `collect` / `status` / `stop` — address a session by name. */
export const NameArgsSchema = z.object({
  /** The session slug given to `serve`. */
  name: NameSchema,
});

/** A live/stopped canvas session (resource `session`). */
export const SessionSchema = z.object({
  name: z.string(),
  mode: z.enum(["list", "doc"]),
  title: z.string(),
  /** The URL (with token) the human opens. LAN-scoped, deliberately visible. */
  url: z.string(),
  token: z.string(),
  pid: z.number().int(),
  port: z.number().int(),
  bind: z.string(),
  outDir: z.string(),
  specPath: z.string(),
  savePath: z.string(),
  mdPath: z.string(),
  logPath: z.string(),
  serverLogPath: z.string(),
  status: z.enum(["serving", "stopped", "dead"]),
  startedAt: z.iso.datetime(),
  updatedAt: z.iso.datetime(),
});

/** A collected review result (resource `result`). */
export const ResultSchema = z.object({
  name: z.string(),
  mode: z.enum(["list", "doc"]),
  collectedAt: z.iso.datetime(),
  /** `savedAt` stamped by the server at the human's last Save. */
  savedAt: z.string().default(""),
  /** doc mode: the human's verdict radio, when an optionScale was set. */
  verdict: z.string().default(""),
  /** The human's free-text notes from the header field. */
  notes: z.string().default(""),
  /** Mode-dependent summary: per-disposition counts, or bytes/lines/sha. */
  summary: z.record(z.string(), z.union([z.number(), z.string()])),
  /** The full saved payload (`<name>.json`) for downstream CEL access. */
  data: z.looseObject({}),
  savePath: z.string(),
  mdPath: z.string(),
});

export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;
export type ServeArgs = z.infer<typeof ServeArgsSchema>;
export type NameArgs = z.infer<typeof NameArgsSchema>;
export type Session = z.infer<typeof SessionSchema>;
export type ReviewResult = z.infer<typeof ResultSchema>;
