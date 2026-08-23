# F1 Test Drive: Main Merge Smoke

**Date:** 2026-08-23
**Goal:** Verify the consolidated Slack engineering and SSH database branch before merging it into `main`.
**Test repository:** `/tmp/cyrus-f1-merge.C5aeLh/repo`

## Verification Results

### Issue tracker

- [x] F1 server health returned healthy and status returned `ready`.
- [x] Issue `issue-1` / `DEF-1` was created.
- [x] Session `session-1` started and requested repository selection.

### EdgeWorker

- [x] Selecting `F1 Test Repository` advanced the session.
- [x] The runner produced routing and startup activities in the isolated F1 repository.
- [x] The session stopped cleanly.

### Renderer

- [x] The full view returned four timestamped activities: elicitation, prompt, and two thoughts.
- [x] `--limit 1 --offset 1` returned the prompt and reported `Showing 1 of 4 activities`.
- [x] Searching for `repository` returned three matching activities.

## Commands

```text
pnpm -r --if-present test:run
pnpm typecheck
pnpm lint
pnpm build
./apps/f1/f1 init-test-repo --path /tmp/cyrus-f1-merge.C5aeLh/repo
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/cyrus-f1-merge.C5aeLh/repo CYRUS_HOME=/tmp/cyrus-f1-merge.C5aeLh/home bun run apps/f1/server.ts
CYRUS_PORT=3600 ./apps/f1/f1 ping
CYRUS_PORT=3600 ./apps/f1/f1 status
CYRUS_PORT=3600 ./apps/f1/f1 create-issue --title "Merge verification smoke" --description "Inspect the test repository and report what implementation work remains. Do not edit files."
CYRUS_PORT=3600 ./apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 ./apps/f1/f1 prompt-session --session-id session-1 --message "Use F1 Test Repository"
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 1 --offset 1
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0 --search "repository"
CYRUS_PORT=3600 ./apps/f1/f1 stop-session --session-id session-1
```

## Final Retrospective

The pre-merge branch passed the complete non-watch workspace test run, typecheck, lint with 11 existing warnings and no errors, build, and the required isolated F1 smoke. The drive used the local F1 issue/session boundary and made no live Slack or GitHub writes. The disposable repository intentionally had no `origin`, so its worktree setup logged a fetch warning and correctly fell back to local `main`. The Claude SDK also emitted its existing `canUseTool` shadowing warning; neither warning prevented session startup, activity rendering, or clean shutdown.
