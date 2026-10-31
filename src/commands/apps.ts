import { AxiError } from "axi-sdk-js";
import { parseAllDocuments, stringify } from "yaml";
import { argocdJson, runArgocd } from "../argocd.js";
import { loadConfig } from "../config.js";
import { evaluateWriteGate } from "../gate.js";
import type { SyncWindow } from "../windows.js";
import {
  CONTEXT_FLAG,
  getBool,
  getInt,
  getList,
  getString,
  parseArgs,
  parseDurationSeconds,
  validateName,
  type CommandSpec,
} from "../args.js";
import {
  CODES,
  axiError,
  mapArgocdFailure,
  validationError,
} from "../errors.js";
import {
  appName,
  appSources,
  attentionReasonPreview,
  attentionReasons,
  autoSyncSummary,
  destinationSummary,
  displayNames,
  formatAge,
  healthStatus,
  isOperationRunning,
  isResourceProblem,
  isUnhealthy,
  needsAttention,
  shortRevision,
  sortApps,
  syncRevision,
  syncStatus,
  plural,
  truncate,
  type AppSource,
  type Application,
  type ResourceStatus,
} from "../model.js";
import { parseTable } from "../context.js";
import { Redactor } from "../redact.js";
import { encodeObject, renderTextBlock } from "../toon.js";
import {
  carriedFlags,
  contextOption,
  contextSuffix,
  dispatch,
  finish,
  preview,
  type Subcommand,
} from "./common.js";

const APP_ARG = {
  name: "app",
  required: true,
  description: "Application name, or namespace/name",
};
const NOT_FOUND_HELP = ["Run `argocd-axi apps` to list applications"];
const MESSAGE_CHARS = 300;
const LOG_CHAR_CAP = 20_000;
const FULL_LOG_CHAR_CAP = 1_000_000;

async function getApp(
  name: string,
  options: { context?: string },
): Promise<Application> {
  return argocdJson<Application>(
    "app get",
    [validateName("app", name), "-o", "json"],
    {
      ...options,
      failure: { notFoundHelp: NOT_FOUND_HELP },
    },
  );
}

// ---------------------------------------------------------------- apps (list)

/** `apps` filters applied locally, after the server-side list is fetched. */
const LOCAL_FILTERS = ["--sync", "--health", "--problems", "--limit"];

const LIST_FIELDS = [
  "namespace",
  "repo",
  "path",
  "target",
  "revision",
  "cluster",
  "dest-namespace",
  "auto-sync",
  "operation",
  "reconciled",
] as const;
type ListField = (typeof LIST_FIELDS)[number];

const SYNC_VALUES = ["Synced", "OutOfSync", "Unknown"];
const HEALTH_VALUES = [
  "Healthy",
  "Progressing",
  "Degraded",
  "Suspended",
  "Missing",
  "Unknown",
];

export const APPS_LIST_SPEC: CommandSpec = {
  path: "apps",
  summary: "List applications, those needing attention first, with the reason",
  positionals: [],
  flags: [
    {
      name: "--project",
      short: "-p",
      kind: "multi",
      valueName: "project",
      description: "Only apps in this project (repeatable or comma-separated)",
    },
    {
      name: "--selector",
      short: "-l",
      kind: "value",
      valueName: "selector",
      description: "Label selector, e.g. team=payments",
    },
    {
      name: "--repo",
      kind: "value",
      valueName: "url",
      description: "Only apps whose source repo URL matches",
    },
    {
      name: "--cluster",
      kind: "value",
      valueName: "name|url",
      description: "Only apps deployed to this cluster",
    },
    {
      name: "--sync",
      kind: "multi",
      valueName: "status",
      description:
        "Only apps with this sync status: Synced, OutOfSync, Unknown",
    },
    {
      name: "--health",
      kind: "multi",
      valueName: "status",
      description:
        "Only apps with this health: Healthy, Progressing, Degraded, Suspended, Missing, Unknown",
    },
    {
      name: "--problems",
      kind: "bool",
      description: "Only apps that need attention",
    },
    {
      name: "--limit",
      kind: "value",
      valueName: "n",
      description: "Rows to show (default 50)",
    },
    {
      name: "--fields",
      kind: "multi",
      valueName: "fields",
      description: `Extra columns: ${LIST_FIELDS.join(", ")}`,
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps",
    "argocd-axi apps --problems",
    "argocd-axi apps --project payments --fields revision,auto-sync",
  ],
  notes: [
    "An app needs attention when it is OutOfSync or sync Unknown; Degraded, Missing or health Unknown; Progressing for more than 10 minutes; its last sync Failed or Errored; or it has conditions",
  ],
  hints: {
    "--status": "use --sync <status> or --health <status>",
    "-N": "pass the app as namespace/name instead",
  },
};

function fieldValue(app: Application, field: ListField): string {
  const source = appSources(app)[0];
  switch (field) {
    case "namespace":
      return app.metadata?.namespace ?? "";
    case "repo":
      return source?.repoURL ?? "";
    case "path":
      return source?.path ?? source?.chart ?? "";
    case "target":
      return source?.targetRevision ?? "HEAD";
    case "revision":
      return syncRevision(app);
    case "cluster":
      return app.spec?.destination?.name ?? app.spec?.destination?.server ?? "";
    case "dest-namespace":
      return app.spec?.destination?.namespace ?? "";
    case "auto-sync":
      return autoSyncSummary(app);
    case "operation":
      return app.status?.operationState?.phase ?? "";
    case "reconciled":
      return formatAge(app.status?.reconciledAt);
  }
}

function validateChoices(
  flag: string,
  values: string[],
  allowed: string[],
): string[] {
  return values.map((value) => {
    const match = allowed.find((a) => a.toLowerCase() === value.toLowerCase());
    if (!match)
      throw validationError(
        `${flag} must be one of ${allowed.join(", ")}, got ${value}`,
      );
    return match;
  });
}

export async function appsList(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_LIST_SPEC, args);
  const limit = getInt(parsed, "--limit", { default: 50, min: 1, max: 10_000 });
  const fields = getList(parsed, "--fields").map((field) => {
    if (!(LIST_FIELDS as readonly string[]).includes(field)) {
      throw validationError(`unknown field ${field} for --fields`, [
        `valid fields: ${LIST_FIELDS.join(", ")}`,
      ]);
    }
    return field as ListField;
  });
  const syncFilter = validateChoices(
    "--sync",
    getList(parsed, "--sync"),
    SYNC_VALUES,
  );
  const healthFilter = validateChoices(
    "--health",
    getList(parsed, "--health"),
    HEALTH_VALUES,
  );
  const problemsOnly = getBool(parsed, "--problems");

  const argv = ["-o", "json"];
  for (const project of getList(parsed, "--project"))
    argv.push("-p", validateName("project", project));
  const selector = getString(parsed, "--selector");
  if (selector !== undefined) argv.push("-l", selector);
  const repo = getString(parsed, "--repo");
  if (repo !== undefined) argv.push("-r", repo);
  const cluster = getString(parsed, "--cluster");
  if (cluster !== undefined) argv.push("-c", cluster);

  const all =
    (await argocdJson<Application[] | null>(
      "app list",
      argv,
      contextOption(parsed),
    )) ?? [];
  const now = Date.now();
  const matching = sortApps(all, now).filter(
    (app) =>
      (syncFilter.length === 0 || syncFilter.includes(syncStatus(app))) &&
      (healthFilter.length === 0 || healthFilter.includes(healthStatus(app))) &&
      (!problemsOnly || needsAttention(app, now)),
  );
  const attention = all.filter((app) => needsAttention(app, now)).length;
  const scope = contextSuffix(parsed);
  const filtered =
    syncFilter.length > 0 || healthFilter.length > 0 || problemsOnly;

  if (matching.length === 0) {
    const what =
      all.length === 0
        ? "0 applications visible to this credential"
        : `0 of ${all.length} applications match the filters`;
    return finish(
      [encodeObject({ apps: what })],
      undefined,
      all.length === 0
        ? []
        : [
            `Run \`argocd-axi apps${carriedFlags(parsed, LOCAL_FILTERS)}\` to list all ${all.length}`,
          ],
    );
  }

  const name = displayNames(matching);
  const showWhy = matching.some((app) => needsAttention(app, now));
  const redactor = new Redactor();
  const rows = matching.slice(0, limit).map((app) => {
    const row: Record<string, string> = {
      app: name(app),
      project: app.spec?.project ?? "",
      sync: syncStatus(app),
      health: healthStatus(app),
    };
    if (showWhy) {
      const why = attentionReasonPreview(app, 160, now, redactor);
      row.why = preview(why.text, 160, false, why.totalChars).text;
    }
    for (const field of fields) row[field] = fieldValue(app, field);
    return row;
  });

  const count = filtered
    ? `${rows.length} of ${matching.length} matching (${all.length} total, ${attention} need attention)`
    : `${rows.length} of ${all.length} total (${attention} need attention)`;
  const help: string[] = [];
  if (rows.length < matching.length)
    help.push(
      `Run \`argocd-axi apps --limit ${matching.length}${carriedFlags(parsed, ["--limit"])}\` to see all ${matching.length}`,
    );
  help.push(
    `Run \`argocd-axi apps view <app>${scope}\` to diagnose an application`,
  );
  if (!problemsOnly && attention > 0)
    help.push(
      `Run \`argocd-axi apps --problems${carriedFlags(parsed, LOCAL_FILTERS)}\` to list only apps needing attention`,
    );
  return finish(
    [encodeObject({ count, apps: redactor.deep(rows) })],
    redactor,
    help,
  );
}

