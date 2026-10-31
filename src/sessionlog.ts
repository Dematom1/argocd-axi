import {
  chmodSync,
  closeSync,
  createReadStream,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmdirSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { configPath } from "./config.js";

const MAX_DIRECTORIES = 100;
const LOCK_WAIT_MS = 2_000;
const STALE_LOCK_MS = 30_000;
const MAX_TRANSCRIPT_BYTES = 256 * 1024 * 1024;
const TOOL = "argocd-axi";
const COMMANDS = new Set([
  "apps",
  "projects",
  "appsets",
  "repos",
  "clusters",
  "ctx",
  "auth",
  "whoami",
  "can-i",
  "setup",
  "context",
]);
const CONTEXTS = new Set([
  "apps",
  "projects",
  "appsets",
  "repos",
  "clusters",
  "ctx",
  "auth",
  "whoami",
  "can-i",
]);

export interface SessionSummary {
  commands: Record<string, number>;
  context?: string;
}

/** Split shell words without retaining anything in the persisted result. */
function words(command: string): string[] {
  const result: string[] = [];
  let token = "";
  let quote = "";
  let started = false;
  const end = () => {
    if (started) result.push(token);
    token = "";
    started = false;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i]!;
    if (quote) {
      if (c === quote) quote = "";
      else if (c === "\\" && quote === '"' && i + 1 < command.length)
        token += command[++i];
      else token += c;
    } else if (c === "'" || c === '"') {
      quote = c;
      started = true;
    } else if (c === "\\" && i + 1 < command.length) {
      token += command[++i];
      started = true;
    } else if (/\s|[;|&()`]/.test(c)) end();
    else {
      token += c;
      started = true;
    }
  }
  end();
  return result;
}

function commandParts(line: string): string[] {
  const parts: string[] = [];
  let quote = "";
  let start = 0;
  for (let i = 0; i < line.length; i++) {
    const c = line[i]!;
    if (quote) {
      if (c === "\\" && quote === '"') i++;
      else if (c === quote) quote = "";
    } else if (c === "\\") i++;
    else if (c === "'" || c === '"') quote = c;
    else if (/[;|&\n]/.test(c)) {
      parts.push(line.slice(start, i));
      start = i + 1;
    }
  }
  parts.push(line.slice(start));
  return parts;
}

function commandCalls(
  line: string,
): Array<{ command: string; context?: string }> {
  const calls: Array<{ command: string; context?: string }> = [];
  for (const part of commandParts(line)) {
    const args = words(part);
    const index = args.findIndex(
      (word) => word.split("/").pop()?.replace(/\.js$/, "") === TOOL,
    );
    if (index < 0) continue;
    const argsAfter = args.slice(index + 1);
    const command = argsAfter.find((arg) => !arg.startsWith("-"));
    if (!command || !COMMANDS.has(command)) continue;
    const contextArg = argsAfter.findIndex((arg) => arg === "--context");
    const contextValue =
      contextArg >= 0
        ? argsAfter[contextArg + 1]
        : argsAfter.find((arg) => arg.startsWith("--context="))?.slice(10);
    calls.push({
      command,
      ...(contextValue && CONTEXTS.has(command.split(" ")[0]!)
        ? { context: contextValue }
        : {}),
    });
  }
  return calls;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function* toolCommands(value: unknown): Generator<string> {
  if (Array.isArray(value)) {
    for (const item of value) yield* toolCommands(item);
    return;
  }
  if (!isRecord(value)) return;
  if (value.type === "tool_use") {
    if (isRecord(value.input) && typeof value.input.command === "string")
      yield value.input.command;
    return;
  }
  for (const key of ["message", "content"])
    if (key in value) yield* toolCommands(value[key]);
}

export async function summarizeTranscript(
  path: string,
): Promise<SessionSummary | undefined> {
  if (statSync(path).size > MAX_TRANSCRIPT_BYTES) return undefined;
  const counts: Record<string, number> = {};
  const contexts: string[] = [];
  const lines = createInterface({
    input: createReadStream(path, { encoding: "utf8" }),
    crlfDelay: Infinity,
  });
  for await (const line of lines) {
    if (!line.includes(TOOL)) continue;
    let entry: unknown;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    for (const commandLine of toolCommands(entry))
      for (const call of commandCalls(commandLine)) {
        counts[call.command] = (counts[call.command] ?? 0) + 1;
        if (call.context) contexts.push(call.context);
      }
  }
  if (Object.keys(counts).length === 0) return undefined;
  const contextCounts = new Map<string, number>();
  for (const context of contexts)
    contextCounts.set(context, (contextCounts.get(context) ?? 0) + 1);
  const context = [...contextCounts].sort((a, b) => b[1] - a[1])[0]?.[0];
  return { commands: counts, ...(context ? { context } : {}) };
}

const sessionsPath = () => join(dirname(configPath()), "sessions.json");
function isSessionSummary(value: unknown): value is SessionSummary {
  return (
    isRecord(value) &&
    isRecord(value.commands) &&
    Object.entries(value.commands).every(
      ([name, count]) =>
        COMMANDS.has(name) &&
        typeof count === "number" &&
        Number.isSafeInteger(count) &&
        count > 0,
    ) &&
    (value.context === undefined ||
      (typeof value.context === "string" && !/[\r\n]/.test(value.context)))
  );
}

function readSessions(): Record<string, SessionSummary> {
  try {
    const parsed: unknown = JSON.parse(readFileSync(sessionsPath(), "utf8"));
    if (isRecord(parsed) && isRecord(parsed.directories))
      return Object.fromEntries(
        Object.entries(parsed.directories).filter(
          (entry): entry is [string, SessionSummary] =>
            isSessionSummary(entry[1]),
        ),
      );
  } catch {
    /* Missing or corrupt memory is optional. */
  }
  return {};
}

export interface SessionLock {
  fd: number;
  path: string;
  token: string;
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return errorCode(error) !== "ESRCH";
  }
}

function lockPid(token: string): number | undefined {
  const pid = Number(token.trim().split(/\s+/, 1)[0]);
  return Number.isSafeInteger(pid) && pid > 0 ? pid : undefined;
}

function errorCode(error: unknown): string | undefined {
  return error &&
    typeof error === "object" &&
    "code" in error &&
    typeof error.code === "string"
    ? error.code
    : undefined;
}

async function acquireLock(path: string): Promise<SessionLock | undefined> {
  const lockPath = `${path}.lock`;
  const deadline = Date.now() + LOCK_WAIT_MS;
  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath, 0o700);
      const ownerPath = join(lockPath, `owner-${randomUUID()}`);
      const token = `${process.pid} ${randomUUID()}\n`;
      let fd: number;
      try {
        fd = openSync(ownerPath, "wx", 0o600);
      } catch {
        rmdirSync(lockPath);
        return undefined;
      }
      try {
        writeFileSync(fd, token);
        return { fd, path: ownerPath, token };
      } catch {
        closeSync(fd);
        try {
          unlinkSync(ownerPath);
          rmdirSync(lockPath);
        } catch {
          /* The lock may already be gone. */
        }
        return undefined;
      }
    } catch (error) {
      if (errorCode(error) !== "EEXIST") return undefined;
      if (reclaimStaleLock(lockPath)) continue;
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
  }
  return undefined;
}

function reclaimStaleLock(lockPath: string): boolean {
  try {
    const owners = readdirSync(lockPath);
    if (owners.length === 0) {
      if (Date.now() - statSync(lockPath).mtimeMs <= STALE_LOCK_MS) return false;
      rmdirSync(lockPath);
      return true;
    }
    for (const ownerFile of owners) {
      const ownerPath = join(lockPath, ownerFile);
      const info = statSync(ownerPath);
      const owner = readFileSync(ownerPath, "utf8");
      const pid = lockPid(owner);
      if (
        Date.now() - info.mtimeMs <= STALE_LOCK_MS ||
        pid === undefined ||
        processAlive(pid) ||
        readFileSync(ownerPath, "utf8") !== owner
      )
        continue;
      unlinkSync(ownerPath);
      rmdirSync(lockPath);
      return true;
    }
  } catch {
    return false;
  }
  return false;
}

export function releaseSessionLock(lock: SessionLock): void {
  closeSync(lock.fd);
  try {
    if (readFileSync(lock.path, "utf8") === lock.token) {
      unlinkSync(lock.path);
      rmdirSync(dirname(lock.path));
    }
  } catch {
    /* A successor owns the lock, or it is already gone. */
  }
}

export async function recordSession(
  directory: string,
  summary: SessionSummary,
): Promise<boolean> {
  const path = sessionsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const lock = await acquireLock(path);
  if (lock === undefined) return false;
  try {
    const directories = readSessions();
    delete directories[directory];
    directories[directory] = summary;
    for (const old of Object.keys(directories).slice(
      0,
      Math.max(0, Object.keys(directories).length - MAX_DIRECTORIES),
    ))
      delete directories[old];
    const temporary = `${path}.${randomUUID()}.tmp`;
    try {
      writeFileSync(
        temporary,
        `${JSON.stringify({ directories }, null, 2)}\n`,
        {
          mode: 0o600,
        },
      );
      chmodSync(temporary, 0o600);
      renameSync(temporary, path);
    } catch (error) {
      try {
        unlinkSync(temporary);
      } catch {
        /* No temporary file to remove. */
      }
      throw error;
    }
    return true;
  } finally {
    releaseSessionLock(lock);
  }
}

export function lastSession(directory: string): SessionSummary | undefined {
  return readSessions()[directory];
}

export function sessionText(summary: SessionSummary): string {
  const commands = Object.entries(summary.commands)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join("; ");
  return `${commands}${summary.context ? ` - context ${JSON.stringify(summary.context)}` : ""}`;
}
