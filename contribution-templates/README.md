# Contribution templates

Canonical onboarding files shared by the AXI tools. Each tool keeps a rendered copy; there is no sync bot, so a change here is copied to each consumer in a normal reviewed pull request.

| Source                               | Copy to                                      |
| ------------------------------------ | -------------------------------------------- |
| `CONTRIBUTING.md`                    | `CONTRIBUTING.md`                            |
| `ISSUE_TEMPLATE/bug_report.yml`      | `.github/ISSUE_TEMPLATE/bug_report.yml`      |
| `ISSUE_TEMPLATE/feature_request.yml` | `.github/ISSUE_TEMPLATE/feature_request.yml` |
| `ISSUE_TEMPLATE/config.yml`          | `.github/ISSUE_TEMPLATE/config.yml`          |
| `PULL_REQUEST_TEMPLATE.md`           | `.github/PULL_REQUEST_TEMPLATE.md`           |
| `.coderabbit.yaml`                   | `.coderabbit.yaml`                           |

When copying, replace `{owner}` and `{repo}` with the repository's owner and name, and replace the "Local checks and test safety" section of `CONTRIBUTING.md` with the tool's real test commands and safety rules. Keep a tool's existing domain rules there rather than dropping them.

Each consumer also adds `.github/workflows/contribution.yml`, a thin caller of the shared [`contribution-checks.yml`](../.github/workflows/contribution-checks.yml) pinned to a reviewed commit of this repository:

```yaml
jobs:
  contribution:
    name: contribution
    uses: Dematom1/argocd-axi/.github/workflows/contribution-checks.yml@<sha>
    with:
      release-bot-login: ${{ vars.RELEASE_APP_BOT_LOGIN }}
```

Copy the triggers, permissions and concurrency from this repository's [`contribution.yml`](../.github/workflows/contribution.yml). The tool's own `ci.yml` keeps its real test lanes and adds the `full-ci` gate and `Full suite` aggregate, as this repository's [`ci.yml`](../.github/workflows/ci.yml) does.

## Consumers

- `Dematom1/argocd-axi`
- `Dematom1/argo-workflows-axi`
- `Dematom1/datadog-axi`
- `Dematom1/terraform-axi`
- `Dematom1/search-console-axi`
- `k8s-axi` (not yet published)
- `Dematom1/axi-verify` (empty; gets the bundle with its initial commit)
