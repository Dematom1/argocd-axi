import {
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { runUpdate } from "axi-sdk-js";
import { makeHome, ROOT, runCli, scenario, type RunResult } from "./helpers.js";

function writableHome() {
  const home = makeHome();
  mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
  writeFileSync(
    join(home, ".config", "argocd-axi", "config"),
    "writable-contexts: [prod]\n",
  );
  return home;
}

function writes(result: RunResult) {
  return result.calls.filter(
    (call) =>
      (call[0] === "app" &&
        ["rollback", "terminate-op", "set"].includes(call[1] ?? "")) ||
      (call[0] === "app" && call[1] === "actions" && call[2] === "run") ||
      call.some((arg) => ["--refresh", "--hard-refresh"].includes(arg)) ||
      (call[0] === "context" && call.length > 1),
  );
}

function snapshot(path: string): unknown {
  return Object.fromEntries(
    readdirSync(path)
      .filter((name) => name !== "argocd-calls.log")
      .sort()
      .map((name) => {
        const file = join(path, name);
        return [
          name,
          statSync(file).isDirectory()
            ? snapshot(file)
            : {
                text: readFileSync(file, "utf8"),
                mtime: statSync(file).mtimeMs,
              },
        ];
      }),
  );
}

const before = {
  metadata: { name: "demo" },
  spec: { project: "default" },
  status: {
    sync: { status: "Synced", revision: "new" },
    operationState: { phase: "Running" },
    history: [{ id: 1, revision: "old" }],
  },
};
const baseResponses = [
  { argv: ["context"], exact: true, stdoutFile: "context.txt" },
  { argv: ["account", "can-i"], stdout: "yes\n" },
];

describe("state-scoped write retries", () => {
  it.each([
    {
      command: ["terminate-op"],
      native: ["app", "terminate-op", "demo"],
      after: {
        ...before,
        status: { ...before.status, operationState: { phase: "Failed" } },
      },
    },
    {
      command: ["rollback", "1"],
      native: ["app", "rollback", "demo"],
      after: {
        ...before,
        status: {
          ...before.status,
          sync: { status: "Synced", revision: "old" },
          operationState: { phase: "Succeeded" },
        },
      },
    },
    {
      command: ["auto-sync", "on"],
      native: ["app", "set", "demo"],
      after: {
        ...before,
        spec: {
          project: "default",
          syncPolicy: { automated: { prune: true } },
        },
      },
    },
    {
      command: ["auto-sync", "off"],
      native: ["app", "set", "demo"],
      after: before,
    },
  ])(
    "runs $command twice without a second native mutation",
    async ({ command, native, after }) => {
      const home = writableHome();
      const initial =
        command[0] === "auto-sync" && command[1] === "off"
          ? { ...before, spec: { syncPolicy: { automated: {} } } }
          : before;
      const fixture = scenario([
        ...baseResponses,
        {
          argv: ["app", "get", "demo"],
          state: "initial",
          stdout: JSON.stringify(initial),
        },
        {
          argv: ["app", "get", "demo"],
          state: "done",
          stdout: JSON.stringify(after),
        },
        { argv: native, stdout: "", nextState: "done" },
      ]);
      const options = {
        home,
        scenario: fixture,
        env: { FAKE_ARGOCD_STATE: join(makeHome(), "native-state") },
      };
      const args = [
        "apps",
        command[0]!,
        "demo",
        ...command.slice(1),
        "--confirm",
        "--context",
        "prod",
      ];
      const first = await runCli(args, options);
      expect(first.exitCode, first.stdout).toBe(0);
      expect(writes(first)).toHaveLength(1);
      const saved = snapshot(home);
      const second = await runCli(args, options);
      expect(second.exitCode, second.stdout).toBe(0);
      expect(second.stdout).toContain("already-done");
      expect(writes(second)).toEqual([]);
      expect(snapshot(home)).toEqual(saved);
    },
  );

  it.each(["restart", "promote", "promote-full", "resume"])(
    "does not repeat %s while the resource is rolling",
    async (action) => {
      const home = writableHome();
      const app = (health: string) =>
        JSON.stringify({
          ...before,
          status: {
            resources: [
              {
                group: "argoproj.io",
                kind: "Rollout",
                name: "demo",
                health: { status: health },
              },
            ],
          },
        });
      const fixture = scenario([
        ...baseResponses,
        {
          argv: ["app", "get", "demo"],
          state: "initial",
          stdout: app("Suspended"),
        },
        {
          argv: ["app", "get", "demo"],
          state: "done",
          stdout: app("Progressing"),
        },
        {
          argv: ["app", "actions", "list"],
          stdout: JSON.stringify([
            {
              Group: "argoproj.io",
              Kind: "Rollout",
              Name: "demo",
              Action: action,
            },
          ]),
        },
        { argv: ["app", "actions", "run"], stdout: "", nextState: "done" },
      ]);
      const options = {
        home,
        scenario: fixture,
        env: { FAKE_ARGOCD_STATE: join(makeHome(), "native-state") },
      };
      const args = [
        "apps",
        "actions",
        "run",
        "demo",
        action,
        "--kind",
        "Rollout",
        "--name",
        "demo",
        "--context",
        "prod",
        "--confirm",
      ];
      const first = await runCli(args, options);
      expect(first.exitCode, first.stdout).toBe(0);
      expect(writes(first)).toHaveLength(1);
      const second = await runCli(args, options);
      expect(second.exitCode, second.stdout).toBe(0);
      expect(second.stdout).toContain("in-progress");
      expect(writes(second)).toEqual([]);
    },
  );

  it.each(["promote", "promote-full", "resume"])(
    "reports %s already-done on a healthy Rollout even if the action is now disabled",
    async (action) => {
      const result = await runCli(
        [
          "apps",
          "actions",
          "run",
          "demo",
          action,
          "--kind",
          "Rollout",
          "--name",
          "demo",
          "--context",
          "prod",
          "--confirm",
        ],
        {
          home: writableHome(),
          scenario: scenario([
            ...baseResponses,
            {
              argv: ["app", "get", "demo"],
              stdout: JSON.stringify({
                status: {
                  resources: [
                    {
                      group: "argoproj.io",
                      kind: "Rollout",
                      name: "demo",
                      health: { status: "Healthy" },
                    },
                  ],
                },
              }),
            },
          ]),
        },
      );
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toContain("already-done");
      expect(writes(result)).toEqual([]);
    },
  );

  it("recognizes full multi-source revisions without abbreviating them", async () => {
    const revisions = ["a".repeat(40), "b".repeat(40)];
    const result = await runCli(
      ["apps", "rollback", "demo", "1", "--confirm", "--context", "prod"],
      {
        home: writableHome(),
        scenario: scenario([
          ...baseResponses,
          {
            argv: ["app", "get", "demo"],
            stdout: JSON.stringify({
              spec: { syncPolicy: { automated: {} } },
              status: {
                sync: { status: "Synced", revisions },
                history: [{ id: 1, revisions }],
              },
            }),
          },
        ]),
      },
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("already-done");
    expect(writes(result)).toEqual([]);
  });

  it("does not repeat a rollback whose target is still in progress", async () => {
    const result = await runCli(
      ["apps", "rollback", "demo", "1", "--confirm", "--context", "prod"],
      {
        home: writableHome(),
        scenario: scenario([
          ...baseResponses,
          {
            argv: ["app", "get", "demo"],
            stdout: JSON.stringify({
              ...before,
              status: {
                ...before.status,
                operationState: {
                  phase: "Running",
                  syncResult: { revision: "old" },
                },
              },
            }),
          },
        ]),
      },
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("in-progress");
    expect(writes(result)).toEqual([]);
  });

  it("reconciles a termination that finishes between preflight and submission", async () => {
    const home = writableHome();
    const nativeState = join(makeHome(), "native-state");
    const fixture = scenario([
      ...baseResponses,
      {
        argv: ["app", "get", "demo"],
        state: "initial",
        stdout: JSON.stringify(before),
        nextState: "finished",
      },
      {
        argv: ["app", "get", "demo"],
        state: "finished",
        stdout: JSON.stringify({ ...before, status: {} }),
      },
      {
        argv: ["app", "terminate-op"],
        stderr: "no operation is in progress",
        exit: 20,
      },
    ]);
    const result = await runCli(
      ["apps", "terminate-op", "demo", "--confirm", "--context", "prod"],
      {
        home,
        scenario: fixture,
        env: { FAKE_ARGOCD_STATE: nativeState },
      },
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("already-done");
  });

  it("does not report termination complete while operation remains pending", async () => {
    const result = await runCli(
      ["apps", "terminate-op", "demo", "--context", "prod", "--confirm"],
      {
        home: writableHome(),
        scenario: scenario([
          ...baseResponses,
          { argv: ["app", "get", "demo"], stdout: JSON.stringify(before) },
          {
            argv: ["app", "get", "demo"],
            stdout: JSON.stringify({ ...before, status: {}, operation: {} }),
          },
          {
            argv: ["app", "terminate-op"],
            stderr: "no operation is in progress",
            exit: 20,
          },
        ]),
      },
    );
    expect(result.exitCode).not.toBe(0);
    expect(result.stdout).not.toContain("already-done");
  });

  it("does not resubmit a termination already in progress", async () => {
    const result = await runCli(
      ["apps", "terminate-op", "demo", "--context", "prod", "--confirm"],
      {
        home: writableHome(),
        scenario: scenario([
          ...baseResponses,
          {
            argv: ["app", "get", "demo"],
            stdout: JSON.stringify({
              ...before,
              status: { operationState: { phase: "Terminating" } },
            }),
          },
        ]),
      },
    );
    expect(result.exitCode, result.stdout).toBe(0);
    expect(result.stdout).toContain("in-progress");
    expect(writes(result)).toEqual([]);
  });

  it.each([false, true])(
    "refresh can safely reconcile twice (hard=%s)",
    async (hard) => {
      const args = [
        "apps",
        "refresh",
        "demo",
        "--context",
        "prod",
        "--confirm",
        ...(hard ? ["--hard"] : []),
      ];
      const options = {
        home: writableHome(),
        scenario: scenario([
          ...baseResponses,
          { argv: ["app", "get", "demo"], stdout: JSON.stringify(before) },
        ]),
      };
      for (let i = 0; i < 2; i++) {
        const result = await runCli(args, options);
        expect(result.exitCode, result.stdout).toBe(0);
        expect(result.stdout).toContain("refresh: completed");
        expect(result.stdout).toContain("sync: Synced");
        expect(writes(result)).toHaveLength(1);
      }
    },
  );

  it("ctx use skips the native switch on retry", async () => {
    const options = {
      home: makeHome(),
      env: { FAKE_ARGOCD_STATE: join(makeHome(), "native-state") },
      scenario: scenario([
        {
          argv: ["context"],
          exact: true,
          state: "initial",
          stdoutFile: "context.txt",
        },
        {
          argv: ["context"],
          exact: true,
          state: "done",
          stdout:
            "CURRENT  NAME     SERVER\n         prod     argocd.example.com\n*        staging  argocd-staging.example.com\n",
        },
        { argv: ["context", "staging"], stdout: "", nextState: "done" },
      ]),
    };
    const first = await runCli(["ctx", "use", "staging"], options);
    expect(first.exitCode, first.stdout).toBe(0);
    expect(writes(first)).toHaveLength(1);
    const second = await runCli(["ctx", "use", "staging"], options);
    expect(second.exitCode, second.stdout).toBe(0);
    expect(second.stdout).toContain("already-done");
    expect(writes(second)).toEqual([]);
  });

  it("writable add no-ops without prompting for an existing grant, remove no-ops on retry", async () => {
    const home = writableHome();
    for (let i = 0; i < 2; i++) {
      const result = await runCli(["ctx", "writable", "add", "prod"], { home });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toContain("already-done");
      expect(result.calls).toEqual([]);
    }
    const first = await runCli(["ctx", "writable", "remove", "prod"], { home });
    expect(first.exitCode).toBe(0);
    const saved = snapshot(home);
    const second = await runCli(["ctx", "writable", "remove", "prod"], {
      home,
    });
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already-done");
    expect(snapshot(home)).toEqual(saved);
  });

  it("session end preserves an identical summary on retry", async () => {
    const home = makeHome();
    const transcript = join(home, "transcript.jsonl");
    writeFileSync(
      transcript,
      JSON.stringify({
        type: "tool_use",
        input: { command: "argocd-axi apps --context prod" },
      }) + "\n",
    );
    const options = {
      home,
      stdin: JSON.stringify({ cwd: home, transcript_path: transcript }),
    };
    const first = await runCli(["context", "end"], options);
    expect(first.exitCode).toBe(0);
    const saved = snapshot(home);
    const second = await runCli(["context", "end"], options);
    expect(second.exitCode).toBe(0);
    expect(second.stdout).toContain("already-done");
    expect(snapshot(home)).toEqual(saved);
  });
});

describe("SDK self-update retry", () => {
  it("does not reinstall a version that was already installed", async () => {
    let installed = "0.1.0";
    let installs = 0;
    const options = {
      args: [],
      stdout: { write: () => undefined },
      packageName: "argocd-axi",
      invokedAs: "/usr/local/lib/node_modules/argocd-axi/bin/argocd-axi.js",
      realpath: (path: string) => path,
      fs: { existsSync: () => false, readFileSync: () => "" },
      env: {},
      fetchLatest: async () => "0.2.0",
      runInstall: async () => {
        installs++;
        installed = "0.2.0";
        return { ok: true };
      },
    };
    await runUpdate({ ...options, version: installed });
    expect(installs).toBe(1);
    const second = await runUpdate({ ...options, version: installed });
    expect(second).toEqual({
      update: "argocd-axi is already on the latest version (0.2.0)",
    });
    expect(installs).toBe(1);
    await runUpdate({ ...options, args: ["--check"], version: "0.1.0" });
    expect(installs).toBe(1);
  });
});

describe("read purity", () => {
  it.each([
    [],
    ["ctx"],
    ["auth", "guide"],
    ["whoami"],
    ["can-i", "sync", "applications", "payments/*"],
    ["apps"],
    ["apps", "view", "payments-api"],
    ["apps", "resources", "payments-api"],
    ["apps", "resources", "payments-api", "--orphaned"],
    ["apps", "diff", "payments-api"],
    ["apps", "diff", "payments-api", "--full"],
    ["apps", "diff", "guestbook", "--revision", "main"],
    ["apps", "history", "payments-api"],
    ["apps", "manifests", "payments-api"],
    ["apps", "manifests", "payments-api", "--source", "live"],
    ["apps", "logs", "payments-api"],
    ["apps", "actions", "web"],
    ["projects"],
    ["projects", "view", "payments"],
    ["projects", "windows", "payments"],
    ["appsets"],
    ["appsets", "view", "team-apps"],
    [
      "appsets",
      "generate",
      join(ROOT, "test", "fixtures", "default", "appset-team-apps.json"),
    ],
    ["repos"],
    ["clusters"],
    ["ctx", "writable", "list"],
    ["context"],
    ["setup", "status"],
    ["--help"],
    ["--version"],
  ])(
    "%j issues no mutations and changes no state files",
    async (...args: string[]) => {
      const home = writableHome();
      const saved = snapshot(home);
      for (let i = 0; i < 2; i++) {
        const result = await runCli(args, {
          home,
          plainText: args.includes("--full"),
        });
        expect(result.exitCode, result.stdout).toBe(0);
        expect(writes(result)).toEqual([]);
        expect(snapshot(home)).toEqual(saved);
      }
    },
  );
});
