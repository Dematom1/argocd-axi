import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { COMMAND_LINES } from "../src/help.js";
import { createSkillMarkdown } from "../src/skill.js";
import { ROOT } from "./helpers.js";

describe("installable skill", () => {
  it("is generated from the CLI's own help and committed up to date", () => {
    const committed = readFileSync(
      join(ROOT, "skills", "argocd-axi", "SKILL.md"),
      "utf8",
    );
    expect(committed).toBe(createSkillMarkdown());
    for (const line of COMMAND_LINES) expect(committed).toContain(line);
  });

  it("has trigger-shaped frontmatter and npx invocations", () => {
    const skill = createSkillMarkdown();
    expect(skill).toMatch(
      /^---\nname: argocd-axi\ndescription: "Inspect Argo CD/,
    );
    expect(skill).toContain("npx -y argocd-axi");
    expect(skill).toContain(
      "read operations plus opt-in writes on writable contexts",
    );
  });
});
