import { renderBlocks, renderTextBlock } from "./toon.js";

export const DESCRIPTION =
  "Read-only Argo CD for agents: applications needing attention, diffs, history, health, logs, projects and sync windows";

/** The commands block; the skill is generated from it so the two never drift. */
export const COMMAND_LINES = [
  "(no command): live overview - context, server, user, apps needing attention with the reason, running operations",
  "ctx [--context <c>]: current context, server and CLI version, local only (what the session hook prints)",
  "ctx use <context>: switch the argocd CLI's current context (local config only)",
  "whoami: user, issuer and groups of the current credential",
  "can-i <action> <resource> <object>: ask Argo CD RBAC, e.g. can-i sync applications 'payments/*'",
  "apps [--project --selector --repo --cluster --sync --health --problems --limit --fields]: applications, problems first",
  "apps view <app>: source, destination, sync, health, operation, conditions, auto-sync, problem resources",
  "apps resources <app> [--problems --orphaned]: managed resources with sync and health",
  "apps diff <app> [--revision <rev>] [--full]: what differs from Git, per resource; raw diff with --full",
  "apps history <app>: deployments, newest first",
  "apps manifests <app> [--source git|live] [--kind <k>] [--full]: rendered manifests, Secret data redacted",
  "apps logs <app> [--kind --name --tail --since --filter -p]: recent pod logs, never follows",
  "apps wait <app> [--sync --health --operation] [--timeout <s>]: bounded wait, returns the state either way",
  "apps actions <app>: resource actions available (listing only)",
  "projects | projects view <p> | projects windows <p>: projects, their rules, and whether sync is allowed now",
  "appsets | appsets view <name> | appsets generate <file>: ApplicationSets and what a spec would generate",
  "repos | clusters: repositories and destination clusters with connection status",
  "setup hooks: install the SessionStart hook (runs the offline ctx view)",
];

export const TOP_HELP = `${renderBlocks([
  "usage: argocd-axi <command> [args] [flags]",
  `description: ${DESCRIPTION}`,
  renderTextBlock("commands", COMMAND_LINES),
  renderTextBlock("flags", [
    "--context <name>: Argo CD context to target (default: the current context); accepted by every command that reads Argo CD",
    "--help: per-command usage, flags and examples, e.g. `argocd-axi apps view --help`",
    "-v, --version: print the version",
  ]),
  renderTextBlock("examples", [
    "argocd-axi",
    "argocd-axi apps --problems",
    "argocd-axi apps view payments-api --context prod",
    "argocd-axi apps diff payments-api",
  ]),
  renderTextBlock("notes", [
    "Read-only: v1 never syncs, rolls back, refreshes or deletes; those verbs answer REFUSED with the raw argocd route (writes are on the roadmap)",
    "Output is TOON on stdout, errors included; exit 0 = success (an unhealthy app is data, not an error), 1 = error, 2 = usage",
    "Secret-looking values are redacted and counted; no flag reveals them",
    "Uses your existing argocd CLI session or ARGOCD_AUTH_TOKEN; never logs in, never reads the argocd config file",
  ]),
])}\n`;
