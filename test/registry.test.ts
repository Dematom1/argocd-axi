import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgv, runArgocd } from "../src/argocd.js";
import { CODES } from "../src/errors.js";
import {
  FORBIDDEN_ARGS,
  OPERATIONS,
  PLANNED_WRITES,
  REFUSALS,
  type OperationId,
} from "../src/registry.js";
import { expectSafeCalls, makeHome, runCli } from "./helpers.js";

// Decision S5: one seam, an explicit allowlist, a refusal registry. These
// tests fail when an operation becomes reachable without a deliberate change.

const WRITE_VERBS = [
  "sync",
  "rollback",
  "terminate-op",
  "delete",
  "create",
  "set",
  "unset",
  "patch",
  "edit",
  "add",
  "rm",
  "patch-resource",
  "delete-resource",
  "run",
  "login",
  "relogin",
  "logout",
  "generate-token",
  "update-password",
  "create-token",
  "import",
  "export",
  "rotate-auth",
  "confirm-deletion",
  "add-source",
  "remove-source",
];

describe("allowlist registry", () => {
  it("is exactly the reviewed set of operations", async () => {
    expect(
      Object.fromEntries(
        Object.entries(OPERATIONS).map(([id, op]) => [
          id,
          `${op.tier} ${op.argv.join(" ")}`,
        ]),
      ),
    ).toEqual({
      "app list": "read app list",
      "app get": "read app get",
      "app diff": "read app diff",
      "app sync": "write app sync",
      "app rollback": "write app rollback",
      "app terminate-op": "write app terminate-op",
      "app refresh": "write app get",
      "app actions run": "write app actions run",
      "app set": "write app set",
      "app resources": "read app resources",
      "app manifests": "read app manifests",
      "app logs": "read app logs",
      "app wait": "read app wait",
      "app actions list": "read app actions list",
      "proj list": "read proj list",
      "proj get": "read proj get",
      "proj windows list": "read proj windows list",
      "appset list": "read appset list",
      "appset get": "read appset get",
      "appset generate": "read appset generate",
      "repo list": "read repo list",
      "cluster list": "read cluster list",
      "account get-user-info": "read account get-user-info",
      "account can-i": "read account can-i",
      version: "read version",
      "version client": "local version --client",
      "context list": "local context",
      "context use": "local-write context",
    });
  });

  it("only exposes approved single-application writes", async () => {
    for (const op of Object.values(OPERATIONS)) {
      if (op.tier !== "write")
        for (const token of op.argv) expect(WRITE_VERBS).not.toContain(token);
    }
  });

  it("only local operations skip the network", async () => {
    for (const op of Object.values(OPERATIONS)) {
      expect(op.network).toBe(op.tier === "read" || op.tier === "write");
    }
  });

  it("refuses forbidden arguments at the seam", async () => {
    for (const arg of FORBIDDEN_ARGS) {
      expect(() => buildArgv("app get", ["guestbook", arg])).toThrow(
        /never passed to argocd/,
      );
    }
    expect(() => buildArgv("app get", ["guestbook", "--refresh=true"])).toThrow(
      /never passed/,
    );
    expect(buildArgv("app refresh", ["guestbook", "--refresh"])).toContain(
      "--refresh",
    );
    expect(buildArgv("app get", ["guestbook", "-o", "json"], "prod")).toEqual([
      "app",
      "get",
      "guestbook",
      "-o",
      "json",
      "--argocd-context",
      "prod",
    ]);
  });

  it("gives every refusal a reason and a route", async () => {
    for (const refusal of [
      ...Object.values(REFUSALS),
      ...Object.values(PLANNED_WRITES),
    ]) {
      expect(refusal.reason.length).toBeGreaterThan(10);
      expect(refusal.help.length).toBeGreaterThan(0);
    }
    expect(Object.keys(PLANNED_WRITES).sort()).toEqual([]);
  });
});

describe("one subprocess seam", () => {
  it("refuses an operation id that is not registered", async () => {
    await expect(
      runArgocd("app delete" as OperationId, ["guestbook"]),
    ).rejects.toMatchObject({ code: CODES.REFUSED });
  });

  it("never surfaces the argocd CLI config or a kubeconfig, on any command", async () => {
    const home = makeHome();
    const sentinel = "SENTINEL-do-not-read";
    mkdirSync(join(home, ".config", "argocd"), { recursive: true });
    writeFileSync(
      join(home, ".config", "argocd", "config"),
      `contexts:\n- name: ${sentinel}-ctx\n  server: ${sentinel}.example\nusers:\n- name: ${sentinel}.example\n  auth-token: ${sentinel}-token\n`,
    );
    const kubeconfig = join(home, "kubeconfig");
    writeFileSync(
      kubeconfig,
      `users:\n- name: ${sentinel}\n  token: ${sentinel}-kube\n`,
    );
    const commands = [
      [],
      ["ctx"],
      ["whoami"],
      ["can-i", "sync", "applications", "default/guestbook"],
      ["apps"],
      ["apps", "view", "guestbook"],
      ["apps", "resources", "guestbook"],
      ["apps", "diff", "guestbook"],
      ["apps", "history", "guestbook"],
      ["apps", "manifests", "guestbook"],
      ["apps", "logs", "guestbook"],
      ["apps", "actions", "guestbook"],
      ["projects"],
      ["projects", "view", "payments"],
      ["projects", "windows", "payments"],
      ["appsets"],
      ["appsets", "view", "team-apps"],
      ["repos"],
      ["clusters"],
    ];
    let callCount = 0;
    for (const args of commands) {
      const { stdout, calls } = await runCli(args, {
        home,
        env: { KUBECONFIG: kubeconfig },
      });
      const label = args.join(" ") || "home";
      expect(stdout, label).not.toContain(sentinel);
      expectSafeCalls(calls);
      for (const argv of calls) {
        expect(argv, label).not.toContain("--config");
        expect(argv.join(" "), label).not.toContain(sentinel);
        expect(argv.join(" "), label).not.toContain(kubeconfig);
      }
      callCount += calls.length;
    }
    expect(callCount).toBeGreaterThan(commands.length);
  }, 120_000);
});

describe("update built-in", () => {
  it("reaches the SDK's update --check offline instead of Unknown command", async () => {
    const { stdout, exitCode, calls } = await runCli(["update", "--check"], {
      env: {
        NODE_OPTIONS:
          "--import=data:text/javascript,globalThis.fetch=async()=>{throw{}}",
      },
    });
    expect(stdout).not.toContain("Unknown command");
    expect(stdout).toContain("code: UPDATE_ERROR");
    expect(stdout).toContain(
      "Could not reach the npm registry to check for updates to argocd-axi",
    );
    expect(exitCode).toBe(1);
    expect(calls).toEqual([]);
  });
});
