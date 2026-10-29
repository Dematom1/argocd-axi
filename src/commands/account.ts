import { argocdJson, runArgocd } from "../argocd.js";
import {
  CONTEXT_FLAG,
  getString,
  parseArgs,
  type CommandSpec,
} from "../args.js";
import { describeTarget, resolveTarget } from "../context.js";
import { CODES, LOGIN_HELP, axiError, validationError } from "../errors.js";
import { encodeObject } from "../toon.js";
import { contextOption, contextSuffix, finish } from "./common.js";

export const WHOAMI_SPEC: CommandSpec = {
  path: "whoami",
  summary:
    "Who the current credential is: user, issuer and groups, plus the target context",
  positionals: [],
  flags: [CONTEXT_FLAG],
  examples: ["argocd-axi whoami", "argocd-axi whoami --context prod"],
};

interface UserInfo {
  loggedIn?: boolean;
  username?: string;
  iss?: string;
  groups?: string[];
}

export async function whoamiCommand(args: string[]): Promise<string> {
  const parsed = parseArgs(WHOAMI_SPEC, args);
  const explicit = getString(parsed, "--context");
  const [{ target, listing }, info] = await Promise.all([
    resolveTarget(explicit),
    argocdJson<UserInfo>(
      "account get-user-info",
      ["-o", "json"],
      contextOption(parsed),
    ),
  ]);
  const where = describeTarget(target, listing);
  if (!info.loggedIn) {
    return finish(
      [encodeObject({ ...where, loggedIn: "no" })],
      undefined,
      LOGIN_HELP,
    );
  }
  return finish(
    [
      encodeObject({
        ...where,
        user: info.username ?? "unknown",
        issuer:
          info.iss === "argocd"
            ? "argocd (local account or project token)"
            : info.iss,
        groups: info.groups && info.groups.length > 0 ? info.groups : undefined,
      }),
    ],
    undefined,
    [
      `Run \`argocd-axi can-i <action> <resource> <object>${contextSuffix(parsed)}\` to check a permission`,
    ],
  );
}

const ACTIONS = [
  "get",
  "create",
  "update",
  "delete",
  "sync",
  "override",
  "action",
  "invoke",
];
const RESOURCES = [
  "clusters",
  "projects",
  "applications",
  "applicationsets",
  "repositories",
  "write-repositories",
  "certificates",
  "accounts",
  "gpgkeys",
  "logs",
  "exec",
  "extensions",
];

export const CAN_I_SPEC: CommandSpec = {
  path: "can-i",
  summary:
    "Ask Argo CD RBAC whether this credential may do something, e.g. sync an app; answers yes or no",
  positionals: [
    { name: "action", required: true, description: ACTIONS.join(", ") },
    { name: "resource", required: true, description: RESOURCES.join(", ") },
    {
      name: "object",
      required: true,
      description: "project/app (applications), a name, or '*'",
    },
  ],
  flags: [CONTEXT_FLAG],
  examples: [
    "argocd-axi can-i sync applications 'payments/payments-api'",
    "argocd-axi can-i get logs 'payments/*'",
  ],
  notes: ['"no" is an answer, not an error: the command exits 0 either way'],
};

export async function canICommand(args: string[]): Promise<string> {
  const parsed = parseArgs(CAN_I_SPEC, args);
  const [action, resource, object] = parsed.positionals as [
    string,
    string,
    string,
  ];
  if (!ACTIONS.includes(action))
    throw validationError(`unknown action ${action}`, [
      `actions: ${ACTIONS.join(", ")}`,
    ]);
  if (!RESOURCES.includes(resource))
    throw validationError(`unknown resource ${resource}`, [
      `resources: ${RESOURCES.join(", ")}`,
    ]);
  if (object.startsWith("-") || /\s/.test(object))
    throw validationError(`invalid object ${JSON.stringify(object)}`);

  const result = await runArgocd(
    "account can-i",
    [action, resource, object],
    contextOption(parsed),
  );
  const answer = result.stdout.trim().toLowerCase();
  // Anything but a bare yes or no (a banner, a changed output format) is not
  // an answer; reporting it as "no" would send a human to grant rights that
  // may already exist.
  if (answer !== "yes" && answer !== "no") {
    throw axiError(
      "argocd returned an unexpected answer for account can-i",
      CODES.UPSTREAM_ERROR,
      [
        "Run `argocd-axi ctx` to check that the argocd CLI version matches the server",
      ],
    );
  }
  const allowed = answer === "yes";
  return finish(
    [
      encodeObject({
        answer: allowed ? "yes" : "no",
        check: `${action} ${resource} ${object}`,
      }),
    ],
    undefined,
    allowed
      ? []
      : [
          "A human with Argo CD admin rights can grant this through project roles or the RBAC policy",
        ],
  );
}
