## Pull request CI

When a fork's ordinary CI run is held for approval, `trusted-pr-ci.yml` runs the
reviewed CI definitions from the default branch against the PR's pinned merge
commit. It reports the aggregate result as the **Trusted PR CI** commit status.
The original run remains unapproved; this workflow does not approve it.

The selector requires one open PR with the same repository, branch and head as
the request. Its merge parents must match that head and the controller's base.
Changes under `.github/workflows` or `.github/scripts` are held for review.
An outdated or ambiguous request cannot select a build or status target. If the
PR or base changes during selection, a new PR update is needed to retry.

Only the source checkout changes. The existing Linux, Windows, macOS and Python
jobs run with read-only repository access, no inherited secrets, no Actions
cache access and no game packaging or uploads. Configuration logs still upload.
Separate jobs report commit status; they do not check out source or read build
artifacts. Untrusted source still executes on disposable GitHub-hosted runners.

This relies on the existing approval requirement for all external contributors
and needs no additional secret. The controller must be on the default branch.
The manual entry point can replay a held run by its run ID. GitHub's event
recursion guard can suppress follow-up events for PRs created by `GITHUB_TOKEN`;
those requests need this entry point instead of the automatic listener.
If required checks name the original CI jobs, selecting the new aggregate status
as a required check is a separate administrator decision.

Run the selector tests with `node --test .github/scripts/select-pr-ci.test.cjs`.
