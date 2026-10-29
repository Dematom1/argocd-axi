import { spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { VERSION } from "../src/version.js";
import { ROOT, makeHome, runCli, scenario } from "./helpers.js";

describe("refusals (A2, A-c22)", () => {
  it.each([
    ["apps", "sync", "payments-api"],
    ["apps", "rollback", "payments-api", "7"],
    ["apps", "terminate-op", "payments-api"],
    ["apps", "refresh", "payments-api"],
    ["apps", "action", "run", "web", "restart"],
  ])("plans the write tier for %s %s", async (...args) => {
    const { stdout, exitCode, calls } = await runCli(args);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: REFUSED");
    expect(stdout).toContain("not in v1 (see ROADMAP.md)");
    expect(stdout).toMatch(/A human can .* with the raw CLI: `argocd app /);
    expect(calls).toEqual([]);
  });

  it.each([
    ["login"],
    ["relogin"],
    ["logout"],
    ["configure"],
    ["account", "generate-token"],
    ["admin", "export"],
    ["cert", "add-tls"],
    ["gpg", "add"],
    ["repocreds", "add"],
    ["repos", "add", "https://x"],
    ["clusters", "add", "ctx"],
    ["clusters", "rotate-auth", "x"],
    ["projects", "role", "create-token", "p", "r"],
    ["projects", "delete", "p"],
    ["appsets", "delete", "x"],
    ["apps", "delete", "x"],
    ["apps", "edit", "x"],
    ["apps", "patch-resource", "x"],
    ["apps", "delete-resource", "x"],
  ])("refuses %s with a reason and a route", async (...args) => {
    const { stdout, exitCode, calls } = await runCli(args);
    expect(exitCode).toBe(1);
    expect(stdout).toContain("code: REFUSED");
    expect(stdout).toMatch(/help\[\d+\]:/);
    expect(calls).toEqual([]);
  });

  it("points argocd's own nouns at the argocd-axi spelling", async () => {
    const { stdout, exitCode } = await runCli(["app", "list"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("argocd-axi spells this `apps`");
  });
});

describe("account, projects, appsets, inventory", () => {
  it("whoami and can-i", async () => {
    const who = await runCli(["whoami"]);
    expect(who.stdout).toContain(
      'user: alice\nissuer: "https://dex.example.com"\ngroups[2]: platform,payments',
    );
    const yes = await runCli(["can-i", "sync", "applications", "payments/*"]);
    expect(yes.stdout).toContain(
      "answer: yes\ncheck: sync applications payments/*",
    );
    const no = await runCli(["can-i", "delete", "applications", "*"]);
    expect(no.exitCode).toBe(0);
    expect(no.stdout).toContain("answer: no");
    expect(
      (await runCli(["can-i", "destroy", "applications", "*"])).exitCode,
    ).toBe(2);
    const odd = await runCli(["can-i", "get", "applications", "*"]);
    expect(odd.exitCode).toBe(1);
    expect(odd.stdout).toContain("code: UPSTREAM_ERROR");
    expect(odd.stdout).not.toContain("answer:");
  });

  it("projects, view and sync windows", async () => {
    expect((await runCli(["projects"])).stdout).toContain(
      'projects[2]{project,description,destinations,windows}:\n  default,"",1,0\n  payments,Payments team services,2,2',
    );
    const view = await runCli(["projects", "view", "payments"]);
    expect(view.stdout).toContain(
      "roles[1]{role,policies,groups,tokens}:\n  ci,1,0,1",
    );
    expect(view.stdout).not.toContain("a1b2c3");
    const frozen = await runCli(["projects", "windows", "frozen"]);
    expect(frozen.stdout).toContain(
      "sync:\n  automated: blocked\n  manual: blocked\n  reason: 1 deny window is active",
    );
    expect((await runCli(["projects", "windows", "default"])).stdout).toContain(
      "windows: 0 sync windows in project default",
    );
  });

  it("redacts secrets in a project description in list and view (S12)", async () => {
    const project = {
      metadata: { name: "leaky" },
      spec: { description: "deploy bot uses token=supersecretvalue123" },
    };
    const leaky = scenario([
      { argv: ["proj", "list"], stdout: JSON.stringify([project]) },
      { argv: ["proj", "get", "leaky"], stdout: JSON.stringify(project) },
    ]);
    for (const args of [["projects"], ["projects", "view", "leaky"]]) {
      const { stdout } = await runCli(args, { scenario: leaky });
      const label = args.join(" ");
      expect(stdout, label).not.toContain("supersecretvalue123");
      expect(stdout, label).toContain("token=[redacted]");
      expect(stdout, label).toContain("1 sensitive value hidden");
    }
  });

  it("appsets, view and generate", async () => {
    const list = await runCli(["appsets"]);
    expect(list.stdout).toContain(
      'broken,default,clusters,"error: failed to execute go template: missing key"',
    );
    expect((await runCli(["appsets", "view", "team-apps"])).stdout).toContain(
      "apps[2]{app,sync,health}:\n  team-blue,OutOfSync,Healthy",
    );
    const home = makeHome();
    const file = join(home, "appset.yaml");
    writeFileSync(file, "kind: ApplicationSet\n");
    const generated = await runCli(["appsets", "generate", file], { home });
    expect(generated.stdout).toContain(
      "count: 1 application would be generated",
    );
    expect(generated.calls).toContainEqual([
      "appset",
      "generate",
      file,
      "-o",
      "json",
    ]);
    expect(
      (await runCli(["appsets", "generate", "/does/not/exist.yaml"])).stdout,
    ).toContain("file not found");
    expect(
      (await runCli(["appsets", "generate", "https://example.com/a.yaml"]))
        .exitCode,
    ).toBe(2);
  });

  it("repos and clusters never print credentials", async () => {
    const repos = await runCli(["repos"]);
    expect(repos.stdout).toContain(
      '"https://charts.example.com",helm,charts,"","Failed: unable to connect: 401 Unauthorized"',
    );
    expect(repos.stdout).not.toContain("ghp_should_never_be_printed");
    expect(repos.stdout).not.toContain("deploy-bot");
    const clusters = await runCli(["clusters"]);
    expect(clusters.stdout).toContain('count: "2 clusters, 1 failing"');
    expect(clusters.stdout).not.toContain("should-never-print");
  });

  it("repos masks credentials embedded in a repository URL", async () => {
    const embedded = scenario([
      { argv: ["context"], exact: true, stdoutFile: "context.txt" },
      {
        argv: ["repo", "list"],
        stdout: JSON.stringify([
          {
            repo: "https://bot:ghp_url_token_never_printed@github.com/example/infra.git",
            type: "git",
            name: "infra",
            connectionState: { status: "Successful" },
          },
        ]),
      },
    ]);
    const { stdout } = await runCli(["repos"], { scenario: embedded });
    expect(stdout).toContain("github.com/example/infra.git");
    expect(stdout).not.toContain("ghp_url_token_never_printed");
    expect(stdout).toMatch(/redacted/);
  });
});

describe("help, version and setup", () => {
  it("answers --version from the fast path", async () => {
    const pkg = JSON.parse(
      readFileSync(join(ROOT, "package.json"), "utf8"),
    ) as { version: string };
    expect(VERSION).toBe(pkg.version);
    for (const flag of ["--version", "-v", "-V"]) {
      const { stdout, calls } = await runCli([flag]);
      expect(stdout).toBe(`${VERSION}\n`);
      expect(calls).toEqual([]);
    }
  });

  it("prints top-level and per-command help without calling argocd", async () => {
    const top = await runCli(["--help"]);
    expect(top.stdout).toContain("commands[18]:");
    expect(top.calls).toEqual([]);
    const view = await runCli(["apps", "view", "--help"]);
    expect(view.stdout).toContain("usage: argocd-axi apps view <app> [flags]");
    expect(view.stdout).toContain("examples[2]:");
    expect(view.calls).toEqual([]);
    expect((await runCli(["apps", "--help"])).stdout).toContain(
      "subcommands[8]:",
    );
  });

  it("rejects flags before the command", async () => {
    const { stdout, exitCode } = await runCli(["--context", "prod", "apps"]);
    expect(exitCode).toBe(2);
    expect(stdout).toContain("Flags must come after the command");
  });

  it("installs a SessionStart hook that runs the offline ctx entrypoint", async () => {
    const home = makeHome();
    const { stdout, exitCode, calls } = await runCli(["setup", "hooks"], {
      home,
    });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("hooks: installed or already up to date");
    expect(calls).toEqual([]);
    const settings = readFileSync(
      join(home, ".claude", "settings.json"),
      "utf8",
    );
    expect(settings).toMatch(/argocd-axi-ctx/);
    expect(settings).not.toMatch(/"command": "[^"]*argocd-axi\.js"/);
  });

  it("refuses to install hooks from a temporary npx cache", async () => {
    const home = makeHome();
    const pkg = join(home, "_npx", "0a1b2c", "node_modules", "argocd-axi");
    mkdirSync(pkg, { recursive: true });
    cpSync(join(ROOT, "dist"), join(pkg, "dist"), { recursive: true });
    cpSync(join(ROOT, "package.json"), join(pkg, "package.json"));
    symlinkSync(join(ROOT, "node_modules"), join(pkg, "node_modules"));
    const result = spawnSync(
      process.execPath,
      [join(pkg, "dist", "bin", "argocd-axi.js"), "setup", "hooks"],
      { encoding: "utf8", env: { PATH: "", HOME: home } },
    );
    expect(result.status).toBe(1);
    expect(result.stdout).toContain("code: REFUSED");
    expect(result.stdout).toContain("npm install -g argocd-axi");
    expect(existsSync(join(home, ".claude", "settings.json"))).toBe(false);
  });
});

describe("guards", () => {
  it("refuses sync-window changes and hints ctx use", async () => {
    const windows = await runCli(["projects", "windows", "add", "payments"]);
    expect(windows.stdout).toContain("code: REFUSED");
    expect(windows.calls).toEqual([]);
    const ctx = await runCli(["ctx", "staging"]);
    expect(ctx.exitCode).toBe(2);
    expect(ctx.stdout).toContain("argocd-axi ctx use staging");
  });

  it("does not treat Object.prototype names as subcommands", async () => {
    for (const verb of ["constructor", "toString", "__proto__"]) {
      const run = await runCli(["apps", verb]);
      expect(run.exitCode).toBe(2);
      expect(run.stdout).toContain("code: VALIDATION_ERROR");
      expect(run.calls).toEqual([]);
      const help = await runCli(["apps", verb, "--help"]);
      expect(help.exitCode).toBe(0);
      expect(help.stdout).toContain("subcommands[8]:");
      const top = await runCli([verb]);
      expect(top.exitCode).toBe(2);
      expect(top.stdout).toContain("code: VALIDATION_ERROR");
      expect(top.stdout).not.toContain("spells this");
      expect(top.calls).toEqual([]);
    }
  });
});
