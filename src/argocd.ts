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
const KILL_GRACE_MS = 2_000;

export interface RunOptions {
  /** Argo CD context, passed as `--argocd-context`. */
  context?: string;
  /** Override the operation's hard timeout (used by bounded waits). */
  timeoutMs?: number;
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
    if (name !== undefined && FORBIDDEN_ARGS.includes(name)) {
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
  const result = await spawnCollect("argocd", argv, timeoutMs);

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
      const { target } = await resolveTarget(options.context);
      const server = target.envServer ?? target.server;
      failure.agentCredentials = Boolean(target.envToken);
      failure.loginCommand = server
        ? `argocd login ${server} --sso --grpc-web`
        : undefined;
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
    });
    const stdout: Buffer[] = [];
    const stderr: Buffer[] = [];
    let bytes = 0;
    let timedOut = false;
    let overflow = false;
    let settled = false;

    const kill = () => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), KILL_GRACE_MS).unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, timeoutMs);

    const collect = (sink: Buffer[]) => (chunk: Buffer) => {
      bytes += chunk.length;
      if (bytes > MAX_OUTPUT_BYTES) {
        overflow = true;
        kill();
        return;
      }
      sink.push(chunk);
    };
    child.stdout.on("data", collect(stdout));
    child.stderr.on("data", collect(stderr));

    child.on("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timer);
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

    child.on("close", (code) => {
      clearTimeout(timer);
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
    });
  });
}
