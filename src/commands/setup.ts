import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstallMethod, installSessionStartHooks } from "axi-sdk-js";
import { parseArgs, renderCommandHelp, type CommandSpec } from "../args.js";
import { CODES, axiError, validationError } from "../errors.js";
import { encodeObject } from "../toon.js";
import { finish } from "./common.js";
import {
  installSessionEndHook,
  sessionEndHookStatus,
  uninstallSessionEndHook,
} from "../session-hook.js";

export const SETUP_HOOKS_SPEC: CommandSpec = {
  path: "setup hooks",
  summary: "Install, inspect or remove agent session hooks",
  positionals: [],
  flags: [],
  examples: ["argocd-axi setup hooks"],
  notes: [
    "The hook runs `argocd-axi-ctx`, which is local only: current context, server and CLI version, with no network call, no SSO refresh and no credential read",
    "SessionEnd records command names, counts and the most-used --context value only; setup status and setup uninstall inspect or remove that Claude Code hook",
    "Intended for global installs; repeated runs are no-ops",
  ],
};

/**
 * The hook points at the dedicated ctx entrypoint, not the main bin, so
 * ambient context never runs the networked home view (decision S17).
 */
function ctxEntrypoint(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  const compiled = join(here, "..", "..", "bin", "argocd-axi-ctx.js");
  return existsSync(compiled)
    ? compiled
    : join(here, "..", "..", "bin", "argocd-axi-ctx.ts");
}

export async function setupCommand(args: string[]): Promise<string> {
  const action = args[0];
  if (action !== "hooks" && action !== "status" && action !== "uninstall") {
    if (args.includes("--help")) return renderCommandHelp(SETUP_HOOKS_SPEC);
    throw validationError("unknown setup action", [
      "Run `argocd-axi setup hooks`, `argocd-axi setup status` or `argocd-axi setup uninstall`",
    ]);
  }
  if (args.includes("--help")) return renderCommandHelp(SETUP_HOOKS_SPEC);
  parseArgs(SETUP_HOOKS_SPEC, args.slice(1));
  if (action === "status")
    return finish(
      [
        encodeObject({
          sessionEnd: sessionEndHookStatus() ? "installed" : "not installed",
        }),
      ],
      undefined,
    );
  if (action === "uninstall")
    return finish(
      [
        encodeObject({
          sessionEnd: uninstallSessionEndHook()
            ? "removed"
            : "not installed (no-op)",
        }),
      ],
      undefined,
    );

  // An npx (or pnpm dlx, bunx) run lives in a cache that later sessions may
  // not have on PATH or may have evicted, so a hook pointing at it would
  // silently stop working. Require a persistent install instead.
  const entrypoint = ctxEntrypoint();
  if (detectInstallMethod({ entry: realpathSync(entrypoint) }).kind === "npx") {
    throw axiError(
      "setup hooks needs a persistent install; this argocd-axi runs from a temporary npx cache",
      CODES.REFUSED,
      [
        "Install it first: `npm install -g argocd-axi`, then run `argocd-axi setup hooks`",
      ],
    );
  }

  const errors: string[] = [];
  installSessionStartHooks({
    marker: "argocd-axi",
    execPath: entrypoint,
    binaryNames: ["argocd-axi-ctx"],
    distEntrypoints: ["dist/bin/argocd-axi-ctx.js"],
    onError: (message) => errors.push(message),
  });
  try {
    installSessionEndHook();
  } catch (error) {
    errors.push(error instanceof Error ? error.message : String(error));
  }
  if (errors.length > 0) {
    throw axiError(
      `hook installation reported problems: ${errors.join("; ")}`,
      CODES.UPSTREAM_ERROR,
      ["Re-run `argocd-axi setup hooks` after fixing the paths above"],
    );
  }
  return finish(
    [
      encodeObject({
        hooks: "installed or already up to date",
        integrations: "Claude Code, Codex, OpenCode",
        command:
          "argocd-axi-ctx (local only: no network, no SSO refresh, no credential read)",
      }),
    ],
    undefined,
    ["Restart the agent session to receive argocd-axi ambient context"],
  );
}
