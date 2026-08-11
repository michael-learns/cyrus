# Test Drive: GitHub Issue Work Items

**Date**: 2026-08-06
**Goal**: Validate GitHub Issue intake, manual agent pickup, follow-up prompting, PR creation, and source-close cleanup.
**Local Test Repo**: `/tmp/f1-test-drive-github-issues.X7IdCD/repo`
**GitHub Test Repo**: `michael-learns/cyrus-github-issues-f1` (private)

## Verification Results

### Issue Tracker

- [x] Typed `issues.opened` webhook accepted with delivery ID
- [x] Webhook did not auto-start an agent
- [x] Real GitHub Issue #1 created and fetched at manual Start time
- [x] Source issue closed automatically when its linked PR merged

### EdgeWorker

- [x] Authenticated Start returned `github-issue-f1-github-issue-1`
- [x] Worktree and branch `cyrus/gh-1-export-a-retry-delay-helper` created from `origin/main`
- [x] Claude subscription session started with GitHub tool permissions
- [x] Agent implemented, typechecked, committed, pushed, and opened PR #2 with `Fixes #1`
- [x] Human follow-up comment resumed the same Claude session
- [x] Follow-up commit updated the existing PR
- [x] Cyrus posted the PR link back to the source issue
- [x] Closing active Issue #3 stopped its runner and removed its worktree
- [x] Merging PR #2 closed Issue #1 and cleanup removed its worktree
- [x] Stop/completion race produced no false failure comment

### Renderer and Regression

- [x] Standard F1 session created and processed in an isolated worktree
- [x] Thought, action, prompt, elicitation, and response activities rendered coherently
- [x] Pagination returned the expected later activity page
- [x] Agent created local commit `f7450b8` and typecheck passed
- [x] Session stopped cleanly while the F1 server remained available

## Session Log

Key results:

```text
POST /github-webhook (issues.opened) -> 200 {"success":true}
POST /api/work-items/start -> 202 {"sessionId":"github-issue-f1-github-issue-1","status":"starting"}
GitHub PR -> https://github.com/michael-learns/cyrus-github-issues-f1/pull/2
Issue comment -> Cyrus finished the implementation. Pull request: .../pull/2
Follow-up -> README commit added to the same PR
Issue #3 close + POST /stop -> runner stopped; worktree_removed=true
PR #2 merge -> Issue #1 CLOSED; worktree removed
```

Focused automated coverage also passed:

```text
GitHubEventTransport: 124 tests passed
GitHub Issue controller/orchestration: 10 tests passed
EdgeWorker package: 759 tests passed
```

## Final Retrospective

The worker-side GitHub Issue workflow passed end to end against real GitHub using the locally authenticated Claude subscription. The hosted inbox UI and persistence still require the separate `cyrus-hosted` repository, which was not available to the authenticated GitHub account in this workspace.
