import { runArgocd, argocdJson } from "../argocd.js";
import { addWritableContext, removeWritableContext } from "../config.js";
import { createInterface } from "node:readline/promises";
import {
  CONTEXT_FLAG,
  getString,
  parseArgs,
  type CommandSpec,
} from "../args.js";
import { loadConfig } from "../config.js";
import {
  describeTarget,
  effectiveServer,
  listContexts,
  resolveTarget,
  validateContextName,
} from "../context.js";
import { CODES, axiError, LOGIN_HELP, validationError } from "../errors.js";
import { writableContextsSummary } from "../gate.js";
import {
  cacheKey,
  readVersionCheck,
  shortVersion,
  skewWarning,
  TESTED_WITH,
  type VersionCheck,
} from "../skew.js";
import { formatAge } from "../model.js";
import { encodeObject } from "../toon.js";
import { dispatch, finish, type Subcommand } from "./common.js";

export const CTX_SPEC: CommandSpec = {
  path: "ctx",
  summary:
    "Current Argo CD context, server and CLI version; local only, never calls the server",
  positionals: [],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi ctx", "argocd-axi ctx --context staging"],
  notes: [
    "This is what the optional SessionStart hook prints: no network, no SSO refresh, no credential read",
    "The server version shown is the cached result of the last networked check (refreshed at most every 12 hours)",
  ],
};

export const CTX_USE_SPEC: CommandSpec = {
  path: "ctx use",
  summary:
    "Switch the argocd CLI's current context (changes only the local argocd config)",
  positionals: [
    {
      name: "context",
      required: true,
      description: "A context listed by `argocd-axi ctx`",
    },
  ],
  flags: [],
  examples: ["argocd-axi ctx use staging"],
  notes: [
    "Every later argocd and argocd-axi call targets the new context, so check the server it names first",
  ],
};

/** Local CLI version from `argocd version --client`; never throws. */
async function clientVersion(): Promise<string | undefined> {
  try {
    const result = await runArgocd("version client", ["-o", "json"], {
      allowFailure: true,
    });
    if (result.exitCode !== 0) return undefined;
    const parsed = JSON.parse(result.stdout) as {
      client?: { Version?: string; version?: string };
    };
    const version = parsed.client?.Version ?? parsed.client?.version;
    return version ? shortVersion(version) : undefined;
  } catch {
    return undefined;
  }
}

/** Writable contexts line; reports a broken config instead of failing. */
export function writableLine(): string {
  try {
    return writableContextsSummary(loadConfig().config);
  } catch (error) {
    return `unavailable - ${(error as Error).message}`;
  }
}

export function versionSummary(
  check: VersionCheck | undefined,
  client: string | undefined,
): Record<string, string | undefined> {
  const cli = client ?? (check ? shortVersion(check.client) : undefined);
  return {
    cli: cli
      ? `${cli} (tested with ${TESTED_WITH})`
      : "argocd CLI not found on PATH",
    serverVersion: check
      ? `${shortVersion(check.server)} (checked ${formatAge(check.checkedAt)})`
      : undefined,
    warning: check ? skewWarning(cli ?? check.client, check.server) : undefined,
  };
}

export async function ctxView(args: string[]): Promise<string> {
  const parsed = parseArgs(CTX_SPEC, args);
  const [{ target, listing }, client] = await Promise.all([
    resolveTarget(getString(parsed, "--context")),
    clientVersion(),
  ]);
  const others = listing.contexts.filter((c) => c.name !== target.context);
  const help: string[] = [];
  if (listing.notInstalled) help.push(...listing.notInstalled.suggestions);
  else if (!target.context && !target.envServer) help.push(...LOGIN_HELP);
  else
    help.push(
      "Run `argocd-axi` for a live overview of this context's applications",
    );
  if (others.length > 0)
    help.push("Run `argocd-axi ctx use <context>` to switch contexts");

  return finish(
    [
      encodeObject({
        ...describeTarget(target, listing),
        ...versionSummary(
          target.context
            ? readVersionCheck(
                cacheKey(target.context, effectiveServer(target)),
              )
            : undefined,
          client,
        ),
        writableContexts: writableLine(),
        contexts: listing.unavailable
          ? `unavailable - ${listing.unavailable}`
          : undefined,
      }),
      others.length > 0
        ? encodeObject({
            otherContexts: others.map((c) => ({
              name: c.name,
              server: c.server,
            })),
          })
        : undefined,
    ],
    undefined,
    help,
  );
}

