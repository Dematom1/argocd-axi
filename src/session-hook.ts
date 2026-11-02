import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { CODES, axiError } from "./errors.js";

const path = () =>
  join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isManagedEntry(entry: unknown): boolean {
  if (!isRecord(entry) || typeof entry.command !== "string") return false;
  return (
    entry.command === "argocd-axi context end" ||
    entry.command.endsWith("/argocd-axi context end") ||
    /^node '(?:[^']|'\\'')*[\\/]argocd-axi\.js' context end$/.test(
      entry.command,
    )
  );
}

function settings(): Record<string, unknown> {
  const file = path();
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    if (error instanceof Error && "code" in error && error.code === "ENOENT")
      return {};
    throw axiError(
      `Cannot read Claude settings ${file}: ${String(error)}`,
      CODES.CONFIG_INVALID,
      [`Check read permissions and JSON syntax for ${file}`],
    );
  }
  if (!isRecord(value))
    throw axiError(`${file} is not a JSON object`, CODES.CONFIG_INVALID, [
      `Fix the JSON object in ${file}`,
    ]);
  return value;
}

function writeSettings(value: Record<string, unknown>): void {
  const file = path();
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    mkdirSync(join(file, ".."), { recursive: true });
    const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file to remove. */
    }
    throw axiError(
      `Cannot update Claude settings ${file}: ${String(error)}`,
      CODES.UPSTREAM_ERROR,
      [`Check write permissions for ${file} and its parent directory`],
    );
  }
}

export function installSessionEndHook(entrypoint: string): void {
  const value = settings();
  const hooks = isRecord(value.hooks) ? value.hooks : {};
  value.hooks = hooks;
  const groups = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  const next: unknown[] = [];
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const kept = group.hooks.filter((entry) => !isManagedEntry(entry));
    if (kept.length) next.push({ ...group, hooks: kept });
  }
  next.push({
    matcher: "",
    hooks: [
      {
        type: "command",
        command: `node '${entrypoint.replaceAll("'", "'\\''")}' context end`,
        timeout: 30,
      },
    ],
  });
  hooks.SessionEnd = next;
  writeSettings(value);
}

export function sessionEndHookStatus(): boolean {
  const hooks = settings().hooks;
  const groups = isRecord(hooks) ? hooks.SessionEnd : undefined;
  return (
    Array.isArray(groups) &&
    groups.some(
      (group) =>
        isRecord(group) &&
        Array.isArray(group.hooks) &&
        group.hooks.some(isManagedEntry),
    )
  );
}

export function uninstallSessionEndHook(): boolean {
  const value = settings();
  const hooks = value.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks.SessionEnd)) return false;
  let removed = false;
  const next = hooks.SessionEnd.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const entries = group.hooks.filter((entry) => {
      const ours = isManagedEntry(entry);
      removed ||= ours;
      return !ours;
    });
    return entries.length ? [{ ...group, hooks: entries }] : [];
  });
  if (!removed) return false;
  if (next.length) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  if (Object.keys(hooks).length === 0) delete value.hooks;
  writeSettings(value);
  if (sessionEndHookStatus())
    throw axiError(
      `SessionEnd hook remains in ${path()}`,
      CODES.UPSTREAM_ERROR,
      ["Re-run `argocd-axi setup uninstall` after checking the settings file"],
    );
  return true;
}
