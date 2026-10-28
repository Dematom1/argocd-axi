import { argocdJson } from "../argocd.js";
import { CODES, axiError } from "../errors.js";
import {
  CONTEXT_FLAG,
  getInt,
  parseArgs,
  validateName,
  type CommandSpec,
} from "../args.js";
import { plural, truncate } from "../model.js";
import { Redactor } from "../redact.js";
import { encodeObject } from "../toon.js";
import { syncVerdict, windowState, type SyncWindow } from "../windows.js";
import {
  contextOption,
  contextSuffix,
  dispatch,
  finish,
  type Subcommand,
} from "./common.js";

interface GroupKind {
  group?: string;
  kind?: string;
}

interface AppProject {
  metadata?: { name?: string };
  spec?: {
    description?: string;
    sourceRepos?: string[];
    sourceNamespaces?: string[];
    destinations?: Array<{
      server?: string;
      name?: string;
      namespace?: string;
    }>;
    clusterResourceWhitelist?: GroupKind[];
    clusterResourceBlacklist?: GroupKind[];
    namespaceResourceWhitelist?: GroupKind[];
    namespaceResourceBlacklist?: GroupKind[];
    roles?: Array<{
      name?: string;
      description?: string;
      policies?: string[];
      groups?: string[];
      jwtTokens?: unknown[];
    }>;
    syncWindows?: SyncWindow[];
    orphanedResources?: { warn?: boolean; ignore?: unknown[] };
    signatureKeys?: unknown[];
  };
}

const NOT_FOUND_HELP = ["Run `argocd-axi projects` to list projects"];

export const PROJECTS_LIST_SPEC: CommandSpec = {
  path: "projects",
  summary: "List projects with their destinations and sync windows",
  positionals: [],
  flags: [
    {
      name: "--limit",
      kind: "value",
      valueName: "n",
      description: "Rows to show (default 100)",
    },
    CONTEXT_FLAG,
  ],
  examples: ["argocd-axi projects"],
};

export async function projectsList(args: string[]): Promise<string> {
  const parsed = parseArgs(PROJECTS_LIST_SPEC, args);
  const limit = getInt(parsed, "--limit", {
    default: 100,
    min: 1,
    max: 10_000,
  });
  const projects =
    (await argocdJson<AppProject[] | null>(
      "proj list",
      ["-o", "json"],
      contextOption(parsed),
    )) ?? [];
  if (projects.length === 0) {
    return finish(
      [encodeObject({ projects: "0 projects visible to this credential" })],
      undefined,
    );
  }
  const sorted = [...projects].sort((a, b) =>
    (a.metadata?.name ?? "").localeCompare(b.metadata?.name ?? ""),
  );
  const rows = sorted.slice(0, limit).map((p) => ({
    project: p.metadata?.name ?? "",
    description: truncate(p.spec?.description ?? "", 60),
    destinations: p.spec?.destinations?.length ?? 0,
    windows: p.spec?.syncWindows?.length ?? 0,
  }));
  const scope = contextSuffix(parsed);
  const help = [
    `Run \`argocd-axi projects view <project>${scope}\` for a project's rules and roles`,
  ];
  if (rows.length < projects.length)
    help.unshift(
      `Run \`argocd-axi projects --limit ${projects.length}${scope}\` to see all`,
    );
  if (rows.some((r) => r.windows > 0))
    help.push(
      `Run \`argocd-axi projects windows <project>${scope}\` to see whether sync is allowed now`,
    );
  return finish(
    [
      encodeObject({
        count: `${rows.length} of ${projects.length} total`,
        projects: rows,
      }),
    ],
    undefined,
    help,
  );
}

export const PROJECTS_VIEW_SPEC: CommandSpec = {
  path: "projects view",
  summary:
    "One project: sources, destinations, resource allow and deny lists, roles, sync windows",
  positionals: [
    { name: "project", required: true, description: "Project name" },
  ],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi projects view payments"],
  notes: [
    "Role token values are never shown; only how many tokens each role has",
  ],
};

