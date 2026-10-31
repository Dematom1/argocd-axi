import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
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
        JSON.stringify({
          type: "tool_use",
          input: { command: "argocd-axi whoami --context prod" },
        }),
        JSON.stringify({
          type: "tool_use",
          input: {
            command: "argocd-axi can-i get applications '*' --context prod",
          },
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
    expect(recorded).toContain('"whoami": 1');
    expect(recorded).toContain('"can-i": 1');
    expect(recorded).toContain('"context": "prod"');
    expect(recorded).not.toContain("SECRET_TOKEN");
    expect(recorded).not.toContain("--token");
    if (process.platform !== "win32")
      expect(statSync(sessions).mode & 0o777).toBe(0o600);
    const view = await runCli(["context"], { home });
    expect(view.exitCode).toBe(0);
    expect(view.stdout).toContain("last_session:");
    expect(view.stdout).toContain("apps 2");
    expect(view.stdout).toContain('context \\"prod\\"');
    expect((await runCli(["setup", "uninstall"], { home })).stdout).toContain(
      "sessionEnd: removed",
    );
    expect((await runCli(["setup", "status"], { home })).stdout).toContain(
      "sessionEnd: not installed",
    );
  });

  it("preserves malformed hook groups and existing settings permissions", async () => {
    const home = makeHome();
    const claude = join(home, ".claude");
    mkdirSync(claude, { recursive: true });
    const settings = join(claude, "settings.json");
    const retained = [
      null,
      "unexpected",
      { matcher: "without-hooks" },
      { matcher: "user", hooks: [{ type: "command", command: "echo keep" }] },
    ];
    writeFileSync(
      settings,
      JSON.stringify({ hooks: { SessionEnd: retained } }),
    );
    const setup = await runCli(["setup", "hooks"], { home });
    expect(setup.exitCode).toBe(0);
    const installed = JSON.parse(readFileSync(settings, "utf8")) as {
      hooks: { SessionEnd: unknown[] };
    };
    expect(installed.hooks.SessionEnd.slice(0, retained.length)).toEqual(
      retained,
    );
    chmodSync(settings, 0o640);
    const removed = await runCli(["setup", "uninstall"], { home });
    expect(removed.exitCode).toBe(0);
    if (process.platform !== "win32")
      expect(statSync(settings).mode & 0o777).toBe(0o640);
  });

  it("keeps both directory records when session ends run concurrently", async () => {
    const home = makeHome();
    const transcript = (name: string) => {
      const path = join(home, `${name}.jsonl`);
      const calls = Array.from({ length: 5000 }, () =>
        JSON.stringify({
          type: "tool_use",
          input: { command: "argocd-axi apps" },
        }),
      );
      writeFileSync(path, calls.join("\n"));
      return path;
    };
    const first = JSON.stringify({
      transcript_path: transcript("first"),
      cwd: "/workspace/first",
    });
    const second = JSON.stringify({
      transcript_path: transcript("second"),
      cwd: "/workspace/second",
    });
    const results = await Promise.all([
      runCli(["context", "end"], { home, stdin: first }),
      runCli(["context", "end"], { home, stdin: second }),
    ]);
    expect(results.map((result) => result.exitCode)).toEqual([0, 0]);
    const sessions = JSON.parse(
      readFileSync(
        join(home, ".config", "argocd-axi", "sessions.json"),
        "utf8",
      ),
    ) as { directories: Record<string, { commands: Record<string, number> }> };
    expect(sessions.directories["/workspace/first"]?.commands.apps).toBe(5000);
    expect(sessions.directories["/workspace/second"]?.commands.apps).toBe(5000);
  });

  it("skips recording when another session holds the lock", async () => {
    const home = makeHome();
    const dir = join(home, ".config", "argocd-axi");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(home, "transcript.jsonl"),
      JSON.stringify({
        type: "tool_use",
        input: { command: "argocd-axi apps" },
      }),
    );
    writeFileSync(join(dir, "sessions.json.lock"), "held");
    const result = await runCli(["context", "end"], {
      home,
      stdin: JSON.stringify({
        transcript_path: join(home, "transcript.jsonl"),
        cwd: "/workspace/busy",
      }),
    });
    expect(result.exitCode).toBe(0);
    expect(result.stdout).toContain("session log is busy");
    expect(existsSync(join(dir, "sessions.json"))).toBe(false);
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
