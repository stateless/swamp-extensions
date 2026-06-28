/**
 * Unit + integration tests for `@stateless/redaction`. Targets the pure
 * recognizer/scan/redact logic (deterministic, no IO) plus one method-level
 * test that walks a temp dir and exercises the hard-halt (failOnHit) gate.
 *
 * @module
 */

import { assert, assertEquals, assertRejects } from "jsr:@std/assert";
import {
  buildRecognizers,
  deriveDenylist,
  domainOf,
  model,
  redactText,
  scanText,
} from "./redaction.ts";
import { GlobalArgsSchema, type Hit } from "./schemas.ts";

const rules = (deny: string[] = [], custom = []) =>
  buildRecognizers(deny, custom);
const scan = (t: string, deny: string[] = []) => scanText(t, rules(deny));
const ruleNames = (hits: Hit[]) => hits.map((h) => h.rule).sort();

// --- generics: private IPv4 -------------------------------------------------

Deno.test("private IPv4: all four private/CGNAT ranges are caught", () => {
  for (
    const ip of [
      "10.0.0.5",
      "192.168.1.1",
      "172.16.0.1",
      "172.31.255.1",
      "100.64.0.1",
      "100.127.3.9",
    ]
  ) {
    const h = scan(`host at ${ip} ok`);
    assertEquals(h.length, 1, `${ip} should be one hit`);
    assertEquals(h[0].rule, "private-ipv4");
    assertEquals(h[0].match, ip);
  }
});

Deno.test("private IPv4: public + RFC5737 + partial-quad pass clean (no false positives)", () => {
  // 0.0.0.0 (bind-all), public DNS, RFC5737 doc ranges, a version-like 3-octet,
  // a bare score "10.3", and 172.15/172.32 (just outside the /12) must NOT trip.
  const clean = [
    "0.0.0.0",
    "8.8.8.8",
    "1.1.1.1",
    "192.0.2.1",
    "198.51.100.10",
    "203.0.113.42", // RFC 5737 placeholders
    "version 10.3.2",
    "score 10.3",
    "build 172.15.0.1 is public",
    "172.32.0.1",
  ];
  for (const s of clean) {
    assertEquals(scan(s).length, 0, `"${s}" must be clean`);
  }
});

// --- generics: tailnet ------------------------------------------------------

Deno.test("tailnet: *.ts.net caught case-insensitively; example.net is clean", () => {
  assertEquals(ruleNames(scan("ssh foo.ts.net")), ["tailnet"]);
  assertEquals(ruleNames(scan("ssh node-1.EXAMPLENET.ts.net")), ["tailnet"]);
  assertEquals(scan("host.example.net is a placeholder").length, 0);
});

// --- denylist: fleet-aware, case-sensitive, word-boundary -------------------

Deno.test("denylist: owned identifiers caught; case-sensitive; word-boundary safe", () => {
  // synthetic identifiers — a scanner's test must never embed REAL fleet names.
  const deny = ["acmehost", "corp-internal.example", "Zoltan"];
  assertEquals(ruleNames(scan("the acmehost box", deny)), ["denylist"]);
  assertEquals(ruleNames(scan("see corp-internal.example", deny)), [
    "denylist",
  ]);
  assertEquals(ruleNames(scan("ping Zoltan", deny)), ["denylist"]);
  // case-sensitive: lowercase 'zoltan' does NOT match 'Zoltan'
  assertEquals(scan("a zoltan-ish string", deny).length, 0);
  // word-boundary: 'acmehost9' / embedded must NOT match 'acmehost'
  assertEquals(scan("model acmehost9 and xacmehostx", deny).length, 0);
  // '#' comments / blanks in the denylist are ignored
  assertEquals(scan("clean", ["# a comment", "  "]).length, 0);
});

// --- the Lab 508 repro shape ------------------------------------------------

Deno.test("508 repro: a README with a jump IP + internal IP + tailnet halts", () => {
  const readme = [
    "## Example config",
    "  jumpHost: 100.64.50.50   # tailnet jump (CGNAT)",
    "  nodeIp: 192.168.77.88",
    "  via: edgegate.ts.net",
    "  placeholder ok: 192.0.2.1 / example.com",
  ].join("\n");
  const hits = scan(readme, ["edgegate"]);
  // 3 IP/tailnet generics fire; the RFC5737 line stays clean
  assert(hits.length >= 3, `expected >=3 hits, got ${hits.length}`);
  assert(hits.some((h) => h.match === "100.64.50.50"));
  assert(hits.some((h) => h.match === "192.168.77.88"));
  assert(hits.some((h) => h.rule === "tailnet"));
  assert(!hits.some((h) => h.match.includes("192.0.2.1")));
});

// --- custom recognizer ------------------------------------------------------