export async function ctxUse(args: string[]): Promise<string> {
  const parsed = parseArgs(CTX_USE_SPEC, args);
  const name = validateContextName(parsed.positionals[0] as string);
  const listing = await listContexts();
  if (listing.notInstalled) throw listing.notInstalled;
  if (listing.unavailable) {
    throw axiError(
      `cannot list Argo CD contexts: ${listing.unavailable}`,
      CODES.NO_CONTEXT,
      LOGIN_HELP,
    );
  }
  const match = listing.contexts.find((c) => c.name === name);
  if (!match) {
    throw axiError(
      `Argo CD context ${name} is not configured`,
      CODES.CONTEXT_NOT_FOUND,
      [
        `configured contexts: ${listing.contexts.map((c) => c.name).join(", ") || "none"}`,
      ],
    );
  }
  if (match.current) {
    return finish(
      [
        encodeObject({
          context: `${name} is already the current context (no-op)`,
          server: match.server,
        }),
      ],
      undefined,
    );
  }
  await runArgocd("context use", [name]);
  return finish(
    [encodeObject({ context: `switched to ${name}`, server: match.server })],
    undefined,
    ["Run `argocd-axi` for a live overview of this context"],
  );
}

const WRITABLE_SPEC: CommandSpec = {
  path: "ctx writable",
  summary: "Manage contexts allowed to perform writes",
  positionals: [],
  flags: [],
  examples: ["argocd-axi ctx writable list"],
};
const WRITABLE_ADD_SPEC: CommandSpec = {
  path: "ctx writable add",
  summary: "Allow writes on a context after interactive confirmation",
  positionals: [
    {
      name: "context",
      required: false,
      description: "Configured Argo CD context",
    },
  ],
  flags: [],
  examples: [
    "argocd-axi ctx writable add",
    "argocd-axi ctx writable add staging",
  ],
};
const WRITABLE_REMOVE_SPEC: CommandSpec = {
  path: "ctx writable remove",
  summary: "Remove write access from a context",
  positionals: [
    {
      name: "context",
      required: true,
      description: "Configured Argo CD context",
    },
  ],
  flags: [],
  examples: ["argocd-axi ctx writable remove staging"],
};
const WRITABLE_LIST_SPEC: CommandSpec = {
  path: "ctx writable list",
  summary: "List contexts allowed to perform writes",
  positionals: [],
  flags: [],
  examples: ["argocd-axi ctx writable list"],
};

export async function readConfirmation(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  prompt: string,
): Promise<string> {
  const rl = createInterface({ input, output });
  const closed = new Promise<string>((resolve) =>
    rl.once("close", () => resolve("")),
  );
  try {
    return await Promise.race([rl.question(prompt), closed]);
  } finally {
    rl.close();
  }
}

