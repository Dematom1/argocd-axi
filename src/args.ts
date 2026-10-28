import { validationError } from "./errors.js";
import { renderBlocks, renderTextBlock } from "./toon.js";

export const BIN = "argocd-axi";

export interface FlagDef {
  name: string;
  short?: string;
  /** bool: presence flag; value: one value; multi: repeatable value. */
  kind: "bool" | "value" | "multi";
  valueName?: string;
  description: string;
}

export interface PositionalDef {
  name: string;
  required: boolean;
  description: string;
}

export interface CommandSpec {
  /** Command path after the binary, e.g. `apps view`. */
  path: string;
  summary: string;
  positionals: PositionalDef[];
  flags: FlagDef[];
  examples: string[];
  notes?: string[];
  /** Targeted hints for flags that do not exist here (AXI principle 6). */
  hints?: Record<string, string>;
}

export type FlagValue = string | boolean | string[];

export interface ParsedArgs {
  flags: Map<string, FlagValue>;
  positionals: string[];
}

/** `--context` selects the Argo CD context; it is accepted by every command. */
export const CONTEXT_FLAG: FlagDef = {
  name: "--context",
  kind: "value",
  valueName: "name",
  description:
    "Argo CD context to use (as listed by `argocd-axi ctx`); default: the current context",
};

/** Hints shared by every command for flags people reach for by habit. */
const COMMON_HINTS: Record<string, string> = {
  "--json":
    "output is always TOON; there is no --json (use the raw `argocd` CLI if you need JSON)",
  "--output":
    "output is always TOON; there is no --output (use the raw `argocd` CLI for other formats)",
  "-o": "output is always TOON; there is no -o (use the raw `argocd` CLI for other formats)",
  "--argocd-context": "use --context <name> to pick the Argo CD context",
  "--follow":
    "argocd-axi never streams; re-run the command for newer output (logs take --tail and --since)",
  "-f": "argocd-axi never streams; re-run the command for newer output (logs take --tail and --since)",
  "--watch":
    "argocd-axi never streams; use `apps wait <app>` for a bounded wait",
  "--refresh":
    "refreshing an app triggers a reconcile, which is a write; it is planned for the write tier (see ROADMAP.md)",
  "--hard-refresh":
    "refreshing an app triggers a reconcile, which is a write; it is planned for the write tier (see ROADMAP.md)",
  "--reveal": "redacted values are never shown; no flag reveals them",
  "--yes": "argocd-axi has no prompts to confirm and runs no writes in v1",
  "-y": "argocd-axi has no prompts to confirm and runs no writes in v1",
};

function flagLabel(flag: FlagDef): string {
  const names = flag.short ? `${flag.short}, ${flag.name}` : flag.name;
  return flag.kind === "bool"
    ? names
    : `${names} <${flag.valueName ?? "value"}>`;
}

export function usageLine(spec: CommandSpec): string {
  const args = spec.positionals
    .map((p) => (p.required ? `<${p.name}>` : `[${p.name}]`))
    .join(" ");
  const flags = spec.flags.length > 0 ? " [flags]" : "";
  return `${BIN} ${spec.path}${args ? ` ${args}` : ""}${flags}`;
}

export function validFlagsSummary(spec: CommandSpec): string {
  if (spec.flags.length === 0) return "none";
  return spec.flags.map(flagLabel).join(", ");
}

/** Concise per-command reference (AXI principle 10). */
export function renderCommandHelp(spec: CommandSpec): string {
  return renderBlocks([
    `usage: ${usageLine(spec)}`,
    `description: ${spec.summary}`,
    renderTextBlock(
      "args",
      spec.positionals.map((p) => `<${p.name}>: ${p.description}`),
    ),
    renderTextBlock(
      "flags",
      spec.flags.map((f) => `${flagLabel(f)}: ${f.description}`),
    ),
    renderTextBlock("examples", spec.examples),
    renderTextBlock("notes", spec.notes ?? []),
  ]);
}

function findFlag(spec: CommandSpec, token: string): FlagDef | undefined {
  return spec.flags.find((f) => f.name === token || f.short === token);
}

function unknownFlag(spec: CommandSpec, token: string): Error {
  const hint = spec.hints?.[token] ?? COMMON_HINTS[token];
  const help = [
    ...(hint ? [hint] : []),
    `valid flags for \`${spec.path}\`: ${validFlagsSummary(spec)} (--help always allowed)`,
    `usage: ${usageLine(spec)}`,
  ];
  return validationError(`unknown flag ${token} for \`${spec.path}\``, help);
}

/**
 * Parse argv for one command. Unknown flags and surplus arguments are
 * rejected before any argocd call (AXI principle 6), listing the valid
 * flags inline so the agent can self-correct in one turn.
 */
