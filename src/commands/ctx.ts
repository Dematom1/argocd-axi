import { runArgocd } from "../argocd.js";
import {
  CONTEXT_FLAG,
  getString,
  parseArgs,
  type CommandSpec,
} from "../args.js";
import { loadConfig } from "../config.js";
import {
  describeTarget,
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
  else if (!target.context) help.push(...LOGIN_HELP);
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
            ? readVersionCheck(cacheKey(target.context, target.server))
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

const SUBCOMMANDS: Record<string, Subcommand> = {
  use: { spec: CTX_USE_SPEC, run: ctxUse },
};

export const CTX_SPECS = [CTX_SPEC, CTX_USE_SPEC];

export async function ctxCommand(args: string[]): Promise<string> {
  const first = args[0];
  if (first !== undefined && !first.startsWith("-") && first !== "use") {
    throw validationError(`unexpected argument ${first} for \`ctx\``, [
      `To switch contexts, run \`argocd-axi ctx use ${first}\``,
      `To read another context without switching, run \`argocd-axi ctx --context ${first}\``,
    ]);
  }
  return dispatch("ctx", args, SUBCOMMANDS, { spec: CTX_SPEC, run: ctxView });
}