// ---------------------------------------------------------------- apps view

export const APPS_VIEW_SPEC: CommandSpec = {
  path: "apps view",
  summary:
    "One application: source, destination, sync, health, operation, conditions, auto-sync, unhealthy resources",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--full",
      kind: "bool",
      description: "Do not truncate messages or Helm values",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps view guestbook",
    "argocd-axi apps view team-a/billing --context staging",
  ],
};

const ROLLOUT_KIND = "Rollout";

export async function appsView(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_VIEW_SPEC, args);
  const full = getBool(parsed, "--full");
  const name = parsed.positionals[0] as string;
  const app = await getApp(name, contextOption(parsed));
  const scope = contextSuffix(parsed);
  const now = Date.now();
  const redactor = new Redactor();
  let truncated = false;
  const cut = (
    text: string | undefined,
    max = MESSAGE_CHARS,
    counter = redactor,
  ) => {
    if (!text) return undefined;
    const result = preview(counter.text(text), max, full);
    truncated ||= result.truncated;
    return result.text;
  };

  const reasons = attentionReasons(app, now, new Redactor());
  const summary: Record<string, unknown> = {
    name: appName(app),
    namespace: app.metadata?.namespace,
    project: app.spec?.project,
    sync: syncStatus(app),
    revision: syncRevision(app) || undefined,
    health: healthStatus(app),
    progressingSince:
      healthStatus(app) === "Progressing"
        ? formatAge(app.status?.health?.lastTransitionTime, now)
        : undefined,
    healthMessage: cut(app.status?.health?.message),
    autoSync: autoSyncSummary(app),
    destination: destinationSummary(app),
    reconciled: app.status?.reconciledAt
      ? formatAge(app.status.reconciledAt, now)
      : undefined,
    attention: reasons.length > 0 ? reasons.join("; ") : "none",
  };

  const sources = appSources(app).map((source) => ({
    repo: source.repoURL ?? "",
    path: source.path ?? (source.chart ? `chart ${source.chart}` : ""),
    target: source.targetRevision ?? "HEAD",
  }));

  const parameters = appSources(app).flatMap((source, index) =>
    (source.helm?.parameters ?? []).map((p) => ({
      source: index + 1,
      name: p.name ?? "",
      value: p.value ?? "",
    })),
  );
  const values = appSources(app)
    .map((source, index) => ({
      index,
      text: helmValuesText(source.helm, redactor),
    }))
    .filter(
      (entry): entry is { index: number; text: string } =>
        entry.text !== undefined,
    )
    .map((entry) => ({
      source: entry.index + 1,
      ...valuesPreview(entry.text, full),
    }));
  for (const value of values) truncated ||= value.truncated;

  const op = app.status?.operationState;
  const operation = op
    ? {
        phase: op.phase,
        message: cut(op.message),
        started: op.startedAt ? formatAge(op.startedAt, now) : undefined,
        finished: op.finishedAt ? formatAge(op.finishedAt, now) : undefined,
        initiatedBy: op.operation?.initiatedBy?.automated
          ? "automated"
          : op.operation?.initiatedBy?.username,
        running: isOperationRunning(app) ? "yes" : undefined,
      }
    : undefined;

  const conditions = (app.status?.conditions ?? []).map((c) => ({
    type: c.type ?? "",
    message: cut(c.message) ?? "",
  }));

  const resources = app.status?.resources ?? [];
  const problems = resources.filter(isResourceProblem);
  const shownProblems = problems.slice(0, 20);
  const rollouts = resources
    .filter((r) => r.kind === ROLLOUT_KIND && r.group === "argoproj.io")
    .map((r) => ({
      name: r.name ?? "",
      namespace: r.namespace ?? "",
      health: r.health?.status ?? "Unknown",
      message:
        cut(
          r.health?.message,
          120,
          shownProblems.includes(r) ? new Redactor() : redactor,
        ) ?? "",
    }));

  const help: string[] = [];
  if (truncated)
    help.push(
      `Run \`argocd-axi apps view ${name} --full${scope}\` to see untruncated text`,
    );
  if (syncStatus(app) !== "Synced")
    help.push(
      `Run \`argocd-axi apps diff ${name}${scope}\` to see what is out of sync`,
    );
  if (problems.length > 0)
    help.push(
      `Run \`argocd-axi apps resources ${name} --problems${scope}\` for every problem resource`,
    );
  if (healthStatus(app) === "Degraded")
    help.push(
      `Run \`argocd-axi apps logs ${name} --kind <kind> --name <resource>${scope}\` to read logs`,
    );

  return finish(
    [
      encodeObject({ app: redactor.deep(summary) }),
      encodeObject({ sources: redactor.deep(sources) }),
      parameters.length > 0
        ? encodeObject({ helmParameters: redactor.deep(parameters) })
        : undefined,
      ...values.map((v) =>
        renderTextBlock(
          `helmValues (source ${v.source}, ${v.chars} chars)`,
          v.lines,
        ),
      ),
      operation ? encodeObject({ operation }) : undefined,
      conditions.length > 0 ? encodeObject({ conditions }) : undefined,
      encodeObject({
        resources: `${resources.length} total, ${resources.filter((r) => r.status === "OutOfSync").length} OutOfSync, ${resources.filter(isUnhealthy).length} unhealthy`,
      }),
      problems.length > 0
        ? encodeObject({
            problemResources: resourceRows(shownProblems, redactor, cut),
          })
        : undefined,
      problems.length > 20
        ? encodeObject({ problemResourcesShown: `20 of ${problems.length}` })
        : undefined,
      rollouts.length > 0 ? encodeObject({ rollouts }) : undefined,
    ],
    redactor,
    help,
  );
}

