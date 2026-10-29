import { AxiError } from "axi-sdk-js";
import { runArgocd, type RunResult } from "./argocd.js";
import {
  CODES,
  axiError,
  cleanArgocdStderr,
  validationError,
} from "./errors.js";

/**
 * Offline target resolution (decisions S8 and S17). Contexts come from
 * `argocd context`, which reads only the local argocd config; argocd-axi
 * never opens that file itself because it holds clear-text tokens (S7).
 */

export interface ArgoContext {
  name: string;
  server: string;
  current: boolean;
}

export interface ContextListing {
  contexts: ArgoContext[];
  /** Why the listing is empty, when argocd could not list contexts. */
  unavailable?: string;
  /** Set when the argocd CLI itself is missing; carries the install help. */
  notInstalled?: AxiError;
}

export interface Target {
  /** The context argocd will use, or undefined when none is configured. */
  context?: string;
  server?: string;
  /** How the context was chosen. */
  source: "flag" | "current" | "none";
  /** ARGOCD_SERVER is set and overrides the context's server. */
  envServer?: string;
  /** ARGOCD_AUTH_TOKEN is set (its value is never read beyond presence). */
  envToken: boolean;
}

const CONTEXT_NAME = /^[^\s-][^\s]*$/;

export function validateContextName(name: string): string {
  if (!CONTEXT_NAME.test(name) || name.length > 253) {
    throw validationError(`invalid context name ${JSON.stringify(name)}`, [
      "Run `argocd-axi ctx` to list configured contexts",
    ]);
  }
  return name;
}

/**
 * Parse argocd's tabwriter table by header column offsets, so empty cells
 * (such as the CURRENT marker) do not shift later columns.
 */
export function parseTable(text: string): Array<Record<string, string>> {
  const lines = text.split("\n").filter((line) => line.trim().length > 0);
  const header = lines[0];
  if (header === undefined) return [];
  const columns: Array<{ name: string; start: number }> = [];
  const pattern = /\S+/g;
  for (let match = pattern.exec(header); match; match = pattern.exec(header)) {
    columns.push({ name: match[0], start: match.index });
  }
  return lines.slice(1).map((line) => {
    const row: Record<string, string> = {};
    columns.forEach((column, index) => {
      const end = columns[index + 1]?.start ?? line.length;
      row[column.name] = line.slice(column.start, end).trim();
    });
    return row;
  });
}

export async function listContexts(): Promise<ContextListing> {
  let result: RunResult;
  try {
    result = await runArgocd("context list", [], { allowFailure: true });
  } catch (error) {
    if (error instanceof AxiError && error.code === CODES.ARGOCD_NOT_INSTALLED)
      return { contexts: [], unavailable: error.message, notInstalled: error };
    throw error;
  }
  if (result.exitCode !== 0) {
    return {
      contexts: [],
      unavailable:
        cleanArgocdStderr(result.stderr) || "argocd could not list contexts",
    };
  }
  const contexts = parseTable(result.stdout)
    .filter((row) => row.NAME)
    .map((row) => ({
      name: row.NAME as string,
      server: row.SERVER ?? "",
      current: row.CURRENT === "*",
    }));
  return { contexts };
}

function envServer(): string | undefined {
  const value = process.env.ARGOCD_SERVER?.trim();
  return value ? value : undefined;
}

function envToken(): boolean {
  return Boolean(process.env.ARGOCD_AUTH_TOKEN?.trim());
}

export function describeTarget(target: Target, listing: ContextListing) {
  return {
    context: target.context ?? "none configured",
    server: target.envServer
      ? `${target.envServer} (from ARGOCD_SERVER)`
      : (target.server ?? (listing.unavailable ? "unknown" : "none")),
    auth: target.envToken
      ? "ARGOCD_AUTH_TOKEN is set"
      : target.context
        ? "argocd CLI session for this context"
        : "none",
  };
}

/**
 * Resolve the context a command will target. An explicit `--context` must
 * name a configured context; otherwise the current context is used.
 */
export async function resolveTarget(
  explicit: string | undefined,
  listing?: ContextListing,
): Promise<{ target: Target; listing: ContextListing }> {
  const contexts = listing ?? (await listContexts());
  const base = { envServer: envServer(), envToken: envToken() };

  if (explicit !== undefined) {
    validateContextName(explicit);
    const match = contexts.contexts.find((c) => c.name === explicit);
    if (!match && !contexts.unavailable) {
      throw axiError(
        `Argo CD context ${explicit} is not configured`,
        CODES.CONTEXT_NOT_FOUND,
        [
          `configured contexts: ${contexts.contexts.map((c) => c.name).join(", ") || "none"}`,
          "Run `argocd-axi ctx` to see them with their servers",
        ],
      );
    }
    return {
      target: {
        ...base,
        context: explicit,
        server: match?.server,
        source: "flag",
      },
      listing: contexts,
    };
  }

  const current = contexts.contexts.find((c) => c.current);
  if (current) {
    return {
      target: {
        ...base,
        context: current.name,
        server: current.server,
        source: "current",
      },
      listing: contexts,
    };
  }
  return { target: { ...base, source: "none" }, listing: contexts };
}
