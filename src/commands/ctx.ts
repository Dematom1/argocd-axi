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
      required: true,
      description: "Configured Argo CD context",
    },
  ],
  flags: [],
  examples: ["argocd-axi ctx writable add staging"],
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
  try {
    return await rl.question(prompt);
  } finally {
    rl.close();
  }
}

async function writableAdd(args: string[]): Promise<string> {
  const parsed = parseArgs(WRITABLE_ADD_SPEC, args);
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
  const match = listing.contexts.find((context) => context.name === name);
  if (!match)
    throw axiError(
      `Argo CD context ${name} is not configured`,
      CODES.CONTEXT_NOT_FOUND,
    );
  if (loadConfig().config.writableContexts.includes(name))
    return finish(
      [
        encodeObject({
          writableContext: `${name} is already writable (no change)`,
        }),
      ],
      undefined,
    );
  if (!process.stdin.isTTY || !process.stdout.isTTY)
    throw axiError(
      "writable context changes require an interactive terminal",
      CODES.REFUSED,
    );
  const info = await argocdJson<{ username?: string }>(
    "account get-user-info",
    ["-o", "json"],
    { context: name },
  );
  process.stdout.write(
    `Context: ${name}\nServer: ${match.server}\nUser: ${info.username ?? "unknown"}\n`,
  );
  const answer = await readConfirmation(
    process.stdin,
    process.stdout,
    `Allow argocd-axi to run write commands (sync, rollback, refresh, terminate-op) against context ${name} / ${match.server}?\nType ${name} to allow writes; anything else leaves it read-only and unchanged.\n> `,
  );
  if (answer !== name)
    throw axiError(
      "confirmation did not match; no changes made",
      CODES.REFUSED,
    );
  const changed = addWritableContext(name);
  return finish(
    [
      encodeObject({
        writableContext: changed
          ? `added ${name}`
          : `${name} is already writable (no change)`,
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
