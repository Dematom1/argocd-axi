import { spawnSync } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, ROOT, runCli } from "./helpers.js";

describe("truthful setup", () => {
  it("removes only argocd-axi SessionStart hooks from CLAUDE_CONFIG_DIR and is idempotent", async () => {
    const home = makeHome();
    const config = join(home, "alternate-claude");
    const file = join(config, "settings.json");
    mkdirSync(config);
    const unrelated = { type: "command", command: "other-tool" };
    writeFileSync(file, JSON.stringify({ hooks: { SessionStart: [
      { hooks: [{ type: "command", command: "argocd-axi-ctx" }, unrelated] },
    ] } }));
    const env = { CLAUDE_CONFIG_DIR: config };

    const first = await runCli(["setup", "uninstall"], { home, env });
    expect(first.exitCode, first.stdout).toBe(0);
    expect(first.stdout).toContain("claude: removed");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.SessionStart).toEqual([
      { hooks: [unrelated] },
    ]);
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);

    const second = await runCli(["setup", "uninstall"], { home, env });
    expect(second.exitCode, second.stdout).toBe(0);
    expect(second.stdout).toContain("claude: not installed (no-op)");
    expect(JSON.parse(readFileSync(file, "utf8")).hooks.SessionStart).toEqual([
      { hooks: [unrelated] },
    ]);
  });

  it("preserves foreign SessionEnd commands mentioning argocd-axi during setup and removal", async () => {
    const home = makeHome();
    const file = join(home, ".claude", "settings.json");
    mkdirSync(join(home, ".claude"));
    const foreign = [
      "echo /usr/local/bin/argocd-axi context end",
      "echo argocd-axi context end",
      "sh -c /usr/local/bin/argocd-axi context end",
      "argocd-axi context end --custom",
      "node '/old/path/argocd-axi.js' context end --custom",
      "echo keep # argocd-axi context end",
    ].map((command) => ({ type: "command", command }));
    const legacy = [
      "argocd-axi context end",
      "/usr/local/bin/argocd-axi context end",
      "node '/old path/argocd-axi.js' context end",
    ].map((command) => ({ type: "command", command }));
    writeFileSync(
      file,
      JSON.stringify({
        hooks: {
          SessionEnd: [{ matcher: "", hooks: [...foreign, ...legacy] }],
        },
      }),
    );
    for (let i = 0; i < 2; i++) {
      expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
      const value = JSON.parse(readFileSync(file, "utf8"));
      const entries = value.hooks.SessionEnd.flatMap(
        (group: { hooks: unknown[] }) => group.hooks,
      );
      expect(entries).toHaveLength(foreign.length + 1);
      for (const entry of foreign) expect(entries).toContainEqual(entry);
      for (const entry of legacy) expect(entries).not.toContainEqual(entry);
    }
    for (let i = 0; i < 2; i++) {
      expect((await runCli(["setup", "uninstall"], { home })).exitCode).toBe(0);
      expect(JSON.parse(readFileSync(file, "utf8")).hooks.SessionEnd).toEqual([
        { matcher: "", hooks: foreign },
      ]);
    }
    expect((await runCli(["setup", "status"], { home })).stdout).toContain(
      "sessionEnd: not installed",
    );
  });

  it.skipIf(process.platform === "win32")(
    "executes relocated SessionStart shell hooks through spaces and quotes",
    () => {
      const home = makeHome();
      const relocated = join(home, "relocated path ' with quote");
      cpSync(join(ROOT, "dist"), join(relocated, "dist"), { recursive: true });
      symlinkSync(
        join(ROOT, "node_modules"),
        join(relocated, "node_modules"),
        "dir",
      );
      cpSync(join(ROOT, "package.json"), join(relocated, "package.json"));
      // npm marks installed bin targets executable; reproduce that on this copy.
      chmodSync(join(relocated, "dist", "bin", "argocd-axi-ctx.js"), 0o755);
      const bin = join(home, "node-only");
      mkdirSync(bin);
      symlinkSync(process.execPath, join(bin, "node"));
      const env = {
        HOME: home,
        XDG_CONFIG_HOME: join(home, ".config"),
        PATH: bin,
      };
      for (let i = 0; i < 2; i++) {
        const setup = spawnSync(
          process.execPath,
          [join(relocated, "dist", "bin", "argocd-axi.js"), "setup", "hooks"],
          { env, encoding: "utf8" },
        );
        expect(setup.status, setup.stdout + setup.stderr).toBe(0);
      }
      for (const file of [
        join(home, ".claude", "settings.json"),
        join(home, ".codex", "hooks.json"),
      ]) {
        const value = JSON.parse(readFileSync(file, "utf8"));
        const entries = value.hooks.SessionStart.flatMap(
          (group: { hooks: unknown[] }) => group.hooks,
        );
        expect(entries).toHaveLength(1);
        const result = spawnSync("/bin/sh", ["-c", entries[0].command], {
          cwd: home,
          env,
          encoding: "utf8",
        });
        expect(result.status, result.stderr).toBe(0);
      }
      const plugin = readFileSync(
        join(home, ".config", "opencode", "plugins", "axi-argocd-axi.js"),
        "utf8",
      );
      expect(plugin).toContain(
        `const command = ${JSON.stringify(realpathSync(join(relocated, "dist", "bin", "argocd-axi-ctx.js")))};`,
      );
    },
  );

  it("repairs duplicate legacy SessionStart entries without changing other hooks", async () => {
    const home = makeHome();
    expect((await runCli(["setup", "hooks"], { home })).exitCode).toBe(0);
    const files = [
      join(home, ".claude", "settings.json"),
      join(home, ".codex", "hooks.json"),
    ];
    const unrelated = { type: "command", command: "echo keep" };
    const mentionsProduct = {
      type: "command",
      command: "echo argocd-axi status",
    };
    const customLegacy = {
      type: "command",
      command: "'/old path/argocd-axi-ctx' --custom",
    };
    for (const file of files) {
      const value = JSON.parse(readFileSync(file, "utf8"));
      value.other = true;
      value.hooks.SessionStart[0].hooks[0].command =
        "/old/location/argocd-axi-ctx";
      value.hooks.SessionStart.push(
        {
          matcher: "keep",
          hooks: [
            unrelated,
            mentionsProduct,
            customLegacy,
            { command: "argocd-axi-ctx" },
          ],
        },
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
      const uninstall = await runCli(["setup", "uninstall"], { home });
      expect(uninstall.stdout).toContain("claude: removed");
      expect(uninstall.stdout).toContain("codex: removed");
      expect(uninstall.stdout).toContain("opencode: removed");
      expect(uninstall.stdout).toContain("sessionEnd: removed");
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
        expect(
          JSON.parse(
            readFileSync(join(home, ".claude", "settings.json"), "utf8"),
          ).hooks,
        ).toBeUndefined();
      } finally {
        chmodSync(dir, 0o755);
        chmodSync(file, 0o600);
      }
      const retry = await runCli(["setup", "uninstall"], { home });
      expect(retry.exitCode).toBe(0);
      expect(retry.stdout).toContain("sessionEnd: not installed (no-op)");
      const status = await runCli(["setup", "status"], { home });
      expect(status.stdout).toContain("codex: false");
      expect(status.stdout).toContain("opencode: false");
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
