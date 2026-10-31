import {
  chmodSync,
  createReadStream,
  mkdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { createInterface } from "node:readline";
import { configPath } from "./config.js";

const MAX_DIRECTORIES = 100;
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

function commandCalls(
  line: string,
): Array<{ command: string; context?: string }> {
  const calls: Array<{ command: string; context?: string }> = [];
  for (const part of line.split(/[;|&\n]/)) {
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
    (value.context === undefined || typeof value.context === "string")
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

export function recordSession(
  directory: string,
  summary: SessionSummary,
): void {
  const directories = readSessions();
  delete directories[directory];
  directories[directory] = summary;
  for (const old of Object.keys(directories).slice(
    0,
    Math.max(0, Object.keys(directories).length - MAX_DIRECTORIES),
  ))
    delete directories[old];
  const path = sessionsPath();
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify({ directories }, null, 2)}\n`, {
    mode: 0o600,
  });
  chmodSync(path, 0o600);
}

export function lastSession(directory: string): SessionSummary | undefined {
  return readSessions()[directory];
}

export function sessionText(summary: SessionSummary): string {
  const commands = Object.entries(summary.commands)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name} ${count}`)
    .join("; ");
  return `${commands}${summary.context ? ` - context ${summary.context}` : ""}`;
}
