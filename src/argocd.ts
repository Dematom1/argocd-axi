import { spawn } from "node:child_process";
import { resolveTarget } from "./context.js";
import {
  CODES,
  axiError,
  mapArgocdFailure,
  type FailureContext,
} from "./errors.js";
import { FORBIDDEN_ARGS, OPERATIONS, type OperationId } from "./registry.js";

/**
 * The one subprocess seam (design decisions A1 and S5). Every argocd call in
 * argocd-axi goes through `runArgocd`, which only accepts operations from the
 * allowlist registry, refuses forbidden arguments, never connects stdin (so
 * no prompt can ever block), and enforces a hard timeout and output cap.
 */

const MAX_OUTPUT_BYTES = 50 * 1024 * 1024;

export interface RunOptions {
  /** Argo CD context, passed as `--argocd-context`. */
  context?: string;
  /** Override the operation's hard timeout (used by bounded waits). */
  timeoutMs?: number;
  /** User-facing limit shown in blocking progress. */
  progressTimeoutMs?: number;
  /** Keep elapsed progress cumulative across bounded wait attempts. */
  progressStartedAt?: number;
  /** Return non-zero exits to the caller instead of throwing. */
  allowFailure?: boolean;
  failure?: FailureContext;
}

export interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
  timedOut: boolean;
}

export function buildArgv(
  op: OperationId,
  args: readonly string[],
  context?: string,
): string[] {
  const operation = OPERATIONS[op];
  for (const arg of args) {
    const name = arg.startsWith("--") ? arg.split("=")[0] : arg;
    if (
      name !== undefined &&
      FORBIDDEN_ARGS.includes(name) &&
      !(
        op === "app refresh" &&
        (name === "--refresh" || name === "--hard-refresh")
      )
    ) {
      throw axiError(
        `internal guard: argument ${name} is never passed to argocd`,
        CODES.REFUSED,
      );
    }
  }
  const argv = [...operation.argv, ...args];
  if (context !== undefined) {
    argv.push("--argocd-context", context);
  }
  return argv;
}

export async function runArgocd(
  op: OperationId,
  args: readonly string[],
  options: RunOptions = {},
): Promise<RunResult> {
  if (!Object.hasOwn(OPERATIONS, op)) {
    throw axiError(
      `internal guard: ${String(op)} is not a registered argocd operation`,
      CODES.REFUSED,
    );
  }
  const argv = buildArgv(op, args, options.context);
  const timeoutMs = options.timeoutMs ?? OPERATIONS[op].timeoutMs;
  const progressTimeoutMs = options.progressTimeoutMs ?? timeoutMs;
  if (OPERATIONS[op].network && process.env.ARGOCD_SERVER?.trim()) {
    await resolveTarget(options.context);
  }
  const blocking =
    op === "app wait" || op === "app rollback" || op === "app refresh";
  const started = options.progressStartedAt ?? Date.now();
  const progress = () =>
    process.stderr.write(
      `Waiting for ${op.slice(4)} (${Math.floor((Date.now() - started) / 1000)}s elapsed; limit ${Math.ceil(progressTimeoutMs / 1000)}s)\n`,
    );
  if (blocking) progress();
  const ticker = blocking ? setInterval(progress, 5000) : undefined;
  let result: RunResult;
  try {
    result = await spawnCollect("argocd", argv, timeoutMs);
  } finally {
    clearInterval(ticker);
  }
  const token = process.env.ARGOCD_AUTH_TOKEN;
  if (token) {
    result.stdout = result.stdout.replaceAll(token, "[redacted]");
    result.stderr = result.stderr.replaceAll(token, "[redacted]");
  }

  if (result.timedOut) {
    throw axiError(
      `argocd did not answer within ${Math.round(timeoutMs / 1000)}s`,
      CODES.TIMEOUT,
      [
        "Run `argocd-axi ctx` to confirm which server this context targets",
        "Retry the command; if it keeps timing out, check network access to the server",
      ],
    );
  }
  if (result.exitCode !== 0 && !options.allowFailure) {
    const failure = options.failure ?? {};
    const cleaned = result.stderr || result.stdout;
    if (!failure.loginCommand && isAuthenticationFailure(cleaned)) {
      failure.agentCredentials = Boolean(process.env.ARGOCD_AUTH_TOKEN?.trim());
      if (!failure.agentCredentials)
        try {
          const { target } = await resolveTarget(options.context);
          const server = target.envServer ?? target.server;
          failure.loginCommand = server
            ? `argocd login '${server.replaceAll("'", "'\\''")}' --sso --grpc-web`
            : undefined;
        } catch {
          failure.loginCommand = undefined;
        }
    }
    throw mapArgocdFailure(cleaned, failure);
  }
  return result;
}