function helmValuesText(
  helm: AppSource["helm"],
  redactor: Redactor,
): string | undefined {
  if (!helm) return undefined;
  if (helm.valuesObject !== undefined && helm.valuesObject !== null) {
    return stringify(redactor.deep(helm.valuesObject)).trimEnd();
  }
  if (!helm.values) return undefined;
  try {
    const docs = parseAllDocuments(helm.values);
    if (docs.some((doc) => doc.errors.length > 0))
      throw new Error("unparseable");
    return docs
      .map((doc) => stringify(redactor.deep(doc.toJS())).trimEnd())
      .join("\n---\n");
  } catch {
    return redactor.text(helm.values).trimEnd();
  }
}

function valuesPreview(
  text: string,
  full: boolean,
): { lines: string[]; chars: number; truncated: boolean } {
  const result = preview(text, 800, full);
  return {
    lines: result.text.split("\n"),
    chars: text.length,
    truncated: result.truncated,
  };
}

function resourceRows(
  resources: ResourceStatus[],
  redactor: Redactor,
  cut: (text: string | undefined, max?: number) => string | undefined,
) {
  return redactor.deep(
    resources.map((r) => ({
      kind: r.kind ?? "",
      name: r.name ?? "",
      namespace: r.namespace ?? "",
      sync: r.requiresPruning ? "Prune" : (r.status ?? ""),
      health: r.health?.status ?? "",
      message: cut(r.health?.message, 120) ?? "",
    })),
  );
}

// ---------------------------------------------------------------- apps resources

export const APPS_RESOURCES_SPEC: CommandSpec = {
  path: "apps resources",
  summary:
    "An application's managed resources with sync and health, problems first",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--problems",
      kind: "bool",
      description:
        "Only resources that are out of sync, unhealthy or awaiting prune",
    },
    {
      name: "--orphaned",
      kind: "bool",
      description:
        "List orphaned resources in the destination namespace instead",
    },
    {
      name: "--limit",
      kind: "value",
      valueName: "n",
      description: "Rows to show (default 200)",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps resources guestbook",
    "argocd-axi apps resources guestbook --problems",
    "argocd-axi apps resources guestbook --orphaned",
  ],
};

export async function appsResources(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_RESOURCES_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const limit = getInt(parsed, "--limit", {
    default: 200,
    min: 1,
    max: 10_000,
  });
  const scope = contextSuffix(parsed);
  const redactor = new Redactor();

  if (getBool(parsed, "--orphaned")) {
    if (getBool(parsed, "--problems"))
      throw validationError("--orphaned and --problems cannot be combined");
    const result = await runArgocd("app resources", [name, "--orphaned"], {
      ...contextOption(parsed),
      failure: { notFoundHelp: NOT_FOUND_HELP },
    });
    const rows = parseTable(result.stdout);
    if (
      rows.length > 0 &&
      (rows[0]?.KIND === undefined || rows[0]?.NAME === undefined)
    ) {
      throw axiError(
        "argocd returned an unrecognised resource table",
        CODES.UPSTREAM_ERROR,
        [
          "Check that the argocd CLI version matches the server (`argocd-axi ctx`)",
        ],
      );
    }
    if (rows.length === 0) {
      return finish(
        [encodeObject({ orphaned: `0 orphaned resources found for ${name}` })],
        undefined,
      );
    }
    const shown = rows.slice(0, limit).map((row) => ({
      kind: row.KIND ?? "",
      name: row.NAME ?? "",
      namespace: row.NAMESPACE ?? "",
      group: row.GROUP ?? "",
    }));
    return finish(
      [
        encodeObject({
          count: `${shown.length} of ${rows.length} orphaned`,
          orphaned: redactor.deep(shown),
        }),
      ],
      redactor,
      shown.length < rows.length
        ? [
            `Run \`argocd-axi apps resources ${name} --limit ${rows.length}${carriedFlags(parsed, ["--limit"])}\` to see all`,
          ]
        : [],
    );
  }

  const app = await getApp(name, contextOption(parsed));
  const all = app.status?.resources ?? [];
  const problemsOnly = getBool(parsed, "--problems");
  const problems = all.filter(isResourceProblem);
  const selected = problemsOnly
    ? problems
    : [...problems, ...all.filter((r) => !isResourceProblem(r))];
  if (selected.length === 0) {
    return finish(
      [
        encodeObject({
          resources: problemsOnly
            ? `0 problem resources in ${name} (${all.length} total, all synced and healthy)`
            : `0 resources managed by ${name}`,
        }),
      ],
      undefined,
    );
  }
  const shown = selected.slice(0, limit);
  const cut = (text: string | undefined, max = 120) =>
    text ? truncate(redactor.text(text), max) : undefined;
  const help: string[] = [];
  if (shown.length < selected.length)
    help.push(
      `Run \`argocd-axi apps resources ${name} --limit ${selected.length}${carriedFlags(parsed, ["--limit"])}\` to see all`,
    );
  if (!problemsOnly && problems.length > 0)
    help.push(
      `Run \`argocd-axi apps resources ${name} --problems${scope}\` to see only problems`,
    );
  return finish(
    [
      encodeObject({
        count: `${shown.length} of ${selected.length}${problemsOnly ? " problem" : ""} resources (${problems.length} with problems)`,
        resources: resourceRows(shown, redactor, cut),
      }),
    ],
    redactor,
    help,
  );
}

// ---------------------------------------------------------------- apps diff

export const APPS_DIFF_SPEC: CommandSpec = {
  path: "apps diff",
  summary:
    "What differs between Git and the live cluster, per resource; raw diff text only with --full",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--revision",
      kind: "value",
      valueName: "rev",
      description:
        "Compare the live state with this Git revision instead of the app's target",
    },
    {
      name: "--full",
      kind: "bool",
      description:
        "Also print the raw diff text (secret-looking values redacted)",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps diff guestbook",
    "argocd-axi apps diff guestbook --full",
    "argocd-axi apps diff guestbook --revision main",
  ],
  notes: [
    "Drift is data, not an error: the command exits 0 whether or not anything differs",
  ],
};

