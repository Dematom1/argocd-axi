import { AxiError } from "axi-sdk-js";
import { redactText } from "./redact.js";

/**
 * Error codes. The first block is shared with the other AXI tools in this
 * family (design decision S13); the second block is specific to argocd-axi.
 * Exit codes follow the SDK: VALIDATION_ERROR exits 2, everything else 1.
 */
export const CODES = {
  VALIDATION_ERROR: "VALIDATION_ERROR",
  AUTH_REQUIRED: "AUTH_REQUIRED",
  AUTH_EXPIRED: "AUTH_EXPIRED",
  FORBIDDEN: "FORBIDDEN",
  NOT_FOUND: "NOT_FOUND",
  RATE_LIMITED: "RATE_LIMITED",
  SERVER_UNREACHABLE: "SERVER_UNREACHABLE",
  REFUSED: "REFUSED",
  UNSUPPORTED_IN_MODE: "UNSUPPORTED_IN_MODE",
  NO_CONTEXT: "NO_CONTEXT",
  CONTEXT_NOT_FOUND: "CONTEXT_NOT_FOUND",
  ARGOCD_NOT_INSTALLED: "ARGOCD_NOT_INSTALLED",
  TIMEOUT: "TIMEOUT",
  CONFIG_INVALID: "CONFIG_INVALID",
  UPSTREAM_ERROR: "UPSTREAM_ERROR",
} as const;

export type ErrorCode = (typeof CODES)[keyof typeof CODES];

export function axiError(
  message: string,
  code: ErrorCode,
  help: string[] = [],
): AxiError {
  return new AxiError(message, code, help);
}

export function validationError(message: string, help: string[] = []) {
  return axiError(message, CODES.VALIDATION_ERROR, help);
}

export const LOGIN_HELP = [
  "A human runs `argocd login <server> --sso --grpc-web`; argocd-axi never starts a login",
  "For agents, prefer a short-lived project-role token in ARGOCD_AUTH_TOKEN (see the README)",
];

export interface FailureContext {
  /** Help shown when the server answers NotFound, e.g. how to list apps. */
  notFoundHelp?: string[];
  /** Exact, context-aware operator login command. */
  loginCommand?: string;
  agentCredentials?: boolean;
}

const MAX_MESSAGE_CHARS = 300;

/**
 * Pull the meaningful message out of argocd stderr. argocd logs fatal errors
 * as `time=... level=fatal msg="..."` (2.x) or as a JSON line
 * `{"level":"fatal","msg":"...","time":"..."}` (3.x), and also prints
 * plugin-lookup warnings that are pure noise for an agent.
 */
export function cleanArgocdStderr(stderr: string): string {
  const lines: string[] = [];
  // The fatal line carries the cause and gRPC code; an earlier error-level
  // line (such as core mode's `finished call` log) is only a fallback.
  let fatal: string | undefined;
  let error: string | undefined;
  for (const raw of stderr.split("\n")) {
    const line = raw.trim();
    if (line.length === 0) continue;
    const json = parseJsonLogLine(line);
    if (json) {
      if (json.level === "fatal") fatal ??= json.msg;
      else if (json.level === "error") error ??= json.msg;
      continue;
    }
    const logfmt = line.match(/level=(fatal|error) msg="((?:[^"\\]|\\.)*)"/);
    if (logfmt?.[2] !== undefined) {
      const msg = unescapeGo(logfmt[2]);
      if (logfmt[1] === "fatal") fatal ??= msg;
      else error ??= msg;
      continue;
    }
    if (!/level=(warning|info|debug)/.test(line)) lines.push(line);
  }
  if (fatal !== undefined) return fatal;
  if (error !== undefined) return error;

  const last = lines.at(-1) ?? "";
  return last.replace(/^(?:Error|FATA\[\d+\]):?\s*/, "");
}

function parseJsonLogLine(
  line: string,
): { level: string; msg: string } | undefined {
  if (!line.startsWith("{")) return undefined;
  try {
    const parsed: unknown = JSON.parse(line);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const { level, msg } = parsed as Record<string, unknown>;
    if (typeof level !== "string" || typeof msg !== "string") return undefined;
    return { level, msg };
  } catch {
    return undefined;
  }
}

