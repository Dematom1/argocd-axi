import { COMMAND_LINES, DESCRIPTION } from "./help.js";

/**
 * The installable skill (AXI principle 7, secondary to the session hook).
 * Generated from the same command list `argocd-axi --help` prints, so the
 * two cannot drift; `npm run check:skill` fails CI when the committed file
 * is stale.
 */

export const SKILL_DESCRIPTION =
  "Inspect Argo CD through the argocd-axi CLI - which applications are OutOfSync, Degraded or failing to sync and why, " +
  "per-resource diffs against Git, deployment history, pod logs, project sync windows and RBAC checks, plus confirmed app syncs on writable contexts. " +
  "Use whenever a task involves Argo CD or GitOps deployments: an app stuck or unhealthy, a sync that failed, " +
  "what changed in a rollout, or whether a sync is allowed right now.";

export function createSkillMarkdown(): string {
  const commands = COMMAND_LINES.map((line) => `  ${line}`).join("\n");
  return `---
name: argocd-axi
description: ${JSON.stringify(SKILL_DESCRIPTION)}
user-invocable: false
---

# argocd-axi

${DESCRIPTION}.

You do not need argocd-axi installed globally - invoke it with \`npx -y argocd-axi <command>\`.
If argocd-axi output suggests a command starting with \`argocd-axi\`, run it as \`npx -y argocd-axi ...\` instead.

argocd-axi wraps the \`argocd\` CLI, which must be on PATH and already logged in (or have \`ARGOCD_AUTH_TOKEN\` set).
It uses that session as is and adds no auth of its own; it never logs in, never prompts, and never reads the argocd config file.
If a command answers \`AUTH_REQUIRED\`, ask the user to run \`argocd login <server> --sso\` (or \`argocd relogin\`) themselves.

It is read-only except for opt-in writes on contexts listed in \`writable-contexts\`. \`apps sync\` previews the diff and does nothing unless \`--confirm\` is passed; pruning also requires \`--prune\`. Other writes answer \`REFUSED\`.
For anything argocd-axi does not cover, the raw \`argocd\` CLI is the fallback.

## Workflow

1. Start wide: \`npx -y argocd-axi\` shows the context, server, user, every app needing attention with the reason, and running operations.
2. Drill in: \`apps view <app>\` gives source, destination, sync and health, the last operation and its message, conditions, auto-sync, and problem resources.
3. Find out why it is out of sync: \`apps diff <app>\` lists the resources that differ (\`--full\` adds the line diff); \`apps history <app>\` shows what was deployed when and by whom.
4. Read the workload: \`apps resources <app> --problems\`, then \`apps logs <app> --kind Deployment --name <name> --since 15m\`.
5. Before asking a human to sync: \`projects windows <project>\` says whether a sync is allowed right now, and \`can-i sync applications '<project>/<app>'\` checks permissions.
6. Pass \`--context <name>\` after the command to target another Argo CD context; \`ctx\` lists them.

## Commands

\`\`\`
commands[${COMMAND_LINES.length}]:
${commands}
\`\`\`

Run \`npx -y argocd-axi --help\` for global flags, or \`npx -y argocd-axi <command> --help\` for per-command usage.

## Tips

- Output is TOON; lists sort problems first and say \`count: N of M total\`. Empty results are stated explicitly.
- An unhealthy or out-of-sync app is data, not an error: exit 0 means the command worked. Exit 1 is an error, 2 a usage error; errors print \`error\`, \`code\` and \`help\` on stdout.
- An app needs attention when it is OutOfSync or sync Unknown; Degraded, Missing or health Unknown; Progressing for more than 10 minutes; its last sync Failed or Errored; or it has conditions.
- Secret-looking values (Secret data, passwords, tokens, Helm parameters) are redacted and counted; no flag reveals them, and log redaction is best effort.
- Nothing streams: \`apps logs\` returns recent lines (default 100), \`apps wait\` is bounded (default 120 s) and returns the current state if it times out.
- Apps in other namespaces are addressed as \`namespace/name\`.
`;
}