const DIFF_HEADER = /^===== (?:(.*)\/)?([^/\s]+) (?:([^/\s]*)\/)?(\S+) ======$/;

export function parseDiffHeaders(
  text: string,
): Array<{ kind: string; name: string; namespace: string }> {
  const rows = [];
  for (const line of text.split("\n")) {
    const match = line.trim().match(DIFF_HEADER);
    if (match)
      rows.push({
        kind: match[2] ?? "",
        name: match[4] ?? "",
        namespace: match[3] ?? "",
      });
  }
  return rows;
}

export async function appsDiff(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_DIFF_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const revision = getString(parsed, "--revision");
  const full = getBool(parsed, "--full");
  const scope = contextSuffix(parsed);
  const redactor = new Redactor();

  if (revision === undefined && !full) {
    const app = await getApp(name, contextOption(parsed));
    const changed = (app.status?.resources ?? []).filter(
      (r) => r.status === "OutOfSync" || r.requiresPruning,
    );
    if (changed.length === 0) {
      return finish(
        [
          encodeObject({
            drift: "no",
            diff: `${name} is ${syncStatus(app)}; no resource differs from Git`,
          }),
        ],
        undefined,
      );
    }
    const rows = changed.map((r) => ({
      kind: r.kind ?? "",
      name: r.name ?? "",
      namespace: r.namespace ?? "",
      change: r.requiresPruning
        ? "prune"
        : r.health?.status === "Missing"
          ? "create"
          : "modify",
    }));
    return finish(
      [
        encodeObject({
          drift: "yes",
          count: `${plural(rows.length, "resource")} ${rows.length === 1 ? "differs" : "differ"}`,
          resources: redactor.deep(rows),
        }),
      ],
      redactor,
      [
        `Run \`argocd-axi apps diff ${name} --full${scope}\` to see the line-level diff`,
      ],
    );
  }

  const argv = [name, "--exit-code=false"];
  if (revision !== undefined) argv.push("--revision", revision);
  const result = await runArgocd("app diff", argv, {
    ...contextOption(parsed),
    failure: { notFoundHelp: NOT_FOUND_HELP },
  });
  const text = result.stdout.replace(/^\s*\n/, "").replace(/\s+$/, "");
  const headers = parseDiffHeaders(text);
  const against = revision === undefined ? "" : ` against revision ${revision}`;
  if (headers.length === 0 && text.trim().length === 0) {
    return finish(
      [
        encodeObject({
          drift: "no",
          diff: `no resource of ${name} differs${against}`,
        }),
      ],
      undefined,
    );
  }
  const blocks = [
    encodeObject({
      drift: "yes",
      count: `${plural(headers.length, "resource")} ${headers.length === 1 ? "differs" : "differ"}${against}`,
      resources: redactor.deep(headers),
    }),
  ];
  if (full) {
    const lines = redactor.text(text).split("\n");
    blocks.push(renderTextBlock("diff", lines));
  }
  return finish(
    blocks,
    redactor,
    full
      ? []
      : [
          `Run \`argocd-axi apps diff ${name}${revision ? ` --revision ${revision}` : ""} --full${scope}\` to see the line-level diff`,
        ],
  );
}

// ---------------------------------------------------------------- apps history

export const APPS_HISTORY_SPEC: CommandSpec = {
  path: "apps history",
  summary:
    "Deployment history, newest first: id, short revision, deployed at, initiated by",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--limit",
      kind: "value",
      valueName: "n",
      description: "Rows to show (default 20)",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps history guestbook",
    "argocd-axi apps history guestbook --limit 5",
  ],
};

export async function appsHistory(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_HISTORY_SPEC, args);
  const name = parsed.positionals[0] as string;
  const limit = getInt(parsed, "--limit", { default: 20, min: 1, max: 1000 });
  const app = await getApp(name, contextOption(parsed));
  const history = [...(app.status?.history ?? [])].sort(
    (a, b) => (b.id ?? 0) - (a.id ?? 0),
  );
  if (history.length === 0) {
    return finish(
      [encodeObject({ history: `0 deployments recorded for ${name}` })],
      undefined,
    );
  }
  const now = Date.now();
  const rows = history.slice(0, limit).map((entry) => ({
    id: entry.id ?? 0,
    revision:
      entry.revisions && entry.revisions.length > 0
        ? entry.revisions.map(shortRevision).join(", ")
        : shortRevision(entry.revision),
    deployed: formatAge(entry.deployedAt, now),
    by: entry.initiatedBy?.automated
      ? "automated"
      : (entry.initiatedBy?.username ?? "unknown"),
  }));
  const current = history[0];
  return finish(
    [
      encodeObject({
        count: `${rows.length} of ${history.length} deployments`,
        current: current?.id,
        history: rows,
      }),
    ],
    undefined,
    rows.length < history.length
      ? [
          `Run \`argocd-axi apps history ${name} --limit ${history.length}${contextSuffix(parsed)}\` to see all`,
        ]
      : [],
  );
}

// ---------------------------------------------------------------- apps manifests

export const APPS_MANIFESTS_SPEC: CommandSpec = {
  path: "apps manifests",
  summary:
    "Rendered manifests as a resource list; YAML only with --full; Secret data always redacted",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--source",
      kind: "value",
      valueName: "git|live",
      description:
        "Manifests rendered from Git (default) or as live in the cluster",
    },
    {
      name: "--revision",
      kind: "value",
      valueName: "rev",
      description: "Render Git manifests at this revision",
    },
    {
      name: "--kind",
      kind: "value",
      valueName: "kind",
      description: "Only resources of this kind, e.g. Deployment",
    },
    { name: "--full", kind: "bool", description: "Print the YAML (redacted)" },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps manifests guestbook",
    "argocd-axi apps manifests guestbook --kind Deployment --full",
    "argocd-axi apps manifests guestbook --source live",
  ],
};

interface ManifestObject {
  kind?: string;
  metadata?: { name?: string; namespace?: string };
}