function unescapeGo(value: string): string {
  return value.replace(/\\(["\\n])/g, (_, ch: string) =>
    ch === "n" ? " " : ch,
  );
}

function shorten(message: string): string {
  const flat = message.replace(/\s+/g, " ").trim();
  if (flat.length <= MAX_MESSAGE_CHARS) return flat;
  return `${flat.slice(0, MAX_MESSAGE_CHARS)}... (truncated, ${flat.length} chars total)`;
}

/** Translate a failed argocd invocation into a structured AXI error. */
export function mapArgocdFailure(
  stderr: string,
  context: FailureContext = {},
): AxiError {
  const cleaned = cleanArgocdStderr(stderr);
  const grpc = cleaned.match(/rpc error: code = (\w+) desc = (.*)$/);
  const grpcCode = grpc?.[1];
  const detail =
    shorten(redactText(grpc?.[2] ?? cleaned).text) ||
    "argocd failed without an error message";

  if (
    /no session information|please login|login required/i.test(cleaned) &&
    !/invalid session|token is expired|token has expired|session (?:has )?expired/i.test(
      cleaned,
    )
  ) {
    return axiError(
      `Not authenticated to Argo CD: ${detail}`,
      CODES.AUTH_REQUIRED,
      context.agentCredentials
        ? [
            "Check ARGOCD_SERVER and ARGOCD_AUTH_TOKEN; replace the token with a valid scoped account token",
          ]
        : context.loginCommand
          ? [
              `A human runs \`${context.loginCommand}\`; argocd-axi never logs in`,
            ]
          : LOGIN_HELP,
    );
  }

  if (
    grpcCode === "Unauthenticated" ||
    /invalid session|token is expired|token has expired|unauthenticated|failed to get token|session (?:has )?expired/i.test(
      cleaned,
    )
  ) {
    return axiError(
      `Not authenticated to Argo CD: ${detail}`,
      CODES.AUTH_EXPIRED,
      context.agentCredentials
        ? [
            "Check ARGOCD_SERVER and ARGOCD_AUTH_TOKEN; replace the token with a valid scoped account token",
            ...(context.loginCommand
              ? [
                  `A human runs \`${context.loginCommand}\`; argocd-axi never logs in`,
                ]
              : []),
          ]
        : context.loginCommand
          ? [
              `A human runs \`${context.loginCommand}\`; argocd-axi never logs in`,
            ]
          : LOGIN_HELP,
    );
  }

  if (/server address unspecified/i.test(cleaned)) {
    return axiError(
      "No Argo CD server is configured for this context",
      CODES.NO_CONTEXT,
      [
        "Run `argocd-axi ctx` to see the configured contexts",
        ...LOGIN_HELP.slice(0, 1),
      ],
    );
  }

  const missingContext = cleaned.match(
    /context '?([^'\s]+)'? (?:undefined|does not exist|not found)/i,
  );
  if (missingContext) {
    return axiError(
      `Argo CD context ${missingContext[1]} is not configured`,
      CODES.CONTEXT_NOT_FOUND,
      ["Run `argocd-axi ctx` to list configured contexts"],
    );
  }

  if (grpcCode === "PermissionDenied" || /permission denied/i.test(cleaned)) {
    const message = /^permission denied\.?$/i.test(detail)
      ? "Permission denied by Argo CD RBAC"
      : `Permission denied: ${detail}`;
    return axiError(message, CODES.FORBIDDEN, [
      "Run `argocd-axi can-i <action> <resource> <object>` to check what this credential may do",
      "Argo CD also answers permission denied for objects in projects you cannot see",
    ]);
  }

  if (grpcCode === "NotFound" || /not found/i.test(cleaned)) {
    return axiError(
      `Not found: ${detail}`,
      CODES.NOT_FOUND,
      context.notFoundHelp ?? [],
    );
  }

  if (
    grpcCode === "ResourceExhausted" ||
    /too many requests|rate limit/i.test(cleaned)
  ) {
    return axiError(`Rate limited by Argo CD: ${detail}`, CODES.RATE_LIMITED, [
      "Wait a moment, then retry the same command",
    ]);
  }

  if (/x509|tls:|certificate/i.test(cleaned)) {
    return axiError(
      `TLS error talking to Argo CD: ${detail}`,
      CODES.SERVER_UNREACHABLE,
      [
        "A human checks the server certificate or the context's TLS settings (`argocd login` options)",
      ],
    );
  }

  if (
    grpcCode === "Unavailable" ||
    grpcCode === "DeadlineExceeded" ||
    /connection refused|no such host|i\/o timeout|dial tcp|deadline exceeded|network is unreachable|connection reset|unexpected EOF|Unavailable/i.test(
      cleaned,
    )
  ) {
    return axiError(
      `Argo CD server unreachable: ${detail}`,
      CODES.SERVER_UNREACHABLE,
      [
        "Run `argocd-axi ctx` to confirm which server this context targets",
        "Check VPN or network access to the server, then retry",
      ],
    );
  }

  if (grpcCode === "InvalidArgument") {
    return validationError(`Argo CD rejected the request: ${detail}`);
  }

  return axiError(
    `Argo CD request failed: ${detail}`,
    CODES.UPSTREAM_ERROR,
    [],
  );
}
