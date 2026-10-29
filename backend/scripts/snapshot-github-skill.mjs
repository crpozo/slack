// Refreshes a built-in skill's snapshot (Phase 44) from a local clone:
//
//   git clone --depth 1 https://github.com/cloudflare/security-audit-skill /tmp/sas
//   node backend/scripts/snapshot-github-skill.mjs /tmp/sas skills/security-audit \
//     https://github.com/cloudflare/security-audit-skill Security \
//     backend/src/lib/skillSeeds/cloudflare-security-audit.json
//
// The snapshot is what the catalog starts with when GitHub can't be read
// (tests, a first load); "Sync from GitHub" replaces it with the live files.
// The repository's LICENSE goes along with the skill.
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

const [clone, skillPath, repoUrl, category, out] = process.argv.slice(2);
if (!out) {
  console.error(
    "usage: snapshot-github-skill.mjs <clone> <skill path> <repo url> <category> <out.json>",
  );
  process.exit(1);
}
const root = join(clone, skillPath);
const walk = (dir) =>
  readdirSync(dir).flatMap((name) => {
    const full = join(dir, name);
    if (name.startsWith(".")) return [];
    return statSync(full).isDirectory() ? walk(full) : [full];
  });
const files = walk(root)
  .map((full) => ({
    path: relative(root, full).split("\\").join("/"),
    content: readFileSync(full, "utf8"),
  }))
  .filter((f) => f.path !== "SKILL.md")
  .sort((a, b) => a.path.localeCompare(b.path));
try {
  if (!files.some((f) => f.path === "LICENSE")) {
    files.push({ path: "LICENSE", content: readFileSync(join(clone, "LICENSE"), "utf8") });
  }
} catch {
  // No license at the root.
}
const commit = execFileSync("git", ["-C", clone, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
const snapshot = {
  repoUrl,
  repoPath: skillPath,
  repoCommit: commit,
  category,
  skillMd: readFileSync(join(root, "SKILL.md"), "utf8"),
  files,
};
writeFileSync(out, `${JSON.stringify(snapshot, null, 2)}\n`);
console.log(`${out}: ${files.length} files + SKILL.md from ${commit}`);
