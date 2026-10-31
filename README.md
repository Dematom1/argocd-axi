<h1 align="center">argocd-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/argocd-axi"><img alt="npm" src="https://img.shields.io/npm/v/argocd-axi?style=flat-square" /></a>
  <a href="https://github.com/Dematom1/argocd-axi/actions/workflows/ci.yml"><img alt="CI" src="https://img.shields.io/github/actions/workflow/status/Dematom1/argocd-axi/ci.yml?style=flat-square&label=ci" /></a>
  <a href="https://github.com/Dematom1/argocd-axi/actions/workflows/release-please.yml"><img alt="Release" src="https://img.shields.io/github/actions/workflow/status/Dematom1/argocd-axi/release-please.yml?style=flat-square&label=release" /></a>
  <a href="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%20%7C%20Linux-blue?style=flat-square" /></a>
  <a href="https://x.com/dematom1"><img alt="X" src="https://img.shields.io/badge/X-@dematom1-black?style=flat-square" /></a>
</p>

Argo CD for agents, read-only except opt-in writes on writable contexts. `argocd-axi` wraps the `argocd` CLI and answers
the questions an agent asks during a deployment problem (which apps need
attention and why, what differs from Git, what was deployed when, what the
pods are logging, whether a sync is allowed right now) in compact
[TOON](https://toonformat.dev/) output that follows the
[AXI](https://github.com/kunchenguid/axi) conventions.

```
$ argocd-axi
bin: ~/.local/bin/argocd-axi
description: Argo CD for agents: read operations plus opt-in writes on writable contexts
context: prod
server: argocd.example.com
auth: argocd CLI session for this context
user: alice
apps: "142 total, 3 need attention, 1 operation running"
writableContexts: none
attention[3]{app,project,sync,health,why}:
  payments-api,payments,OutOfSync,Degraded,"OutOfSync; Degraded: Deployment \"payments-api\" exceeded its progress deadline; last sync Failed: ..."
  legacy,default,Unknown,Unknown,"sync Unknown; health Unknown; ComparisonError: ..."
  checkout,shop,Synced,Progressing,Progressing for 25m
operations[1]{app,phase,started}:
  checkout,Running,25m ago
help[2]: Run `argocd-axi apps view <app>` to diagnose an application,Run `argocd-axi apps` to list every application
```

## Why

The raw `argocd` CLI is built for people. An agent using it has to cope with
wide tables or very large JSON, `app diff` exiting 1 when it finds drift,
`app history` having no JSON output, prompts and browser logins, `logs -f` and
`app wait` that can hang, and Secret data in `app manifests --source live`.
argocd-axi turns that into small, definitive answers:

- **Problems first.** Every list sorts the apps that need attention to the
  top and says why, in one line, with `count: N of M total`.
- **Summary first.** Diffs and manifests come back as a per-resource list;
  the raw text is one `--full` away.
- **Opt-in writes.** `apps sync <app>` previews the per-resource diff and
  makes no change unless `--confirm` is passed. It never prunes unless
  `--prune` is explicit. Resource actions and automated-sync changes also
  preview by default and execute only on configured writable contexts.
- **Safe output.** Secret data, passwords, tokens and sensitive-looking Helm
  parameters are redacted and counted. No flag reveals them.
- **Never hangs.** Nothing streams or follows; waits are bounded; no prompt can
  block because argocd never gets a stdin.

## Quick start

Install the published package:

```sh
npm install -g argocd-axi
argocd-axi setup hooks
```

Or run without installing: `npx -y argocd-axi`. The session hook requires a global install.

Requirements:

- Node.js 22.12 or newer.
- The [`argocd` CLI](https://argo-cd.readthedocs.io/en/stable/cli_installation/)
  on `PATH`, ideally matching your server's version. Tested with argocd
  v3.3.6. There is no hard minimum; `ctx` and the home view warn when the CLI
  and server differ by a major version.

## Setup

argocd-axi adds no auth of its own. It uses whatever the `argocd` CLI already
has: the current context's session, or `ARGOCD_SERVER` and
`ARGOCD_AUTH_TOKEN` from the environment. It never starts a login, never
prompts, and never reads the argocd config file (`~/.config/argocd/config`,
which holds clear-text tokens). A missing session answers `AUTH_REQUIRED`; an
expired or rejected login answers `AUTH_EXPIRED`. When the target server is
known, help includes the exact operator login command; otherwise it shows the
login syntax and asks for the server address. Run
`argocd-axi auth guide` for offline setup instructions. Human operators run
`argocd login <server> --sso --grpc-web` interactively themselves. Agents and
CI should set `ARGOCD_SERVER` and `ARGOCD_AUTH_TOKEN` from a scoped account
token. Verify the selected context with `argocd-axi ctx`. The tool never logs in.

### Scoped agent credentials

An agent that uses your own SSO session has all of your Argo CD permissions.
The recommended agent credential is a **short-lived project-role token**,
scoped to read (and later, sync only where you want it), so the server bounds
what the agent can do whatever any tool does:

```sh
# A human runs these, once per project and role:
argocd proj role create payments agent-read
argocd proj role add-policy payments agent-read --action get --permission allow --object '*'
argocd proj role add-policy payments agent-read --action get --permission allow --object '*' --resource logs
export ARGOCD_AUTH_TOKEN="$(argocd proj role create-token payments agent-read --expires-in 8h --token-only)"
```

A project role only adds permissions. Argo CD also grants every token the
server's `policy.default` role (from `argocd-rbac-cm`), so with
`policy.default: role:readonly` this token can read every project, not just
`payments`. For a token that is really project-scoped, keep `policy.default`
empty or minimal and review the effective policies in `argocd-rbac-cm`.
`can-i` checks one object literally (`'other-project/*'` is not "any app in
other-project"), so a `no` there proves nothing about other apps; spot-check
concrete apps instead, e.g. `argocd-axi can-i get applications
'other-project/some-app'`.

argocd-axi itself refuses `proj role create-token`, `account generate-token`
and every other command that prints or changes a credential.

## Agent integration

Pick one; you do not need both.

- **Session hook (recommended).** `argocd-axi setup hooks` installs a
  SessionStart hook for Claude Code, Codex and OpenCode. The hook runs
  `argocd-axi-ctx`, which is local only: current context, server, CLI version
  and the cached server version. It makes no network call, triggers no SSO
  refresh and reads no credential, so a dead context can never hang a session
  start. It needs a persistent install (`npm install -g argocd-axi`); run from
  an npx cache, it answers `REFUSED` because the hook would point at a
  temporary path.
- **Skill.** `npx skills add Dematom1/argocd-axi --skill argocd-axi`
  installs [`skills/argocd-axi/SKILL.md`](skills/argocd-axi/SKILL.md), which
  is generated from the CLI's own help and loads when a task is about Argo CD.

## Usage

```
argocd-axi                                   live overview (needs the server)
argocd-axi ctx [--context <c>]               current context, server, CLI version (local only)
argocd-axi ctx use <context>                 switch the argocd CLI's current context
argocd-axi whoami                            user, issuer and groups
argocd-axi can-i <action> <resource> <obj>   ask Argo CD RBAC, e.g. can-i sync applications 'payments/payments-api'
argocd-axi apps [--problems --project --selector --repo --cluster --sync --health --limit --fields]
argocd-axi apps view <app> [--full]
argocd-axi apps resources <app> [--problems | --orphaned]
argocd-axi apps diff <app> [--revision <rev>] [--full]
argocd-axi apps sync <app> [--confirm] [--prune] [--timeout <s>] --context <c>
argocd-axi apps auto-sync <app> <on|off> [--confirm] --context <c>
argocd-axi apps history <app> [--limit <n>]
argocd-axi apps manifests <app> [--source git|live] [--revision <rev>] [--kind <k>] [--full]
argocd-axi apps logs <app> [--kind <k> --name <n>] [--tail 100] [--since 15m] [--filter <s>] [--full] [-p]
argocd-axi apps wait <app> [--sync --health --operation] [--timeout 120]
argocd-axi apps actions <app> [--kind <k>]
argocd-axi apps actions run <app> <action> --kind <k> --name <resource> [--confirm] --context <c>
argocd-axi projects | projects view <p> | projects windows <p>
argocd-axi appsets | appsets view <name> | appsets generate <file>
argocd-axi repos | clusters
argocd-axi setup hooks
argocd-axi update [--check]
```

Every command takes `--context <name>` to target another Argo CD context, and
`--help` for its flags and examples. Flags always come after the command.
Apps in other namespaces are addressed as `namespace/name`.

### What "needs attention" means

An app needs attention when its sync status is OutOfSync or Unknown; its
health is Degraded, Missing or Unknown; it has been Progressing for more than
10 minutes; its last sync Failed or Errored; or it has conditions. Both axes
and the reason are always shown, and Progressing is never folded into
healthy. When Argo CD does not report when health turned Progressing, the
duration is shown as unknown and the app is not counted as needing attention.

### Sync windows

`projects windows <project>` lists each window, whether it is active now, and
when an inactive one next opens, then says whether automated and manual syncs
are allowed right now. It evaluates the windows the way Argo CD does (5-field
cron schedule or a descriptor such as `@daily` or `@every 1h`, duration, the
window's time zone or UTC). When a window that could change the outcome cannot
be evaluated, the verdict is `unknown` and names that window. The verdict assumes
every window applies; check each window's apps, namespaces and clusters for a
specific app.

## Output and exit codes

- Output is TOON on stdout, errors included: `error`, `code`, and `help` with
  the next command to run. There is no `--json`; the raw `argocd` CLI is the
  fallback for anything argocd-axi does not cover.
- Exit 0 means the command did what was asked. An OutOfSync or Degraded app,
  drift found by `apps diff`, a `can-i` answer of no, and an `apps wait` that
  timed out are all data with exit 0.
- Exit 1 is an error, exit 2 a usage error (unknown flag, missing argument).
  Unknown flags are rejected before any argocd call, with the valid flags
  listed.

| Code                              | Meaning                                                                                       |
| --------------------------------- | --------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                | Bad flag or argument (exit 2)                                                                 |
| `AUTH_REQUIRED`                   | No session is configured                                                                      |
| `AUTH_EXPIRED`                    | Argo CD rejected or expired the login; help prints the exact command when the server is known |
| `FORBIDDEN`                       | Argo CD RBAC denied it (Argo CD also says this for objects in projects you cannot see)        |
| `NOT_FOUND`                       | No such app, project or ApplicationSet                                                        |
| `RATE_LIMITED`                    | The server asked to slow down                                                                 |
| `SERVER_UNREACHABLE`              | Network or TLS failure reaching the server                                                    |
| `REFUSED`                         | A verb argocd-axi does not run, with the reason and the human route                           |
| `NO_CONTEXT`, `CONTEXT_NOT_FOUND` | No current context, or `--context` names one that is not configured                           |
| `TIMEOUT`                         | argocd did not answer in time                                                                 |
| `ARGOCD_NOT_INSTALLED`            | No `argocd` on `PATH`                                                                         |
| `CONFIG_INVALID`                  | argocd-axi's own config file is malformed                                                     |
| `UPSTREAM_ERROR`                  | Any other argocd failure, with its cleaned message                                            |

## Safety model

- **One subprocess seam.** Every argocd call goes through `src/argocd.ts`,
  which accepts only operations from the allowlist registry in
  `src/registry.ts`. Every registered operation is a server read or a
  local-config operation. The seam also refuses streaming, refresh, prompt,
  local-file and delete flags whatever a command passes, gives argocd no
  stdin, and enforces a timeout and an output cap. Tests fail if a new
  operation becomes reachable without updating the registry.
- **Opt-in Application writes.** Sync, rollback, refresh, terminate-op, resource actions and automated-sync changes require an explicit context, preview and `--confirm`; execution is limited by `writable-contexts` and Argo CD RBAC. Other writes and credential commands answer `REFUSED`.
- **Redaction.** Kubernetes Secret `data`, `stringData` and their
  last-applied annotation, values under sensitive-looking keys, and env-var or
  Helm-parameter pairs with sensitive-looking names are replaced with
  `[redacted]`, and the output says how many values were hidden. Free text
  (log lines, diff text) is redacted line by line on a best-effort basis:
  `key=value` pairs, bearer tokens, JWTs and URL passwords. Repository and
  cluster rows are built from an explicit field list, so credentials never
  reach them.
- **Writable contexts.** argocd-axi's own config file,
  `~/.config/argocd-axi/config` (or `$XDG_CONFIG_HOME/argocd-axi/config`),
  holds the allowlist of contexts where Application writes may execute.
  It defaults to none. To allow writes on a context, a human runs
  `argocd-axi ctx writable add <context>` in a terminal and confirms the exact
  context name. Use `argocd-axi ctx writable remove <context>` to revoke access.

- **Version cache.** The server version is checked at most once every 12
  hours per context and server, and cached in `~/.cache/argocd-axi/`
  (`$XDG_CACHE_HOME`). This file holds version strings only.

## Development

Build from source and run checks:

```sh
npm install
npm run build
npm run check   # format, lint, typecheck, tests, skill drift check
```

Tests never touch a real Argo CD server, cluster, kubeconfig or credential.
They run the built CLI as a user would, with a fake `argocd`
(`test/fake-argocd/`) as the only executable on `PATH`. The fake answers from
the recorded fixtures in `test/fixtures/`, and each test gets a throwaway
`HOME`. After changing help text, run `npm run build:skill` to regenerate the
skill.

## Releases

Releases are cut by [release-please](https://github.com/googleapis/release-please)
from conventional commits (`feat:`, `fix:`, `docs:`, ...) on `main`. It keeps
a release PR open that bumps the package version, updates `src/version.ts`,
and updates `CHANGELOG.md`; merging
that PR tags the release and publishes it to npm from
`.github/workflows/release-please.yml` through npm trusted publishing, with
provenance and no stored npm token. Each release is staged: after the workflow
runs, approve the staged version with 2FA using `npm stage approve <id>` or
npmjs.com. The version is not live on npm until approved. `CHANGELOG.md` and
`.release-please-manifest.json` are generated, so never edit them by hand.

If a release was tagged but its publish failed, re-run the publish on that tag
(the run must be dispatched on the tag so the provenance names its commit):

```sh
gh workflow run release-please.yml --ref v0.1.1 -f tag=v0.1.1
```

A version that is staged but not yet approved does not count as published, so
re-running would try to stage it again and fail. Approve or discard the staged
version instead.

## License

[MIT](LICENSE)
