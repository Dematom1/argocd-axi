# Roadmap

argocd-axi supports confirmed app sync, rollback, refresh and terminate-op on
contexts explicitly listed as writable. This file records remaining write
tier work and shared safety rules.

## Remaining write tier

Resource actions such as restart, and Argo Rollouts promote and abort, remain
future work. The supported Application writes are listed in [README.md](README.md).

### Rules every write follows

The gate is built in `src/gate.ts`, with its allowlist loaded from
`src/config.ts`. New writes must use the gate and the registered operation path.

1. **Preview by default.** Without `--confirm`, no write is sent. Each write
   previews the target action before execution.
2. **A local allowlist of writable contexts, default none.** See [README.md](README.md)
   for how a human manages the allowlist.

3. **An explicit target.** Every write names `--context <name>`; the current
   context is never used implicitly, and the result echoes the context and
   server.
4. **Explicit confirmation.** Every supported Application write requires
   `--confirm` to execute.
5. **Idempotent.** Asking for a state that already exists (syncing an app
   that is already synced to the target revision, terminating when nothing
   runs) is a no-op with exit 0. Exit 1 only when the intent cannot be met:
   permission denied (`FORBIDDEN`), a sync window is closed
   (`SYNC_WINDOW_BLOCKED`), auto-sync blocks a rollback.
6. **Attributed.** Every sync carries `--info initiated-by=argocd-axi`, so
   the app's audit trail shows agent syncs. Whether `--info` is accepted
   under restricted RBAC is checked in the first real verification pass.
7. **Bounded.** A write that waits does so for about 120 seconds (`--timeout`)
   and then returns the current operation state with a hint to wait again.
   Nothing streams.
8. **Registered.** Each new argocd invocation is added to the allowlist
   registry in `src/registry.ts` under a write tier, and the registry test is
   updated in the same change.

Everything else that writes (app create, set, patch, edit and delete,
resource patch and delete, project, repository, cluster, certificate and GPG
changes, credential and token commands, `admin`) stays refused.

## Before output shapes lock: a real verification pass

All tests run against a fake `argocd` with recorded fixtures. Before the
output shapes are considered stable, one pass against a real, disposable
Argo CD (a local kind or k3d cluster) checks what the fixtures could not:

- the JSON field coverage of `app get -o json` and `app list -o json`;
- the text layout of `app diff` section headers and the `app resources
--orphaned` table;
- the JSON shape of `app actions list -o json` and `proj windows list -o json`;
- how argocd reports sync-window blocks and expired sessions;
- `--info` under restricted RBAC.

Each such pass is a separate task that asks the maintainer first.

## Tuning once instance facts are known

Default list limits, the attention threshold for Progressing apps
(10 minutes) and which features need first-class handling (ApplicationSets,
app-of-apps, apps in any namespace) are tuned once the target Argo CD
instances (version, SSO provider, app count) are known.

## AXI community catalog

Submission to the [AXI community catalog](https://github.com/kunchenguid/axi)
comes after v1. npm releases are automated; see the Releases section in