export async function appsManifests(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_MANIFESTS_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const source = getString(parsed, "--source") ?? "git";
  if (source !== "git" && source !== "live")
    throw validationError(`--source must be git or live, got ${source}`);
  const revision = getString(parsed, "--revision");
  if (revision !== undefined && source === "live")
    throw validationError("--revision only applies to --source git");
  const kind = getString(parsed, "--kind");
  const full = getBool(parsed, "--full");

  const argv = [name, "--source", source];
  if (revision !== undefined) argv.push("--revision", revision);
  const result = await runArgocd("app manifests", argv, {
    ...contextOption(parsed),
    failure: { notFoundHelp: NOT_FOUND_HELP },
  });

  const redactor = new Redactor();
  const docs = parseAllDocuments(result.stdout);
  if (docs.some((doc) => doc.errors.length > 0)) {
    throw axiError(
      "argocd returned manifests that are not valid YAML",
      CODES.UPSTREAM_ERROR,
    );
  }
  const objects = docs
    .map((doc) => doc.toJS() as unknown)
    .filter(
      (obj): obj is ManifestObject => typeof obj === "object" && obj !== null,
    )
    .filter(
      (obj) =>
        kind === undefined || obj.kind?.toLowerCase() === kind.toLowerCase(),
    )
    .map((obj) => redactor.deep(obj));

  if (objects.length === 0) {
    return finish(
      [
        encodeObject({
          manifests: `0 ${kind ? `${kind} ` : ""}manifests rendered for ${name} (source ${source})`,
        }),
      ],
      undefined,
    );
  }
  const rows = objects.map((obj) => ({
    kind: obj.kind ?? "",
    name: obj.metadata?.name ?? "",
    namespace: obj.metadata?.namespace ?? "",
  }));
  const blocks = [
    encodeObject({
      source,
      count: plural(rows.length, "resource"),
      manifests: rows,
    }),
  ];
  const yaml = redactor.text(
    objects.map((obj) => stringify(obj).trimEnd()).join("\n---\n"),
  );
  const yamlPreview = preview(yaml, 800, full);
  blocks.push(renderTextBlock("yaml", yamlPreview.text.split("\n")));
  return finish(
    blocks,
    redactor,
    yamlPreview.truncated
      ? [
          `Run \`argocd-axi apps manifests ${name} --full${carriedFlags(parsed)}\` to see the YAML`,
        ]
      : [],
  );
}

// ---------------------------------------------------------------- apps logs

export const APPS_LOGS_SPEC: CommandSpec = {
  path: "apps logs",
  summary: "Recent logs of an application's pods; never follows",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--kind",
      kind: "value",
      valueName: "kind",
      description: "Resource kind, e.g. Deployment or Pod",
    },
    {
      name: "--name",
      kind: "value",
      valueName: "name",
      description: "Resource name",
    },
    {
      name: "--tail",
      kind: "value",
      valueName: "n",
      description: "Lines from the end (default 100, max 5000)",
    },
    {
      name: "--since",
      kind: "value",
      valueName: "duration",
      description: "Only lines newer than this, e.g. 15m or 2h",
    },
    {
      name: "--filter",
      kind: "value",
      valueName: "text",
      description: "Only lines containing this text",
    },
    {
      name: "--full",
      kind: "bool",
      description:
        "Return requested lines up to 5000, capped at 1,000,000 characters after redaction",
    },
    {
      name: "--previous",
      short: "-p",
      kind: "bool",
      description: "Logs of the previous, terminated container",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps logs guestbook",
    "argocd-axi apps logs guestbook --kind Deployment --name guestbook-ui --since 15m",
    "argocd-axi apps logs guestbook --filter error -p",
  ],
  notes: [
    `Output keeps the newest lines and is capped at ${LOG_CHAR_CAP} characters; --full returns up to 5000 requested lines, capped at ${FULL_LOG_CHAR_CAP} characters after redaction; secret-looking values are redacted on a best-effort basis`,
  ],
};

export async function appsLogs(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_LOGS_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const tail = getInt(parsed, "--tail", { default: 100, min: 1, max: 5000 });
  const argv = [name, "--tail", String(tail)];
  const since = getString(parsed, "--since");
  if (since !== undefined)
    argv.push(
      "--since-seconds",
      String(parseDurationSeconds("--since", since)),
    );
  const kind = getString(parsed, "--kind");
  if (kind !== undefined) argv.push("--kind", kind);
  const resource = getString(parsed, "--name");
  if (resource !== undefined) argv.push("--name", resource);
  const filter = getString(parsed, "--filter");
  if (filter !== undefined) argv.push("--filter", filter);
  if (getBool(parsed, "--previous")) argv.push("--previous");

  const result = await runArgocd("app logs", argv, {
    ...contextOption(parsed),
    failure: { notFoundHelp: NOT_FOUND_HELP },
  });
  const full = getBool(parsed, "--full");
  const lines = result.stdout.split("\n");
  if (lines.at(-1) === "") lines.pop();
  if (lines.length === 0) {
    return finish(
      [
        encodeObject({
          logs: `0 log lines returned for ${name}${since ? ` in the last ${since}` : ""}${filter ? ` matching ${JSON.stringify(filter)}` : ""}`,
        }),
      ],
      undefined,
    );
  }
  const redactor = new Redactor();
  const redacted = lines.map((line) => redactor.text(line));
  const charCap = full ? FULL_LOG_CHAR_CAP : LOG_CHAR_CAP;
  const kept: string[] = [];
  let chars = 0;
  let charLimitCut = false;
  let lineCut = false;
  let cutLineChars = 0;
  for (let i = redacted.length - 1; i >= 0; i--) {
    const line = redacted[i] as string;
    if (kept.length >= tail) break;
    if (chars + line.length + 1 > charCap) {
      charLimitCut = true;
      if (kept.length === 0) {
        kept.unshift(line.slice(-charCap));
        lineCut = true;
        cutLineChars = line.length;
      }
      break;
    }
    kept.unshift(line);
    chars += line.length + 1;
  }
  const lineLimitCut = redacted.length > tail;
  const omittedByCharCap = charLimitCut
    ? Math.max(0, Math.min(tail, redacted.length) - kept.length)
    : 0;
  const cutNote = lineCut
    ? ` and only the last ${charCap} of the newest line's ${cutLineChars} chars`
    : "";
  const header = lineLimitCut
    ? `showing the newest ${kept.length} of ${redacted.length} merged lines (--tail ${tail} limit)`
    : charLimitCut
      ? `showing the newest ${kept.length} of ${redacted.length} lines (output capped at ${charCap} chars)${cutNote}`
      : `${kept.length} lines (--tail ${tail})`;
  const logHeader = charLimitCut
    ? [
        header,
        `${plural(omittedByCharCap, "requested line")} omitted by the ${charCap}-character cap`,
        ...(lineCut
          ? [`${cutLineChars - charCap} chars omitted from the newest line`]
          : []),
      ].join("; ")
    : header;
  const help: string[] = [];
  const carried = carriedFlags(parsed, ["--tail", "--full", "--filter"]);
  if (lineLimitCut && tail < 5000)
    help.push(
      `Run \`argocd-axi apps logs ${name} --tail 5000 --full${carried}\` to read more merged lines${filter ? "; reapply --filter manually if needed" : ""}`,
    );
  else if (lineLimitCut)
    help.push("The --tail limit is 5000 lines; no larger tail is supported");
  if (charLimitCut)
    help.push(
      full
        ? `The --full output reached its ${FULL_LOG_CHAR_CAP}-character cap; narrow with --tail, --since, --kind, or --name${filter ? "; reapply --filter manually if needed" : ""}`
        : tail >= 5000
          ? `The --full output is capped at ${FULL_LOG_CHAR_CAP} characters; narrow with --since, --kind, or --name${filter ? "; reapply --filter manually if needed" : ""}`
          : `Run \`argocd-axi apps logs ${name} --full${carriedFlags(parsed, ["--full", "--filter"])}\` to see all requested lines (up to ${FULL_LOG_CHAR_CAP} characters); narrow with --tail, --since, --kind, or --name if needed${filter ? "; reapply --filter manually if needed" : ""}`,
    );
  return finish(
    [encodeObject({ logs: logHeader }), renderTextBlock("lines", kept)],
    redactor,
    help,
  );
}

