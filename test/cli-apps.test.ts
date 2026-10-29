import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, runCli, scenario } from "./helpers.js";

describe("apps", () => {
  it("lists problems first with the reason and a total", () => {
    const { stdout, calls } = runCli(["apps"]);
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

  it("filters, limits, widens and carries --context into hints", () => {
    const { stdout } = runCli([
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
      "Run `argocd-axi apps --limit 3 --context prod` to see all 3",
    );
    const project = runCli(["apps", "-p", "payments"]);
    expect(project.calls).toContainEqual([
      "app",
      "list",
      "-o",
      "json",
      "-p",
      "payments",
    ]);
    const none = runCli(["apps", "--health", "missing"]);
    expect(none.stdout).toContain(
      "apps: 0 of 5 applications match the filters",
    );
    expect(runCli(["apps", "--sync", "Broken"]).stdout).toContain(
      "--sync must be one of Synced, OutOfSync, Unknown",
    );
  });

  it("qualifies names with the namespace when apps span namespaces", () => {
    const { stdout, calls } = runCli(["apps", "--context", "staging"]);
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

  it("views an app with redacted Helm parameters and values", () => {
    const { stdout, exitCode } = runCli(["apps", "view", "payments-api"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "  sync: OutOfSync\n  revision: 9f8e7d6\n  health: Degraded",
    );
    expect(stdout).toContain("destination: prod-eu ns/payments");
    expect(stdout).toContain('1,db.password,"[redacted]"');
    expect(stdout).toContain('apiToken: "[redacted]"');
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

  it("shows every source of a multi-source app and Rollout health (A8, A9)", () => {
    expect(runCli(["apps", "view", "team-a/billing"]).stdout).toContain(
      'sources[2]{repo,path,target}:\n  "https://charts.example.com",chart billing,4.1.2\n  "https://github.com/example/values.git","",main',
    );
    expect(runCli(["apps", "view", "web"]).stdout).toContain(
      "rollouts[1]{name,namespace,health,message}:\n  web,shop,Suspended,Rollout is paused at step 2 of 4",
    );
  });

  it("maps errors to codes with exit 1, and usage errors to exit 2", () => {
    const missing = runCli(["apps", "view", "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: NOT_FOUND");
    expect(missing.stdout).toContain(
      "Run `argocd-axi apps` to list applications",
    );
    expect(runCli(["apps", "view", "secret-app"]).stdout).toContain(
      "error: Permission denied by Argo CD RBAC\ncode: FORBIDDEN",
    );
    const usage = runCli(["apps", "view"]);
    expect(usage.exitCode).toBe(2);
    expect(usage.calls).toEqual([]);
    const unknown = runCli(["apps", "view", "x", "--refresh"]);
    expect(unknown.exitCode).toBe(2);
    expect(unknown.stdout).toContain(
      "refreshing an app triggers a reconcile, which is a write",
    );
    expect(unknown.calls).toEqual([]);
  });

  it("lists resources problems first, and orphaned resources from the table", () => {
    const all = runCli(["apps", "resources", "payments-api"]);
    expect(all.stdout).toContain("count: 4 of 4 resources (3 with problems)");
    expect(all.stdout.indexOf("Service,payments-api")).toBeGreaterThan(
      all.stdout.indexOf("ConfigMap,payments-old"),
    );
    expect(
      runCli(["apps", "resources", "payments-api", "--problems"]).stdout,
    ).toContain("count: 3 of 3 problem resources");
    expect(
      runCli(["apps", "resources", "payments-api", "--orphaned"]).stdout,
    ).toContain(
      'orphaned[2]{kind,name,namespace,group}:\n  ConfigMap,stale-config,payments,""\n  Deployment,old-worker,payments,apps',
    );
    expect(
      runCli(["apps", "resources", "guestbook", "--problems"]).stdout,
    ).toContain("0 problem resources in guestbook");
  });

  it("summarises drift per resource and only shows raw diff with --full (A5, S14)", () => {
    const summary = runCli(["apps", "diff", "payments-api"]);
    expect(summary.exitCode).toBe(0);
    expect(summary.stdout).toContain("drift: yes\ncount: 3 resources differ");
    expect(summary.stdout).toContain(
      "ConfigMap,payments-flags,payments,create",
    );
    expect(summary.stdout).toContain("ConfigMap,payments-old,payments,prune");
    expect(summary.calls.some((c) => c[1] === "diff")).toBe(false);

    const full = runCli(["apps", "diff", "payments-api", "--full"]);
    expect(full.calls).toContainEqual([
      "app",
      "diff",
      "payments-api",
      "--exit-code=false",
    ]);
    expect(full.stdout).toContain(
      "diff[17]:\n  ===== apps/Deployment payments/payments-api ======",
    );
    expect(full.stdout).toContain(">           value: [redacted]");
    expect(full.stdout).not.toContain("hunter2");

    expect(runCli(["apps", "diff", "guestbook"]).stdout).toContain("drift: no");
    const revision = runCli([
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

  it("shows history newest first from app get", () => {
    const { stdout, calls } = runCli(["apps", "history", "payments-api"]);
    expect(stdout).toContain(
      "current: 8\nhistory[2]{id,revision,deployed,by}:\n  8,bbbbbbb,24h ago,automated\n  7,aaaaaaa,2d ago,bob",
    );
    expect(calls.some((c) => c[1] === "history")).toBe(false);
  });

  it("lists manifests, redacting Secret data and sensitive env values", () => {
    const summary = runCli(["apps", "manifests", "payments-api"]);
    expect(summary.stdout).toContain(
      "manifests[3]{kind,name,namespace}:\n  Secret,payments-db,payments",
    );
    expect(summary.stdout).toContain("redacted: 4 sensitive values hidden");
    const full = runCli([
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
    expect(full.stdout).toContain('password: "[redacted]"');
    expect(full.stdout).not.toMatch(/aHVudGVyMg|cGF5bWVudHM|hunter2/);
    expect(
      runCli(["apps", "manifests", "payments-api", "--kind", "service"]).stdout,
    ).toContain("count: 1 resource\n");
    expect(
      runCli(["apps", "manifests", "x", "--source", "live", "--revision", "a"])
        .exitCode,
    ).toBe(2);
  });

  it("reads bounded logs, never follows, and redacts best effort (S11, S16)", () => {
    const { stdout, calls } = runCli([
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
    expect(runCli(["apps", "logs", "guestbook"]).stdout).toContain(
      "logs: 0 log lines returned for guestbook",
    );
    expect(runCli(["apps", "logs", "x", "--follow"]).stdout).toContain(
      "argocd-axi never streams",
    );
  });

  it("caps log output keeping the newest lines", () => {
    const lines = Array.from(
      { length: 400 },
      (_, i) => `line ${i} ${"x".repeat(80)}`,
    ).join("\n");
    const { stdout } = runCli(["apps", "logs", "big", "--tail", "400"], {
      scenario: scenario([{ argv: ["app", "logs", "big"], stdout: lines }]),
    });
    expect(stdout).toMatch(
      /logs: showing the newest \d+ of 400 lines \(output capped at 20000 chars\)/,
    );
    expect(stdout).toContain("line 399 ");
    expect(stdout).not.toContain("line 0 ");
  });

  it("keeps only the tail of a newest line longer than the cap", () => {
    const line = `head ${"y".repeat(30_000)} tail-marker`;
    const { stdout } = runCli(["apps", "logs", "big"], {
      scenario: scenario([
        { argv: ["app", "logs", "big"], stdout: `older line\n${line}\n` },
      ]),
    });
    expect(stdout).toContain(
      `logs: showing the newest 1 of 2 lines (output capped at 20000 chars) and only the last 20000 of the newest line's ${line.length} chars`,
    );
    expect(stdout).toContain("tail-marker");
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
  ])("masks credentials in repo URL %s everywhere (S12)", (repoURL, masked) => {
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
      const { stdout, exitCode } = runCli(args, {
        scenario: credScenario,
        home,
      });
      expect(exitCode, args.join(" ")).toBe(0);
      expect(stdout, args.join(" ")).toContain(masked);
      expect(stdout, args.join(" ")).not.toContain("ghp_secret123");
      expect(stdout, args.join(" ")).toMatch(/sensitive values? hidden/);
    }
  });

  it("shows an unknown Progressing duration without flagging it (A6)", () => {
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
    expect(runCli(["apps"], { scenario: progressing }).stdout).toContain(
      "count: 1 of 1 total (0 need attention)",
    );
    const view = runCli(["apps", "view", "rolling"], { scenario: progressing });
    expect(view.stdout).toContain("progressingSince: unknown");
    expect(view.stdout).toContain("attention: none");
  });

  it("waits with a bound and returns the state either way (S16)", () => {
    const met = runCli([
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
    const timedOut = runCli(["apps", "wait", "checkout", "--timeout", "5"]);
    expect(timedOut.exitCode).toBe(0);
    expect(timedOut.stdout).toContain(
      'wait: "timed out after 5s; condition not met (sync, health, operation)"',
    );
    expect(timedOut.stdout).toContain("health: Progressing");
    expect(timedOut.stdout).toContain(
      "Run `argocd-axi apps wait checkout --timeout 5` to wait again",
    );
    expect(runCli(["apps", "wait", "x", "--timeout", "601"]).stdout).toContain(
      "--timeout must be between 1 and 600",
    );
  });

  it("lists resource actions and refuses running them", () => {
    expect(runCli(["apps", "actions", "web"]).stdout).toContain(
      "actions[3]{kind,name,action,disabled}:\n  Rollout,web,promote-full,no\n  Rollout,web,abort,no\n  Rollout,web,resume,yes",
    );
    const run = runCli(["apps", "actions", "run", "web", "promote-full"]);
    expect(run.stdout).toContain("code: REFUSED");
    expect(run.calls).toEqual([]);
  });
});
