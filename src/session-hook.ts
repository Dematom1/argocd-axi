import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const path = () =>
  join(
    process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude"),
    "settings.json",
  );
const command = "argocd-axi context end";

function settings(): Record<string, unknown> {
  const file = path();
  if (!existsSync(file)) return {};
  const value: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new Error(`${file} is not a JSON object`);
  return value as Record<string, unknown>;
}

export function installSessionEndHook(): void {
  const value = settings();
  const hooks = (value.hooks ??= {}) as Record<string, unknown>;
  const groups = Array.isArray(hooks.SessionEnd)
    ? (hooks.SessionEnd as Array<Record<string, unknown>>)
    : [];
  const next: Array<Record<string, unknown>> = [];
  let installed = false;
  for (const group of groups) {
    const entries = Array.isArray(group.hooks)
      ? (group.hooks as Array<Record<string, unknown>>)
      : [];
    const kept = entries.filter((entry) => {
      const ours =
        entry.command === command ||
        (typeof entry.command === "string" &&
          entry.command.endsWith("/argocd-axi context end"));
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
  mkdirSync(join(path(), ".."), { recursive: true });
  writeFileSync(path(), `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

export function sessionEndHookStatus(): boolean {
  try {
    const hooks = settings().hooks as Record<string, unknown> | undefined;
    const groups = hooks?.SessionEnd;
    return (
      Array.isArray(groups) &&
      groups.some((group) => {
        if (
          !group ||
          typeof group !== "object" ||
          !Array.isArray((group as Record<string, unknown>).hooks)
        )
          return false;
        return (group as { hooks: Array<Record<string, unknown>> }).hooks.some(
          (entry) =>
            entry.command === command ||
            (typeof entry.command === "string" &&
              entry.command.endsWith("/argocd-axi context end")),
        );
      })
    );
  } catch {
    return false;
  }
}

export function uninstallSessionEndHook(): boolean {
  const value = settings();
  const hooks = value.hooks as Record<string, unknown> | undefined;
  const groups = hooks?.SessionEnd;
  if (!Array.isArray(groups)) return false;
  let removed = false;
  const next = groups.flatMap((group) => {
    if (
      !group ||
      typeof group !== "object" ||
      !Array.isArray((group as Record<string, unknown>).hooks)
    )
      return [group];
    const entries = (
      group as { hooks: Array<Record<string, unknown>> }
    ).hooks.filter((entry) => {
      const ours =
        entry.command === command ||
        (typeof entry.command === "string" &&
          entry.command.endsWith("/argocd-axi context end"));
      removed ||= ours;
      return !ours;
    });
    return entries.length ? [{ ...group, hooks: entries }] : [];
  });
  if (!removed || !hooks) return false;
  if (next.length) hooks.SessionEnd = next;
  else delete hooks.SessionEnd;
  if (Object.keys(hooks).length === 0) delete value.hooks;
  writeFileSync(path(), `${JSON.stringify(value, null, 2)}\n`);
  return true;
}
