import {
  readFileSync,
  writeFileSync,
  renameSync,
  chmodSync,
  statSync,
  mkdirSync,
  unlinkSync,
  rmSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { homedir } from "node:os";
import { join } from "node:path";
import { parse, parseDocument } from "yaml";
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

function updateWritableContext(name: string, add: boolean): void {
  const path = configPath();
  mkdirSync(join(path, ".."), { recursive: true });
  const lockPath = `${path}.lock`;
  const waitCell = new Int32Array(new SharedArrayBuffer(4));
  const deadline = Date.now() + 5000;
  while (true) {
    try {
      mkdirSync(lockPath);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      if (Date.now() >= deadline)
        throw axiError(
          `timed out waiting for writable-context config lock ${lockPath}`,
          CODES.CONFIG_INVALID,
        );
      Atomics.wait(waitCell, 0, 0, 10);
    }
  }
  try {
    updateWritableContextLocked(path, name, add);
  } finally {
    rmSync(lockPath, { recursive: true, force: true });
  }
}

function updateWritableContextLocked(
  path: string,
  name: string,
  add: boolean,
): void {
  const loaded = loadConfig();
  const contexts = loaded.config.writableContexts;
  const updated = add
    ? [...new Set([...contexts, name])]
    : contexts.filter((item) => item !== name);
  if (
    updated.length === contexts.length &&
    updated.every((item, index) => item === contexts[index])
  )
    return;
  mkdirSync(join(loaded.path, ".."), { recursive: true });
  const source = loaded.exists ? readFileSync(loaded.path, "utf8") : "";
  const doc = parseDocument(source || "{}");
  const root = doc.contents;
  if (root === null || root === undefined || !("set" in root))
    throw invalid(loaded.path, "the top level must be a mapping");
  doc.set("writable-contexts", updated);
  const temp = `${loaded.path}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temp, doc.toString(), {
      mode: loaded.exists ? statSync(loaded.path).mode & 0o777 : 0o600,
    });
    if (loaded.exists) chmodSync(temp, statSync(loaded.path).mode & 0o777);
    renameSync(temp, loaded.path);
  } catch (error) {
    try {
      unlinkSync(temp);
    } catch {
      /* no temporary file */
    }
    throw error;
  }
}

export function addWritableContext(name: string): void {
  updateWritableContext(name, true);
}
export function removeWritableContext(name: string): void {
  updateWritableContext(name, false);
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
