import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildArgv } from "../src/argocd.js";
import {
  FORBIDDEN_ARGS,
  OPERATIONS,
  PLANNED_WRITES,
  REFUSALS,
} from "../src/registry.js";
import { ROOT } from "./helpers.js";

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
  it("is exactly the reviewed set of operations", () => {
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

  it("never names a write verb", () => {
    for (const op of Object.values(OPERATIONS)) {
      for (const token of op.argv) expect(WRITE_VERBS).not.toContain(token);
    }
  });

  it("only local operations skip the network", () => {
    for (const op of Object.values(OPERATIONS)) {
      expect(op.network).toBe(op.tier === "read");
    }
  });

  it("refuses forbidden arguments at the seam", () => {
    for (const arg of FORBIDDEN_ARGS) {
      expect(() => buildArgv("app get", ["guestbook", arg])).toThrow(
        /never passed to argocd/,
      );
    }
    expect(() => buildArgv("app get", ["guestbook", "--refresh=true"])).toThrow(
      /never passed/,
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

  it("gives every refusal a reason and a route", () => {
    for (const refusal of [
      ...Object.values(REFUSALS),
      ...Object.values(PLANNED_WRITES),
    ]) {
      expect(refusal.reason.length).toBeGreaterThan(10);
      expect(refusal.help.length).toBeGreaterThan(0);
    }
    expect(Object.keys(PLANNED_WRITES).sort()).toEqual([
      "apps action",
      "apps refresh",
      "apps rollback",
      "apps sync",
      "apps terminate-op",
    ]);
  });
});

describe("one subprocess seam", () => {
  function sources(dir: string): string[] {
    return readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
      entry.isDirectory()
        ? sources(join(dir, entry.name))
        : entry.name.endsWith(".ts")
          ? [join(dir, entry.name)]
          : [],
    );
  }

  it("only src/argocd.ts can start a process", () => {
    const offenders = sources(join(ROOT, "src")).filter(
      (file) =>
        !file.endsWith(join("src", "argocd.ts")) &&
        /node:child_process|child_process/.test(readFileSync(file, "utf8")),
    );
    expect(offenders).toEqual([]);
  });

  it("runArgocd is only ever called with registered operation ids", () => {
    const pattern = /(?:runArgocd|argocdJson)(?:<[^>]*>)?\(\s*"([^"]+)"/g;
    const used = new Set<string>();
    for (const file of sources(join(ROOT, "src"))) {
      for (const match of readFileSync(file, "utf8").matchAll(pattern))
        used.add(match[1] as string);
    }
    expect([...used].filter((id) => !(id in OPERATIONS))).toEqual([]);
    expect(used.size).toBeGreaterThan(15);
  });

  it("never reads the argocd CLI config or a kubeconfig", () => {
    for (const file of sources(join(ROOT, "src"))) {
      const text = readFileSync(file, "utf8");
      expect(text).not.toMatch(/\.config\/argocd\/|\.kube\/config|KUBECONFIG/);
    }
  });
});
