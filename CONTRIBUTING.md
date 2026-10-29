# Contributing

All contributions must be raised through the no-mistakes pipeline. The PR body must contain the pipeline's required signature and attestation; the required status check verifies them. Fork CI must receive maintainer approval only after a security review of the proposed changes and workflows.

Before review, classify the PR's effect on the existing project contract:

- **restore** — returns behavior or guarantees that regressed from the existing contract. May merge after review and green checks.
- **opt-in** — adds behavior without changing existing defaults or guarantees. May merge after review and green checks.
- **new-default** — changes the default behavior or existing contract. Waits for maintainer decision; do not merge until approved.
- **cannot-tell** — available evidence is insufficient to classify the effect. Must not receive merge authority.

Maintainers approve each CI approval, public comment, close, and merge individually. There is no standing delegation.