Deno.test("custom recognizer: internal TLDs opt-in", () => {
  const recs = buildRecognizers([], [{
    name: "internal-tld",
    pattern: String.raw`\b[\w-]+\.(?:internal|corp)\b`,
    flags: "",
    placeholder: "host.example.com",
  }]);
  const hits = scanText("db.internal and app.corp", recs);
  assertEquals(hits.length, 2);
  assertEquals(hits[0].rule, "internal-tld");
});

// --- redact -----------------------------------------------------------------

Deno.test("redact: remaps to swamp-blessed placeholders", () => {
  const recs = buildRecognizers(["acmehost"]);
  const out = redactText("10.0.0.5 on foo.ts.net is acmehost", recs);
  assertEquals(out, "192.0.2.0 on host.example.net is REDACTED");
});

// --- line numbers -----------------------------------------------------------

Deno.test("scanText: reports 1-based line numbers", () => {
  const hits = scanText("clean line\nleak 10.0.0.1 here\nclean", rules());
  assertEquals(hits.length, 1);
  assertEquals(hits[0].line, 2);
});

// --- denylist derivation (build the fleet-aware tier from data) -------------

Deno.test("domainOf: handles co.nz and plain TLDs", () => {
  assertEquals(domainOf("host.example.co.nz"), "example.co.nz");
  assertEquals(domainOf("host.example.com"), "example.com");
  assertEquals(domainOf("example.com"), "example.com");
  assertEquals(domainOf("single"), null);
});

Deno.test("deriveDenylist: unambiguous vs review tiers, ts.net + generics dropped", () => {
  // synthetic inputs — never embed real fleet identifiers, even baselined.
  const r = deriveDenylist(
    [
      {
        hostname: "acmehost",
        fqdns: ["host1.example.co.nz", "x.ts.net"],
        users: ["alice", "root"],
      },
      { hostname: "rb4011", fqdns: [], users: [] }, // product name → filtered from review
    ],
    { current: ["example.co.nz"] },
  );
  // unambiguous = fqdns (minus ts.net) + domains + non-generic users
  assert(r.unambiguous.includes("host1.example.co.nz"));
  assert(r.unambiguous.includes("example.co.nz"));
  assert(r.unambiguous.includes("alice"));
  assert(!r.unambiguous.some((t) => t.includes("ts.net"))); // ts.net dropped (generic recognizer)
  assert(!r.unambiguous.includes("root")); // generic user dropped
  // review = hostnames, product names filtered
  assertEquals(r.review, ["acmehost"]);
  // diff vs current
  assert(!r.newUnambiguous.includes("example.co.nz")); // already known
  assert(r.newUnambiguous.includes("alice"));
});

// --- method-level: file walk + hard-halt gate -------------------------------

function mockCtx(deny: string[] = []) {
  return {
    globalArgs: GlobalArgsSchema.parse({ name: "test", denylist: deny }),
    writeResource: (specName: string, instanceName: string, data: unknown) =>
      Promise.resolve({
        name: instanceName,
        specName,
        kind: "resource",
        dataId: "test",
        version: 1,
        _data: data,
      }),
    logger: { info: () => {}, warning: () => {} },
  };
}

Deno.test("scan method: walks a dir, advisory report (failOnHit=false)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/clean.md`,
      "see 192.0.2.1 and example.com",
    );
    await Deno.writeTextFile(
      `${dir}/leak.yaml`,
      "ip: 192.168.50.5\nhost: host.ts.net",
    );
    // deno-lint-ignore no-explicit-any
    const ctx: any = mockCtx();
    const res = await model.methods.scan.execute(
      { paths: [dir], failOnHit: false, label: "scan" },
      ctx,
    );
    const data = (res.dataHandles[0] as unknown as {
      _data: { clean: boolean; hitCount: number };
    })._data;
    assertEquals(data.clean, false);
    assertEquals(data.hitCount, 2); // the private IP + the ts.net host
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan method: hard-halt THROWS on a hit (failOnHit default)", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${dir}/leak.md`, "node at 10.1.2.3");
    // deno-lint-ignore no-explicit-any
    const ctx: any = mockCtx();
    await assertRejects(
      () =>
        model.methods.scan.execute({
          paths: [dir],
          failOnHit: true,
          label: "scan",
        }, ctx),
      Error,
      "redaction gate HALT",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scan method: clean tree does not throw", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(
      `${dir}/ok.md`,
      "all placeholders: 192.0.2.5, example.com",
    );
    // deno-lint-ignore no-explicit-any
    const ctx: any = mockCtx();
    const res = await model.methods.scan.execute(
      { paths: [dir], failOnHit: true, label: "scan" },
      ctx,
    );
    const data =
      (res.dataHandles[0] as unknown as { _data: { clean: boolean } })._data;
    assertEquals(data.clean, true);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
