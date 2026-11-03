import { spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, runCli } from "./helpers.js";

describe("truthful setup", () => {
  it("repairs duplicate legacy SessionStart entries without changing other hooks", async () => {
    const home = makeHome();
    expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
    const files = [
      join(home, ".claude", "settings.json"),
      join(home, ".codex", "hooks.json"),
    ];
    const unrelated = { type: "command", command: "echo keep" };
    for (const file of files) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      value.other = true;
      value.hooks.SessionStart[0].hooks[0].command =
        "/old/location/argocd-axi-ctx";
      value.hooks.SessionStart.push(
        { matcher: "keep", hooks: [unrelated, { command: "argocd-axi-ctx" }] },
        { hooks: [{ command: "/another/argocd-axi-ctx" }] },
        { matcher: "empty", hooks: [] },
      );
      writeFileSync(file, JSON.stringify(value));
    }
    for (let i = 0; i < 2; i++)
      expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
    for (const file of files) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      expect(value.other).toBe(true);
      const groups = value.hooks.SessionStart;
      expect(groups).toHaveLength(3);
      expect(groups[0].hooks).toHaveLength(1);
      expect(groups[0].hooks[0].command).not.toContain("/old/location/");
      expect(groups[1]).toEqual({ matcher: "keep", hooks: [unrelated] });
      expect(groups[2]).toEqual({ matcher: "empty", hooks: [] });
    }
  });

  it.skipIf(process.platform === "win32")(
    "repairs legacy hooks, remains idempotent and executes SessionEnd without the CLI on PATH",
    async () => {
      const home = makeHome();
      const file = join(home, ".claude", "settings.json");
      mkdirSync(join(home, ".claude"));
      const unrelated = { type: "command", command: "echo keep" };
      writeFileSync(
        file,
        JSON.stringify({
          hooks: {
            SessionEnd: [
              {
                matcher: "",
                hooks: [
                  unrelated,
                  { type: "command", command: "argocd-axi context end" },
                ],
              },
            ],
            Stop: [unrelated],
          },
          other: true,
        }),
      );
      for (let i = 0; i < 2; i++)
        expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
      const settings = JSON.parse(readFileSync(file, "utf8"));
      expect(settings.other).toBe(true);
      expect(settings.hooks.Stop).toEqual([unrelated]);
      const entries = settings.hooks.SessionEnd.flatMap(
        (g: { hooks: unknown[] }) => g.hooks,
      );
      expect(entries).toHaveLength(2);
      expect(entries).toContainEqual(unrelated);
      const command = entries.find(
        (e: { command: string }) => e.command !== "echo keep",
      ).command;
      const bin = join(home, "node-only");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const transcript = join(home, "transcript.jsonl");
      writeFileSync(
        transcript,
        JSON.stringify({
          type: "tool_use",
          input: { command: "argocd-axi apps" },
        }),
      );
      const result = spawnSync("/bin/sh", ["-c", command], {
        cwd: home,
        env: { HOME: home, XDG_CONFIG_HOME: join(home, ".config"), PATH: bin },
        input: JSON.stringify({ transcript_path: transcript, cwd: home }),
        encoding: "utf8",
      });
      expect(result.status, result.stderr).toBe(0);
      expect(
        readFileSync(
          join(home, ".config", "argocd-axi", "sessions.json"),
          "utf8",
        ),
      ).toContain('"apps": 1');
      expect((await runCli(["setup", "uninstall"], { home })).stdout).toContain(
        "sessionEnd: removed",
      );
      const removed = JSON.parse(readFileSync(file, "utf8"));
      expect(removed.hooks.SessionEnd).toEqual([
        { matcher: "", hooks: [unrelated] },
      ]);
      expect(removed.hooks.Stop).toEqual([unrelated]);
      expect(removed.hooks.SessionStart).toBeUndefined();
      expect(
        JSON.parse(readFileSync(join(home, ".codex", "hooks.json"), "utf8"))
          .hooks,
      ).toBeUndefined();
      expect(
        readFileSync(join(home, ".codex", "config.toml"), "utf8"),
      ).toContain("hooks = true");
      expect(
        existsSync(
          join(home, ".config", "opencode", "plugins", "axi-argocd-axi.js"),
        ),
      ).toBe(false);
      expect((await runCli(["setup", "uninstall"], { home })).exitCode).toBe(0);
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "classifies denied uninstall and unreadable status without changing hooks",
    async () => {
      const home = makeHome();
      expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
      const dir = join(home, ".claude");
      const file = join(dir, "settings.json");
      const before = readFileSync(file, "utf8");
      try {
        chmodSync(dir, 0o555);
        chmodSync(file, 0o444);
        const result = await runCli(["setup", "uninstall"], { home });
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("code: UPSTREAM_ERROR");
        expect(readFileSync(file, "utf8")).toBe(before);
        chmodSync(file, 0);
        const status = await runCli(["setup", "status"], { home });
        expect(status.exitCode).not.toBe(0);
        expect(status.stdout).toContain("code: CONFIG_INVALID");
      } finally {
        chmodSync(dir, 0o755);
        chmodSync(file, 0o600);
      }
    },
  );

  it
    .skipIf(process.platform === "win32" || process.getuid?.() === 0)
    .each([".codex", ".config/opencode/plugins"])(
    "reports denied removal in %s with repair guidance",
    async (relative) => {
      const home = makeHome();
      expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
      const dir = join(home, relative);
      const file = join(
        dir,
        relative === ".codex" ? "hooks.json" : "axi-argocd-axi.js",
      );
      try {
        chmodSync(dir, 0o555);
        chmodSync(file, 0o444);
        const result = await runCli(["setup", "uninstall"], { home });
        expect(result.exitCode).toBe(1);
        expect(result.stdout).toContain("code: UPSTREAM_ERROR");
        expect(result.stdout).toContain("argocd-axi setup uninstall");
        expect(existsSync(file)).toBe(true);
      } finally {
        chmodSync(dir, 0o755);
        chmodSync(file, 0o600);
      }
    },
  );

  it.skipIf(process.platform === "win32" || process.getuid?.() === 0)(
    "classifies allowlist write failures and leaves the config unchanged",
    async () => {
      const home = makeHome();
      const dir = join(home, ".config", "argocd-axi");
      const file = join(dir, "config");
      mkdirSync(dir, { recursive: true });
      const before = "writable-contexts: [probe]\n";
      writeFileSync(file, before);
      try {
        chmodSync(dir, 0o555);
        chmodSync(file, 0o444);
        const result = await runCli(["ctx", "writable", "remove", "probe"], {
          home,
        });
        expect(result.exitCode).not.toBe(0);
        expect(result.stdout).toContain("code: CONFIG_INVALID");
        expect(readFileSync(file, "utf8")).toBe(before);
      } finally {
        chmodSync(dir, 0o755);
        chmodSync(file, 0o600);
      }
    },
  );
});
