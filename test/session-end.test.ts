import { mkdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, runCli } from "./helpers.js";

describe("session-end memory", () => {
  it("records only command names, counts and the most-used context", async () => {
    const home = makeHome();
    expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
    expect((await runCli(["setup", "status"], { home })).stdout).toContain(
      "sessionEnd: installed",
    );
    const transcript = join(home, "transcript.jsonl");
    mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
    writeFileSync(
      transcript,
      [
        JSON.stringify({
          type: "tool_use",
          input: {
            command: "argocd-axi apps --context prod --token SECRET_TOKEN",
          },
        }),
        JSON.stringify({
          type: "tool_use",
          input: { command: "argocd-axi apps --context prod" },
        }),
        JSON.stringify({
          type: "tool_use",
          input: { command: "argocd-axi ctx --context staging" },
        }),
      ].join("\n"),
    );
    const payload = JSON.stringify({
      transcript_path: transcript,
      cwd: process.cwd(),
    });
    const end = await runCli(["context", "end"], { home, stdin: payload });
    expect(end.exitCode).toBe(0);
    const sessions = join(home, ".config", "argocd-axi", "sessions.json");
    const recorded = readFileSync(sessions, "utf8");
    expect(recorded).toContain('"apps": 2');
    expect(recorded).toContain('"ctx": 1');
    expect(recorded).toContain('"context": "prod"');
    expect(recorded).not.toContain("SECRET_TOKEN");
    expect(recorded).not.toContain("--token");
    expect(statSync(sessions).mode & 0o777).toBe(0o600);
    const view = await runCli(["context"], { home });
    expect(view.exitCode).toBe(0);
    expect(view.stdout).toContain("last_session:");
    expect(view.stdout).toContain("apps 2");
    expect(view.stdout).toContain("context prod");
    expect((await runCli(["setup", "uninstall"], { home })).stdout).toContain(
      "sessionEnd: removed",
    );
    expect((await runCli(["setup", "status"], { home })).stdout).toContain(
      "sessionEnd: not installed",
    );
  });

  it("treats missing and corrupt session files as empty memory", async () => {
    const home = makeHome();
    expect((await runCli(["context"], { home })).exitCode).toBe(0);
    const dir = join(home, ".config", "argocd-axi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(join(dir, "sessions.json"), "not-json");
    const result = await runCli(["context"], { home });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).not.toContain("last_session:");
  });
});
