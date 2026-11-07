import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { dirname, isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  computeSessionStartHookRemoval,
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

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManagedSessionStartCommand(command: string): boolean {
  return command.includes("argocd-axi");
}

function hasCanonicalSessionStartHook(file: string, command: string): boolean {
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return false;
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^E[A-Z0-9]+$/.test(error.code)
    ) {
      if (!("path" in error) || typeof error.path !== "string")
        Object.assign(error, { path: file });
      throw error;
    }
    throw axiError(
      `Cannot read hook destination ${file}: ${String(error)}`,
      CODES.CONFIG_INVALID,
      [`Check read permissions and file syntax for ${file}`],
    );
  }
  if (!isRecord(value) || !isRecord(value.hooks)) return false;
  const groups = value.hooks.SessionStart;
  if (!Array.isArray(groups)) return false;
  const commands = groups.flatMap((group: unknown) =>
    isRecord(group) && Array.isArray(group.hooks)
      ? group.hooks.flatMap((hook: unknown) =>
          isRecord(hook) &&
          typeof hook.command === "string" &&
          isManagedSessionStartCommand(hook.command)
            ? [hook.command]
            : [],
        )
      : [],
  );
  return commands.length === 1 && commands[0] === command;
}

function repairSessionStartHooks(): void {
  const targets = sessionStartHookStatus({ marker: "argocd-axi" });
  for (const file of [targets.claude.path, targets.codex.path]) {
    const value: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (
      !isRecord(value) ||
      !isRecord(value.hooks) ||
      !Array.isArray(value.hooks.SessionStart)
    )
      continue;
    let seen = false;
    let changed = false;
    // axi-sdk-js 0.1.13 repairs only the first matching entry. Keep that repaired
    // entry and remove later duplicates until the SDK deduplicates updates.
    const groups = value.hooks.SessionStart.flatMap((group: unknown) => {
      if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
      const hooks = group.hooks.filter((hook: unknown) => {
        if (
          !isRecord(hook) ||
          typeof hook.command !== "string" ||
          !isManagedSessionStartCommand(hook.command)
        )
          return true;
        if (!seen) {
          seen = true;
          // The SDK also stores raw paths in shell hooks; quote absolute paths
          // here without changing the OpenCode plugin's shell-free executable.
          if (isAbsolute(hook.command)) {
            hook.command = `'${hook.command.replaceAll("'", "'\\''")}'`;
            changed = true;
          }
          return true;
        }
        changed = true;
        return false;
      });
      if (hooks.length === group.hooks.length) return [group];
      return hooks.length ? [{ ...group, hooks }] : [];
    });
    if (changed) {
      value.hooks.SessionStart = groups;
      writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`);
    }
  }
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
    const before = sessionStartHookStatus({ marker: "argocd-axi" });
    const claudeConfigDir =
      process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
    const claudeSettingsPath = join(claudeConfigDir, "settings.json");
    let customClaudeInstalled = false;
    const errors: string[] = [];
    uninstallSessionStartHooks({
      marker: "argocd-axi",
      onError: (message) => errors.push(message),
    });
    if (process.env.CLAUDE_CONFIG_DIR) {
      try {
        const settings: unknown = JSON.parse(
          readFileSync(claudeSettingsPath, "utf8"),
        );
        if (!isRecord(settings))
          throw new Error("settings must be a JSON object");
        const [updated, changed] = computeSessionStartHookRemoval(
          settings,
          "argocd-axi",
        );
        customClaudeInstalled = changed;
        if (changed) {
          mkdirSync(dirname(claudeSettingsPath), {
            recursive: true,
            mode: 0o700,
          });
          const mode = existsSync(claudeSettingsPath)
            ? statSync(claudeSettingsPath).mode & 0o777
            : 0o600;
          const temporary = `${claudeSettingsPath}.${randomUUID()}.tmp`;
          try {
            writeFileSync(temporary, `${JSON.stringify(updated, null, 2)}\n`, {
              mode,
            });
            chmodSync(temporary, mode);
            renameSync(temporary, claudeSettingsPath);
          } catch (error) {
            try {
              unlinkSync(temporary);
            } catch {
              // No temporary file to remove.
            }
            throw error;
          }
        }
      } catch (error) {
        if (!(
          error instanceof Error &&
          "code" in error &&
          error.code === "ENOENT"
        ))
          errors.push(
            `Cannot remove SessionStart hook from ${claudeSettingsPath}: ${String(error)}`,
          );
      }
    }
    let sessionEndRemoved = false;
    try {
      sessionEndRemoved = uninstallSessionEndHook();
    } catch (error) {
      errors.push(error instanceof Error ? error.message : String(error));
    }
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
          claude:
            before.claude.installed || customClaudeInstalled
              ? "removed"
              : "not installed (no-op)",
          codex: before.codex.installed ? "removed" : "not installed (no-op)",
          opencode: before.opencode.installed
            ? "removed"
            : "not installed (no-op)",
          sessionEnd: sessionEndRemoved ? "removed" : "not installed (no-op)",
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
  const canonicalCommand = `'${realpathSync(entrypoint).replaceAll("'", "'\\''")}'`;
  const currentHooks = sessionStartHookStatus({ marker: "argocd-axi" });
  const claudeCanonical = hasCanonicalSessionStartHook(
    currentHooks.claude.path,
    canonicalCommand,
  );
  const codexCanonical = hasCanonicalSessionStartHook(
    currentHooks.codex.path,
    canonicalCommand,
  );
  const canonicalHooksInstalled =
    currentHooks.claude.installed &&
    currentHooks.codex.installed &&
    currentHooks.opencode.installed &&
    claudeCanonical &&
    codexCanonical;
  if (!canonicalHooksInstalled)
    installSessionStartHooks({
      marker: "argocd-axi",
      execPath: entrypoint,
      binaryNames: ["argocd-axi-ctx"],
      distEntrypoints: ["dist/bin/argocd-axi-ctx.js"],
      onError: (message) => errors.push(message),
    });
  try {
    // Run only after successful SDK installation, so the retained entry is current.
    if (errors.length === 0) repairSessionStartHooks();
    installSessionEndHook(
      realpathSync(join(dirname(entrypoint), "argocd-axi.js")),
    );
  } catch (error) {
    if (
      error !== null &&
      typeof error === "object" &&
      "code" in error &&
      typeof error.code === "string" &&
      /^E[A-Z0-9]+$/.test(error.code) &&
      "path" in error &&
      typeof error.path === "string"
    )
      throw error;
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
