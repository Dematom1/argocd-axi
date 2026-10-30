/**
 * Argo CD Application shapes (the subset argocd-axi reads from
 * `argocd app get|list -o json`) and the derived state agents need.
 */

import { Redactor } from "./redact.js";

export interface AppSource {
  repoURL?: string;
  path?: string;
  chart?: string;
  targetRevision?: string;
  ref?: string;
  name?: string;
  helm?: {
    parameters?: Array<{ name?: string; value?: string }>;
    values?: string;
    valuesObject?: unknown;
    valueFiles?: string[];
  };
}

export interface ResourceStatus {
  group?: string;
  version?: string;
  kind?: string;
  namespace?: string;
  name?: string;
  status?: string;
  health?: { status?: string; message?: string };
  requiresPruning?: boolean;
  hook?: boolean;
}

export interface HistoryEntry {
  id?: number;
  revision?: string;
  revisions?: string[];
  deployedAt?: string;
  deployStartedAt?: string;
  initiatedBy?: { username?: string; automated?: boolean };
}

export interface OperationState {
  phase?: string;
  message?: string;
  startedAt?: string;
  finishedAt?: string;
  operation?: { initiatedBy?: { username?: string; automated?: boolean } };
  syncResult?: { revision?: string; revisions?: string[] };
}

export interface Application {
  metadata?: {
    name?: string;
    namespace?: string;
    labels?: Record<string, string>;
    creationTimestamp?: string;
  };
  spec?: {
    project?: string;
    source?: AppSource;
    sources?: AppSource[];
    destination?: { server?: string; name?: string; namespace?: string };
    syncPolicy?: {
      automated?: { prune?: boolean; selfHeal?: boolean; enabled?: boolean };
    };
  };
  status?: {
    sync?: { status?: string; revision?: string; revisions?: string[] };
    health?: { status?: string; message?: string; lastTransitionTime?: string };
    operationState?: OperationState;
    conditions?: Array<{
      type?: string;
      message?: string;
      lastTransitionTime?: string;
    }>;
    resources?: ResourceStatus[];
    history?: HistoryEntry[];
    reconciledAt?: string;
  };
  operation?: unknown;
}

/**
 * Decision A6: an app that has been Progressing for longer than this many
 * minutes needs attention. Shorter Progressing spells, and those whose start
 * (health.lastTransitionTime) is unknown, are shown on both axes but not
 * counted, so a normal rollout does not look like a problem.
 */
export const PROGRESSING_ATTENTION_MINUTES = 10;

const REASON_CHARS = 80;

/** `1 window`, `3 windows`. */
export function plural(
  count: number,
  singular: string,
  pluralForm = `${singular}s`,
): string {
  return `${count} ${count === 1 ? singular : pluralForm}`;
}

export function truncate(text: string, max: number): string {
  const flat = text.replace(/\s+/g, " ").trim();
  return flat.length <= max ? flat : `${flat.slice(0, max - 3)}...`;
}

export function appName(app: Application): string {
  return app.metadata?.name ?? "unknown";
}

export function syncStatus(app: Application): string {
  return app.status?.sync?.status ?? "Unknown";
}

export function healthStatus(app: Application): string {
  return app.status?.health?.status ?? "Unknown";
}

export function operationPhase(app: Application): string | undefined {
  return app.status?.operationState?.phase;
}

export function isOperationRunning(app: Application): boolean {
  const phase = operationPhase(app);
  return (
    phase === "Running" || phase === "Terminating" || Boolean(app.operation)
  );
}

export function minutesSince(
  iso: string | undefined,
  now: number,
): number | undefined {
  if (!iso) return undefined;
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return undefined;
  return Math.max(0, Math.floor((now - then) / 60_000));
}

export function formatAge(
  iso: string | undefined,
  now: number = Date.now(),
): string {
  const minutes = minutesSince(iso, now);
  if (minutes === undefined) return "unknown";
  if (minutes < 1) return "just now";
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 48) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}

function formatMinutes(minutes: number): string {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  return hours < 48 ? `${hours}h` : `${Math.floor(hours / 24)}d`;
}

/**
 * Why an app needs attention (empty when it does not), per decision A6.
 * Messages are redacted before they are cut, counted on `redactor`.
 */