function groupKinds(list: GroupKind[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.map((gk) => `${gk.group || "core"}/${gk.kind ?? "*"}`);
}

const LIST_CAP = 20;

function capped(list: string[] | undefined): string[] | undefined {
  if (!list || list.length === 0) return undefined;
  return list.length <= LIST_CAP
    ? list
    : [...list.slice(0, LIST_CAP), `... ${list.length - LIST_CAP} more`];
}

export async function projectsView(args: string[]): Promise<string> {
  const parsed = parseArgs(PROJECTS_VIEW_SPEC, args);
  const name = validateName("project", parsed.positionals[0] as string);
  const project = await argocdJson<AppProject>(
    "proj get",
    [name, "-o", "json"],
    {
      ...contextOption(parsed),
      failure: { notFoundHelp: NOT_FOUND_HELP },
    },
  );
  const spec = project.spec ?? {};
  const redactor = new Redactor();
  const windows = spec.syncWindows ?? [];
  const summary = {
    name: project.metadata?.name ?? name,
    description: spec.description || undefined,
    sourceRepos: capped(spec.sourceRepos),
    sourceNamespaces: capped(spec.sourceNamespaces),
    clusterResourcesAllowed: groupKinds(spec.clusterResourceWhitelist),
    clusterResourcesDenied: groupKinds(spec.clusterResourceBlacklist),
    namespaceResourcesAllowed: groupKinds(spec.namespaceResourceWhitelist),
    namespaceResourcesDenied: groupKinds(spec.namespaceResourceBlacklist),
    orphanedResources: spec.orphanedResources
      ? spec.orphanedResources.warn
        ? "monitored, warns"
        : "monitored"
      : "not monitored",
    signatureKeys: spec.signatureKeys?.length
      ? `${spec.signatureKeys.length} required`
      : undefined,
    syncWindows: windows.length,
  };
  const destinations = (spec.destinations ?? []).map((d) => ({
    cluster: d.name ?? d.server ?? "",
    namespace: d.namespace ?? "",
  }));
  const roles = (spec.roles ?? []).map((r) => ({
    role: r.name ?? "",
    policies: r.policies?.length ?? 0,
    groups: r.groups?.length ?? 0,
    tokens: r.jwtTokens?.length ?? 0,
  }));
  const help =
    windows.length > 0
      ? [
          `Run \`argocd-axi projects windows ${name}${contextSuffix(parsed)}\` to see whether sync is allowed now`,
        ]
      : [];
  return finish(
    [
      encodeObject({ project: redactor.deep(summary) }),
      destinations.length > 0
        ? encodeObject({ destinations })
        : encodeObject({
            destinations: "none (no app in this project can deploy anywhere)",
          }),
      roles.length > 0 ? encodeObject({ roles }) : undefined,
    ],
    redactor,
    help,
  );
}

export const PROJECTS_WINDOWS_SPEC: CommandSpec = {
  path: "projects windows",
  summary:
    "A project's sync windows, which are active now, and whether sync is allowed right now",
  positionals: [
    { name: "project", required: true, description: "Project name" },
  ],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi projects windows payments"],
  notes: [
    "The verdict assumes every window applies; check each window's apps, namespaces and clusters for a specific app",
    "Evaluated like Argo CD: a window is active when its cron schedule fired within the last duration, in its time zone (UTC when unset)",
  ],
};

function appliesTo(window: SyncWindow): string {
  const parts = [
    window.applications?.length ? `apps ${window.applications.join(" ")}` : "",
    window.namespaces?.length
      ? `namespaces ${window.namespaces.join(" ")}`
      : "",
    window.clusters?.length ? `clusters ${window.clusters.join(" ")}` : "",
  ].filter(Boolean);
  return parts.length > 0 ? truncate(parts.join("; "), 120) : "nothing matched";
}

export async function projectsWindows(args: string[]): Promise<string> {
  const parsed = parseArgs(PROJECTS_WINDOWS_SPEC, args);
  const name = validateName("project", parsed.positionals[0] as string);
  const windows =
    (await argocdJson<SyncWindow[] | null>(
      "proj windows list",
      [name, "-o", "json"],
      {
        ...contextOption(parsed),
        failure: { notFoundHelp: NOT_FOUND_HELP },
      },
    )) ?? [];
  const now = Date.now();
  const verdict = syncVerdict(windows, now);
  const sync = {
    automated: verdict.automated ? "allowed" : "blocked",
    manual: verdict.manual ? "allowed" : "blocked",
    reason: verdict.reason,
  };
  if (windows.length === 0) {
    return finish(
      [encodeObject({ sync, windows: `0 sync windows in project ${name}` })],
      undefined,
    );
  }
  const rows = windows.map((w) => {
    const state = windowState(w, now);
    return {
      kind: w.kind ?? "",
      schedule: w.schedule ?? "",
      duration: w.duration ?? "",
      timeZone: w.timeZone || "UTC",
      active: state.error
        ? `unknown (${state.error})`
        : state.active
          ? "yes"
          : "no",
      nextStart: state.nextStart ? new Date(state.nextStart).toISOString() : "",
      manualSync: w.manualSync ? "yes" : "no",
      appliesTo: appliesTo(w),
    };
  });
  return finish(
    [
      encodeObject({
        sync,
        count: plural(rows.length, "window"),
        windows: rows,
      }),
    ],
    undefined,
  );
}

const SUBCOMMANDS: Record<string, Subcommand> = {
  view: { spec: PROJECTS_VIEW_SPEC, run: projectsView },
  windows: { spec: PROJECTS_WINDOWS_SPEC, run: projectsWindows },
};

export const PROJECTS_SPECS = [
  PROJECTS_LIST_SPEC,
  PROJECTS_VIEW_SPEC,
  PROJECTS_WINDOWS_SPEC,
];

const WINDOW_WRITES = [
  "add",
  "update",
  "delete",
  "enable-manual-sync",
  "disable-manual-sync",
];

export async function projectsCommand(args: string[]): Promise<string> {
  if (args[0] === "windows" && WINDOW_WRITES.includes(args[1] ?? "")) {
    throw axiError(
      "not wrapped - changing a project's sync windows is a write",
      CODES.REFUSED,
      [
        "Run `argocd-axi projects windows <project>` to read them",
        `A human runs this with the raw argocd CLI: \`argocd proj windows ${args[1]} <project> ...\``,
      ],
    );
  }
  return dispatch("projects", args, SUBCOMMANDS, {
    spec: PROJECTS_LIST_SPEC,
    run: projectsList,
  });
}