// ---------------------------------------------------------------- apps wait

export const APPS_WAIT_SPEC: CommandSpec = {
  path: "apps wait",
  summary:
    "Wait, bounded, until the app is synced, healthy and its operation done; returns the state either way",
  positionals: [APP_ARG],
  flags: [
    { name: "--sync", kind: "bool", description: "Wait for Synced" },
    { name: "--health", kind: "bool", description: "Wait for Healthy" },
    {
      name: "--operation",
      kind: "bool",
      description: "Wait for the running operation to finish",
    },
    {
      name: "--timeout",
      kind: "value",
      valueName: "seconds",
      description: "Give up after this many seconds (default 120, max 600)",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps wait guestbook",
    "argocd-axi apps wait guestbook --health --timeout 300",
  ],
  notes: [
    "With no condition flags it waits for sync, health and operation together, like argocd",
    "A timeout is not an error: the current state is returned with a hint to wait again",
  ],
};

const WAIT_GRACE_MS = 15_000;

export async function appsWait(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_WAIT_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const timeout = getInt(parsed, "--timeout", {
    default: 120,
    min: 1,
    max: 600,
  });
  const conditions = ["--sync", "--health", "--operation"].filter((flag) =>
    getBool(parsed, flag),
  );
  const options = contextOption(parsed);
  const started = Date.now();

  let met = false;
  try {
    const result = await runArgocd(
      "app wait",
      [name, ...conditions, "--timeout", String(timeout)],
      {
        ...options,
        timeoutMs: timeout * 1000 + WAIT_GRACE_MS,
        allowFailure: true,
        failure: { notFoundHelp: NOT_FOUND_HELP },
      },
    );
    if (result.exitCode === 0) {
      met = true;
    } else if (!/timed out|deadline exceeded/i.test(result.stderr)) {
      throw mapArgocdFailure(result.stderr || result.stdout, {
        notFoundHelp: NOT_FOUND_HELP,
      });
    }
  } catch (error) {
    // The seam's own hard timeout is a timed-out wait, not an error.
    if (!(error instanceof AxiError && error.code === CODES.TIMEOUT))
      throw error;
  }

  const elapsed = Math.round((Date.now() - started) / 1000);
  const app = await getApp(name, options);
  const redactor = new Redactor();
  const waited =
    conditions.length > 0
      ? conditions.map((c) => c.slice(2)).join(", ")
      : "sync, health, operation";
  const state = {
    name: appName(app),
    sync: syncStatus(app),
    health: healthStatus(app),
    operation: app.status?.operationState?.phase ?? "none",
  };
  return finish(
    [
      encodeObject({
        wait: met
          ? `condition met (${waited}) after ${elapsed}s`
          : `timed out after ${timeout}s; condition not met (${waited})`,
        app: state,
        attention:
          attentionReasons(app, Date.now(), redactor).join("; ") || "none",
      }),
    ],
    redactor,
    met
      ? []
      : [
          `Run \`argocd-axi apps wait ${name}${conditions.map((c) => ` ${c}`).join("")} --timeout ${timeout}${contextSuffix(parsed)}\` to wait again`,
        ],
  );
}

// ---------------------------------------------------------------- apps sync

export const APPS_SYNC_SPEC: CommandSpec = {
  path: "apps sync",
  summary: "Preview and optionally sync one Application",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--confirm",
      kind: "bool",
      description: "Execute the sync after preview",
    },
    {
      name: "--prune",
      kind: "bool",
      description: "Allow pruning resources in the sync",
    },
    {
      name: "--timeout",
      kind: "value",
      valueName: "s",
      description: "Maximum wait in seconds (default 120)",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps sync guestbook --context staging",
    "argocd-axi apps sync guestbook --context staging --confirm",
  ],
  notes: [
    "Never prunes unless --prune is given; requires the context in writable-contexts to execute",
  ],
};

export async function appsSync(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_SYNC_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const context = getString(parsed, "--context");
  const confirm = getBool(parsed, "--confirm");
  const prune = getBool(parsed, "--prune");
  const timeout = getInt(parsed, "--timeout", {
    default: 120,
    min: 1,
    max: 3600,
  });
  const gate = evaluateWriteGate(
    {
      command: "apps sync",
      context,
      execute: confirm,
      executeFlag: "--confirm",
    },
    loadConfig().config,
  );
  const options = { context: gate.context };
  const diff = await appsDiff([name, "--context", gate.context]);
  const app = await getApp(name, options);
  const project = validateName("project", app.spec?.project ?? "default");
  const windows =
    (await argocdJson<SyncWindow[] | null>(
      "proj windows list",
      [project, "-o", "json"],
      options,
    )) ?? [];
  const preview = [diff, encodeObject({ syncWindows: windows })];
  if (!confirm)
    return finish(preview, undefined, [
      "No changes made; add --confirm to sync",
      ...(gate.mode === "preview" ? gate.help : []),
    ]);
  const permission = await runArgocd(
    "account can-i",
    ["sync", "applications", `${app.spec?.project ?? "default"}/${name}`],
    { ...options, allowFailure: true },
  );
  if (permission.exitCode !== 0 || !/^yes\s*$/i.test(permission.stdout.trim()))
    throw axiError(
      `REFUSED: Argo CD RBAC denies sync for ${name}`,
      CODES.REFUSED,
    );
  const syncArgs = [name, "--async", "--info", "initiated-by=argocd-axi"];
  if (prune) syncArgs.push("--prune");
  try {
    await runArgocd("app sync", syncArgs, options);
  } catch (error) {
    if (
      error instanceof AxiError &&
      /sync.?window|operation.*(?:running|progress|active)|(?:running|progress).*operation/i.test(
        error.message,
      )
    )
      throw axiError(`REFUSED: ${error.message}`, CODES.REFUSED);
    throw error;
  }
  let waitTimedOut = false;
  let waitError: string | undefined;
  try {
    const wait = await runArgocd(
      "app wait",
      [name, "--operation", "--timeout", String(timeout)],
      { ...options, allowFailure: true, timeoutMs: (timeout + 10) * 1000 },
    );
    if (wait.exitCode !== 0) {
      const message =
        wait.stderr.trim() || wait.stdout.trim() || "app wait failed";
      if (/timed out|deadline exceeded/i.test(message)) waitTimedOut = true;
      else waitError = message;
    }
  } catch (error) {
    if (!(error instanceof AxiError && error.code === CODES.TIMEOUT))
      throw error;
    waitTimedOut = true;
  }
  const result = await getApp(name, options);
  const phase = result.status?.operationState?.phase;
  const syncResult =
    phase === "Succeeded"
      ? "complete"
      : phase === "Failed" || phase === "Error"
        ? "failed"
        : phase === "Running" && waitTimedOut
          ? "timeout"
          : "error";
  return finish(
    [
      ...preview,
      encodeObject({
        sync: syncResult,
        ...(syncResult === "error"
          ? {
              error:
                waitError ??
                result.status?.operationState?.message ??
                `app wait ended with operation phase ${phase ?? "unknown"}`,
            }
          : {}),
        revision: syncRevision(result),
        health: healthStatus(result),
        failedResources: (result.status?.resources ?? [])
          .filter(
            (r) => r.status === "SyncFailed" || r.health?.status === "Degraded",
          )
          .map((r) => ({
            kind: r.kind ?? "",
            name: r.name ?? "",
            message: r.health?.message ?? r.status ?? "failed",
          })),
      }),
    ],
    undefined,
  );
}

