import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse } from "yaml";
import { CODES, axiError } from "./errors.js";

/**
 * argocd-axi's own config file (design decision A4), by default
 * `~/.config/argocd-axi/config` (or `$XDG_CONFIG_HOME/argocd-axi/config`).
 * It is YAML and currently holds one setting, the writable-contexts
 * allowlist for the write tier, which defaults to none (decision S3):
 *
 *   writable-contexts:
 *     - staging
 *
 * This is the only file argocd-axi reads. It never reads the argocd CLI's
 * config, which holds clear-text tokens (decision S7).
 */

export interface ToolConfig {
  writableContexts: string[];
}

export interface LoadedConfig {
  path: string;
  exists: boolean;
  config: ToolConfig;
}

const KNOWN_KEYS = ["writable-contexts"];

export function configPath(): string {
  const base =
    process.env.XDG_CONFIG_HOME?.trim() || join(homedir(), ".config");
  return join(base, "argocd-axi", "config");
}

function invalid(path: string, problem: string) {
  return axiError(
    `argocd-axi config ${path} is invalid: ${problem}`,
    CODES.CONFIG_INVALID,
    [
      "Fix the file by hand; the expected shape is `writable-contexts: [<context>, ...]`",
    ],
  );
}

export function parseConfig(path: string, text: string): ToolConfig {
  let data: unknown;
  try {
    data = parse(text);
  } catch (error) {
    throw invalid(
      path,
      `not valid YAML (${(error as Error).message.split("\n")[0]})`,
    );
  }
  if (data === null || data === undefined) return { writableContexts: [] };
  if (typeof data !== "object" || Array.isArray(data)) {
    throw invalid(path, "the top level must be a mapping");
  }
  const record = data as Record<string, unknown>;
  const unknown = Object.keys(record).filter(
    (key) => !KNOWN_KEYS.includes(key),
  );
  if (unknown.length > 0) {
    throw invalid(
      path,
      `unknown setting ${unknown.join(", ")} (known: ${KNOWN_KEYS.join(", ")})`,
    );
  }
  const raw = record["writable-contexts"];
  if (raw === undefined || raw === null) return { writableContexts: [] };
  if (!Array.isArray(raw)) {
    throw invalid(path, "writable-contexts must be a list of context names");
  }
  const writableContexts: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string" || entry.trim().length === 0) {
      throw invalid(
        path,
        "every writable-contexts entry must be a non-empty context name",
      );
    }
    if (/[*?]/.test(entry)) {
      throw invalid(
        path,
        `writable-contexts takes exact context names, not patterns (${entry})`,
      );
    }
    writableContexts.push(entry.trim());
  }
  return { writableContexts: [...new Set(writableContexts)] };
}

export function loadConfig(): LoadedConfig {
  const path = configPath();
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { path, exists: false, config: { writableContexts: [] } };
    }
    throw invalid(path, (error as Error).message);
  }
  return { path, exists: true, config: parseConfig(path, text) };
}
