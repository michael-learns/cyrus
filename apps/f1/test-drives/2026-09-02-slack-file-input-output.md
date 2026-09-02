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
- [x] A real `EdgeWorker` resolved the verified `ChatSessionHandler` session and conditionally supplied its `createCyrusToolsOptions()` Slack callback to the real `slack_file_upload` MCP tool.
- [x] Token, channel, parent thread, and workspace came from that verified production session; the model-facing call supplied only file paths, titles, and the initial comment.
- [x] The complete ordered PNG `local_image` structure/path/media type and exact bytes were asserted.
- [x] The complete delivery structure was asserted, including ordered IDs, names, titles, byte lengths, destination, and exact output bytes.
- [x] The test is format-agnostic and makes no document-rendering-quality claim.

### Slack Output Boundary

- [x] `files.getUploadURLExternal` required authenticated Slack API access.
- [x] Missing and incorrect Web API Authorization were rejected; forwarding Authorization to the raw ticket upload was rejected without consuming the ticket.
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

### Fix Round 1

Focused RED deliberately registered the MCP server without an EdgeWorker-derived
callback:

```bash
corepack pnpm --filter cyrus-f1 test:run -- slackChatThreadContext syntheticSlackEngineeringBackend
```

Observed result: the end-to-end drive failed with MCP `-32601 Method not found`,
proving the drive now depends on conditional production registration rather than
a test-injected upload destination.

GREEN used a real `EdgeWorker` connected to the real production-created
`ChatSessionHandler` session. `EdgeWorker.createCyrusToolsOptions()` derived the
bot token, channel, original parent thread, and exact workspace from that
verified session and supplied the callback to the MCP server:

```text
Test Files  5 passed (5)
Tests       24 passed (24)
```

Guard-removal-sensitive assertions now separately reject missing/wrong
Authorization on `files.getUploadURLExternal` and any Authorization header on
the raw one-time upload. The latter rejection also proves the ticket remains
available for the subsequent valid unauthenticated, no-redirect transfer.

Directly affected production suites:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.slack-file-upload SlackFileUploadService
corepack pnpm --filter cyrus-mcp-tools test:run -- slack-files
corepack pnpm --filter cyrus-slack-event-transport test:run -- SlackMessageService
```

Results: edge-worker 82 files / 956 tests passed; MCP tools 7 files / 33 tests
passed; Slack transport 3 files / 103 tests passed.

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
three modern external-upload stages. The final drive reaches the upload through
the real EdgeWorker verified-session callback rather than injecting destination
authority in test code. Keeping ticket secrets private while exposing exact
delivered bytes to assertions made transport fidelity testable without
persisting reusable capabilities. The coordinated hosted catalog entry for
`mcp__cyrus-tools__slack_file_upload` remains a release blocker because the
`cyrus-hosted` repository is not present here.

**Verdict**: PASS locally, subject to the hosted catalog release blocker.
