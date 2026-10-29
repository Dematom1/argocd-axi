import { argocdJson } from "../argocd.js";
import { CONTEXT_FLAG, parseArgs, type CommandSpec } from "../args.js";
import { truncate } from "../model.js";
import { Redactor } from "../redact.js";
import { encodeObject } from "../toon.js";
import { contextOption, dispatch, finish } from "./common.js";

/**
 * Repositories and clusters. Both objects carry credentials (repo
 * passwords and SSH keys, cluster bearer tokens and TLS keys), so rows are
 * built from an explicit field allowlist and never from the raw object.
 */

interface ConnectionState {
  status?: string;
  message?: string;
}

interface Repository {
  repo?: string;
  type?: string;
  name?: string;
  project?: string;
  connectionState?: ConnectionState;
}

interface Cluster {
  server?: string;
  name?: string;
  connectionState?: ConnectionState;
  serverVersion?: string;
  info?: {
    connectionState?: ConnectionState;
    serverVersion?: string;
    applicationsCount?: number;
  };
}

function connection(
  state: ConnectionState | undefined,
  redactor: Redactor,
): string {
  const status = state?.status || "Unknown";
  if (status === "Successful" || !state?.message) return status;
  return `${status}: ${truncate(redactor.text(state.message), 120)}`;
}

function failedFirst<T>(rows: T[], failed: (row: T) => boolean): T[] {
  return [...rows.filter(failed), ...rows.filter((row) => !failed(row))];
}

export const REPOS_SPEC: CommandSpec = {
  path: "repos",
  summary:
    "Configured Git, Helm and OCI repositories with their connection status; credentials never shown",
  positionals: [],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi repos"],
};

export async function reposList(args: string[]): Promise<string> {
  const parsed = parseArgs(REPOS_SPEC, args);
  const repos =
    (await argocdJson<Repository[] | null>(
      "repo list",
      ["-o", "json"],
      contextOption(parsed),
    )) ?? [];
  if (repos.length === 0) {
    return finish(
      [
        encodeObject({
          repos:
            "0 repositories configured (public repos can be used without one)",
        }),
      ],
      undefined,
    );
  }
  const redactor = new Redactor();
  const rows = failedFirst(
    repos,
    (r) => r.connectionState?.status === "Failed",
  ).map((r) => ({
    repo: redactor.text(r.repo ?? ""),
    type: r.type || "git",
    name: r.name ?? "",
    project: r.project ?? "",
    connection: connection(r.connectionState, redactor),
  }));
  const failed = rows.filter((r) => r.connection.startsWith("Failed")).length;
  return finish(
    [
      encodeObject({
        count: `${rows.length} repositories, ${failed} failing`,
        repos: rows,
      }),
    ],
    redactor,
  );
}

export const CLUSTERS_SPEC: CommandSpec = {
  path: "clusters",
  summary:
    "Destination clusters with connection status, Kubernetes version and app count; credentials never shown",
  positionals: [],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi clusters"],
};

export async function clustersList(args: string[]): Promise<string> {
  const parsed = parseArgs(CLUSTERS_SPEC, args);
  const clusters =
    (await argocdJson<Cluster[] | null>(
      "cluster list",
      ["-o", "json"],
      contextOption(parsed),
    )) ?? [];
  if (clusters.length === 0) {
    return finish(
      [encodeObject({ clusters: "0 clusters visible to this credential" })],
      undefined,
    );
  }
  const redactor = new Redactor();
  const state = (c: Cluster) => c.info?.connectionState ?? c.connectionState;
  const rows = failedFirst(clusters, (c) => state(c)?.status === "Failed").map(
    (c) => ({
      name: c.name ?? "",
      server: redactor.text(c.server ?? ""),
      connection: connection(state(c), redactor),
      version: c.info?.serverVersion ?? c.serverVersion ?? "",
      apps: c.info?.applicationsCount ?? 0,
    }),
  );
  const failed = rows.filter((r) => r.connection.startsWith("Failed")).length;
  return finish(
    [
      encodeObject({
        count: `${rows.length} clusters, ${failed} failing`,
        clusters: rows,
      }),
    ],
    redactor,
  );
}

export async function reposCommand(args: string[]): Promise<string> {
  return dispatch("repos", args, {}, { spec: REPOS_SPEC, run: reposList });
}

export async function clustersCommand(args: string[]): Promise<string> {
  return dispatch(
    "clusters",
    args,
    {},
    { spec: CLUSTERS_SPEC, run: clustersList },
  );
}
