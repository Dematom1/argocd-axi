import { type ToolConfig } from "./config.js";
import { validateContextName } from "./context.js";
import { CODES, axiError, validationError } from "./errors.js";

/**
 * Shared write gate: writes use the sole writable context when unambiguous,
 * preview by default, and enforce the local writable-contexts allowlist.
 *
 * Rules:
 * - An omitted context resolves only when writable-contexts has one entry.
 * - Without the command's execute flag, a write is a preview: nothing is
 *   sent. Previews work against any context.
 * - Executing needs the context in the local writable-contexts allowlist in
 *   argocd-axi's own config file, which defaults to none.
 * - Writes that reach Argo CD carry `--info initiated-by=argocd-axi`, so the
 *   app's audit trail shows the agent.
 *
 * The execute flag's spelling follows Argo CD's own vocabulary per command
 * (resolved design question 1(b)); the write tier names it, the gate only
 * needs to know whether it was given.
 */

export const ATTRIBUTION_INFO = "initiated-by=argocd-axi";

export function attributionArgs(): string[] {
  return ["--info", ATTRIBUTION_INFO];
}

export interface WriteRequest {
  /** The argocd-axi command, e.g. `apps sync`. */
  command: string;
  /** The `--context` flag as given; undefined when it was omitted. */
  context: string | undefined;
  /** Whether the command's execute flag was given. */
  execute: boolean;
  /** The execute flag's spelling, for hints, e.g. `--now`. */
  executeFlag: string;
}

export type GateDecision =
  | {
      mode: "preview";
      context: string;
      writable: boolean;
      defaulted: boolean;
      help: string[];
    }
  | { mode: "execute"; context: string; defaulted: boolean };

export function isWritableContext(
  config: ToolConfig,
  context: string,
): boolean {
  return config.writableContexts.includes(context);
}

export function writableContextsSummary(config: ToolConfig): string {
  return config.writableContexts.length === 0
    ? "none"
    : config.writableContexts.join(", ");
}

export function evaluateWriteGate(
  request: WriteRequest,
  config: ToolConfig,
): GateDecision {
  const defaulted = request.context === undefined;
  const writableContexts = config.writableContexts;
  if (defaulted && writableContexts.length !== 1) {
    throw validationError(
      `\`${request.command}\` needs --context <name>; writable contexts: ${writableContextsSummary(config)}`,
      [
        `Pass --context <name> (writable contexts: ${writableContextsSummary(config)})`,
      ],
    );
  }
  const context = validateContextName(request.context ?? writableContexts[0]!);
  const writable = isWritableContext(config, context);
  const allowHint = `A human can allow writes by running \`argocd-axi ctx writable add ${context}\` in a terminal`;

  if (!request.execute) {
    return {
      mode: "preview",
      context,
      writable,
      defaulted,
      help: writable
        ? [`Re-run with ${request.executeFlag} to execute against ${context}`]
        : [
            `${context} is not a writable context, so this can only be previewed`,
            allowHint,
          ],
    };
  }

  if (!writable) {
    throw axiError(
      `writes to context ${context} are not allowed: it is not listed in writable-contexts`,
      CODES.REFUSED,
      [
        `Re-run without ${request.executeFlag} to preview the change`,
        allowHint,
      ],
    );
  }
  return { mode: "execute", context, defaulted };
}
