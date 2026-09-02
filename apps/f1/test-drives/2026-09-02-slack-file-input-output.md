# Test Drive: Slack File Input and Output

**Date**: 2026-09-02
**Goal**: Prove credential-free, exact-byte Slack file input/output through production capture, workspace, MCP validation, and transport boundaries.
**Test Repo**: `/Users/yahshua/code/opensource/cyrus/.worktrees/slack-file-input-output`
**Protocol**: `.codex/skills/f1-test-drive/SKILL.md`

## Verification Results

### Slack Input Boundary

- [x] Synthetic Slack thread and app-mention event created without credentials.
- [x] Authenticated private-file downloads required the synthetic bot token.
- [x] Exact PDF and CSV fixture bytes were readable inside the isolated thread workspace.
- [x] JPEG/PNG/GIF/WebP image behavior remained compatible; the PNG was delivered as an ordered `local_image` input.
- [x] Audio and video fixtures were rejected and recorded as `media_type` skips.

### Workspace and MCP Boundary

- [x] HTML, CSV, and PDF outputs were created only inside the production-created Slack thread workspace.
- [x] The real `SlackFileUploadService` validated the files and the real `slack_file_upload` MCP tool invoked the callback.
- [x] Exact output names, titles, and bytes crossed the transport boundary.
- [x] The test is format-agnostic and makes no document-rendering-quality claim.

### Slack Output Boundary

- [x] `files.getUploadURLExternal` required authenticated Slack API access.
- [x] Raw ticket uploads contained exact bytes, no Authorization header, and used no redirects.
- [x] One `files.completeUploadExternal` call delivered all three files to `C_FILE_REPORTS`, parent thread `1800000000.000100`.
- [x] Safe recorded state contained only destination/file metadata, not bot tokens or one-time URLs.
- [x] Every one-time ticket was consumed; replay returned HTTP 410 and no active ticket remained.
- [x] No synthetic request escaped to an external service.

## Session Log

RED was captured first with:

```bash
corepack pnpm --filter cyrus-f1 test:run -- slackEngineeringFixture syntheticSlackEngineeringBackend
```

The new generic fixture assertion failed because file metadata was absent. The
new backend assertion failed because external upload tickets/endpoints were
absent. This was the expected missing-behavior failure.

GREEN focused evidence:

```bash
corepack pnpm --filter cyrus-f1 test:run -- slackEngineeringFixture syntheticSlackEngineeringBackend slackChatThreadContext
```

Result: fixture/backend tests passed, and the end-to-end test exercised exact
input/output bytes through production capture, workspace, MCP validation, and
Slack transport.

Release verification commands:

```bash
corepack pnpm --filter cyrus-f1 test:run
corepack pnpm test:packages:run
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm build
corepack pnpm audit
git diff --check
```

Final results are recorded in the task implementation report.

## Final Retrospective

The existing synthetic Slack boundary needed only generic fixture files and the
three modern external-upload stages. Keeping ticket secrets private while
exposing exact delivered bytes to assertions made transport fidelity testable
without persisting reusable capabilities. The coordinated hosted catalog entry
for `mcp__cyrus-tools__slack_file_upload` remains a release blocker because the
`cyrus-hosted` repository is not present here.

**Verdict**: PASS locally, subject to the hosted catalog release blocker.
