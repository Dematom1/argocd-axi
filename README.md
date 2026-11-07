<h1 align="center">argocd-axi</h1>

<p align="center">
  <a href="https://www.npmjs.com/package/argocd-axi"><img alt="npm" src="https://img.shields.io/npm/v/argocd-axi?style=flat-square" /></a>
  <a href="https://www.npmjs.com/package/argocd-axi"><img alt="npm downloads" src="https://img.shields.io/npm/dw/argocd-axi?style=flat-square" /></a>
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
attention[3]{app,sync,health,why}:
  payments-api,OutOfSync,Degraded,"Degraded: Deployment \"payments-api\" exceeded its progress deadline; last sync Failed: ..."
  legacy,Unknown,Unknown,"ComparisonError: ..."
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
  `apps diff --full` adds the redacted, line-oriented diff.
- **Opt-in writes.** `apps sync <app>` previews the per-resource diff and
  makes no change unless `--confirm` is passed. It never prunes unless
  `--prune` is explicit. Selective sync can target managed resources with
  `--resource`; see [write completion and migration](#write-completion-and-migration).
  Resource actions and automated-sync changes also preview by default and
  execute only on configured writable contexts.
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
- Windows is not tested or supported yet. The config/cache paths, credential
  handling, Claude Code hook installation and session-end, and printed-command
  shell quoting are implemented, but their compatibility with Windows has not
  been validated.

## Setup

argocd-axi adds no auth of its own. It uses whatever the `argocd` CLI already
has: the current context's session, or `ARGOCD_SERVER` and
`ARGOCD_AUTH_TOKEN` from the environment. It never starts a login, never
prompts, and never reads the argocd config file (`~/.config/argocd/config`,
which holds clear-text tokens). A missing session answers `AUTH_REQUIRED`; an
expired or rejected login answers `AUTH_EXPIRED`. When the target server is
known, CLI-session help includes the exact operator login command; otherwise it
shows the login syntax and asks for the server address. With `ARGOCD_AUTH_TOKEN`
set, failures instead request a replacement token: there is no SSO or stored
CLI-session fallback. Run
`argocd-axi auth guide` for offline setup instructions. Human operators run
`argocd login <server> --sso --grpc-web` interactively themselves. Agents and
CI should set `ARGOCD_SERVER` and `ARGOCD_AUTH_TOKEN` from a scoped account
token. Verify the selected context with `argocd-axi ctx` and live identity with
`argocd-axi whoami`. If `ARGOCD_SERVER` is set and a context is selected, it must
exactly match that context's configured server; a mismatch is rejected before
network requests, including writes. Unset the override or select the matching
context. The tool never logs in.

`whoami` and `auth guide` show `tokenExpiry` without printing the token:
`expires <timestamp>`, `expired <timestamp>`, `non-expiring`, `unknown` for
malformed JWT/expiry metadata, or `not configured`. JWT metadata is decoded
locally and **unverified**: it is scheduling information, not proof of identity,
validity or revocation status. Non-expiring tokens remain supported; prefer a
short lifetime and rotate before expiry. Live requests still rely on Argo CD to
validate the credential. `auth guide` is offline and does not validate it. Validation against a real Argo CD server awaits a separately provisioned dedicated credential and explicit action approval.

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
'other-project/some-app'`. A bare app name (no `project/` prefix) for
`applications`, `logs` or `exec` is resolved to its project first, and the
answer shows which project was used; if the app cannot be found, `can-i`
errors instead of answering `no`.

argocd-axi itself refuses `proj role create-token`, `account generate-token`
and every other command that prints or changes a credential.

Normal and hard `apps refresh` require `applications,get`, not `update`.
`apps terminate-op` requires `applications,sync`, not `update`; that permission
also permits sync and rollback. Both retain the writable-context and `--confirm`
gates. Do not broaden token grants to work around a wrapper preflight.
These checks follow [Argo CD v3.4.12's application server](https://github.com/argoproj/argo-cd/blob/v3.4.12/server/application/application.go)
(`Get` and `TerminateOperation`); server RBAC remains authoritative.

## Agent integration

Pick one; you do not need both.

- **Session hook (recommended).** `argocd-axi setup hooks` installs
  SessionStart hooks for Claude Code, Codex and OpenCode, plus a Claude Code
  SessionEnd hook. The start hook runs `argocd-axi-ctx`, which is local only:
  current context, server, CLI version and the cached server version. It makes
  no network call, triggers no SSO refresh and reads no credential, so a dead
  context can never hang a session start. The end hook records only argocd-axi
  command names, their counts and the most-used `--context` value for that
  working directory; it does not save arguments or other values. The session
  log is limited to 100 directories and stored with `0600` permissions. Run
  `argocd-axi context` to view the current directory's last session.
  `argocd-axi setup status` verifies installed hooks across integrations; use
  `argocd-axi setup uninstall` to remove all managed SessionStart and SessionEnd
  hooks and the OpenCode plugin. The shared Codex hooks feature flag is
  preserved. SessionStart removal also checks `CLAUDE_CONFIG_DIR/settings.json`
  so hooks installed in an alternate Claude config are removed; unrelated hooks
  remain untouched. SessionEnd honors `CLAUDE_CONFIG_DIR`.
  Hooks need a persistent install (`npm install -g argocd-axi`); setup refuses
  an npx-cache
  install because hooks would point at a temporary path.
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
# Default columns: app, sync, health, why; add project with --fields project
argocd-axi apps view <app> [--full]
argocd-axi apps resources <app> [--problems | --orphaned]
argocd-axi apps diff <app> [--revision <rev>] [--full]
argocd-axi apps sync <app> [--resource <GROUP:KIND:NAME>]... [--confirm] [--prune] [--timeout <s>] [--context <c>]
# --confirm starts the operation and returns; --timeout bounds the request, not deployment
argocd-axi apps auto-sync <app> <on|off> [--confirm] [--context <c>]
argocd-axi apps history <app> [--limit <n>]
argocd-axi apps manifests <app> [--source git|live] [--revision <rev>] [--kind <k>] [--full]
argocd-axi apps logs <app> [--kind <k> --name <n>] [--tail 100] [--since 15m] [--filter <s>] [--full] [-p]
argocd-axi apps wait <app> [--sync --health --operation] [--timeout 120] [--fail-on-degraded]
argocd-axi apps actions <app> [--kind <k>]
argocd-axi apps actions run <app> <action> --kind <k> --name <resource> [--confirm] [--context <c>]
argocd-axi projects | projects view <p> | projects windows <p>
argocd-axi appsets | appsets view <name> | appsets generate <file>
argocd-axi repos | clusters
argocd-axi context [end]
argocd-axi setup hooks | status | uninstall
argocd-axi update [--check]
```

Commands take `--context <name>` to target another Argo CD context; write commands use the sole writable context when omitted. `--help` lists flags and examples. Flags always come after the command.
Apps in other namespaces are addressed as `namespace/name`.

### What "needs attention" means

### Write completion and migration

`apps sync --resource GROUP:KIND:NAME` previews the selected resources and, with `--confirm`, syncs only those managed resources. Use `GROUP:KIND:NAMESPACE/NAME` to disambiguate namespaced resources, or an empty group for core kinds such as `:Service:my-svc`. Repeat `--resource` to select several resources. Unknown or malformed specs are refused before submission. Selective sync does not run resource hooks or record the sync in application history, so it cannot be rolled back from that history.

`apps sync --confirm` returns `sync: started` when the server accepts the async
operation. It prints the target revision, the last observed revision, and commands
to inspect or wait. Acceptance is not deployment success. An operation already
running returns `sync: already running` with exit 0, without submitting another sync.
A race rejected by the server has the same result.

For callers that previously assumed sync blocked, add a separate wait before
dependent steps:

```sh
argocd-axi apps sync <app> --context <context> --confirm
argocd-axi apps wait <app> --context <context> --timeout 300
argocd-axi apps view <app> --context <context>
```

Inspect the structured wait result before proceeding: timeout returns exit 1 with
`condition not met`, not deployment success. `apps view` shows operation failures
and the resolved operation revision. A requested branch or tag may move after
submission; the sync response does not claim that the last observed commit is the
new operation's commit.

Long-running Application writes:

- `apps sync`: submits with `--async`; no completion wait.
- `apps actions run`: submits the action; no resource-health polling.
- `apps terminate-op`: requests termination; no completion wait. No running
  operation is a successful no-op.
- `apps auto-sync`: submits the policy update; no convergence polling.
- `apps rollback`: the native CLI blocks until rollback finishes. There is no
  native async flag. `--timeout` bounds the native wait, with a 10-second hard
  subprocess grace. No additional wrapper wait runs.
- `apps refresh` (including `--hard`): the native CLI blocks for reconciliation.
  `--timeout` bounds the subprocess (default 120 seconds).

`apps wait`, rollback, and refresh print elapsed-time progress to stderr immediately
and every 5 seconds. Structured final output stays on stdout. For sync, actions,
termination, and policy updates, `--timeout` bounds submission only (default 120
seconds). A request timeout does not prove the server rejected the write. Inspect
`apps view` before retrying. Local configuration, context, and setup writes do not
wait for deployment.

`apps sync` returns on acceptance, not deployment completion. For app-of-apps,
run `argocd-axi apps wait <parent>` before acting on children. A child may not
exist yet even when Argo CD answers permission denied. For a named app denied
by RBAC, the tool checks the visible app list and explains this possibility
when the app is absent. Absence can also mean RBAC hides the app.
An already-synced app with no running operation or resource drift is a clean
sync no-op: nothing is submitted. With `--resource`, only selected resources
that are not Synced or need pruning are submitted. If every selected resource
is Synced and none needs pruning, the command is a no-op even if other
resources in the app are out of sync. No-op decisions use the last Argo CD
comparison, which can lag recent Git changes. The no-op result suggests
`apps refresh <app> --confirm` before retrying sync; refresh requires write approval.

`apps wait` checks whether all requested conditions hold now; it does not wait
for a future operation. Synced and Healthy with no running or pending operation
satisfies `--operation`, even without historical `operationState`. Missing,
Degraded and not-yet-existing apps keep polling until the timeout. Use
`--fail-on-degraded` to stop immediately on Degraded. Timeout exits 1 and reports
each unmet condition, the last state, and up to 20 blocking resources with their
messages and total count. Re-running wait only observes state and never submits
work. Rate-limited polls retry with increasing delays from 1 to 10 seconds,
bounded by the same timeout. A timeout retains the last observed state and
identifies a rate-limited final poll.

A sync wait returns promptly as `sync: prune-only drift` with exit 1 when the
last operation Succeeded and every non-Synced resource is OutOfSync and requires
pruning. This is not Synced. Valid `reconciledAt` and `operationState.finishedAt`
timestamps must establish reconciliation at or after completion; stale or unknown
snapshots keep polling. The result names the blocking resources and suggests
`argocd-axi apps sync <app> --prune --confirm --context <read-context>`, pinned to
the explicit or current context used by the wait, not the sole writable context.
If no read context can be established, the result suggests `argocd-axi ctx`
instead of a confirmed prune command. Wait never performs that write. Health-only and operation-only waits ignore
unrequested sync drift.

An app needs attention when its sync status is OutOfSync or Unknown; its
health is Degraded, Missing or Unknown; it has been Progressing for more than
10 minutes; its last sync Failed or Errored; or it has conditions. Both axes
and the reason are always shown, and Progressing is never folded into
healthy. When Argo CD does not report when health turned Progressing, the
duration is shown as unknown and the app is not counted as needing attention.

### Idempotency contract

Reads do not submit mutations or write wrapper state files. The home view checks
versions without persisting a cache. `ctx` can still read a legacy version cache;
only explicit `context end` records session memory. Values can change as the server
changes, so repeatability means no extra effects, not byte-identical output.

This inventory follows `COMMANDS` in `src/cli.ts`, its nested command specs,
`REFUSALS` in `src/registry.ts`, and the SDK's `update` built-in. Application
writes still require the writable-context gate and `--confirm`. Satisfied desired
states return exit 0 with `already-done`; observed partial states return exit 0
with `in-progress`. Native reads are allowed on a no-op.

| Command                                                                                                                          | Class       | Retry contract (and previous write behavior)                                                                                                                                                                                                                                                                        |
| -------------------------------------------------------------------------------------------------------------------------------- | ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| No arguments                                                                                                                     | Read        | Live overview; no files changed. Previously persisted the version check.                                                                                                                                                                                                                                            |
| `ctx`                                                                                                                            | Read        | Local context and version inspection only.                                                                                                                                                                                                                                                                          |
| `auth guide`                                                                                                                     | Read        | Offline credential instructions only.                                                                                                                                                                                                                                                                               |
| `whoami`                                                                                                                         | Read        | Identity lookup only.                                                                                                                                                                                                                                                                                               |
| `can-i`                                                                                                                          | Read        | Permission lookup only; both yes and no exit 0.                                                                                                                                                                                                                                                                     |
| `apps`                                                                                                                           | Read        | Application list only.                                                                                                                                                                                                                                                                                              |
| `apps view`                                                                                                                      | Read        | Application state only.                                                                                                                                                                                                                                                                                             |
| `apps resources`                                                                                                                 | Read        | Managed or orphaned resource lookup only.                                                                                                                                                                                                                                                                           |
| `apps diff`                                                                                                                      | Read        | No refresh or mutation, including `--full` and `--revision`; drift exits 0.                                                                                                                                                                                                                                         |
| `apps history`                                                                                                                   | Read        | Deployment history lookup only.                                                                                                                                                                                                                                                                                     |
| `apps manifests`                                                                                                                 | Read        | Rendered Git or live manifests only.                                                                                                                                                                                                                                                                                |
| `apps logs`                                                                                                                      | Read        | Bounded log lookup only.                                                                                                                                                                                                                                                                                            |
| `apps actions`                                                                                                                   | Read        | Resource-action listing only.                                                                                                                                                                                                                                                                                       |
| `apps wait`                                                                                                                      | Read        | Re-entrant bounded observation; wait/sync changes are maintained separately.                                                                                                                                                                                                                                        |
| `apps sync`                                                                                                                      | Write       | Existing operations report already running; already-synced handling is maintained in the separate wait/sync change.                                                                                                                                                                                                 |
| `apps rollback`                                                                                                                  | Write       | Same full revision(s), Synced, no running operation: already-done, no rollback. Matching running target: in-progress. Previously submitted another rollback. OutOfSync at the same revision still needs rollback.                                                                                                   |
| `apps terminate-op`                                                                                                              | Write       | No operation: already-done. Terminating: in-progress. Neither submits termination. A native no-operation race is re-read before reporting success. Previously re-submitted termination while Terminating and errored on the race.                                                                                   |
| `apps auto-sync`                                                                                                                 | Write       | Requested policy already on/off: already-done, no `app set`; preserves prune/self-heal. Includes `automated.enabled: false`. Previously submitted another update.                                                                                                                                                   |
| `apps refresh`                                                                                                                   | Reconcile   | Repeats reconciliation, including `--hard`, and returns current sync, health and revision. Same desired end state; an additional native refresh is intentional. Previously repeated refresh and reported only submission.                                                                                           |
| `apps actions run`                                                                                                               | Event       | Built-in Rollout promote/promote-full/resume on Healthy: already-done. Those actions, or a built-in workload restart, on Progressing: in-progress. Neither submits an action. Otherwise executes a listed, enabled action. Previously submitted again or errored when the action became disabled. See limits below. |
| `ctx use`                                                                                                                        | Local write | Already-current context: already-done, no native switch. Previously already a no-op.                                                                                                                                                                                                                                |
| `ctx writable` / `ctx writable list`                                                                                             | Read        | Allowlist inspection; bare `ctx writable` reports usage without changing state.                                                                                                                                                                                                                                     |
| `ctx writable add`                                                                                                               | Local write | Existing named grant: already-done, no prompt or file rewrite. A new grant still requires interactive confirmation. Previously refused even the no-op without a terminal.                                                                                                                                           |
| `ctx writable remove`                                                                                                            | Local write | Missing grant: already-done, no file rewrite. Previously already a no-op, without the explicit already-done result.                                                                                                                                                                                                 |
| `context`                                                                                                                        | Read        | Reads optional session memory only.                                                                                                                                                                                                                                                                                 |
| `context end`                                                                                                                    | Local write | Same summary: already-done, no session-file rewrite. Partial atomic writes leave the prior summary intact. Previously rewrote an identical summary.                                                                                                                                                                 |
| `setup hooks`                                                                                                                    | Local write | Installs or repairs missing hooks; repeated installation converges. Hook-file no-op behavior is maintained by the separate setup change.                                                                                                                                                                            |
| `setup status`                                                                                                                   | Read        | Hook inspection only.                                                                                                                                                                                                                                                                                               |
| `setup uninstall`                                                                                                                | Local write | Removes managed SessionStart/SessionEnd hooks and the OpenCode plugin; missing SessionEnd hooks are a successful no-op. SessionStart removal failures return `UPSTREAM_ERROR` after attempting SessionEnd removal. Fix the reported paths' permissions and retry.                                                   |
| `update --check` / `update --dry-run`                                                                                            | Read        | SDK registry lookup, no installation; package-manager fallback can maintain its own cache.                                                                                                                                                                                                                          |
| `update`                                                                                                                         | Local write | SDK skips installation when current is latest, reports already on the latest version. A newer registry release changes the desired target. Partial installation repair belongs to the detected package manager.                                                                                                     |
| `--help` / per-command `--help`, `-v` / `-V` / `--version`                                                                       | Read        | Static help or version, no mutation.                                                                                                                                                                                                                                                                                |
| `login`, `relogin`, `logout`, `configure`, `account`, `repocreds`, `cert`, `gpg`, `admin`                                        | Refused     | Repeatable nonzero refusal, no effects.                                                                                                                                                                                                                                                                             |
| `apps create`, `apps edit`, `apps delete`, `apps delete-resource`, `apps patch-resource`, `apps set`, `apps unset`, `apps patch` | Refused     | Repeatable nonzero refusal, no effects.                                                                                                                                                                                                                                                                             |
| `projects role`, `projects create`, `projects delete`, `projects edit`, `projects set`                                           | Refused     | Repeatable nonzero refusal, no effects.                                                                                                                                                                                                                                                                             |
| `appsets create`, `appsets delete`                                                                                               | Refused     | Repeatable nonzero refusal, no effects.                                                                                                                                                                                                                                                                             |
| `repos add`, `repos rm`, `clusters add`, `clusters rm`, `clusters set`, `clusters rotate-auth`                                   | Refused     | Repeatable nonzero refusal, no effects.                                                                                                                                                                                                                                                                             |
| `projects`, `projects view`, `projects windows`                                                                                  | Read        | Project and sync-window lookup only.                                                                                                                                                                                                                                                                                |
| `appsets`, `appsets view`, `appsets generate`                                                                                    | Read        | Listing, lookup or generation preview only; generate does not create Applications.                                                                                                                                                                                                                                  |
| `repos`, `clusters`                                                                                                              | Read        | Inventory lookup only.                                                                                                                                                                                                                                                                                              |

**Event limits:** actions use the target resource's observed Argo CD health, not
an execution receipt. `Progressing` suppresses another restart or advancement
while that workload is rolling, including a rollout started elsewhere. A deliberate
repeat after completion can run again, especially restart. Arbitrary custom
actions have no generic target-state test and remain repeatable events. Concurrent
calls before progress becomes visible can both submit. A retry after interruption
cannot be distinguished from an intentional repeat beyond this state check. No
request keys or exactly-once guarantee are provided. Refresh is repeatable
reconciliation, not a deduplicated event.

The fixture checks run with `npm test -- test/idempotency.test.ts`. They retain
native state between invocations, count mutation calls, and compare local state
contents and modification times. Setup, wait and sync have separate owners and
checks; package installation is never exercised against a real installation.

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
  the next command to run. `apps diff --full` is the exception: its structured
  summary is followed by redacted plain-text diff lines. There is no `--json`;
  the raw `argocd` CLI is the fallback for anything argocd-axi does not cover.
- Exit 0 means the command did what was asked. An OutOfSync or Degraded app,
  drift found by `apps diff`, and a `can-i` answer of no are data with exit 0.
  `apps wait` exits 1 if its conditions are not met before timeout or if
  `--fail-on-degraded` stops the wait.
- Exit 1 is an error, exit 2 a usage error (unknown flag, missing argument).
  Unknown flags are rejected before any argocd call, with the valid flags
  listed.

| Code                              | Meaning                                                                                                  |
| --------------------------------- | -------------------------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                | Bad flag or argument (exit 2)                                                                            |
| `AUTH_REQUIRED`                   | No session is configured                                                                                 |
| `AUTH_EXPIRED`                    | Argo CD rejected the credential; token users must replace it, while CLI-session users get login guidance |
| `FORBIDDEN`                       | Argo CD RBAC denied it (Argo CD also says this for objects in projects you cannot see)                   |
| `NOT_FOUND`                       | No such app, project or ApplicationSet                                                                   |
| `RATE_LIMITED`                    | The server asked to slow down                                                                            |
| `SERVER_UNREACHABLE`              | Network or TLS failure reaching the server                                                               |
| `REFUSED`                         | A verb argocd-axi does not run, with the reason and the human route                                      |
| `NO_CONTEXT`, `CONTEXT_NOT_FOUND` | No current context, or `--context` names one that is not configured                                      |
| `TIMEOUT`                         | argocd did not answer in time                                                                            |
| `ARGOCD_NOT_INSTALLED`            | No `argocd` on `PATH`                                                                                    |
| `CONFIG_INVALID`                  | argocd-axi's own config file is malformed                                                                |
| `UPSTREAM_ERROR`                  | Any other argocd failure, with its cleaned message                                                       |

## Safety model

- **One subprocess seam.** Every argocd call goes through `src/argocd.ts`,
  which accepts only operations from the allowlist registry in
  `src/registry.ts`. Registered operations declare server reads, local operations,
  or opt-in Application writes. The seam refuses streaming, refresh (except
  the registered refresh write), prompt, local-file and delete flags, gives argocd no
  stdin, and enforces a timeout and an output cap. Tests fail if a new
  operation becomes reachable without updating the registry.
- **Opt-in Application writes.** Sync, rollback, refresh, terminate-op, resource actions and automated-sync changes preview by default and require `--confirm` to execute; when `--context` is omitted, exactly one configured `writable-contexts` entry is selected. With zero or multiple entries, pass `--context` explicitly. Execution is limited by `writable-contexts` and Argo CD RBAC. Other writes and credential commands answer `REFUSED`.
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
  It defaults to none. To allow writes, a human runs
  `argocd-axi ctx writable add` in a terminal to select a configured context,
  or passes `<context>` directly; either path requires an explicit y/yes
  confirmation. Non-interactive grants are refused unless the named context is
  already writable, in which case the command is a no-op. Use
  `argocd-axi ctx writable remove <context>` to revoke access.

- **Version checks.** The home view queries versions without writing files.
  The local `ctx` view can read a legacy version cache from `~/.cache/argocd-axi/`
  (`$XDG_CACHE_HOME`) but does not create or update it. A recent legacy entry
  can also satisfy the home view's version check for up to 12 hours.

## Development

To contribute, read [CONTRIBUTING.md](CONTRIBUTING.md) first.

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
