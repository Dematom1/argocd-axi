import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { expect } from "vitest";
import { decode } from "@toon-format/toon";
import { FORBIDDEN_ARGS, OPERATIONS } from "../src/registry.js";

/**
 * End-to-end harness: runs the built CLI as a user would, with a fake
 * `argocd` as the only executable on PATH and a throwaway HOME, so a test can
 * never reach a real Argo CD server, cluster, kubeconfig or credential.
 */

export const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const FAKE_BIN = join(ROOT, "test", "fake-argocd", "bin");
const FAKE_JS = join(ROOT, "test", "fake-argocd", "fake-argocd.mjs");
export const DEFAULT_SCENARIO = join(
  ROOT,
  "test",
  "fixtures",
  "default",
  "scenario.json",
);

export interface RunResult {
  stdout: string;
  exitCode: number;
  /** argv of every argocd invocation, in order. */
  calls: string[][];
  home: string;
}

export interface RunOptions {
  scenario?: string;
  env?: Record<string, string>;
  home?: string;
  bin?: "argocd-axi" | "argocd-axi-ctx";
  stdin?: string;
}

export function makeHome(): string {
  return mkdtempSync(join(tmpdir(), "argocd-axi-test-"));
}

/**
 * Run the CLI as a child process without blocking the test worker, so a
 * loaded machine cannot starve Vitest's worker RPC.
 */
export async function runCli(
  args: string[],
  options: RunOptions = {},
): Promise<RunResult> {
  const home = options.home ?? makeHome();
  const log = join(home, "argocd-calls.log");
  writeFileSync(log, "");
  const entry = join(ROOT, "dist", "bin", `${options.bin ?? "argocd-axi"}.js`);
  const child = spawn(process.execPath, [entry, ...args], {
    stdio: ["pipe", "pipe", "ignore"],
    timeout: 30_000,
    env: {
      PATH: FAKE_BIN,
      HOME: home,
      XDG_CONFIG_HOME: join(home, ".config"),
      XDG_CACHE_HOME: join(home, ".cache"),
      FAKE_ARGOCD_NODE: process.execPath,
      FAKE_ARGOCD_JS: FAKE_JS,
      FAKE_ARGOCD_SCENARIO: options.scenario ?? DEFAULT_SCENARIO,
      FAKE_ARGOCD_LOG: log,
      ...options.env,
    },
  });
  if (options.stdin !== undefined) child.stdin.end(options.stdin);
  else child.stdin.end();
  let stdout = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => (stdout += chunk));
  const exitCode = await new Promise<number>((resolve, reject) => {
    child.on("error", reject);
    child.on("close", (code) => resolve(code ?? -1));
  });
  const calls = existsSync(log)
    ? readFileSync(log, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as string[])
    : [];
  expect(() => decode(stdout), args.join(" ") || "home").not.toThrow();
  return { stdout, exitCode, calls, home };
}

/** Write a one-off scenario next to the default fixtures. */
export function scenario(responses: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "argocd-axi-scenario-"));
  const base = join(ROOT, "test", "fixtures", "default");
  const path = join(dir, "scenario.json");
  // Resolve fixture files against the default directory.
  const rewritten = (responses as Array<Record<string, unknown>>).map((r) => ({
    ...r,
    ...(typeof r.stdoutFile === "string"
      ? { stdoutFile: join(base, r.stdoutFile) }
      : {}),
    ...(Array.isArray(r.jsonArrayOf)
      ? { jsonArrayOf: (r.jsonArrayOf as string[]).map((f) => join(base, f)) }
      : {}),
  }));
  writeFileSync(path, JSON.stringify({ responses: rewritten }));
  return path;
}

/** The registered operation an argv belongs to (longest prefix wins). */
export function operationOf(argv: string[]) {
  const joined = argv.join(" ");
  return Object.values(OPERATIONS)
    .filter(
      (op) =>
        joined === op.argv.join(" ") ||
        joined.startsWith(`${op.argv.join(" ")} `),
    )
    .sort((a, b) => b.argv.length - a.argv.length)[0];
}

export function isNetworkCall(argv: string[]): boolean {
  return operationOf(argv)?.network ?? true;
}

/** Every argocd call must be a registered operation with no forbidden flag. */
export function expectSafeCalls(calls: string[][]) {
  for (const argv of calls) {
    expect(operationOf(argv), argv.join(" ")).toBeDefined();
    for (const arg of argv)
      expect(FORBIDDEN_ARGS).not.toContain(arg.split("=")[0]);
  }
}
