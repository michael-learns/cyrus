# Test Drive: Slack GitHub Pull Request Actions

**Date**: 2026-08-06
**Goal**: Verify that a natural Slack conversation can use the complete `gh pr` command family for private pull-request reads and explicitly requested writes without gaining general shell or unrelated GitHub CLI access.
**Read Target**: [yahshua-abba/yahshua-one-payroll#257](https://github.com/yahshua-abba/yahshua-one-payroll/pull/257)
**Write Target**: [michael-learns/cyrus-github-issues-f1#5](https://github.com/michael-learns/cyrus-github-issues-f1/pull/5)

## Verification Results

### Permission Boundary

- [x] Real Slack-style Claude session received `Bash(gh pr:*)`
- [x] Session retained the narrow `Bash(git -C * pull)` repository refresh permission
- [x] Session did not receive general `Bash`
- [x] Session did not receive broad `Bash(gh:*)`
- [x] File access remained read-only
- [x] Prompt allows automatic PR reads but requires clear user intent for mutations
- [x] Prompt requires an explicit target before merging or closing a pull request

### Private Pull Request Read

- [x] Cyrus used `gh pr view` against private payroll PR #257
- [x] An invalid requested JSON field produced a normal CLI error
- [x] Cyrus corrected the command and retried without user intervention
- [x] Final answer correctly reported open, not draft, not merged, targeting `staging`, clean, and mergeable
- [x] No pull-request mutation occurred during the read request

### Explicit Pull Request Write

- [x] A separate natural Slack request explicitly asked Cyrus to post one exact comment
- [x] Cyrus used `gh pr comment` on disposable F1 PR #5
- [x] GitHub returned the new comment URL
- [x] The comment exists with the exact requested text
- [x] Cyrus reported that it made no other change

## Session Log

```text
Read request:
  "inspect .../yahshua-one-payroll/pull/257 using GitHub CLI ... Do not change the pull request"

Permission telemetry:
  Bash(git -C * pull)
  Bash(gh pr:*)
  no general Bash
  no Bash(gh:*)

Successful read command:
  gh pr view https://github.com/yahshua-abba/yahshua-one-payroll/pull/257 --json ...

Result:
  OPEN, isDraft=false, mergedAt=null, base=staging,
  mergeStateStatus=CLEAN, mergeable=MERGEABLE

Write request:
  "post this exact comment on .../cyrus-github-issues-f1/pull/5 ... Do not make any other change"

Result:
  https://github.com/michael-learns/cyrus-github-issues-f1/pull/5#issuecomment-5207164918
```

## Final Retrospective

The capability passed both halves of the intended contract. Cyrus can now investigate private pull requests directly from Slack and can perform explicitly requested pull-request mutations, while the permission rule remains scoped to the `gh pr` namespace. The first harness launch loaded stale compiled packages and was discarded; rebuilding the monorepo made the new permission visible, after which both real sessions passed.
