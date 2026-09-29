// scripts/sync-dsl-docs.mjs  -- usage: node scripts/sync-dsl-docs.mjs [path/to/qkt]   (default ../qkt)
//
// Copies qkt's DSL reference pages and example strategies into the studio's assets, so the image ships the docs of the
// qkt it pins. qkt's examples/ is one .qkt per feature subfolder (not a flat directory), so this walks a few levels
// deep to find them.
import { cpSync, mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";

const qkt = path.resolve(process.argv[2] ?? path.join(import.meta.dirname, "..", "..", "qkt"));
const out = path.join(import.meta.dirname, "..", "packages", "server", "assets", "dsl");
const PAGES = ["index", "strategy-block", "conditions", "expressions", "indicators", "actions", "bracket", "sizing", "now", "series", "schedule"];

mkdirSync(path.join(out, "examples"), { recursive: true });
for (const p of PAGES) cpSync(path.join(qkt, "docs", "reference", "dsl", `${p}.md`), path.join(out, `${p}.md`));

/** .qkt files under `dir`, a few levels deep (qkt's examples/ nests each sample in its own feature folder). */
function findQktFiles(dir, depth = 3) {
  const found = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, e.name);
    if (e.isDirectory() && depth > 0) found.push(...findQktFiles(p, depth - 1));
    else if (e.isFile() && e.name.endsWith(".qkt")) found.push(p);
  }
  return found;
}

const ex = path.join(qkt, "examples");
const picked = findQktFiles(ex)
  .sort((a, b) => path.basename(a).localeCompare(path.basename(b)))
  .slice(0, 40);
for (const f of picked) cpSync(f, path.join(out, "examples", path.basename(f)));

writeFileSync(path.join(out, "SOURCE.txt"), `Synced from ${qkt} (docs/reference/dsl, examples) on ${new Date().toISOString().slice(0, 10)}.\n`);
console.log(`synced ${PAGES.length} pages and ${picked.length} examples`);
