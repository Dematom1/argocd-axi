import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  detectInstallMethod,
  installSessionStartHooks,
  sessionStartHookStatus,
  uninstallSessionStartHooks,
} from "axi-sdk-js";
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
    "SessionEnd records command names, counts and the most-used --context value only; setup status and setup uninstall inspect or remove all managed integrations",
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

function hookStatus() {
  const observed = sessionStartHookStatus({ marker: "argocd-axi" });
  // The SDK treats read errors as absence. Check its destinations before reporting.
  for (const [file, json] of [
    [observed.claude.path, true],
    [observed.codex.path, true],
    [observed.codex.userFeaturePath, false],
    [observed.opencode.path, false],
  ] as const) {
    try {
      const text = readFileSync(file, "utf8");
      if (json) JSON.parse(text);
    } catch (error) {
      if (error instanceof Error && "code" in error && error.code === "ENOENT")
        continue;
      throw axiError(
        `Cannot read hook destination ${file}: ${String(error)}`,
        CODES.CONFIG_INVALID,
        [`Check read permissions and file syntax for ${file}`],
      );
    }
  }
  return {
    claude: observed.claude.installed,
    codex: observed.codex.installed,
    codexFeature: observed.codex.userFeatureEnabled,
    opencode: observed.opencode.installed,
    sessionEnd: sessionEndHookStatus() ? "installed" : "not installed",
  };
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
    return finish([encodeObject(hookStatus())], undefined);
  if (action === "uninstall") {
    const errors: string[] = [];
    uninstallSessionStartHooks({
      marker: "argocd-axi",
      onError: (message) => errors.push(message),
    });
    if (errors.length)
      throw axiError(
        `Hook removal reported problems: ${errors.join("; ")}`,
        CODES.UPSTREAM_ERROR,
        [
          "Check write permissions for the paths above, then re-run `argocd-axi setup uninstall`",
        ],
      );
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
  }

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
    installSessionEndHook(
      realpathSync(join(dirname(entrypoint), "argocd-axi.js")),
    );
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
  const observed = hookStatus();
  if (
    !observed.claude ||
    !observed.codex ||
    !observed.codexFeature ||
    !observed.opencode ||
    observed.sessionEnd !== "installed"
  ) {
    throw axiError(
      `Hook installation is incomplete: ${encodeObject(observed)}`,
      CODES.UPSTREAM_ERROR,
      [
        "Check hook destinations with `argocd-axi setup status` and re-run setup hooks",
      ],
    );
  }
  return finish([encodeObject(observed)], undefined, [
    "Restart the agent session to receive argocd-axi ambient context",
  ]);
}
