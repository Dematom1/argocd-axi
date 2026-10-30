import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  expectSafeCalls,
  isNetworkCall,
  makeHome,
  runCli,
  scenario,
} from "./helpers.js";

describe("test isolation", () => {
  it("can only reach the fake argocd", async () => {
    const result = await runCli(["apps"], { scenario: scenario([]) });
    expect(result.stdout).toContain("fake argocd: no fixture");
    expect(result.exitCode).toBe(1);
  });
});

describe("home view", () => {
  it("prints the offline auth guide for the resolved server", async () => {
    const { stdout, exitCode, calls } = await runCli(["auth", "guide"]);
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      "argocd login 'argocd.example.com' --sso --grpc-web",
    );
    expect(stdout).toContain("ARGOCD_SERVER");
    expect(stdout).toContain("ARGOCD_AUTH_TOKEN");
    expect(calls.filter(isNetworkCall)).toEqual([]);
  });

  it("includes the context lookup failure in the offline guide", async () => {
    const failedLookup = scenario([
      {
        argv: ["context"],
        exact: true,
        exit: 20,
        stderr: 'level=fatal msg="No contexts defined"\\n',
      },
    ]);
    const { stdout, exitCode } = await runCli(
      ["auth", "guide", "--context", "prod"],
      { scenario: failedLookup, env: { ARGOCD_SERVER: "cd.example.com" } },
    );
    expect(exitCode).toBe(0);
    expect(stdout).toContain("contexts: unavailable - No contexts defined");
    expect(stdout).toContain("argocd login 'cd.example.com' --sso --grpc-web");
  });

  it("reports rejected login separately from an unreachable server", async () => {
    const auth = scenario([
      { argv: ["context"], exact: true, stdoutFile: "context.txt" },
      {
        argv: ["app", "list"],
        exit: 20,
        stderr:
          'level=fatal msg="rpc error: code = Unauthenticated desc = token is expired"\\n',
      },
    ]);
    const rejected = await runCli(["apps"], { scenario: auth });
    expect(rejected.stdout).toContain("code: AUTH_EXPIRED");
    expect(rejected.stdout).toContain(
      "argocd login 'argocd.example.com' --sso --grpc-web",
    );

    const unreachable = scenario([
      { argv: ["context"], exact: true, stdoutFile: "context.txt" },
      {
        argv: ["app", "list"],
        exit: 20,
        stderr:
          'level=fatal msg="dial tcp 10.0.0.1:443: connect: connection refused"\\n',
      },
    ]);
    expect(
      (await runCli(["apps"], { scenario: unreachable })).stdout,
    ).toContain("code: SERVER_UNREACHABLE");
  });

  it("shows the target, user, apps needing attention and running operations", async () => {
    const { stdout, exitCode, calls } = await runCli([]);
    expect(exitCode).toBe(0);
    expect(stdout).toMatch(/^bin: .*argocd-axi\.js\ndescription: /);
    expect(stdout).toContain("context: prod\nserver: argocd.example.com\n");
    expect(stdout).toContain("user: alice");
    expect(stdout).toContain(
      'apps: "5 total, 3 need attention, 1 operation running"',
    );
    expect(stdout).toContain("writableContexts: none");
    expect(stdout).toContain(
      "attention[3]{app,project,sync,health,why}:\n  payments-api,payments,OutOfSync,Degraded,",
    );
    expect(stdout).toContain(
      "checkout,shop,Synced,Progressing,Progressing for 25m",
    );
    expect(stdout).toContain(
      "operations[1]{app,phase,started}:\n  checkout,Running,25m ago",
    );
    expect(stdout).not.toContain("guestbook");
    expectSafeCalls(calls);
  });

  const skewed = scenario([
    { argv: ["context"], exact: true, stdoutFile: "context.txt" },
    {
      argv: ["version"],
      stdout: '{"client":{"Version":"v3.3.6"},"server":{"Version":"v2.13.1"}}',
    },
    { argv: ["app", "list"], stdout: "[]" },
    { argv: ["account", "get-user-info"], stdoutFile: "user.json" },
    { argv: ["version", "--client"], stdoutFile: "version-client.json" },
  ]);

  it("refreshes the version check at most every 12 hours and warns on major skew", async () => {
    const home = makeHome();
    const first = await runCli([], { home, scenario: skewed });
    expect(first.stdout).toContain(
      "warning: argocd CLI v3.3.6 and server v2.13.1 differ by a major version",
    );
    expect(first.stdout).toContain(
      "apps: 0 applications visible to this credential",
    );
    expect(
      first.calls.filter((c) => c[0] === "version" && c[1] !== "--client"),
    ).toHaveLength(1);
    const second = await runCli([], { home, scenario: skewed });
    expect(
      second.calls.filter((c) => c[0] === "version" && c[1] !== "--client"),
    ).toHaveLength(0);
    expect(second.stdout).toContain("warning:");
    const ctx = await runCli(["ctx"], { home, scenario: skewed });
    expect(ctx.stdout).toContain("serverVersion: v2.13.1 (checked just now)");
    expect(ctx.stdout).toContain(
      "warning: argocd CLI v3.3.6 and server v2.13.1",
    );
  });

  it("caches a check made against ARGOCD_SERVER under that server", async () => {
    // It neither shows for nor replaces the context's own server.
    const env = { ARGOCD_SERVER: "other.example.com" };
    const envHome = makeHome();
    await runCli([], { home: envHome, scenario: skewed, env });
    expect(
      (await runCli(["ctx"], { home: envHome, scenario: skewed, env })).stdout,
    ).toContain("serverVersion: v2.13.1");
    expect(
      (await runCli(["ctx"], { home: envHome, scenario: skewed })).stdout,
    ).not.toContain("serverVersion:");
  });

  it("degrades each read to unavailable instead of failing", async () => {
    const broken = scenario([
      { argv: ["context"], exact: true, stdoutFile: "context.txt" },
      {
        argv: ["app", "list"],
        exit: 20,
        stderr:
          'level=fatal msg="dial tcp 1.2.3.4:443: connect: connection refused"\n',
      },
      {
        argv: ["account"],
        exit: 20,
        stderr:
          'level=fatal msg="rpc error: code = Unauthenticated desc = invalid session"\n',
      },
      { argv: ["version"], exit: 20, stderr: "boom" },
    ]);
    const { stdout, exitCode } = await runCli([], { scenario: broken });
    expect(exitCode).toBe(0);
    expect(stdout).toContain(
      'apps: "unavailable - Argo CD server unreachable: dial tcp 1.2.3.4:443: connect: connection refused"',
    );
    expect(stdout).toContain(
      'user: "unavailable - Not authenticated to Argo CD',
    );
    expect(stdout).toContain(
      "Run `argocd-axi ctx` to confirm which server this context targets",
    );
  });

  it("makes no server call when no context is configured", async () => {
    const empty = scenario([
      {
        argv: ["context"],
        exact: true,
        exit: 20,
        stderr: 'level=fatal msg="No contexts defined"\n',
      },
    ]);
    const { stdout, exitCode, calls } = await runCli([], { scenario: empty });
    expect(exitCode).toBe(0);
    expect(stdout).toContain("context: none configured");
    expect(stdout).toContain(
      "A human runs `argocd login <server> --sso --grpc-web`",
    );
    expect(calls.filter(isNetworkCall)).toEqual([]);
  });
});

