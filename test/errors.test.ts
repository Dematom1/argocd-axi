import { describe, expect, it } from "vitest";
import { cleanArgocdStderr, mapArgocdFailure } from "../src/errors.js";

const fatal = (msg: string) =>
  `time="2026-10-28T10:00:00Z" level=warning msg="error looking for plugin 'argocd-x'"\ntime="2026-10-28T10:00:00Z" level=fatal msg="${msg}"\n`;

describe("argocd error translation", () => {
  it("extracts the fatal message and drops plugin warnings", () => {
    expect(
      cleanArgocdStderr(
        fatal('rpc error: code = NotFound desc = app \\"x\\" not found'),
      ),
    ).toBe('rpc error: code = NotFound desc = app "x" not found');
    expect(
      cleanArgocdStderr(
        '{"level":"warning","msg":"error looking for plugin","time":"t"}\n{"level":"fatal","msg":"rpc error: code = NotFound desc = app \\"x\\" not found","time":"2026-10-29T06:23:17-06:00"}\n',
      ),
    ).toBe('rpc error: code = NotFound desc = app "x" not found');
    expect(cleanArgocdStderr("Error: unknown flag: --bogus\n")).toBe(
      "unknown flag: --bogus",
    );
  });

  it.each([
    [
      "rpc error: code = Unauthenticated desc = invalid session: token has invalid claims",
      "AUTH_REQUIRED",
    ],
    ["rpc error: code = Unknown desc = token is expired", "AUTH_REQUIRED"],
    ["Argo CD server address unspecified", "NO_CONTEXT"],
    ["context 'nope' undefined", "CONTEXT_NOT_FOUND"],
    [
      "rpc error: code = PermissionDenied desc = permission denied",
      "FORBIDDEN",
    ],
    [
      'rpc error: code = NotFound desc = applications.argoproj.io \\"x\\" not found',
      "NOT_FOUND",
    ],
    [
      "rpc error: code = ResourceExhausted desc = too many requests",
      "RATE_LIMITED",
    ],
    [
      "dial tcp 10.0.0.1:443: connect: connection refused",
      "SERVER_UNREACHABLE",
    ],
    ["x509: certificate signed by unknown authority", "SERVER_UNREACHABLE"],
    [
      "rpc error: code = InvalidArgument desc = bad selector",
      "VALIDATION_ERROR",
    ],
    ["something else entirely", "UPSTREAM_ERROR"],
  ])("maps %s to %s", (message, code) => {
    expect(mapArgocdFailure(fatal(message)).code).toBe(code);
  });

  it("tells a human, not the agent, to log in", () => {
    const error = mapArgocdFailure(
      fatal("rpc error: code = Unauthenticated desc = no session information"),
    );
    expect(error.suggestions.join(" ")).toMatch(
      /A human runs `argocd login <server> --sso`/,
    );
  });

  it("redacts secrets that leak into error text", () => {
    const error = mapArgocdFailure(fatal("failed: password=hunter2"));
    expect(error.message).not.toContain("hunter2");
  });
});