export async function confirmWritableContext(
  name: string,
  server: string,
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<boolean> {
  const answer = await readConfirmation(
    input,
    output,
    `Allow argocd-axi to sync, rollback, refresh, and terminate operations on context ${name} (${server})? [y/N] `,
  );
  return /^y(?:es)?$/i.test(answer.trim());
}

export async function contextDetails(
  contexts: Array<{ name: string; server: string; current: boolean }>,
  lookup: (name: string) => Promise<string | undefined> = async (name) =>
    (
      await argocdJson<{ username?: string }>(
        "account get-user-info",
        ["-o", "json"],
        { context: name, timeoutMs: 1_500 },
      )
    ).username,
): Promise<
  Array<{ name: string; server: string; current: boolean; username: string }>
> {
  const result = [];
  for (let offset = 0; offset < contexts.length; offset += 3) {
    const batch = await Promise.all(
      contexts.slice(offset, offset + 3).map(async (context) => ({
        ...context,
        username:
          (await lookup(context.name).catch(() => undefined)) ?? "unknown",
      })),
    );
    result.push(...batch);
  }
  return result;
}

export function addWritableContextIfConfirmed(
  name: string,
  confirmed: boolean,
): boolean {
  return confirmed ? addWritableContext(name) : false;
}

export async function chooseContext(
  contexts: Array<{ name: string; server: string; username: string }>,
  writable: string[],
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
): Promise<string> {
  output.write(
    contexts
      .map(
        (context, index) =>
          `${index + 1}. ${context.name} - ${context.server} - ${context.username}${writable.includes(context.name) ? " (already writable)" : ""}`,
      )
      .join("\n") + "\n",
  );
  const selected = await readConfirmation(
    input,
    output,
    "Select a context by number: ",
  );
  const index = Number(selected);
  const context =
    Number.isInteger(index) && index >= 1 ? contexts[index - 1] : undefined;
  if (!context)
    throw axiError("invalid context selection; no changes made", CODES.REFUSED);
  return context.name;
}

async function writableAdd(args: string[]): Promise<string> {
  const parsed = parseArgs(WRITABLE_ADD_SPEC, args);
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw axiError(
      "writable context changes require an interactive terminal; run this command in a terminal",
      CODES.REFUSED,
    );
  const listing = await listContexts();
  if (listing.notInstalled) throw listing.notInstalled;
  if (listing.unavailable) {
    throw axiError(
      `cannot list Argo CD contexts: ${listing.unavailable}`,
      CODES.NO_CONTEXT,
      LOGIN_HELP,
    );
  }
  const writable = loadConfig().config.writableContexts;
  let name = parsed.positionals[0]
    ? validateContextName(parsed.positionals[0])
    : undefined;
  let username: string | undefined;
  if (name === undefined) {
    if (listing.contexts.length === 0)
      throw axiError(
        "no configured Argo CD contexts to select",
        CODES.NO_CONTEXT,
      );
    const details = await contextDetails(listing.contexts);
    name = await chooseContext(
      details,
      writable,
      process.stdin,
      process.stdout,
    );
    username = details.find((context) => context.name === name)?.username;
  }
  const selectedName = name;
  const match = listing.contexts.find(
    (context) => context.name === selectedName,
  );
  if (!match)
    throw axiError(
      `Argo CD context ${name} is not configured`,
      CODES.CONTEXT_NOT_FOUND,
    );
  if (writable.includes(selectedName))
    return finish(
      [
        encodeObject({
          writableContext: `${selectedName} is already writable (no change)`,
        }),
      ],
      undefined,
    );
  username ??= (
    await argocdJson<{ username?: string }>(
      "account get-user-info",
      ["-o", "json"],
      { context: selectedName },
    )
  ).username;
  process.stdout.write(
    `Context: ${selectedName}\nServer: ${match.server}\nUser: ${username ?? "unknown"}\n`,
  );
  const confirmed = await confirmWritableContext(
    selectedName,
    match.server,
    process.stdin,
    process.stdout,
  );
  const changed = addWritableContextIfConfirmed(selectedName, confirmed);
  if (!confirmed)
    return finish(
      [
        encodeObject({
          writableContext: `${selectedName} remains read-only (no change)`,
        }),
      ],
      undefined,
    );
  return finish(
    [
      encodeObject({
        writableContext: changed
          ? `added ${selectedName}`
          : `${selectedName} is already writable (no change)`,
      }),
    ],
    undefined,
  );
}

async function writableRemove(args: string[]): Promise<string> {
  const parsed = parseArgs(WRITABLE_REMOVE_SPEC, args);
  const name = validateContextName(parsed.positionals[0] as string);
  const changed = removeWritableContext(name);
  return finish(
    [
      encodeObject({
        writableContext: changed
          ? `removed ${name}`
          : `${name} is not in writable-contexts (no change)`,
      }),
    ],
    undefined,
  );
}

async function writableList(args: string[]): Promise<string> {
  parseArgs(WRITABLE_LIST_SPEC, args);
  return finish(
    [encodeObject({ writableContexts: loadConfig().config.writableContexts })],
    undefined,
  );
}

const WRITABLE_SUBCOMMANDS: Record<string, Subcommand> = {
  add: { spec: WRITABLE_ADD_SPEC, run: writableAdd },
  remove: { spec: WRITABLE_REMOVE_SPEC, run: writableRemove },
  list: { spec: WRITABLE_LIST_SPEC, run: writableList },
};

const SUBCOMMANDS: Record<string, Subcommand> = {
  use: { spec: CTX_USE_SPEC, run: ctxUse },
  writable: {
    spec: WRITABLE_SPEC,
    run: (args) =>
      dispatch("ctx writable", args, WRITABLE_SUBCOMMANDS, {
        spec: WRITABLE_SPEC,
        run: async () => {
          throw validationError(
            "expected list, add, or remove for `ctx writable`",
          );
        },
      }),
  },
};

export const CTX_SPECS = [CTX_SPEC, CTX_USE_SPEC];

export async function ctxCommand(args: string[]): Promise<string> {
  const first = args[0];
  if (
    first !== undefined &&
    !first.startsWith("-") &&
    first !== "use" &&
    first !== "writable"
  ) {
    throw validationError(`unexpected argument ${first} for \`ctx\``, [
      `To switch contexts, run \`argocd-axi ctx use ${first}\``,
      `To read another context without switching, run \`argocd-axi ctx --context ${first}\``,
    ]);
  }
  return dispatch("ctx", args, SUBCOMMANDS, { spec: CTX_SPEC, run: ctxView });
}