describe("ctx and the session hook (S17)", () => {
  it("is offline: only local argocd commands run", async () => {
    for (const bin of ["argocd-axi", "argocd-axi-ctx"] as const) {
      const { stdout, exitCode, calls } = await runCli(
        bin === "argocd-axi" ? ["ctx"] : [],
        { bin },
      );
      expect(exitCode).toBe(0);
      expect(stdout).toContain(
        "context: prod\nserver: argocd.example.com\nauth: argocd CLI session for this context\ncli: v3.3.6 (tested with v3.3.6)",
      );
      expect(stdout).toContain("writableContexts: none");
      expect(stdout).toContain(
        "otherContexts[1]{name,server}:\n  staging,argocd-staging.example.com",
      );
      expect(calls.filter(isNetworkCall)).toEqual([]);
      expect(calls.map((c) => c.join(" ")).sort()).toEqual([
        "context",
        "version --client -o json",
      ]);
    }
  });

  it("degrades with exit 0 when the argocd CLI is not on PATH", async () => {
    const emptyPath = makeHome();
    for (const [bin, args] of [
      ["argocd-axi", ["ctx"]],
      ["argocd-axi-ctx", []],
      ["argocd-axi", []],
    ] as const) {
      const { stdout, exitCode } = await runCli([...args], {
        bin,
        env: { PATH: emptyPath },
      });
      const label = [bin, ...args].join(" ");
      expect(exitCode, label).toBe(0);
      expect(stdout, label).toContain("context: none configured");
      expect(stdout, label).toContain(
        "contexts: unavailable - The argocd CLI is not installed or not on PATH",
      );
      if (label !== "argocd-axi")
        expect(stdout, label).toContain("cli: argocd CLI not found on PATH");
      expect(stdout, label).toContain("A human installs the argocd CLI");
      expect(stdout, label).not.toContain("argocd login");
    }
    const use = await runCli(["ctx", "use", "staging"], {
      env: { PATH: emptyPath },
    });
    expect(use.exitCode).toBe(1);
    expect(use.stdout).toContain("code: ARGOCD_NOT_INSTALLED");
    expect(use.stdout).toContain("A human installs the argocd CLI");
  });

  it("points env-credential setups without a context at the live view", async () => {
    const empty = scenario([
      {
        argv: ["context"],
        exact: true,
        exit: 20,
        stderr: 'level=fatal msg="No contexts defined"\n',
      },
    ]);
    for (const bin of ["argocd-axi", "argocd-axi-ctx"] as const) {
      const { stdout, exitCode } = await runCli(
        bin === "argocd-axi" ? ["ctx"] : [],
        {
          bin,
          scenario: empty,
          env: {
            ARGOCD_AUTH_TOKEN: "eyJ.secret.value",
            ARGOCD_SERVER: "cd.example.com",
          },
        },
      );
      expect(exitCode, bin).toBe(0);
      expect(stdout, bin).toContain(
        "server: cd.example.com (from ARGOCD_SERVER)",
      );
      expect(stdout, bin).toContain("Run `argocd-axi` for a live overview");
      expect(stdout, bin).not.toContain("argocd login");
    }
  });

  it("reports the environment token and server without reading them out", async () => {
    const { stdout } = await runCli(["ctx"], {
      env: {
        ARGOCD_AUTH_TOKEN: "eyJ.secret.value",
        ARGOCD_SERVER: "cd.example.com",
      },
    });
    expect(stdout).toContain("server: cd.example.com (from ARGOCD_SERVER)");
    expect(stdout).toContain("auth: ARGOCD_AUTH_TOKEN is set");
    expect(stdout).not.toContain("eyJ.secret.value");
  });

  it("shows the writable-contexts allowlist from the tool's own config", async () => {
    const home = makeHome();
    mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
    writeFileSync(
      join(home, ".config", "argocd-axi", "config"),
      "writable-contexts: [staging]\n",
    );
    expect((await runCli(["ctx"], { home })).stdout).toContain(
      "writableContexts: staging",
    );
    writeFileSync(
      join(home, ".config", "argocd-axi", "config"),
      "writable-contexts: staging\n",
    );
    const broken = await runCli(["ctx"], { home });
    expect(broken.exitCode).toBe(0);
    expect(broken.stdout).toMatch(
      /writableContexts: "?unavailable - argocd-axi config .* is invalid: writable-contexts must be a list/,
    );
  });

  it("switches context with ctx use, idempotently (A11)", async () => {
    const switched = await runCli(["ctx", "use", "staging"]);
    expect(switched.stdout).toContain("context: switched to staging");
    expect(switched.calls.at(-1)).toEqual(["context", "staging"]);
    const already = await runCli(["ctx", "use", "prod"]);
    expect(already.exitCode).toBe(0);
    expect(already.stdout).toContain(
      "prod is already the current context (no-op)",
    );
    expect(already.calls).toEqual([["context"]]);
    const missing = await runCli(["ctx", "use", "nope"]);
    expect(missing.exitCode).toBe(1);
    expect(missing.stdout).toContain("code: CONTEXT_NOT_FOUND");
  });
});