function* attentionReasonTexts(
  app: Application,
  now: number,
  redactor: Redactor,
): Generator<string> {
  const redact = (text: string) => redactor.text(text);
  const sync = syncStatus(app);
  if (sync === "OutOfSync") yield "OutOfSync";
  else if (sync !== "Synced") yield `sync ${sync}`;

  const health = healthStatus(app);
  const healthMessage = app.status?.health?.message;
  if (health === "Degraded" || health === "Missing" || health === "Unknown") {
    const label = health === "Unknown" ? "health Unknown" : health;
    yield healthMessage ? `${label}: ${redact(healthMessage)}` : label;
  } else if (health === "Progressing") {
    const minutes = minutesSince(app.status?.health?.lastTransitionTime, now);
    if (minutes !== undefined && minutes > PROGRESSING_ATTENTION_MINUTES) {
      yield `Progressing for ${formatMinutes(minutes)}`;
    }
  }

  const op = app.status?.operationState;
  if (op?.phase === "Failed" || op?.phase === "Error") {
    yield op.message
      ? `last sync ${op.phase}: ${redact(op.message)}`
      : `last sync ${op.phase}`;
  }

  for (const condition of app.status?.conditions ?? []) {
    yield condition.message
      ? `${condition.type ?? "Condition"}: ${redact(condition.message)}`
      : (condition.type ?? "Condition");
  }
}

export function attentionReasons(
  app: Application,
  now: number = Date.now(),
  redactor: Redactor = new Redactor(),
): string[] {
  return Array.from(attentionReasonTexts(app, now, redactor), (reason) =>
    truncate(reason, REASON_CHARS),
  );
}

export function attentionReasonPreview(
  app: Application,
  max: number,
  now: number = Date.now(),
  redactor: Redactor = new Redactor(),
): { text: string; totalChars: number } {
  let text = "";
  let totalChars = 0;
  for (const reason of attentionReasonTexts(app, now, redactor)) {
    if (totalChars > 0) {
      if (text.length < max) text += "; ".slice(0, max - text.length);
      totalChars += 2;
    }
    if (text.length < max) text += reason.slice(0, max - text.length);
    totalChars += reason.length;
  }
  return { text, totalChars };
}

export function needsAttention(
  app: Application,
  now: number = Date.now(),
): boolean {
  return attentionReasons(app, now).length > 0;
}

export function shortRevision(revision: string | undefined): string {
  if (!revision) return "";
  return /^[0-9a-f]{40}$/.test(revision) ? revision.slice(0, 7) : revision;
}

export function appSources(app: Application): AppSource[] {
  if (app.spec?.sources && app.spec.sources.length > 0) return app.spec.sources;
  return app.spec?.source ? [app.spec.source] : [];
}

export function syncRevision(app: Application): string {
  const sync = app.status?.sync;
  if (sync?.revisions && sync.revisions.length > 0) {
    return sync.revisions.map(shortRevision).join(", ");
  }
  return shortRevision(sync?.revision);
}

export function autoSyncSummary(app: Application): string {
  const automated = app.spec?.syncPolicy?.automated;
  if (!automated || automated.enabled === false) return "manual";
  const options = [
    automated.prune ? "prune" : "",
    automated.selfHeal ? "self-heal" : "",
  ].filter(Boolean);
  return options.length > 0 ? `automated (${options.join(", ")})` : "automated";
}

export function destinationSummary(app: Application): string {
  const dest = app.spec?.destination;
  const cluster = dest?.name ?? dest?.server ?? "unknown";
  return dest?.namespace ? `${cluster} ns/${dest.namespace}` : cluster;
}

/**
 * Display names for a set of apps: bare names when every app lives in one
 * namespace, `namespace/name` for all of them otherwise (decision A9).
 */
export function displayNames(
  apps: Application[],
): (app: Application) => string {
  const namespaces = new Set(apps.map((app) => app.metadata?.namespace ?? ""));
  if (namespaces.size <= 1) return appName;
  return (app) => {
    const namespace = app.metadata?.namespace;
    return namespace ? `${namespace}/${appName(app)}` : appName(app);
  };
}

const HEALTH_RANK: Record<string, number> = {
  Missing: 0,
  Degraded: 1,
  Unknown: 2,
  Progressing: 3,
  Suspended: 4,
  Healthy: 5,
};

/** Problems first, then by name. */
export function sortApps(
  apps: Application[],
  now: number = Date.now(),
): Application[] {
  return [...apps].sort((a, b) => {
    const attention =
      Number(needsAttention(b, now)) - Number(needsAttention(a, now));
    if (attention !== 0) return attention;
    const rank =
      (HEALTH_RANK[healthStatus(a)] ?? 2) - (HEALTH_RANK[healthStatus(b)] ?? 2);
    if (rank !== 0) return rank;
    return appName(a).localeCompare(appName(b));
  });
}

export function resourceId(resource: ResourceStatus): string {
  return `${resource.kind ?? "?"}/${resource.name ?? "?"}`;
}

/** Suspended (a paused Rollout or CronJob) is a state, not a problem. */
export function isUnhealthy(resource: ResourceStatus): boolean {
  const health = resource.health?.status;
  return health !== undefined && health !== "Healthy" && health !== "Suspended";
}

export function isResourceProblem(resource: ResourceStatus): boolean {
  return (
    (resource.status !== undefined && resource.status !== "Synced") ||
    isUnhealthy(resource) ||
    resource.requiresPruning === true
  );
}
