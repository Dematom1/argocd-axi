import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { isNetworkCall, makeHome, runCli, scenario } from "./helpers.js";

function jwt(claims: unknown): string {
  return `eyJhbGciOiJIUzI1NiJ9.${Buffer.from(JSON.stringify(claims)).toString("base64url")}.synthetic-signature`;
}
const base = [
  { argv: ["context"], exact: true, stdoutFile: "context.txt" },
  { argv: ["account", "get-user-info"], stdoutFile: "user.json" },
];
const env = { ARGOCD_SERVER: "argocd.example.com" };

describe("dedicated non-interactive credential", () => {
  it.each([
    [jwt({ exp: 4102444800 }), "expires 2100-01-01"],
    [jwt({ exp: 1 }), "expired 1970-01-01"],
    [jwt({}), "non-expiring"],
    [jwt({ exp: "tomorrow" }), "unknown (invalid exp)"],
    ["synthetic-invalid-token", "unknown (invalid JWT)"],
    ["", "not configured"],
  ])("reports value-free expiry for whoami and auth", async (token, status) => {
    for (const args of [["whoami"], ["auth", "guide"]]) {
      const result = await runCli(args, {
        scenario: scenario(base),
        env: { ...env, ARGOCD_AUTH_TOKEN: token },
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("tokenExpiry:");
      expect(result.stdout).toContain(status);
      if (token) {
        expect(result.stdout).not.toContain(token);
        expect(result.stdout).not.toContain("--sso");
      }
    }
  });

  it.each([
    ["whoami"],
    ["apps"],
    ["can-i", "get", "applications", "default/app"],
    ["auth", "guide"],
  ])(
    "rejects a mismatched server before any network call: %s",
    async (...args) => {
      const result = await runCli(args, {
        scenario: scenario(base),
        env: { ARGOCD_AUTH_TOKEN: jwt({}), ARGOCD_SERVER: "wrong.example.com" },
      });
      expect(result.exitCode).not.toBe(0);
      expect(result.stdout).toContain("ARGOCD_SERVER does not match");
      expect(result.calls.filter(isNetworkCall)).toEqual([]);
    },
  );

  it.each(["token has expired", "no session information"])(
    "never suggests SSO or retries with CLI credentials: %s",
    async (reason) => {
      const token = jwt({ exp: 1 });
      const result = await runCli(["whoami"], {
        env: { ...env, ARGOCD_AUTH_TOKEN: token },
        scenario: scenario([
          base[0],
          {
            argv: ["account", "get-user-info"],
            exit: 1,
            stderr: `rpc error: code = Unauthenticated desc = ${reason} ${token}`,
          },
        ]),
      });
      expect(result.exitCode).toBe(1);
      expect(result.stdout).toContain("replace the token");
      expect(result.stdout).not.toContain(token);
      expect(result.stdout).not.toContain("--sso");
      expect(result.calls.filter(isNetworkCall)).toHaveLength(1);
    },
  );

  // Published server checks: Argo CD v3.4.12 server/application/application.go
  // Get (including refresh): lines 792-825; TerminateOperation: lines 2451-2457.
  // https://github.com/argoproj/argo-cd/blob/v3.4.12/server/application/application.go
  it.each([
    ["refresh", false, "get", true],
    ["refresh", true, "get", true],
    ["terminate-op", false, "sync", true],
    ["terminate-op", false, "sync", false],
  ])(
    "uses server RBAC for %s hard=%s allowed=%s",
    async (command, hard, permission, allowed) => {
      const home = makeHome();
      mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
      writeFileSync(
        join(home, ".config", "argocd-axi", "config"),
        'writable-contexts: ["prod"]',
      );
      const app = {
        metadata: { name: "proof" },
        spec: { project: "default" },
        operation: {},
        status: { operationState: { phase: "Running" } },
      };
      const result = await runCli(
        [
          "apps",
          command,
          "proof",
          "--context",
          "prod",
          "--confirm",
          ...(command === "terminate-op" ? ["--timeout", "1"] : []),
          ...(hard ? ["--hard"] : []),
        ],
        {
          home,
          env: { ...env, ARGOCD_AUTH_TOKEN: jwt({}) },
          scenario: scenario([
            base[0],
            { argv: ["app", "get", "proof"], stdout: JSON.stringify(app) },
            {
              argv: [
                "account",
                "can-i",
                "get",
                "applications",
                "default/proof",
              ],
              stdout: "yes",
            },
            {
              argv: [
                "account",
                "can-i",
                "sync",
                "applications",
                "default/proof",
              ],
              stdout: allowed ? "yes" : "no",
            },
            { argv: ["account", "can-i", "update"], stdout: "no" },
            {
              argv: ["app", "get", "proof"],
              contains: [hard ? "--hard-refresh" : "--refresh"],
              stdout: JSON.stringify(app),
            },
            { argv: ["app", "terminate-op", "proof"], stdout: "" },
            { argv: ["app", "wait", "proof"], stdout: "" },
          ]),
        },
      );
      expect(result.calls).toContainEqual([
        "account",
        "can-i",
        permission,
        "applications",
        "default/proof",
        "--argocd-context",
        "prod",
      ]);
      expect(result.calls.some((call) => call.includes("update"))).toBe(false);
      const writes = result.calls.filter(
        (call) =>
          call.includes("--refresh") ||
          call.includes("--hard-refresh") ||
          call[1] === "terminate-op",
      );
      expect(writes).toHaveLength(allowed ? 1 : 0);
      expect(result.exitCode, result.stdout).toBe(allowed ? 0 : 1);
    },
  );
});
