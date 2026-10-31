---
name: argocd-axi
description: "Inspect Argo CD through the argocd-axi CLI - which applications are OutOfSync, Degraded or failing to sync and why, per-resource diffs against Git, deployment history, pod logs, project sync windows and RBAC checks, plus confirmed app sync, rollback, refresh, and operation termination on writable contexts. Use whenever a task involves Argo CD or GitOps deployments: an app stuck or unhealthy, a sync that failed, what changed in a rollout, or whether a sync is allowed right now."
user-invocable: false
---

# argocd-axi

Argo CD for agents: read operations plus opt-in writes on writable contexts.

You do not need argocd-axi installed globally - invoke it with `npx -y argocd-axi <command>`.
If argocd-axi output suggests a command starting with `argocd-axi`, run it as `npx -y argocd-axi ...` instead.

argocd-axi wraps the `argocd` CLI, which must be on PATH and already logged in (or have `ARGOCD_AUTH_TOKEN` set).
It uses that session as is and adds no auth of its own; it never logs in, never prompts, and never reads the argocd config file.
Run `npx -y argocd-axi auth guide` for setup instructions; the README is the authority for credential setup. The tool never logs in. If a command answers `AUTH_EXPIRED`, show the exact operator login command when the server is known; otherwise show the fallback login syntax and ask for the server address. An unreachable server is a separate error.

It supports opt-in writes on contexts listed in `writable-contexts`: `apps sync`, `apps rollback`, `apps refresh`, and `apps terminate-op` preview first and require `--confirm` to act. Sync pruning also requires `--prune`. Other writes answer `REFUSED`.
For anything argocd-axi does not cover, the raw `argocd` CLI is the fallback.

## Setup

Run `npx -y argocd-axi auth guide` for offline instructions. A human operator logs in interactively with `argocd login <server> --sso --grpc-web`; agents and CI use `ARGOCD_SERVER` and `ARGOCD_AUTH_TOKEN` from a scoped account token. The user owns login; argocd-axi never logs in. Verify access with `npx -y argocd-axi whoami`. See the README's writable-context instructions before enabling writes.

## Workflow

1. Start wide: `npx -y argocd-axi` shows the context, server, user, every app needing attention with the reason, and running operations.
2. Drill in: `apps view <app>` gives source, destination, sync and health, the last operation and its message, conditions, auto-sync, and problem resources.
3. Find out why it is out of sync: `apps diff <app>` lists the resources that differ (`--full` adds the line diff); `apps history <app>` shows what was deployed when and by whom.
4. Read the workload: `apps resources <app> --problems`, then `apps logs <app> --kind Deployment --name <name> --since 15m`.
5. Before asking a human to sync: `projects windows <project>` says whether a sync is allowed right now, and `can-i sync applications '<project>/<app>'` checks permissions.
6. Pass `--context <name>` after the command to target another Argo CD context; `ctx` lists them.

## Commands

```
commands[27]:
  (no command): live overview - context, server, user, apps needing attention with the reason, running operations
  ctx [--context <c>]: current context, server and CLI version, local only (what the session hook prints)
  context: last session's argocd-axi command summary for this directory
  context end: record the current Claude Code session summary (SessionEnd hook)
  ctx use <context>: switch the argocd CLI's current context (local config only)
  auth guide [--context <c>]: offline human login and agent token setup instructions
  whoami: user, issuer and groups of the current credential
  can-i <action> <resource> <object>: ask Argo CD RBAC, e.g. can-i sync applications 'payments/payments-api'
  apps [--project --selector --repo --cluster --sync --health --problems --limit --fields]: applications, problems first
  apps view <app>: source, destination, sync, health, operation, conditions, auto-sync, problem resources
  apps resources <app> [--problems --orphaned]: managed resources with sync and health
  apps diff <app> [--revision <rev>] [--full]: what differs from Git, per resource; raw diff with --full
  apps sync <app> [--confirm] [--prune] [--timeout <s>]: preview, then optionally sync one app
  apps rollback <app> <history-id> [--confirm] [--timeout <s>]: preview revision, then optionally roll back
  apps refresh <app> [--hard] [--confirm]: preview, then optionally refresh one app
  apps terminate-op <app> [--confirm] [--timeout <s>]: preview, then optionally stop a running operation
  apps auto-sync <app> <on|off> [--confirm]: preview, then optionally change automated sync
  apps actions run <app> <action> --kind <kind> --name <resource> [--confirm]: preview, then optionally run one listed resource action
  apps history <app>: deployments, newest first
  apps manifests <app> [--source git|live] [--kind <k>] [--full]: rendered manifests, Secret data redacted
  apps logs <app> [--kind --name --tail --since --filter -p]: recent pod logs, never follows
  apps wait <app> [--sync --health --operation] [--timeout <s>]: bounded wait, returns the state either way
  apps actions <app>: list available resource actions
  projects | projects view <p> | projects windows <p>: projects, their rules, and whether sync is allowed now
  appsets | appsets view <name> | appsets generate <file>: ApplicationSets and what a spec would generate
  repos | clusters: repositories and destination clusters with connection status
  setup hooks | status | uninstall: manage the Claude Code SessionEnd memory hook; setup hooks also installs SessionStart hooks
```

Run `npx -y argocd-axi --help` for global flags, or `npx -y argocd-axi <command> --help` for per-command usage.

## Tips

- Output is TOON; lists sort problems first and say `count: N of M total`. Empty results are stated explicitly.
- An unhealthy or out-of-sync app is data, not an error: exit 0 means the command worked. Exit 1 is an error, 2 a usage error; errors print `error`, `code` and `help` on stdout.
- An app needs attention when it is OutOfSync or sync Unknown; Degraded, Missing or health Unknown; Progressing for more than 10 minutes; its last sync Failed or Errored; or it has conditions.
- Secret-looking values (Secret data, passwords, tokens, Helm parameters) are redacted and counted; no flag reveals them, and log redaction is best effort.
- Nothing streams: `apps logs` returns recent lines (default 100), `apps wait` is bounded (default 120 s) and returns the current state if it times out.
- Apps in other namespaces are addressed as `namespace/name`.
