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

const path = () =>
  join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
const command = "argocd-axi context end";

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function settings(): Record<string, unknown> {
  const file = path();
  if (!existsSync(file)) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!isRecord(value)) throw new Error(`${file} is not a JSON object`);
  return value;
}

function writeSettings(value: Record<string, unknown>): void {
  const file = path();
  mkdirSync(join(file, ".."), { recursive: true });
  const mode = existsSync(file) ? statSync(file).mode & 0o777 : 0o600;
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { mode });
    chmodSync(temporary, mode);
    renameSync(temporary, file);
  } catch (error) {
    try {
      unlinkSync(temporary);
    } catch {
      /* No temporary file to remove. */
    }
    throw error;
  }
}

export function installSessionEndHook(): void {
  const value = settings();
  const hooks = isRecord(value.hooks) ? value.hooks : {};
  value.hooks = hooks;
  const groups = Array.isArray(hooks.SessionEnd) ? hooks.SessionEnd : [];
  const next: unknown[] = [];
  let installed = false;
  for (const group of groups) {
    if (!isRecord(group) || !Array.isArray(group.hooks)) {
      next.push(group);
      continue;
    }
    const kept = group.hooks.filter((entry) => {
      const ours =
        isRecord(entry) &&
        (entry.command === command ||
          (typeof entry.command === "string" &&
            entry.command.endsWith("/argocd-axi context end")));
      if (ours && !installed) {
        installed = true;
        return false;
      }
      return !ours;
    });
    if (kept.length) next.push({ ...group, hooks: kept });
  }
  next.push({
    matcher: "",
    hooks: [{ type: "command", command, timeout: 30 }],
  });
  hooks.SessionEnd = next;
  writeSettings(value);
}

export function sessionEndHookStatus(): boolean {
  try {
    const hooks = settings().hooks;
    const groups = isRecord(hooks) ? hooks.SessionEnd : undefined;
    return (
      Array.isArray(groups) &&
      groups.some(
        (group) =>
          isRecord(group) &&
          Array.isArray(group.hooks) &&
          group.hooks.some(
            (entry) =>
              isRecord(entry) &&
              (entry.command === command ||
                (typeof entry.command === "string" &&
                  entry.command.endsWith("/argocd-axi context end"))),
          ),
      )
    );
  } catch {
    return false;
  }
}

export function uninstallSessionEndHook(): boolean {
  const value = settings();
  const hooks = value.hooks;
  if (!isRecord(hooks) || !Array.isArray(hooks.SessionEnd)) return false;
  let removed = false;
  const next = hooks.SessionEnd.flatMap((group) => {
    if (!isRecord(group) || !Array.isArray(group.hooks)) return [group];
    const entries = group.hooks.filter((entry) => {
      const ours =
        isRecord(entry) &&
        (entry.command === command ||
          (typeof entry.command === "string" &&
            entry.command.endsWith("/argocd-axi context end")));
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
  return true;
}
