import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { makeHome, runCli, scenario } from "./helpers.js";

describe("resource action RBAC", () => {
  it.each([
    { group: "argoproj.io", kind: "Rollout", action: "retry" },
    { group: "argoproj.io", kind: "Rollout", action: "promote-full" },
    { group: "argoproj.io", kind: "Rollout", action: "resume" },
    { group: "argoproj.io", kind: "Rollout", action: "abort" },
    { group: "", kind: "Pod", action: "delete" },
  ])(
    "submits $kind/$action without unsupported can-i",
    async ({ group, kind, action }) => {
      const home = makeHome();
      mkdirSync(join(home, ".config", "argocd-axi"), { recursive: true });
      writeFileSync(
        join(home, ".config", "argocd-axi", "config"),
        "writable-contexts: [staging]\n",
      );
      const args = [
        "apps",
        "actions",
        "run",
        "demo",
        action,
        "--kind",
        kind,
        "--name",
        "demo",
        "--context",
        "staging",
        "--confirm",
      ];
      const responses = [
        { argv: ["context"], exact: true, stdoutFile: "context.txt" },
        {
          argv: ["app", "get", "demo"],
          stdout: JSON.stringify({
            spec: { project: "default" },
            status: {
              resources: [
                {
                  ...(group ? { group } : {}),
                  kind,
                  name: "demo",
                  namespace: "default",
                  health: { status: "Suspended" },
                },
              ],
            },
          }),
        },
        {
          argv: ["app", "actions", "list"],
          stdout: JSON.stringify([
            {
              Group: group,
              Kind: kind,
              Name: "demo",
              Namespace: "default",
              Action: action,
            },
          ]),
        },
        // Record the upstream CanI validation, rather than an impossible "yes".
        {
          argv: ["account", "can-i"],
          stderr: `rpc error: code = InvalidArgument desc = [get create update delete sync override action invoke] does not contain action/${group}/${kind}/${action}`,
          exit: 20,
        },
      ];
      const native = [
        "app",
        "actions",
        "run",
        "demo",
        action,
        "--kind",
        kind,
        "--resource-name",
        "demo",
        ...(group ? ["--group", group] : []),
        "--namespace",
        "default",
      ];
      const result = await runCli(args, {
        home,
        scenario: scenario([...responses, { argv: native, stdout: "" }]),
      });
      expect(result.exitCode, result.stdout).toBe(0);
      expect(result.stdout).toContain("result: submitted");
      expect(result.calls.some((call) => call[0] === "account")).toBe(false);
      const submitted = result.calls.filter(
        (call) => call[1] === "actions" && call[2] === "run",
      );
      expect(submitted).toHaveLength(1);
      expect(submitted[0]?.slice(0, native.length)).toEqual(native);
      if (!group) expect(submitted[0]).not.toContain("--group");

      const denied = await runCli(args, {
        home,
        scenario: scenario([
          ...responses,
          {
            argv: native,
            stderr:
              "rpc error: code = PermissionDenied desc = permission denied",
            exit: 20,
          },
        ]),
      });
      expect(denied.exitCode).toBe(1);
      expect(denied.stdout).toContain("code: REFUSED");
      expect(denied.stdout).toContain(
        "Argo CD RBAC denied actions run for demo",
      );
      expect(denied.stdout).not.toContain("result: submitted");
      expect(denied.calls.some((call) => call[0] === "account")).toBe(false);
    },
  );
});