export function parseArgs(spec: CommandSpec, args: string[]): ParsedArgs {
  const flags = new Map<string, FlagValue>();
  const positionals: string[] = [];

  for (let i = 0; i < args.length; i++) {
    const token = args[i] as string;
    if (token === "--help") continue;
    if (token === "--") {
      throw validationError("`--` is not supported", [
        `usage: ${usageLine(spec)}`,
      ]);
    }
    if (!token.startsWith("-") || token === "-") {
      positionals.push(token);
      continue;
    }

    const eq = token.indexOf("=");
    const name = token.startsWith("--") && eq > 0 ? token.slice(0, eq) : token;
    const def = findFlag(spec, name);
    if (!def) throw unknownFlag(spec, name);

    if (def.kind === "bool") {
      if (name !== token) {
        throw validationError(`${def.name} takes no value`, [
          `usage: ${usageLine(spec)}`,
        ]);
      }
      flags.set(def.name, true);
      continue;
    }

    let value: string | undefined;
    if (name !== token) {
      value = token.slice(eq + 1);
    } else {
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        value = next;
        i++;
      }
    }
    if (value === undefined || value.length === 0) {
      throw validationError(`${def.name} needs a value`, [
        `usage: ${usageLine(spec)}`,
      ]);
    }

    if (def.kind === "multi") {
      const existing = flags.get(def.name);
      const list = Array.isArray(existing) ? existing : [];
      list.push(...value.split(",").filter((v) => v.length > 0));
      flags.set(def.name, list);
    } else {
      if (flags.has(def.name)) {
        throw validationError(`${def.name} was given more than once`, [
          `usage: ${usageLine(spec)}`,
        ]);
      }
      flags.set(def.name, value);
    }
  }

  const required = spec.positionals.filter((p) => p.required).length;
  if (positionals.length > spec.positionals.length) {
    const extra = positionals[spec.positionals.length] as string;
    throw validationError(`unexpected argument ${extra} for \`${spec.path}\``, [
      `usage: ${usageLine(spec)}`,
    ]);
  }
  if (positionals.length < required) {
    const missing = spec.positionals[positionals.length] as PositionalDef;
    throw validationError(`missing <${missing.name}> for \`${spec.path}\``, [
      `usage: ${usageLine(spec)}`,
      ...spec.examples.slice(0, 1).map((e) => `example: ${e}`),
    ]);
  }

  return { flags, positionals };
}

export function getString(
  parsed: ParsedArgs,
  name: string,
): string | undefined {
  const value = parsed.flags.get(name);
  return typeof value === "string" ? value : undefined;
}

export function getBool(parsed: ParsedArgs, name: string): boolean {
  return parsed.flags.get(name) === true;
}

export function getList(parsed: ParsedArgs, name: string): string[] {
  const value = parsed.flags.get(name);
  return Array.isArray(value) ? value : [];
}

export function getInt(
  parsed: ParsedArgs,
  name: string,
  options: { default: number; min: number; max: number },
): number {
  const raw = getString(parsed, name);
  if (raw === undefined) return options.default;
  if (!/^\d+$/.test(raw)) {
    throw validationError(`${name} must be a whole number, got ${raw}`);
  }
  const value = Number(raw);
  if (value < options.min || value > options.max) {
    throw validationError(
      `${name} must be between ${options.min} and ${options.max}, got ${value}`,
    );
  }
  return value;
}

/**
 * Parse a duration like `90s`, `15m`, `2h` or `1d` into seconds.
 */
export function parseDurationSeconds(flag: string, raw: string): number {
  const match = raw.match(/^(\d+)([smhd])$/);
  if (!match) {
    throw validationError(
      `${flag} must look like 30s, 15m, 2h or 1d, got ${raw}`,
    );
  }
  const unit = { s: 1, m: 60, h: 3600, d: 86400 }[
    match[2] as "s" | "m" | "h" | "d"
  ];
  const seconds = Number(match[1]) * unit;
  if (seconds <= 0) throw validationError(`${flag} must be positive`);
  return seconds;
}

const NAME_PATTERN =
  /^(?:[a-z0-9](?:[-a-z0-9]*[a-z0-9])?\/)?[a-z0-9](?:[-a-z0-9.]*[a-z0-9])?$/;

/**
 * Argo CD object names are DNS-style; apps may be `namespace/name` (apps in
 * any namespace, design decision A9). Validating here keeps arbitrary text
 * out of the argocd argv.
 */
export function validateName(kind: string, value: string): string {
  if (!NAME_PATTERN.test(value) || value.length > 253) {
    throw validationError(
      `invalid ${kind} name ${JSON.stringify(value)}: expected a lowercase DNS-style name${kind === "app" ? " or namespace/name" : ""}`,
    );
  }
  return value;
}
