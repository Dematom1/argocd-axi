# argocd-axi

Read-only Argo CD for agents. `argocd-axi` wraps the `argocd` CLI and answers
the questions an agent asks during a deployment problem (which apps need
attention and why, what differs from Git, what was deployed when, what the
pods are logging, whether a sync is allowed right now) in compact
[TOON](https://toonformat.dev/) output that follows the
[AXI](https://github.com/kunchenguid/axi) conventions.

```
$ argocd-axi
bin: ~/.local/bin/argocd-axi
description: Read-only Argo CD for agents: applications needing attention, diffs, history, health, logs, projects and sync windows
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
help[2]:
  Run `argocd-axi apps view <app>` to diagnose an application
  Run `argocd-axi apps` to list every application
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
- **Read-only.** v1 cannot sync, roll back, refresh, delete or change
  anything. Those verbs answer `REFUSED` with the raw `argocd` command a human
  can run. Writes are on the [roadmap](ROADMAP.md).
- **Safe output.** Secret data, passwords, tokens and sensitive-looking Helm
  parameters are redacted and counted. No flag reveals them.
- **Never hangs.** Nothing streams or follows; waits are bounded; no prompt can
  block because argocd never gets a stdin.

## Install

```sh
npm install -g argocd-axi
```

Or run it without installing: `npx -y argocd-axi`.

Requirements:

- Node.js 20 or newer.
- The [`argocd` CLI](https://argo-cd.readthedocs.io/en/stable/cli_installation/)
  on `PATH`, ideally matching your server's version. Tested with argocd
  v3.3.6. There is no hard minimum; `ctx` and the home view warn when the CLI
  and server differ by a major version.

## Credentials

argocd-axi adds no auth of its own. It uses whatever the `argocd` CLI already
has: the current context's session, or `ARGOCD_SERVER` and
`ARGOCD_AUTH_TOKEN` from the environment. It never starts a login, never
prompts, and never reads the argocd config file (`~/.config/argocd/config`,
which holds clear-text tokens). When a session is missing or expired, it
answers `AUTH_REQUIRED` and tells the agent that a human runs
`argocd login <server> --sso` or `argocd relogin`.

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
argocd-axi can-i <action> <resource> <obj>   ask Argo CD RBAC, e.g. can-i sync applications 'payments/checkout'
argocd-axi apps [--problems --project --selector --repo --cluster --sync --health --limit --fields]
argocd-axi apps view <app> [--full]
argocd-axi apps resources <app> [--problems | --orphaned]
argocd-axi apps diff <app> [--revision <rev>] [--full]
argocd-axi apps history <app> [--limit <n>]
argocd-axi apps manifests <app> [--source git|live] [--revision <rev>] [--kind <k>] [--full]
argocd-axi apps logs <app> [--kind <k> --name <n>] [--tail 100] [--since 15m] [--filter <s>] [-p]
argocd-axi apps wait <app> [--sync --health --operation] [--timeout 120]
argocd-axi apps actions <app> [--kind <k>]
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

| Code                              | Meaning                                                                                |
| --------------------------------- | -------------------------------------------------------------------------------------- |
| `VALIDATION_ERROR`                | Bad flag or argument (exit 2)                                                          |
| `AUTH_REQUIRED`                   | No session or an expired one; a human logs in                                          |
| `FORBIDDEN`                       | Argo CD RBAC denied it (Argo CD also says this for objects in projects you cannot see) |
| `NOT_FOUND`                       | No such app, project or ApplicationSet                                                 |
| `RATE_LIMITED`                    | The server asked to slow down                                                          |
| `SERVER_UNREACHABLE`              | Network or TLS failure reaching the server                                             |
| `REFUSED`                         | A verb argocd-axi does not run, with the reason and the human route                    |
| `NO_CONTEXT`, `CONTEXT_NOT_FOUND` | No current context, or `--context` names one that is not configured                    |
| `TIMEOUT`                         | argocd did not answer in time                                                          |
| `ARGOCD_NOT_INSTALLED`            | No `argocd` on `PATH`                                                                  |
| `CONFIG_INVALID`                  | argocd-axi's own config file is malformed                                              |
| `UPSTREAM_ERROR`                  | Any other argocd failure, with its cleaned message                                     |

## Safety model

- **One subprocess seam.** Every argocd call goes through `src/argocd.ts`,
  which accepts only operations from the allowlist registry in
  `src/registry.ts`. Every registered operation is a server read or a
  local-config operation. The seam also refuses streaming, refresh, prompt,
  local-file and delete flags whatever a command passes, gives argocd no
  stdin, and enforces a timeout and an output cap. Tests fail if a new
  operation becomes reachable without updating the registry.
- **A refusal registry.** Known writes and credential commands answer
  `REFUSED` with a reason and the raw command a human can run instead of
  failing blind.
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
  holds the allowlist of contexts where the future write tier may execute.
  It defaults to none, and v1 only displays it:

  ```yaml
  writable-contexts:
    - staging
  ```

- **Version cache.** The server version is checked at most once every 12
  hours per context and server, and cached in `~/.cache/argocd-axi/`
  (`$XDG_CACHE_HOME`). This file holds version strings only.

## Development

```sh
npm install
npm run check   # format, lint, typecheck, tests, skill drift check
```

Tests never touch a real Argo CD server, cluster, kubeconfig or credential.
They run the built CLI as a user would, with a fake `argocd`
(`test/fake-argocd/`) as the only executable on `PATH`. The fake answers from
the recorded fixtures in `test/fixtures/`, and each test gets a throwaway
`HOME`. After changing help text, run `npm run build:skill` to regenerate the
skill.

## License

[MIT](LICENSE)