// ---------------------------------------------------------------- apps actions

export const APPS_ACTIONS_SPEC: CommandSpec = {
  path: "apps actions",
  summary:
    "Resource actions available on an application's resources (restart, Rollout promote, ...)",
  positionals: [APP_ARG],
  flags: [
    {
      name: "--kind",
      kind: "value",
      valueName: "kind",
      description: "Only resources of this kind",
    },
    CONTEXT_FLAG,
  ],
  examples: [
    "argocd-axi apps actions guestbook",
    "argocd-axi apps actions guestbook --kind Rollout",
  ],
  notes: [
    "Running an action is planned for a later write tier; this command only lists them",
  ],
};

function pick(record: Record<string, unknown>, key: string): unknown {
  const found = Object.keys(record).find((k) => k.toLowerCase() === key);
  return found === undefined ? undefined : record[found];
}

export async function appsActions(args: string[]): Promise<string> {
  if (args[0] === "run") refuseActionRun();
  const parsed = parseArgs(APPS_ACTIONS_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const argv = [name, "-o", "json"];
  const kind = getString(parsed, "--kind");
  if (kind !== undefined) argv.push("--kind", kind);
  const raw =
    (await argocdJson<Array<Record<string, unknown>> | null>(
      "app actions list",
      argv,
      {
        ...contextOption(parsed),
        failure: { notFoundHelp: NOT_FOUND_HELP },
      },
    )) ?? [];
  if (raw.length === 0) {
    return finish(
      [
        encodeObject({
          actions: `0 resource actions available on ${name}${kind ? ` for kind ${kind}` : ""}`,
        }),
      ],
      undefined,
    );
  }
  const rows = raw.map((entry) => ({
    kind: String(pick(entry, "kind") ?? ""),
    name: String(pick(entry, "name") ?? ""),
    action: String(pick(entry, "action") ?? ""),
    disabled: pick(entry, "disabled") === true ? "yes" : "no",
  }));
  return finish(
    [encodeObject({ count: plural(rows.length, "action"), actions: rows })],
    undefined,
  );
}

function refuseActionRun(): never {
  throw axiError(
    "running resource actions is planned for the write tier, behind preview-by-default and the writable-contexts allowlist; not in v1 (see ROADMAP.md)",
    CODES.REFUSED,
    [
      "A human can run one with the raw CLI: `argocd app actions run <app> <action> --kind <kind>`",
    ],
  );
}

// ---------------------------------------------------------------- app writes

function writeSpec(
  path: string,
  summary: string,
  positionals: CommandSpec["positionals"],
): CommandSpec {
  return {
    path,
    summary,
    positionals,
    flags: [
      { name: "--confirm", kind: "bool", description: "Execute after preview" },
      {
        name: "--timeout",
        kind: "value",
        valueName: "s",
        description: "Maximum wait in seconds (default 120)",
      },
      ...(path === "apps refresh"
        ? [
            {
              name: "--hard",
              kind: "bool" as const,
              description: "Hard refresh, bypassing the cache",
            },
          ]
        : []),
      CONTEXT_FLAG,
    ],
    examples: [
      `argocd-axi ${path} ${path === "apps rollback" ? "guestbook 3" : "guestbook"} --context staging`,
    ],
  };
}

const WRITE_TIMEOUT = { default: 120, min: 1, max: 3600 } as const;

async function checkWritePermission(
  action: string,
  app: Application,
  name: string,
  options: { context?: string },
): Promise<void> {
  const permission = await runArgocd(
    "account can-i",
    [action, "applications", `${app.spec?.project ?? "default"}/${name}`],
    { ...options, allowFailure: true },
  );
  if (permission.exitCode !== 0 || !/^yes\s*$/i.test(permission.stdout.trim()))
    throw axiError(
      `REFUSED: Argo CD RBAC denies ${action} for ${name}`,
      CODES.REFUSED,
    );
}

async function runApplicationWrite(
  op: "app rollback" | "app terminate-op" | "app refresh",
  args: string[],
  options: { context?: string },
  name: string,
): Promise<void> {
  try {
    await runArgocd(op, args, options);
  } catch (error) {
    if (error instanceof AxiError && error.code === CODES.FORBIDDEN)
      throw axiError(
        `REFUSED: Argo CD RBAC denied ${op.slice(4)} for ${name}`,
        CODES.REFUSED,
      );
    throw error;
  }
}

function writeOutcome(
  phase: string | undefined,
  timedOut: boolean,
  completed: string,
): string {
  if (phase === "Failed" || phase === "Error") return "failed";
  return timedOut ? "waiting" : completed;
}

async function waitForWrite(
  name: string,
  timeout: number,
  options: { context?: string },
): Promise<{ app: Application; timedOut: boolean }> {
  try {
    const result = await runArgocd(
      "app wait",
      [name, "--operation", "--timeout", String(timeout)],
      { ...options, allowFailure: true, timeoutMs: (timeout + 10) * 1000 },
    );
    if (result.exitCode !== 0) {
      const failure = mapArgocdFailure(result.stderr || result.stdout);
      if (!/timed? out|timeout/i.test(failure.message)) throw failure;
      return { app: await getApp(name, options), timedOut: true };
    }
    return { app: await getApp(name, options), timedOut: false };
  } catch (error) {
    if (!(error instanceof AxiError) || error.code !== CODES.TIMEOUT) throw error;
    return { app: await getApp(name, options), timedOut: true };
  }
}

const APPS_ROLLBACK_SPEC = writeSpec(
  "apps rollback",
  "Preview and optionally roll back one Application",
  [
    APP_ARG,
    {
      name: "history-id",
      required: true,
      description: "Deployment history id",
    },
  ],
);
export async function appsRollback(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_ROLLBACK_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const historyId = parsed.positionals[1] as string;
  if (!/^\d+$/.test(historyId))
    throw validationError("history-id must be a non-negative decimal integer");
  const id = Number(historyId);
  if (!Number.isSafeInteger(id) || id < 0)
    throw validationError("history-id must be a non-negative integer");
  const context = getString(parsed, "--context"),
    confirm = getBool(parsed, "--confirm"),
    timeout = getInt(parsed, "--timeout", WRITE_TIMEOUT);
  const gate = evaluateWriteGate(
    {
      command: "apps rollback",
      context,
      execute: confirm,
      executeFlag: "--confirm",
    },
    loadConfig().config,
  );
  const options = { context: gate.context },
    app = await getApp(name, options);
  const history = app.status?.history?.find((entry) => entry.id === id);
  if (!history)
    throw axiError(
      `REFUSED: history id ${id} not found for ${name}`,
      CODES.REFUSED,
    );
  if (autoSyncSummary(app) !== "manual")
    throw axiError(
      `REFUSED: disable auto-sync before rolling back ${name}`,
      CODES.REFUSED,
    );
  const target = history.revisions?.join(", ") ?? history.revision ?? "unknown";
  const previewBlocks = [
    encodeObject({
      rollback: name,
      currentRevision: syncRevision(app),
      targetHistoryId: id,
      targetRevision: target,
    }),
  ];
  if (!confirm)
    return finish(previewBlocks, undefined, [
      "No changes made; add --confirm to roll back",
      ...(gate.mode === "preview" ? gate.help : []),
    ]);
  await checkWritePermission("sync", app, name, options);
  await runApplicationWrite(
    "app rollback",
    [name, String(id), "--info", "initiated-by=argocd-axi"],
    options,
    name,
  );
  const current = await waitForWrite(name, timeout, options);
  const outcome = writeOutcome(
    current.app.status?.operationState?.phase,
    current.timedOut,
    "submitted",
  );
  return finish(
    [
      ...previewBlocks,
      encodeObject({
        rollback: outcome,
        historyId: id,
        phase: current.app.status?.operationState?.phase,
        operation: current.app.status?.operationState,
      }),
    ],
    undefined,
    outcome === "waiting" ? ["Wait again with `apps wait`"] : [],
  );
}

const APPS_REFRESH_SPEC = writeSpec(
  "apps refresh",
  "Preview and optionally refresh one Application",
  [APP_ARG],
);
export async function appsRefresh(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_REFRESH_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const context = getString(parsed, "--context"),
    confirm = getBool(parsed, "--confirm"),
    hard = getBool(parsed, "--hard"),
    timeout = getInt(parsed, "--timeout", WRITE_TIMEOUT);
  const gate = evaluateWriteGate(
    {
      command: "apps refresh",
      context,
      execute: confirm,
      executeFlag: "--confirm",
    },
    loadConfig().config,
  );
  const options = { context: gate.context },
    app = await getApp(name, options);
  const blocks = [
    encodeObject({
      refresh: name,
      mode: hard ? "hard" : "normal",
      reRead: hard ? "live state and source caches" : "live state",
    }),
  ];
  if (!confirm)
    return finish(blocks, undefined, [
      "No changes made; add --confirm to refresh",
      ...(gate.mode === "preview" ? gate.help : []),
    ]);
  await checkWritePermission("update", app, name, options);
  await runApplicationWrite(
    "app refresh",
    [name, hard ? "--hard-refresh" : "--refresh"],
    options,
    name,
  );
  const current = await waitForWrite(name, timeout, options);
  const outcome = writeOutcome(
    current.app.status?.operationState?.phase,
    current.timedOut,
    "complete",
  );
  return finish(
    [
      ...blocks,
      encodeObject({
        refresh: outcome,
        phase: current.app.status?.operationState?.phase,
        operation: current.app.status?.operationState,
      }),
    ],
    undefined,
    outcome === "waiting" ? ["Wait again with `apps wait`"] : [],
  );
}

const APPS_TERMINATE_SPEC = writeSpec(
  "apps terminate-op",
  "Preview and optionally terminate one running operation",
  [APP_ARG],
);
export async function appsTerminateOp(args: string[]): Promise<string> {
  const parsed = parseArgs(APPS_TERMINATE_SPEC, args);
  const name = validateName("app", parsed.positionals[0] as string);
  const context = getString(parsed, "--context"),
    confirm = getBool(parsed, "--confirm"),
    timeout = getInt(parsed, "--timeout", WRITE_TIMEOUT);
  const gate = evaluateWriteGate(
    {
      command: "apps terminate-op",
      context,
      execute: confirm,
      executeFlag: "--confirm",
    },
    loadConfig().config,
  );
  const options = { context: gate.context },
    app = await getApp(name, options),
    phase = app.status?.operationState?.phase;
  if (!isOperationRunning(app))
    return finish(
      [encodeObject({ terminateOperation: name, status: "no operation running" })],
      undefined,
    );
  const blocks = [
    encodeObject({
      terminateOperation: name,
      phase,
      startedAt: app.status?.operationState?.startedAt,
      message: app.status?.operationState?.message,
    }),
  ];
  if (!confirm)
    return finish(blocks, undefined, [
      "No changes made; add --confirm to terminate the operation",
      ...(gate.mode === "preview" ? gate.help : []),
    ]);
  await checkWritePermission("update", app, name, options);
  await runApplicationWrite("app terminate-op", [name], options, name);
  const current = await waitForWrite(name, timeout, options);
  const outcome = writeOutcome(
    current.app.status?.operationState?.phase,
    current.timedOut,
    "submitted",
  );
  return finish(
    [
      ...blocks,
      encodeObject({
        terminateOperation: outcome,
        phase: current.app.status?.operationState?.phase,
        operation: current.app.status?.operationState,
      }),
    ],
    undefined,
    outcome === "waiting" ? ["Wait again with `apps wait`"] : [],
  );
}

// ---------------------------------------------------------------- dispatcher

const SUBCOMMANDS: Record<string, Subcommand> = {
  view: { spec: APPS_VIEW_SPEC, run: appsView },
  resources: { spec: APPS_RESOURCES_SPEC, run: appsResources },
  diff: { spec: APPS_DIFF_SPEC, run: appsDiff },
  history: { spec: APPS_HISTORY_SPEC, run: appsHistory },
  manifests: { spec: APPS_MANIFESTS_SPEC, run: appsManifests },
  logs: { spec: APPS_LOGS_SPEC, run: appsLogs },
  wait: { spec: APPS_WAIT_SPEC, run: appsWait },
  actions: { spec: APPS_ACTIONS_SPEC, run: appsActions },
  sync: { spec: APPS_SYNC_SPEC, run: appsSync },
  rollback: { spec: APPS_ROLLBACK_SPEC, run: appsRollback },
  refresh: { spec: APPS_REFRESH_SPEC, run: appsRefresh },
  "terminate-op": { spec: APPS_TERMINATE_SPEC, run: appsTerminateOp },
};

export const APPS_SPECS = [
  APPS_LIST_SPEC,
  ...Object.values(SUBCOMMANDS).map((s) => s.spec),
];

export async function appsCommand(args: string[]): Promise<string> {
  return dispatch("apps", args, SUBCOMMANDS, {
    spec: APPS_LIST_SPEC,
    run: appsList,
  });
}
