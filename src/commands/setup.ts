import { existsSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { detectInstallMethod, installSessionStartHooks } from "axi-sdk-js";
import { parseArgs, renderCommandHelp, type CommandSpec } from "../args.js";
import { CODES, axiError, validationError } from "../errors.js";
import { encodeObject } from "../toon.js";
import { finish } from "./common.js";

export const SETUP_HOOKS_SPEC: CommandSpec = {
  path: "setup hooks",
  summary:
    "Install or repair SessionStart hooks for Claude Code, Codex and OpenCode",
  positionals: [],
  flags: [],
  examples: ["argocd-axi setup hooks"],
  notes: [
    "The hook runs `argocd-axi-ctx`, which is local only: current context, server and CLI version, with no network call, no SSO refresh and no credential read",
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
  if (args[0] !== "hooks") {
    if (args.includes("--help")) return renderCommandHelp(SETUP_HOOKS_SPEC);
    throw validationError("unknown setup action", [
      "Run `argocd-axi setup hooks`",
    ]);
  }
  if (args.includes("--help")) return renderCommandHelp(SETUP_HOOKS_SPEC);
  parseArgs(SETUP_HOOKS_SPEC, args.slice(1));

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
