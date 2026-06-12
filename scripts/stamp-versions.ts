// stamp-versions.ts — refresh the README version column from each extension's
// manifest. Run from the monorepo root after a publish/sync:
//   deno run --allow-read --allow-write scripts/stamp-versions.ts
//
// Reads every `<dir>/manifest.yaml`, pulls its `name` + `version`, and rewrites
// that extension's `Version` cell in the README table. Idempotent.

const README = "README.md";
let md = await Deno.readTextFile(README);
const changes: string[] = [];

for await (const entry of Deno.readDir(".")) {
  if (!entry.isDirectory || entry.name.startsWith(".")) continue;
  let manifest: string;
  try {
    manifest = await Deno.readTextFile(`${entry.name}/manifest.yaml`);
  } catch {
    continue; // not an extension dir
  }
  const name = manifest.match(/^name:\s*"?([^"\n]+?)"?\s*$/m)?.[1]?.trim();
  const version = manifest.match(/^version:\s*"?([^"\n]+?)"?\s*$/m)?.[1]?.trim();
  if (!name || !version) continue;

  // Replace the version cell in the table row: | `<name>` | `<old>` | …
  const esc = name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp("(\\|\\s*`" + esc + "`\\s*\\|\\s*`)[^`]*(`)");
  const before = md;
  md = md.replace(re, `$1${version}$2`);
  if (md !== before) changes.push(`${name} → ${version}`);
}

await Deno.writeTextFile(README, md);
console.log(
  changes.length
    ? "stamped:\n  " + changes.join("\n  ")
    : "README versions already current.",
);
