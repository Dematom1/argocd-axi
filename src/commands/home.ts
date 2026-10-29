import { argocdJson } from "../argocd.js";
import { describeTarget, resolveTarget } from "../context.js";
import { LOGIN_HELP } from "../errors.js";
import {
  attentionReasons,
  displayNames,
  healthStatus,
  isOperationRunning,
  needsAttention,
  sortApps,
  syncStatus,
  truncate,
  formatAge,
  type Application,
} from "../model.js";
import { Redactor } from "../redact.js";
import { refreshVersionCheck } from "../skew.js";
import { encodeObject } from "../toon.js";
import { finish } from "./common.js";
import { versionSummary, writableLine } from "./ctx.js";

const ATTENTION_ROWS = 10;
const OPERATION_ROWS = 5;

function unavailable(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return `unavailable - ${message}`;
}

/**
 * Content-first home view (AXI principle 8, decision A-c1): the target,
 * the user, apps needing attention with the reason, and running operations.
 * Each server read degrades to `unavailable - reason` instead of failing.
 */
export async function homeCommand(): Promise<string> {
  const { target, listing } = await resolveTarget(undefined);
  const where = describeTarget(target, listing);

  if (!target.context && !target.envServer) {
    return finish(
      [
        encodeObject({
          ...where,
          writableContexts: writableLine(),
          contexts: listing.unavailable
            ? `unavailable - ${listing.unavailable}`
            : undefined,
        }),
      ],
      undefined,
      [...LOGIN_HELP, "Run `argocd-axi ctx` to see configured contexts"],
    );
  }

  const [apps, user, check] = await Promise.allSettled([
    argocdJson<Application[] | null>("app list", ["-o", "json"]),
    argocdJson<{ loggedIn?: boolean; username?: string }>(
      "account get-user-info",
      ["-o", "json"],
    ),
    target.context
      ? refreshVersionCheck(target.context, target.server)
      : Promise.resolve(undefined),
  ]);

  const now = Date.now();
  const redactor = new Redactor();
  const blocks: Array<string | undefined> = [];
  const help: string[] = [];

  const userLine =
    user.status === "fulfilled"
      ? user.value.loggedIn
        ? (user.value.username ?? "unknown")
        : "not logged in"
      : unavailable(user.reason);
  if (user.status === "fulfilled" && !user.value.loggedIn)
    help.push(...LOGIN_HELP);

  let appsLine: string;
  if (apps.status === "fulfilled") {
    const list = apps.value ?? [];
    const attention = sortApps(
      list.filter((app) => needsAttention(app, now)),
      now,
    );
    const running = list.filter(isOperationRunning);
    appsLine =
      list.length === 0
        ? "0 applications visible to this credential"
        : `${list.length} total, ${attention.length} need attention, ${running.length} ${running.length === 1 ? "operation" : "operations"} running`;
    const name = displayNames(list);
    if (attention.length > 0) {
      blocks.push(
        encodeObject({
          attention: redactor.deep(
            attention.slice(0, ATTENTION_ROWS).map((app) => ({
              app: name(app),
              project: app.spec?.project ?? "",
              sync: syncStatus(app),
              health: healthStatus(app),
              why: truncate(
                attentionReasons(app, now, redactor).join("; "),
                160,
              ),
            })),
          ),
        }),
      );
      if (attention.length > ATTENTION_ROWS) {
        help.push(
          `Run \`argocd-axi apps --problems\` to see all ${attention.length} apps needing attention`,
        );
      }
      help.push("Run `argocd-axi apps view <app>` to diagnose an application");
    }
    if (running.length > 0) {
      blocks.push(
        encodeObject({
          operations: running.slice(0, OPERATION_ROWS).map((app) => ({
            app: name(app),
            phase: app.status?.operationState?.phase ?? "Pending",
            started: formatAge(app.status?.operationState?.startedAt, now),
          })),
        }),
      );
    }
    if (list.length > 0)
      help.push("Run `argocd-axi apps` to list every application");
  } else {
    appsLine = unavailable(apps.reason);
    help.push(
      "Run `argocd-axi ctx` to confirm which server this context targets",
    );
  }

  const versions = versionSummary(
    check.status === "fulfilled" ? check.value : undefined,
    undefined,
  );
  const summary = encodeObject({
    ...where,
    user: userLine,
    apps: appsLine,
    warning: versions.warning,
    writableContexts: writableLine(),
  });
  if (help.length === 0)
    help.push("Run `argocd-axi projects` to list projects");
  return finish([summary, ...blocks], redactor, help);
}
