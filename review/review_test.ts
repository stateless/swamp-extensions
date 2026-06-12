/**
 * Tests for `@stateless/review` — schema validation, pure helpers, and a
 * gated end-to-end exercise of the bundled Python server (skipped when
 * python3 is unavailable).
 *
 * @module
 */

import {
  assert,
  assertEquals,
  assertFalse,
} from "jsr:@std/assert@1";
import { ItemSchema, ServeArgsSchema, SessionSchema } from "./schemas.ts";
import { pidMatchesSession, sessionPaths, summarize } from "./review.ts";

// ---------------------------------------------------------------------------
// Schemas
// ---------------------------------------------------------------------------

Deno.test("ServeArgs: list mode requires items", () => {
  const bad = ServeArgsSchema.safeParse({ name: "gate", mode: "list" });
  assertFalse(bad.success);
  const ok = ServeArgsSchema.safeParse({
    name: "gate",
    mode: "list",
    items: [{ name: "thing" }],
  });
  assert(ok.success);
  assertEquals(ok.data!.optionScale, []); // server defaults keep/decide/drop
});

Deno.test("ServeArgs: doc mode requires content, contentPath, or files", () => {
  const bad = ServeArgsSchema.safeParse({ name: "doc", mode: "doc" });
  assertFalse(bad.success);
  const byFiles = ServeArgsSchema.safeParse({
    name: "doc",
    mode: "doc",
    files: [{ name: "brief", path: "/tmp/brief.md" }],
  });
  assert(byFiles.success);
  const fileNeedsSource = ServeArgsSchema.safeParse({
    name: "doc",
    mode: "doc",
    files: [{ name: "brief" }],
  });
  assertFalse(fileNeedsSource.success);
  const inline = ServeArgsSchema.safeParse({
    name: "doc",
    mode: "doc",
    content: "# hi",
  });
  assert(inline.success);
  const byPath = ServeArgsSchema.safeParse({
    name: "doc",
    mode: "doc",
    contentPath: "/tmp/x.md",
  });
  assert(byPath.success);
});

Deno.test("ServeArgs: name must be a safe slug", () => {
  assertFalse(ServeArgsSchema.safeParse({
    name: "../escape",
    mode: "doc",
    content: "x",
  }).success);
  assertFalse(ServeArgsSchema.safeParse({
    name: "Has Spaces",
    mode: "doc",
    content: "x",
  }).success);
  assert(ServeArgsSchema.safeParse({
    name: "app-gate.v2",
    mode: "doc",
    content: "x",
  }).success);
});

Deno.test("ItemSchema defaults optional fields", () => {
  const it = ItemSchema.parse({ name: "restic" });
  assertEquals(it.group, "");
  assertEquals(it.recommendation, "");
});

