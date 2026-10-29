import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createSkillMarkdown } from "../src/skill.js";

// Compiled to dist/scripts/build-skill.js; the repo root is two levels up.
const root = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const target = join(root, "skills", "argocd-axi", "SKILL.md");
const expected = createSkillMarkdown();

if (process.argv.includes("--check")) {
  let actual: string;
  try {
    actual = readFileSync(target, "utf8");
  } catch {
    actual = "";
  }
  if (actual !== expected) {
    process.stderr.write(
      "skills/argocd-axi/SKILL.md is stale; run `npm run build:skill`\n",
    );
    process.exit(1);
  }
  process.stdout.write("skills/argocd-axi/SKILL.md is up to date\n");
} else {
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, expected);
  process.stdout.write(`wrote ${target}\n`);
}
