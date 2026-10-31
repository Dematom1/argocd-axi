import { mkdirSync, writeFileSync } from "node:fs";
import { decode } from "@toon-format/toon";
import { renderTextBlock } from "../src/toon.js";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, runCli, scenario } from "./helpers.js";

describe("apps", () => {
  it.each([
    ["rollback", "payments-api", "7"],
    ["refresh", "payments-api"],
  ])("%s preview never invokes a write", async (...args) => {
    const { stdout, calls } = await runCli([
      "apps",
      ...args,
      "--context",
      "prod",
    ]);
    expect(stdout).toContain("No changes made; add --confirm");
    expect(
      calls.some((call) =>
        ["rollback", "terminate-op"].includes(call[1] ?? ""),
      ),
    ).toBe(false);
  });

  it("terminate-op succeeds when nothing is running", async () => {
    const { stdout, exitCode } = await runCli([
      "apps",
      "terminate-op",
      "payments-api",
      "--context",
      "prod",
    ]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain("status: no operation running");
  });

  it("sync preview is explicit-context and never invokes a write", async () => {
    const { stdout, calls } = await runCli([
      "apps",
      "sync",
      "payments-api",
      "--context",
      "prod",
    ]);
    expect(stdout).toContain("No changes made; add --confirm to sync");
    expect(calls).toContainEqual([
      "app",
      "get",
      "payments-api",
      "-o",
      "json",
      "--argocd-context",
      "prod",
    ]);
    expect(calls.some((call) => call[1] === "sync")).toBe(false);
  });

  it("refuses a server-rejected sync window without losing its reason", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
    writeFileSync(
      join(home, ".config", "argocd-axi", "config"),
      'writable-contexts: ["prod"]',
    );
    const { stdout, calls } = await runCli(
      ["apps", "sync", "payments-api", "--context", "prod", "--confirm"],
      {
        home,
        scenario: scenario([
          {
            argv: ["app", "get", "payments-api"],
            stdoutFile: "app-payments-api.json",
          },
          { argv: ["proj", "windows", "list", "payments"], stdout: "[]" },
          {
            argv: ["account", "can-i", "sync", "applications"],
            stdout: "yes\n",
          },
          {
            argv: ["app", "sync", "payments-api"],
            exit: 20,
            stderr:
              'time="2026-01-01T00:00:00Z" level=fatal msg="rpc error: code = FailedPrecondition desc = SyncWindow blocks this application"\n',
          },
        ]),
      },
    );
    expect(stdout).toContain("code: REFUSED");
    expect(stdout).toContain("SyncWindow blocks this application");
    expect(calls.some((call) => call[1] === "wait")).toBe(false);
  });

  it("reports a successful server sync as complete", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
    writeFileSync(
      join(home, ".config", "argocd-axi", "config"),
      'writable-contexts: ["prod"]',
    );
    const app = JSON.stringify({
      metadata: { name: "demo" },
      spec: { project: "default" },
      status: {
        sync: { revision: "abc123" },
        health: { status: "Healthy" },
        operationState: { phase: "Succeeded" },
        resources: [],
      },
    });
    const { stdout, calls } = await runCli(
      ["apps", "sync", "demo", "--context", "prod", "--confirm"],
      {
        home,
        scenario: scenario([
          { argv: ["app", "get", "demo"], stdout: app },
          { argv: ["proj", "windows", "list", "default"], stdout: "[]" },
          {
            argv: ["account", "can-i", "sync", "applications"],
            stdout: "yes\n",
          },
          { argv: ["app", "sync", "demo"], stdout: "" },
          { argv: ["app", "wait", "demo"], stdout: "" },
        ]),
      },
    );
    expect(stdout).toContain("sync: complete");
    expect(calls.some((call) => call[1] === "sync")).toBe(true);
  });

  it("lists problems first with the reason and a total", async () => {
    const { stdout, calls } = await runCli(["apps"]);
    expect(stdout).toContain("count: 5 of 5 total (3 need attention)");
    const table = stdout.slice(
      stdout.indexOf("apps[5]"),
      stdout.indexOf("help["),
    );
    const rows = table.split("\n").filter((line) => line.startsWith("  "));
    expect(rows.map((r) => r.trim().split(",")[0])).toEqual([
      "payments-api",
      "legacy",
      "checkout",
      "web",
      "guestbook",
    ]);
    expect(calls).toContainEqual(["app", "list", "-o", "json"]);
  });

  it("filters, limits, widens and carries --context into hints", async () => {
    const { stdout } = await runCli([
      "apps",
      "--problems",
      "--limit",
      "1",
      "--fields",
      "revision",
      "--context",
      "prod",
    ]);
    expect(stdout).toContain(
      'count: "1 of 3 matching (5 total, 3 need attention)"',
    );
    expect(stdout).toContain("apps[1]{app,project,sync,health,why,revision}:");
    expect(stdout).toContain(
      "Run `argocd-axi apps --limit 3 --problems --fields revision --context prod` to see all 3",
    );
    const project = await runCli(["apps", "-p", "payments"]);
    expect(project.calls).toContainEqual([
      "app",
      "list",
      "-o",
      "json",
      "-p",
      "payments",
    ]);
    const none = await runCli(["apps", "--health", "missing"]);
    expect(none.stdout).toContain(
      "apps: 0 of 5 applications match the filters",
    );
    expect(none.stdout).toContain("Run `argocd-axi apps` to list all 5");
    expect((await runCli(["apps", "--sync", "Broken"])).stdout).toContain(
      "--sync must be one of Synced, OutOfSync, Unknown",
    );
  });

  it("keeps every given filter in the see-all hints", async () => {
    const synced = await runCli(["apps", "--sync", "Synced", "--limit", "1"]);
    const all = synced.stdout.match(/Run `argocd-axi (apps [^`]*)` to see all/);
    expect(all?.[1]).toBe("apps --limit 3 --sync Synced");
    expect(synced.stdout).toContain(
      'count: "1 of 3 matching (5 total, 3 need attention)"',
    );
    const widened = await runCli(["apps", "--sync", "Synced", "--limit", "3"]);
    expect(widened.stdout).toContain(
      'count: "3 of 3 matching (5 total, 3 need attention)"',
    );
    const selected = await runCli([
      "apps",
      "-l",
      "team in (a,b)",
      "--sync",
      "Synced",
      "--limit",
      "1",
    ]);
    expect(selected.stdout).toContain(
      "Run `argocd-axi apps --limit 3 --selector 'team in (a,b)' --sync Synced` to see all 3",
    );
    expect(selected.stdout).toContain(
      "Run `argocd-axi apps --problems --selector 'team in (a,b)'` to list only apps needing attention",
    );
    const resources = await runCli([
      "apps",
      "resources",
      "payments-api",
      "--problems",
      "--limit",
      "1",
    ]);
    expect(resources.stdout).toContain(
      "Run `argocd-axi apps resources payments-api --limit 3 --problems` to see all",
    );
    const orphaned = await runCli([
      "apps",
      "resources",
      "payments-api",
      "--orphaned",
      "--limit",
      "1",
    ]);
    expect(orphaned.stdout).toContain(
      "Run `argocd-axi apps resources payments-api --limit 2 --orphaned` to see all",
    );
    const manifests = await runCli([
      "apps",
      "manifests",
      "payments-api",
      "--revision",
      "abc123",
      "--kind",
      "Service",
      "--context",
      "prod",
    ]);
    expect(manifests.stdout).not.toContain("to see the YAML");
  });

  it("qualifies names with the namespace when apps span namespaces", async () => {
    const { stdout, calls } = await runCli(["apps", "--context", "staging"]);
    expect(stdout).toContain("argocd/guestbook");
    expect(stdout).toContain("team-a/billing");
    expect(calls[0]).toEqual([
      "app",
      "list",
      "-o",
      "json",
      "--argocd-context",
      "staging",
    ]);
  });

  it("views an app with redacted Helm parameters and values", async () => {
    const { stdout, exitCode } = await runCli(["apps", "view", "payments-api"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "  sync: OutOfSync\n  revision: 9f8e7d6\n  health: Degraded",
    );
    expect(stdout).toContain("destination: prod-eu ns/payments");
    expect(stdout).toContain('1,db.password,"[redacted]"');
    expect(stdout).toContain('apiToken: \\"[redacted]\\"');
    expect(stdout).not.toContain("hunter2");
    expect(stdout).not.toContain("tok-abc123");
    expect(stdout).toContain(
      "redacted: 2 sensitive values hidden; no flag reveals them",
    );
    expect(stdout).toContain("operation:\n  phase: Failed");
    expect(stdout).toContain("problemResources[3]");
    expect(stdout).toContain(
      "Run `argocd-axi apps diff payments-api` to see what is out of sync",
    );
  });

  it("shows every source of a multi-source app and Rollout health (A8, A9)", async () => {
    expect((await runCli(["apps", "view", "team-a/billing"])).stdout).toContain(
      'sources[2]{repo,path,target}:\n  "https://charts.example.com",chart billing,4.1.2\n  "https://github.com/example/values.git","",main',
    );
    expect((await runCli(["apps", "view", "web"])).stdout).toContain(
      "rollouts[1]{name,namespace,health,message}:\n  web,shop,Suspended,Rollout is paused at step 2 of 4",
    );
  });

  it("maps errors to codes with exit 1, and usage errors to exit 2", async () => {
    const missing = await runCli(["apps", "view", "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NOT_FOUND");
    expect(missing.stdout).toContain(
      "Run `argocd-axi apps` to list applications",
    );
    expect((await runCli(["apps", "view", "secret-app"])).stdout).toContain(
      "error: Permission denied by Argo CD RBAC\ncode: FORBIDDEN",
    );
    const jsonMissing = await runCli(["apps", "view", "gone"]);
    expect(jsonMissing.exitCode).toBe(1);
    expect(jsonMissing.stdout).toContain(
      'error: "Not found: applications.argoproj.io \\"gone\\" not found"\ncode: NOT_FOUND',
    );
    expect((await runCli(["apps", "view", "locked-app"])).stdout).toContain(
      "error: Permission denied by Argo CD RBAC\ncode: FORBIDDEN",
    );
    const usage = await runCli(["apps", "view"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.calls).toEqual([]);
    const unknown = await runCli(["apps", "view", "x", "--refresh"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain(
      "refreshing an app triggers a reconcile, which is a write",
    );
    expect(unknown.calls).toEqual([]);
  });

  it("lists resources problems first, and orphaned resources from the table", async () => {
    const all = await runCli(["apps", "resources", "payments-api"]);
    expect(all.stdout).toContain("count: 4 of 4 resources (3 with problems)");
    expect(all.stdout.indexOf("Service,payments-api")).toBeGreaterThan(
      all.stdout.indexOf("ConfigMap,payments-old"),
    );
    expect(
      (await runCli(["apps", "resources", "payments-api", "--problems"]))
        .stdout,
    ).toContain("count: 3 of 3 problem resources");
    expect(
      (await runCli(["apps", "resources", "payments-api", "--orphaned"]))
        .stdout,
    ).toContain(
      'orphaned[2]{kind,name,namespace,group}:\n  ConfigMap,stale-config,payments,""\n  Deployment,old-worker,payments,apps',
    );
    expect(
      (await runCli(["apps", "resources", "guestbook", "--problems"])).stdout,
    ).toContain("0 problem resources in guestbook");
  });

  it("summarises drift per resource and only shows raw diff with --full (A5, S14)", async () => {
    const summary = await runCli(["apps", "diff", "payments-api"]);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("drift: yes\ncount: 3 resources differ");
    expect(summary.stdout).toContain(
      "ConfigMap,payments-flags,payments,create",
    );
    expect(summary.stdout).toContain("ConfigMap,payments-old,payments,prune");
    expect(summary.calls.some((c) => c[1] === "diff")).toBe(false);

    const full = await runCli(["apps", "diff", "payments-api", "--full"]);
    expect(full.calls).toContainEqual([
      "app",
      "diff",
      "payments-api",
      "--exit-code=false",
    ]);
    expect(full.stdout).toContain("diff[17]");
    expect(full.stdout).toContain(
      "===== apps/Deployment payments/payments-api ======",
    );
    expect(full.stdout).toContain(">           value: [redacted]");
    expect(full.stdout).not.toContain("hunter2");

    expect((await runCli(["apps", "diff", "guestbook"])).stdout).toContain(
      "drift: no",
    );
    const revision = await runCli([
      "apps",
      "diff",
      "guestbook",
      "--revision",
      "main",
    ]);
    expect(revision.calls).toContainEqual([
      "app",
      "diff",
      "guestbook",
      "--exit-code=false",
      "--revision",
      "main",
    ]);
    expect(revision.stdout).toContain(
      "no resource of guestbook differs against revision main",
    );
  });

  it("shows history newest first from app get", async () => {
    const { stdout, calls } = await runCli(["apps", "history", "payments-api"]);
    expect(stdout).toContain(
      "current: 8\nhistory[2]{id,revision,deployed,by}:\n  8,bbbbbbb,24h ago,automated\n  7,aaaaaaa,2d ago,bob",
    );
    expect(calls.some((c) => c[1] === "history")).toBe(false);
  });

  it("encodes arbitrary text blocks as valid TOON", () => {
    expect(
      decode(renderTextBlock("lines", ["a,b", 'say "hi"', "one\ntwo"])),
    ).toEqual({
      lines: ["a,b", 'say "hi"', "one\ntwo"],
    });
  });

  it("lists manifests, redacting Secret data and sensitive env values", async () => {
    const summary = await runCli(["apps", "manifests", "payments-api"]);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("yaml[");
    expect(summary.stdout).not.toContain("to see the YAML");
    expect(summary.stdout).toContain(
      "manifests[3]{kind,name,namespace}:\n  Secret,payments-db,payments",
    );
    expect(summary.stdout).toContain("redacted: 5 sensitive values hidden");
    const full = await runCli([
      "apps",
      "manifests",
      "payments-api",
      "--full",
      "--source",
      "live",
    ]);
    expect(full.calls).toContainEqual([
      "app",
      "manifests",
      "payments-api",
      "--source",
      "live",
    ]);
    expect(full.stdout).toContain('password: \\"[redacted]\\"');
    expect(full.stdout).not.toMatch(/aHVudGVyMg|cGF5bWVudHM|hunter2/);

    const yaml = `apiVersion: v1\nkind: ConfigMap\nmetadata:\n  name: long\ndata:\n  config.yaml: |\n    password: hunter2\n    filler: ${"x".repeat(900)}\n`;
    const long = await runCli(["apps", "manifests", "long"], {
      scenario: scenario([
        { argv: ["app", "manifests", "long"], stdout: yaml },
      ]),
    });
    expect(long.exitCode).toBe(0);
    expect(long.stdout).toContain("password: [redacted]");
    expect(long.stdout).not.toContain("hunter2");
    expect(long.stdout).toContain("truncated,");
    expect(long.stdout).toContain(
      "Run `argocd-axi apps manifests long --full` to see the YAML",
    );
    const longFull = await runCli(["apps", "manifests", "long", "--full"], {
      scenario: scenario([
        { argv: ["app", "manifests", "long"], stdout: yaml },
      ]),
    });
    expect(longFull.stdout).toContain("password: [redacted]");
    expect(longFull.stdout).not.toContain("hunter2");

    expect(
      (await runCli(["apps", "manifests", "payments-api", "--kind", "service"]))
        .stdout,
    ).toContain("count: 1 resource\n");
    expect(
      (
        await runCli([
          "apps",
          "manifests",
          "x",
          "--source",
          "live",
          "--revision",
          "a",
        ])
      ).exitCode,
    ).toBe(2);
  });

  it("reads bounded logs, never follows, and redacts best effort (S11, S16)", async () => {
    const { stdout, calls } = await runCli([
      "apps",
      "logs",
      "payments-api",
      "--since",
      "15m",
      "--kind",
      "Deployment",
      "--name",
      "payments-api",
      "-p",
    ]);
    expect(calls).toContainEqual([
      "app",
      "logs",
      "payments-api",
      "--tail",
      "100",
      "--since-seconds",
      "900",
      "--kind",
      "Deployment",
      "--name",
      "payments-api",
      "--previous",
    ]);
    expect(stdout).toContain("logs: 5 lines (--tail 100)");
    expect(stdout).toContain("password=[redacted]");
    expect(stdout).toContain("Authorization: Bearer [redacted]");
    expect((await runCli(["apps", "logs", "guestbook"])).stdout).toContain(
      "logs: 0 log lines returned for guestbook",
    );
    expect((await runCli(["apps", "logs", "x", "--follow"])).stdout).toContain(
      "argocd-axi never streams",
    );
  });

  it("caps merged log lines at --tail, including with --full", async () => {
    const { stdout } = await runCli(
      ["apps", "logs", "multi", "--tail", "3", "--full"],
      {
        scenario: scenario([
          {
            argv: ["app", "logs", "multi"],
            stdout: "line 0\nline 1\nline 2\nline 3\nline 4\n",
          },
        ]),
      },
    );
    expect(stdout).toContain(
      "showing the newest 3 of 5 merged lines (--tail 3 limit)",
    );
    expect(stdout).not.toContain("line 1");
    expect(stdout).toContain("line 2");
    expect(stdout).toContain("line 4");
    expect(stdout).toContain(
      "Run `argocd-axi apps logs multi --tail 5000 --full` to read more merged lines",
    );
  });

  it("caps log output keeping the newest lines", async () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `line ${i} ${"x".repeat(80)}`,
    ).join("\n");
    const { stdout } = await runCli(
      ["apps", "logs", "big", "--tail", "400", "--filter", "password=hunter2"],
      {
        scenario: scenario([{ argv: ["app", "logs", "big"], stdout: lines }]),
      },
    );
    expect(stdout).toMatch(
      /logs: showing the newest \d+ of 400 lines \(output capped at 20000 chars\)/,
    );
    expect(stdout).toContain("line 399 ");
    expect(stdout).not.toContain("line 0 ");
    expect(stdout).not.toContain("hunter2");
    expect(stdout).toContain("reapply --filter manually if needed");
    expect(stdout).toContain(
      "Run `argocd-axi apps logs big --full --tail 400` to see all requested lines",
    );
    const full = await runCli(
      ["apps", "logs", "big", "--tail", "400", "--full"],
      {
        scenario: scenario([{ argv: ["app", "logs", "big"], stdout: lines }]),
      },
    );
    expect(full.stdout).toContain("line 0 ");
    expect(full.stdout).toContain("line 399 ");
    expect(full.stdout).not.toContain("to see all requested lines");
  });

  it("reports the hard tail ceiling and any simultaneous character cap", async () => {
    const lines = Array.from({ length: 5001 }, (_, index) => `line ${index}`);
    const { stdout } = await runCli(
      ["apps", "logs", "ceiling", "--tail", "5000"],
      {
        scenario: scenario([
          { argv: ["app", "logs", "ceiling"], stdout: lines.join("\n") },
        ]),
      },
    );
    expect(stdout).toContain(
      "The --tail limit is 5000 lines; no larger tail is supported",
    );
    expect(stdout).not.toContain("to see all requested lines");

    const longLines = Array.from(
      { length: 5001 },
      (_, index) => `line ${index} ${"x".repeat(100)}`,
    );
    const capped = await runCli(["apps", "logs", "ceiling", "--tail", "5000"], {
      scenario: scenario([
        { argv: ["app", "logs", "ceiling"], stdout: longLines.join("\n") },
      ]),
    });
    expect(capped.stdout).toContain("no larger tail is supported");
    expect(capped.stdout).toContain(
      "--full output is capped at 1000000 characters",
    );
    expect(capped.stdout).not.toContain("to see all requested lines");
  });

  it("bounds --full output and reports the exact omitted line count", async () => {
    const lines = Array.from(
      { length: 11 },
      (_, index) => `line ${index} ${"x".repeat(100_000)}`,
    ).join("\n");
    const { stdout } = await runCli(
      ["apps", "logs", "large", "--tail", "20", "--full"],
      {
        scenario: scenario([{ argv: ["app", "logs", "large"], stdout: lines }]),
      },
    );
    expect(stdout).toContain(
      "2 requested lines omitted by the 1000000-character cap",
    );
    expect(stdout).toContain("narrow with --tail, --since, --kind, or --name");
    expect(stdout.length).toBeLessThan(1_010_000);
    expect(stdout).toContain("line 10 ");
    expect(stdout).not.toContain("line 0 ");

    const oversizedLine = `line ${"y".repeat(1_000_001)}`;
    const oversized = await runCli(
      ["apps", "logs", "large", "--tail", "1", "--full"],
      {
        scenario: scenario([
          { argv: ["app", "logs", "large"], stdout: oversizedLine },
        ]),
      },
    );
    expect(oversized.stdout).toContain(
      "0 requested lines omitted by the 1000000-character cap",
    );
    expect(oversized.stdout).toContain("6 chars omitted from the newest line");
    expect(oversized.stdout.length).toBeLessThan(1_010_000);
  });

  it("keeps only the tail of a newest line longer than the cap", async () => {
    const line = `head ${"y".repeat(30_000)} tail-marker`;
    const { stdout } = await runCli(["apps", "logs", "big"], {
      scenario: scenario([
        { argv: ["app", "logs", "big"], stdout: `older line\n${line}\n` },
      ]),
    });
    expect(stdout).toContain(
      `logs: showing the newest 1 of 2 lines (output capped at 20000 chars) and only the last 20000 of the newest line's ${line.length} chars`,
    );
    expect(stdout).toContain("tail-marker");
    expect(stdout).toContain(
      `${line.length - 20_000} chars omitted from the newest line`,
    );
    expect(stdout).not.toContain("head ");
    expect(stdout).not.toContain("older line");
    expect(stdout.length).toBeLessThan(21_000);
  });

  it.each([
    [
      "https://bot:ghp_secret123@github.com/org/repo.git",
      "https://bot:[redacted]@github.com/org/repo.git",
    ],
    [
      "https://ghp_secret123@github.com/org/repo.git",
      "https://[redacted]@github.com/org/repo.git",
    ],
    [
      "https://:ghp_secret123@github.com/org/repo.git",
      "https://:[redacted]@github.com/org/repo.git",
    ],
  ])(
    "masks credentials in repo URL %s everywhere (S12)",
    async (repoURL, masked) => {
      const app = {
        metadata: { name: "cred", namespace: "argocd" },
        spec: {
          project: "default",
          source: { repoURL, path: "app", targetRevision: "HEAD" },
          destination: { server: "https://kubernetes.default.svc" },
        },
        status: { sync: { status: "Synced" }, health: { status: "Healthy" } },
      };
      const appset = {
        metadata: { name: "cred-set", namespace: "argocd" },
        spec: {
          generators: [{ list: { elements: [] } }],
          template: {
            metadata: { name: "x" },
            spec: { project: "default", source: { repoURL, path: "app" } },
          },
        },
      };
      const credScenario = scenario([
        { argv: ["app", "list"], stdout: JSON.stringify([app]) },
        { argv: ["app", "get", "cred"], stdout: JSON.stringify(app) },
        { argv: ["appset", "get", "cred-set"], stdout: JSON.stringify(appset) },
        { argv: ["appset", "generate"], stdout: JSON.stringify([app]) },
      ]);
      const home = makeHome();
      const file = join(home, "appset.json");
      writeFileSync(file, JSON.stringify(appset));
      for (const args of [
        ["apps", "--fields", "repo"],
        ["apps", "view", "cred"],
        ["appsets", "view", "cred-set"],
        ["appsets", "generate", file],
      ]) {
        const { stdout, exitCode } = await runCli(args, {
          scenario: credScenario,
          home,
        });
        expect(exitCode, args.join(" ")).toBe(0);
        expect(stdout, args.join(" ")).toContain(masked);
        expect(stdout, args.join(" ")).not.toContain("ghp_secret123");
        expect(stdout, args.join(" ")).toMatch(/sensitive values? hidden/);
      }
    },
  );

  it("reports the original size of a long list attention reason", async () => {
    const message = "failure detail ".repeat(20);
    const app = {
      metadata: { name: "long-reason", namespace: "argocd" },
      spec: { project: "default" },
      status: {
        sync: { status: "Synced" },
        health: { status: "Degraded", message },
        conditions: Array.from({ length: 50 }, (_, index) => ({
          type: `Condition${index}`,
          message,
        })),
      },
    };
    const { stdout } = await runCli(["apps"], {
      scenario: scenario([
        { argv: ["app", "list"], stdout: JSON.stringify([app]) },
      ]),
    });
    expect(stdout).toContain(
      `truncated, ${"Degraded: ".length + message.length + Array.from({ length: 50 }, (_, index) => `; Condition${index}: `.length + message.length).reduce((total, length) => total + length, 0)} chars total`,
    );
  });

  it("redacts messages before cutting them in list views (S12)", async () => {
    const token = "ghp_SECRETTOKEN1234567890abcdefghijklmnop";
    const cutInUrl = (prefix: number) =>
      `${"x".repeat(prefix)} clone https://bot:${token}@github.com/org/repo.git failed`;
    const keyValue = "rendering failed: token=supersecretvalue123";
    const app = {
      metadata: { name: "leaky", namespace: "argocd" },
      spec: { project: "default" },
      status: {
        sync: { status: "Synced" },
        health: { status: "Degraded", message: keyValue },
        conditions: [{ type: "ComparisonError", message: cutInUrl(50) }],
      },
    };
    const appset = (name: string, message: string) => ({
      metadata: { name },
      spec: { generators: [{ list: {} }] },
      status: {
        conditions: [{ type: "ErrorOccurred", status: "True", message }],
      },
    });
    const leaky = scenario([
      { argv: ["context"], exact: true, stdoutFile: "context.txt" },
      { argv: ["version"], stdoutFile: "version.json" },
      { argv: ["version", "--client"], stdoutFile: "version-client.json" },
      { argv: ["account", "get-user-info"], stdoutFile: "user.json" },
      { argv: ["app", "list"], stdout: JSON.stringify([app]) },
      {
        argv: ["appset", "list"],
        stdout: JSON.stringify([
          appset("cut", cutInUrl(70)),
          appset("kv", keyValue),
        ]),
      },
    ]);
    for (const args of [["apps"], [], ["appsets"]]) {
      const { stdout } = await runCli(args, { scenario: leaky });
      const label = args.join(" ") || "home";
      expect(stdout, label).not.toContain("ghp_SECRET");
      expect(stdout, label).not.toContain("supersecretvalue123");
      expect(stdout, label).toContain("[redacted]");
      expect(stdout, label).toMatch(/sensitive values? hidden/);
    }
  });

  it("counts each hidden secret once in apps view", async () => {
    const app = {
      metadata: { name: "leaky", namespace: "argocd" },
      spec: { project: "default" },
      status: {
        sync: { status: "Synced" },
        health: { status: "Healthy" },
        conditions: [
          {
            type: "ComparisonError",
            message: "rendering failed: token=supersecretvalue123",
          },
        ],
      },
    };
    const { stdout } = await runCli(["apps", "view", "leaky"], {
      scenario: scenario([
        { argv: ["app", "get", "leaky"], stdout: JSON.stringify(app) },
      ]),
    });
    expect(stdout).not.toContain("supersecretvalue123");
    expect(stdout).toContain(
      "ComparisonError: rendering failed: token=[redacted]",
    );
    expect(stdout).toContain("1 sensitive value hidden");
  });

  it("counts a secret once when a view shows its message twice", async () => {
    const secret = "rendering failed: token=supersecretvalue123";
    const app = {
      metadata: { name: "canary", namespace: "argocd" },
      spec: { project: "default" },
      status: {
        sync: { status: "Synced" },
        health: { status: "Healthy" },
        resources: [
          {
            group: "argoproj.io",
            kind: "Rollout",
            namespace: "web",
            name: "canary",
            status: "Synced",
            health: { status: "Degraded", message: secret },
          },
        ],
      },
    };
    const appset = {
      metadata: { name: "broken" },
      spec: { generators: [{ list: {} }] },
      status: {
        conditions: [
          { type: "ErrorOccurred", status: "True", message: secret },
        ],
      },
    };
    const views = scenario([
      { argv: ["app", "get", "canary"], stdout: JSON.stringify(app) },
      { argv: ["appset", "get", "broken"], stdout: JSON.stringify(appset) },
    ]);
    for (const args of [
      ["apps", "view", "canary"],
      ["appsets", "view", "broken"],
    ]) {
      const { stdout } = await runCli(args, { scenario: views });
      const label = args.join(" ");
      expect(stdout, label).not.toContain("supersecretvalue123");
      expect(stdout.split("token=[redacted]").length - 1, label).toBe(2);
      expect(stdout, label).toContain("1 sensitive value hidden");
    }
  });

  it("shows an unknown Progressing duration without flagging it (A6)", async () => {
    const app = {
      metadata: { name: "rolling", namespace: "argocd" },
      spec: { project: "default" },
      status: {
        sync: { status: "Synced" },
        health: { status: "Progressing" },
        operationState: {
          phase: "Succeeded",
          finishedAt: "2026-01-01T00:00:00Z",
        },
      },
    };
    const progressing = scenario([
      { argv: ["app", "list"], stdout: JSON.stringify([app]) },
      { argv: ["app", "get", "rolling"], stdout: JSON.stringify(app) },
    ]);
    expect(
      (await runCli(["apps"], { scenario: progressing })).stdout,
    ).toContain("count: 1 of 1 total (0 need attention)");
    const view = await runCli(["apps", "view", "rolling"], {
      scenario: progressing,
    });
    expect(view.stdout).toContain("progressingSince: unknown");
    expect(view.stdout).toContain("attention: none");
  });

  it("waits with a bound and returns the state either way (S16)", async () => {
    const met = await runCli([
      "apps",
      "wait",
      "guestbook",
      "--health",
      "--timeout",
      "30",
    ]);
    expect(met.calls[0]).toEqual([
      "app",
      "wait",
      "guestbook",
      "--health",
      "--timeout",
      "30",
    ]);
    expect(met.stdout).toMatch(/wait: condition met \(health\) after \d+s\n/);
    const timedOut = await runCli([
      "apps",
      "wait",
      "checkout",
      "--timeout",
      "5",
    ]);
    expect(timedOut.exitCode).toBe(0);
    expect(timedOut.stdout).toContain(
      'wait: "timed out after 5s; condition not met (sync, health, operation)"',
    );
    expect(timedOut.stdout).toContain("health: Progressing");
    expect(timedOut.stdout).toContain(
      "Run `argocd-axi apps wait checkout --timeout 5` to wait again",
    );
    expect(
      (await runCli(["apps", "wait", "x", "--timeout", "601"])).stdout,
    ).toContain("--timeout must be between 1 and 600");
  });

  it("lists resource actions and refuses running them", async () => {
    expect((await runCli(["apps", "actions", "web"])).stdout).toContain(
      "actions[3]{kind,name,action,disabled}:\n  Rollout,web,promote-full,no\n  Rollout,web,abort,no\n  Rollout,web,resume,yes",
    );
    const run = await runCli(["apps", "actions", "run", "web", "promote-full"]);
    expect(run.stdout).toContain("code: REFUSED");
    expect(run.calls).toEqual([]);
  });
});