Deno.test("SessionSchema round-trips a full session", () => {
  const paths = sessionPaths("/tmp/out", "gate");
  const s = SessionSchema.parse({
    name: "gate",
    mode: "list",
    title: "Gate",
    url: "http://host:8800/?t=abc",
    token: "abc",
    pid: 1234,
    port: 8800,
    bind: "0.0.0.0",
    outDir: "/tmp/out",
    ...paths,
    status: "serving",
    startedAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  });
  assertEquals(s.savePath, "/tmp/out/gate.json");
  assertEquals(s.specPath, "/tmp/out/.review.gate.spec.json");
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

Deno.test("summarize: list counts dispositions on the given scale", () => {
  const data = {
    items: [
      { name: "a", disposition: "keep" },
      { name: "b", disposition: "keep" },
      { name: "c", disposition: "drop" },
    ],
  };
  const s = summarize("list", data, ["keep", "decide", "drop"]);
  assertEquals(s, { total: 3, keep: 2, decide: 0, drop: 1 });
});

Deno.test("summarize: multi-file doc counts per-file verdicts", () => {
  const s = summarize("doc", {
    verdict: "approve",
    files: [
      { name: "a", content: "12345", verdict: "approve" },
      { name: "b", content: "678", verdict: "revise" },
    ],
  }, ["approve", "revise", "reject"]);
  assertEquals(s, {
    files: 2,
    bytes: 8,
    verdict: "approve",
    approve: 1,
    revise: 1,
    reject: 0,
  });
});

Deno.test("summarize: doc reports bytes/lines/verdict", () => {
  const s = summarize("doc", {
    content: "line1\nline2",
    verdict: "approve",
  }, []);
  assertEquals(s.lines, 2);
  assertEquals(s.verdict, "approve");
  assertEquals(s.bytes, 11);
});

Deno.test("pidMatchesSession: rejects a foreign pid", async () => {
  // pid 1 exists but is not our server
  assertFalse(await pidMatchesSession(1, "/tmp/nope.spec.json"));
  // an absurd pid does not exist
  assertFalse(await pidMatchesSession(999999999, "/tmp/nope.spec.json"));
});

// ---------------------------------------------------------------------------
// Embedded markdown renderer (extracted from the python source and executed)
// ---------------------------------------------------------------------------

type MdRender = (src: string, isTop?: boolean) => string;
type MdBlocks = (src: string, isTop?: boolean) => { l: number; h: string }[];

async function loadMd(): Promise<{ mdRender: MdRender; mdBlocks: MdBlocks }> {
  const py = await Deno.readTextFile(
    new URL("./server_py.txt", import.meta.url),
  );
  const m = py.match(/MD_JS = """\n([\s\S]*?)\n"""/);
  if (!m) throw new Error("MD_JS block not found in server_py.txt");
  // Render the python string literal: the only escapes used are \\ pairs.
  const js = m[1].replaceAll("\\\\", "\\");
  return new Function(
    js + "\nreturn {mdRender: mdRender, mdBlocks: mdBlocks};",
  )() as { mdRender: MdRender; mdBlocks: MdBlocks };
}

async function loadMdRender(): Promise<MdRender> {
  return (await loadMd()).mdRender;
}

Deno.test("mdRender: frontmatter block at top level only", async () => {
  const mdRender = await loadMdRender();
  const out = mdRender("---\ndate: 2026-06-12\ntag:\n  - test\n---\n# Title", true);
  assert(out.includes('class="fm"'), "frontmatter block missing");
  assert(out.includes("date: 2026-06-12"));
  assert(out.includes("<h1>Title</h1>"));
  const sub = mdRender("---\nx: y\n---", false);
  assertFalse(sub.includes('class="fm"'), "fm must not render off top level");
  assert(sub.includes("<hr>"));
  mdRender("---\nunterminated", true); // must not throw
});

Deno.test("mdRender: all five CriticMarkup marks", async () => {
  const mdRender = await loadMdRender();
  const out = mdRender(
    "a {++added++} b {--gone--} c {~~old~>new~~} d {==hot==}{>>why<<} e {>>solo<<}",
    true,
  );
  assert(out.includes("<ins>added</ins>"), "addition");
  assert(out.includes("<del>gone</del>"), "deletion");
  assert(out.includes("<del>old</del><ins>new</ins>"), "substitution");
  assert(out.includes("<mark>hot</mark>"), "highlight");
  assert(out.includes('<span class="critc">why</span>'), "paired comment");
  assert(out.includes('<span class="critc">solo</span>'), "solo comment");
});

Deno.test("mdRender: strikethrough + ==highlight== coexist with Critic", async () => {
  const mdRender = await loadMdRender();
  const out = mdRender(
    "~~struck~~ and ==hot== and {~~old~>new~~} and {==cm==}{>>note<<}",
    true,
  );
  assert(out.includes("<s>struck</s>"), "plain strikethrough");
  assert(out.includes("<mark>hot</mark>"), "markdown highlight");
  assert(out.includes("<del>old</del><ins>new</ins>"), "substitution intact");
  assert(out.includes("<mark>cm</mark>"), "critic highlight intact");
  assert(out.includes('<span class="critc">note</span>'), "comment intact");
});

Deno.test("mdBlocks: source-line stamps and local-edit stability", async () => {
  const { mdBlocks } = await loadMd();
  const src = "# Title\n\npara one\n\n- a\n- b\n\npara two";
  const blocks = mdBlocks(src, true);
  assertEquals(blocks.map((b) => b.l), [0, 2, 4, 7]);
  assert(blocks[2].h.startsWith("<ul>"));
  // editing one paragraph leaves every other block's html identical
  const edited = mdBlocks(
    "# Title\n\npara one EDITED\n\n- a\n- b\n\npara two",
    true,
  );
  assertEquals(edited.length, blocks.length);
  const changed = blocks.filter((b, i) => edited[i].h !== b.h);
  assertEquals(changed.length, 1);
  assert(edited[1].h.includes("EDITED"));
});

// ---------------------------------------------------------------------------
// End-to-end server exercise (needs python3 + a listening socket)
// ---------------------------------------------------------------------------

const havePython = await (async () => {
  try {
    const out = await new Deno.Command("python3", { args: ["--version"] })
      .output();
    return out.success;
  } catch {
    return false;
  }
})();

Deno.test({
  name: "server: serve → ping → save → artifacts on disk",
  ignore: !havePython,
  fn: async () => {
    const outDir = await Deno.makeTempDir({ prefix: "review-test-" });
    const port = 18923;
    const token = "testtoken123";
    const spec = {
      name: "e2e",
      title: "E2E",
      mode: "list",
      outDir,
      optionScale: ["keep", "drop"],
      contexts: [],
      items: [{ name: "restic", group: "Backup", meta: "apt", note: "" }],
      content: "",
      instructions: "",
    };
    const specPath = `${outDir}/.review.e2e.spec.json`;
    await Deno.writeTextFile(specPath, JSON.stringify(spec));
    const serverPy = new URL("./server_py.txt", import.meta.url).pathname;
    const child = new Deno.Command("python3", {
      args: [
        serverPy,
        "--spec",
        specPath,
        "--bind",
        "127.0.0.1",
        "--port",
        String(port),
        "--token",
        token,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      // wait for /ping
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/ping?t=${token}`,
            { signal: AbortSignal.timeout(500) },
          );
          up = res.ok;
          await res.body?.cancel();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert(up, "server never answered /ping");

      // bad token → 403
      const forbidden = await fetch(`http://127.0.0.1:${port}/?t=wrong`);
      assertEquals(forbidden.status, 403);
      await forbidden.body?.cancel();

      // page renders the item
      const page = await fetch(`http://127.0.0.1:${port}/?t=${token}`);
      const htmlBody = await page.text();
      assert(htmlBody.includes("restic"));
      assert(htmlBody.includes("Backup"));

      // save a gated result
      const save = await fetch(`http://127.0.0.1:${port}/save?t=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "looks fine",
          items: [{
            name: "restic",
            group: "Backup",
            disposition: "keep",
            context: "",
            comment: "fleet standard",
          }],
        }),
      });
      const saved = await save.json();
      assert(saved.ok);

      const json = JSON.parse(await Deno.readTextFile(`${outDir}/e2e.json`));
      assertEquals(json.items[0].disposition, "keep");
      const md = await Deno.readTextFile(`${outDir}/e2e.md`);
      assert(md.includes("**keep** (1): restic"));
      const log = await Deno.readTextFile(`${outDir}/e2e.log.md`);
      assert(log.includes("(1 items)"));

      // token-authenticated self-shutdown: bad token refused, good token exits
      const noAuth = await fetch(
        `http://127.0.0.1:${port}/shutdown?t=wrong`,
        { method: "POST" },
      );
      assertEquals(noAuth.status, 403);
      await noAuth.body?.cancel();
      const down = await fetch(
        `http://127.0.0.1:${port}/shutdown?t=${token}`,
        { method: "POST" },
      );
      assert((await down.json()).stopping);
      const exit = await child.status;
      assertEquals(exit.code, 0);
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already dead */ }
      await child.status;
      await Deno.remove(outDir, { recursive: true });
    }
  },
});

Deno.test({
  name: "server: multi-file doc — directory listing + per-file saves",
  ignore: !havePython,
  fn: async () => {
    const outDir = await Deno.makeTempDir({ prefix: "review-test-" });
    const port = 18924;
    const token = "testtoken456";
    const spec = {
      name: "docs",
      title: "Doc review",
      mode: "doc",
      outDir,
      optionScale: ["approve", "revise", "reject"],
      contexts: [],
      items: [],
      content: "",
      files: [
        { name: "brief", title: "Design brief", content: "# Brief\nhello" },
        { name: "model", title: "Platform model", content: "# Model\nworld" },
      ],
      instructions: "",
    };
    const specPath = `${outDir}/.review.docs.spec.json`;
    await Deno.writeTextFile(specPath, JSON.stringify(spec));
    const serverPy = new URL("./server_py.txt", import.meta.url).pathname;
    const child = new Deno.Command("python3", {
      args: [
        serverPy,
        "--spec",
        specPath,
        "--bind",
        "127.0.0.1",
        "--port",
        String(port),
        "--token",
        token,
      ],
      stdin: "null",
      stdout: "null",
      stderr: "null",
    }).spawn();
    try {
      let up = false;
      for (let i = 0; i < 40 && !up; i++) {
        try {
          const res = await fetch(
            `http://127.0.0.1:${port}/ping?t=${token}`,
            { signal: AbortSignal.timeout(500) },
          );
          up = res.ok;
          await res.body?.cancel();
        } catch {
          await new Promise((r) => setTimeout(r, 100));
        }
      }
      assert(up, "server never answered /ping");

      // directory listing renders both files
      const page = await fetch(`http://127.0.0.1:${port}/?t=${token}`);
      const htmlBody = await page.text();
      assert(htmlBody.includes("Design brief"));
      assert(htmlBody.includes("Platform model"));
      assert(htmlBody.includes('id="dir"'));

      // save: one file edited + per-file verdicts + overall verdict
      const save = await fetch(`http://127.0.0.1:${port}/save?t=${token}`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          notes: "second doc needs work",
          verdict: "revise",
          files: [
            {
              name: "brief",
              title: "Design brief",
              content: "# Brief\nhello EDITED",
              verdict: "approve",
              comment: "",
            },
            {
              name: "model",
              title: "Platform model",
              content: "# Model\nworld",
              verdict: "revise",
              comment: "tighten section 2",
            },
          ],
        }),
      });
      const saved = await save.json();
      assert(saved.ok);

      // per-file markdown carries the edit; index summarises verdicts
      const brief = await Deno.readTextFile(`${outDir}/docs.brief.md`);
      assert(brief.includes("hello EDITED"));
      const index = await Deno.readTextFile(`${outDir}/docs.md`);
      assert(index.includes("**Verdict:** revise"));
      assert(index.includes("**approve**"));
      assert(index.includes("tighten section 2"));
      const log = await Deno.readTextFile(`${outDir}/docs.log.md`);
      assert(log.includes("(2 files)"));

      // reload prefills from the save (resume)
      const page2 = await fetch(`http://127.0.0.1:${port}/?t=${token}`);
      const htmlBody2 = await page2.text();
      assert(htmlBody2.includes("hello EDITED"));
    } finally {
      try {
        child.kill("SIGTERM");
      } catch { /* already dead */ }
      await child.status;
      await Deno.remove(outDir, { recursive: true });
    }
  },
});