function isAuthenticationFailure(message: string): boolean {
  return /rpc error: code = Unauthenticated|invalid session|token is expired|token has expired|no session information|unauthenticated|please login|login required|failed to get token|session (?:has )?expired/i.test(
    message,
  );
}

/** Run an operation whose stdout is JSON and parse it. */
export async function argocdJson<T>(
  op: OperationId,
  args: readonly string[],
  options: RunOptions = {},
): Promise<T> {
  const result = await runArgocd(op, args, options);
  try {
    return JSON.parse(result.stdout) as T;
  } catch {
    throw axiError(
      `argocd returned output that is not JSON for ${op}`,
      CODES.UPSTREAM_ERROR,
      [
        "Check that the argocd CLI version matches the server (`argocd-axi ctx`)",
      ],
    );
  }
}

function spawnCollect(
  bin: string,
  argv: string[],
  timeoutMs: number,
): Promise<RunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, argv, {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
      windowsHide: true,
      detached: process.platform !== "win32",
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const kill = () => {
      if (process.platform !== "win32" && child.pid !== undefined) {
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          // The group may already have exited; still try the direct child.
          child.kill("SIGKILL");
        }
      } else {
        child.kill("SIGKILL");
      }
      // A descendant can escape the group while retaining these pipes.
      child.stdout.destroy();
      child.stderr.destroy();
      child.unref();
    };
    const interrupt = (exitCode: number) => {
      kill();
      // Let every active subprocess's listener run before terminating the CLI.
      queueMicrotask(() => process.exit(exitCode));
    };
    const onSigint = () => interrupt(130);
    const onSigterm = () => interrupt(143);
    process.once("SIGINT", onSigint);
    process.once("SIGTERM", onSigterm);
    const cleanup = () => {
      clearTimeout(timer);
      process.off("SIGINT", onSigint);
      process.off("SIGTERM", onSigterm);
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
      finish(1);
    }, timeoutMs);

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        kill();
        finish(1);
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error: NodeJS.ErrnoException) => {
      cleanup();
      if (settled) return;
      settled = true;
      if (error.code === "ENOENT") {
        reject(
          axiError(
            "The argocd CLI is not installed or not on PATH",
            CODES.ARGOCD_NOT_INSTALLED,
            [
              "A human installs the argocd CLI, ideally the version matching the server: https://argo-cd.readthedocs.io/en/stable/cli_installation/",
            ],
          ),
        );
        return;
      }
      reject(
        axiError(
          `could not start argocd: ${error.message}`,
          CODES.UPSTREAM_ERROR,
        ),
      );
    });

    function finish(code: number | null) {
      cleanup();
      if (settled) return;
      settled = true;
      if (overflow) {
        reject(
          axiError(
            `argocd produced more than ${MAX_OUTPUT_BYTES / 1024 / 1024} MB of output`,
            CODES.UPSTREAM_ERROR,
            ["Narrow the request (for example with --project or --kind)"],
          ),
        );
        return;
      }
      resolve({
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
        exitCode: code ?? 1,
        timedOut,
      });
    }
    child.on("close", finish);
  });
}
