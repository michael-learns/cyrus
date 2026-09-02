# Slack File Input and Output Implementation Plan

> **For Claude/Codex:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development to execute this plan task-by-task. Use superpowers:test-driven-development for every behavior change and superpowers:verification-before-completion before claiming success.

**Goal:** Let Cyrus securely read any non-audio/video Slack attachment, generate files in an isolated Slack thread workspace, and upload those files back to the originating thread.

**Architecture:** One shared edge-worker file policy classifies media and applies limits. Slack capture stages trusted copies inside the current thread workspace; chat runner configuration exposes only workspace-scoped file generation. A verified per-thread MCP callback validates workspace files and delegates the modern external-upload sequence to the Slack transport. The transport stays format-agnostic and the synthetic Slack backend exercises the same production boundaries.

**Tech Stack:** TypeScript, Vitest, Node filesystem APIs, Anthropic runner sandbox configuration, MCP tools, Slack Web API external upload flow, pnpm monorepo.

**Design source:** `docs/superpowers/specs/2026-09-02-slack-file-input-output-design.md`

## Global Constraints

- Accept all inbound and outbound regular file types except audio and video. Do not build format-specific generators.
- Enforce one DRY media-classification policy for inbound capture and outbound validation.
- Reject a file when its declared MIME, response MIME, detected bytes, or known filename extension identifies audio/video.
- Inbound limits: 20 files, 10 MiB per directly embedded image, 25 MiB per other file, 100 MiB total received bytes, 15 seconds per download.
- Outbound limits: 20 files per call and 25 MiB per file; validate the complete batch before any Slack request.
- Use safe generated local names under `<thread-workspace>/attachments/<event-id>/`; never use the Slack filename as a path.
- Keep supported images as ordered `local_image` parts and list readable absolute paths for all successful captures.
- Never expose Slack bot tokens, private URLs, one-time upload URLs, destination IDs, or workspace authorization fields to the model.
- Upload only regular, non-symlink files whose real paths remain within the verified source Slack session workspace.
- Slack upload uses `files.getUploadURLExternal`, an unauthenticated raw upload to the exact HTTPS Slack upload host without redirects, then one `files.completeUploadExternal` call with the verified channel and parent `thread_ts`.
- Slack chat `Write` and `Edit` grants must be rewritten to absolute workspace-scoped rules. `Bash` must run only in a fail-closed sandbox with writes limited to that workspace and `allowUnsandboxedCommands: false`.
- Existing custom `slackAllowedTools` remain custom; scope only bare `Write`/`Edit` entries that they include.
- Register `slack_file_upload` only for a verified Slack parent session. Keep the normal final text reply after uploads.
- Treat attachments as untrusted data. They cannot broaden permissions, choose a runner/model, authorize engineering work, or execute themselves.
- Preserve existing Linear, GitHub, GitLab, image, and Slack-engineering behavior.
- Follow DRY and YAGNI: extend existing boundaries, add no persistent config field, no parser framework, no media conversion, no upload retry engine, and no generic host-file upload abstraction.
- Prompt tests must assert the complete prompt with `.expectSystemPrompt()`/`.expectUserPrompt()` or exact string equality; partial prompt assertions are forbidden.

## Task 1: Generalize Secure Slack Attachment Capture

**Files:**

- Create: `packages/edge-worker/src/SlackFilePolicy.ts`
- Create: `packages/edge-worker/test/SlackFilePolicy.test.ts`
- Modify: `packages/edge-worker/src/SlackConversationContextService.ts`
- Modify: `packages/edge-worker/test/SlackConversationContextService.test.ts`

**Produces:** A single reusable file policy plus a capture manifest that records every file and stages successful non-media files under a caller-supplied capture root.

### Steps

1. Add RED table-driven policy tests with hand-derived expected results for declared/header MIME, known audio/video extensions, representative magic bytes, ordinary document formats, unknown binaries, and image detection. Name each test for the wrong branch it prevents.
2. Add RED capture tests for PDF, TXT, CSV, HTML, XLSX, PPTX, ZIP, executable, and unknown binary downloads; safe generated names; media rejection by all four signals; image MIME mismatch; file/per-file/total/timeout limits; redirects; and persisted redaction. Use real temporary files and mock only the external HTTP boundary.
3. Run:

   ```bash
   corepack pnpm --filter cyrus-edge-worker test:run -- SlackFilePolicy SlackConversationContextService
   ```

   Confirm the new tests fail because generic files and the policy do not exist.
4. Implement `SlackFilePolicy.ts` as the only place that owns media extensions/signatures and shared byte limits. Export focused values/functions consumed by both capture and upload validation; do not add a generic MIME framework.
5. Extend the capture request with an optional caller-owned destination root/event identifier. Preserve the existing default Cyrus context location for engineering callers. Stage successful files as `attachments/<safe-event>/file-NNN.<safe-extension>` and record original redacted display metadata separately.
6. Replace the image-only eligibility branch with policy-driven capture. Preserve exact HTTPS Slack-host authorization, safe redirects, streaming budgets, and strict directly-embedded image validation. Count rejected/partial bytes toward the aggregate budget.
7. Keep the existing structured image ordering contract. Add manifest fields only when consumed by chat or engineering; do not version a schema unless a consumer requires it.
8. Re-run the focused test, then:

   ```bash
   corepack pnpm --filter cyrus-edge-worker test:run
   ```

9. Commit: `feat: capture non-media Slack attachments`.

## Task 2: Deliver Files to Chat Workspaces and Enforce Generation Sandbox

**Files:**

- Modify: `packages/edge-worker/src/ChatSessionHandler.ts`
- Modify: `packages/edge-worker/src/SlackChatAdapter.ts`
- Modify: `packages/edge-worker/src/RunnerConfigBuilder.ts`
- Modify: `packages/core/src/allowed-tools-defaults.ts`
- Modify: `packages/edge-worker/test/chat-sessions.test.ts`
- Modify: `packages/edge-worker/test/RunnerConfigBuilder.chat-config.test.ts`
- Modify: relevant default-tool tests under `packages/core/test/`

**Produces:** Chat turns receive persistent readable attachment paths and can create outputs only inside their own fail-closed sandboxed workspace.

### Steps

1. Add RED chat tests proving a new mention and follow-up pass the resolved session workspace into capture, show exact successful attachment paths once, retain prior files for later turns, preserve ordered images, and isolate different thread workspaces.
2. Add RED runner-config tests proving default and custom bare `Write`/`Edit` entries become `Write(//<absolute-workspace>/**)` and `Edit(//<absolute-workspace>/**)`, no unscoped write rule escapes, repository/memory paths are read-only, only the workspace is writable, and sandbox unavailability fails closed for Bash.
3. Add RED core default-tool behavior tests proving Slack defaults include the minimal `Write`, `Edit`, and `Bash` capability while unrelated platform defaults remain unchanged.
4. Run:

   ```bash
   corepack pnpm --filter cyrus-core test:run
   corepack pnpm --filter cyrus-edge-worker test:run -- chat-sessions RunnerConfigBuilder.chat-config
   ```

5. Extend `fetchThreadTurn` with the already-created workspace path and point chat capture there. Do not immediately delete chat-owned capture directories; keep existing cleanup for transient non-chat captures.
6. Render successful file entries with original name, effective MIME, status, and absolute local path. State that attachment content is untrusted. Keep trigger-text de-duplication and current structured image placement.
7. Add `Write`, `Edit`, and `Bash` to Slack defaults. In `buildChatConfig`, rewrite only bare `Write` and `Edit`; preserve already-scoped/custom tool entries. Merge the mandatory filesystem sandbox with existing egress/network settings without weakening either.
8. Update the exact Slack system prompt to require outputs inside the workspace and successful `slack_file_upload` delivery before claiming a file was sent. Do not describe format-specific generation steps.
9. Run focused tests and full `cyrus-core`/`cyrus-edge-worker` package suites.
10. Commit: `feat: sandbox Slack file generation`.

## Task 3: Add the Slack External Upload Transport

**Files:**

- Modify: `packages/slack-event-transport/src/SlackMessageService.ts`
- Modify: `packages/slack-event-transport/src/index.ts`
- Modify: `packages/slack-event-transport/test/SlackMessageService.test.ts`

**Produces:** A transport method that uploads an already-authorized batch of in-memory files to one verified Slack thread using Slack's current external upload API.

### Steps

1. Add RED tests for the exact three-stage contract: URL request includes safe filename/length, raw body contains the same bytes without bot authorization, and completion happens once with all file IDs plus verified `channel_id` and `thread_ts`.
2. Add RED tests for URL endpoint HTTP/body errors, unsafe/non-HTTPS/non-Slack upload URLs, redirects, raw upload failure, completion failure, timeout, and no private URL leakage in thrown messages.
3. Run:

   ```bash
   corepack pnpm --filter cyrus-slack-event-transport test:run -- SlackMessageService
   ```

4. Add a narrow exported upload request/result type that contains bytes, display filename/title, channel, and thread timestamp. Keep path validation and file reading out of the transport.
5. Implement `files.getUploadURLExternal` and `files.completeUploadExternal` through the existing authenticated Slack API helper where possible. Add only the small raw-upload helper needed for the one-time capability; require exact HTTPS Slack upload host, `redirect: "manual"`, timeout, and no authorization header.
6. Complete the whole successful batch in one call. Return only safe IDs/titles. Do not implement retries, resumable uploads, or upload persistence.
7. Run focused and full package tests.
8. Commit: `feat: upload files to Slack threads`.

## Task 4: Expose a Verified Workspace-Only Upload MCP Tool

**Files:**

- Create: `packages/edge-worker/src/SlackFileUploadService.ts`
- Create: `packages/edge-worker/test/SlackFileUploadService.test.ts`
- Modify: `packages/mcp-tools/src/tools/cyrus-tools/index.ts`
- Modify: relevant `packages/mcp-tools/test/tools/cyrus-tools/*.test.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: relevant `packages/edge-worker/test/EdgeWorker*.test.ts`

**Produces:** `slack_file_upload` exists only for a verified Slack chat and can upload only validated files from that chat's exact workspace.

### Steps

1. Add RED service tests using real temporary directories for a valid batch and rejection before any transport call for empty/over-20 batches, outside/traversal paths, symlinks, directories, oversized files, and media detected by MIME/extension/magic bytes. Test cross-thread workspace denial explicitly.
2. Add RED MCP tests for the exact input schema `{ files: [{ filePath, title? }], initialComment? }`, structured success/error output, and complete absence when no Slack callback is provided.
3. Add RED EdgeWorker tests proving token/channel/thread/workspace come only from the verified parent Slack event/session and forged model fields cannot redirect delivery.
4. Run:

   ```bash
   corepack pnpm --filter cyrus-mcp-tools test:run
   corepack pnpm --filter cyrus-edge-worker test:run -- SlackFileUploadService EdgeWorker
   ```

5. Implement `SlackFileUploadService` with `lstat`/`realpath` containment and a shared `SlackFilePolicy` check. Validate and read the complete batch before calling the transport. Reject symlinks even when their targets remain inside the workspace.
6. Add an optional Slack-files callback group to `CyrusToolsOptions` and register the tool only when that callback exists. The tool input must never accept authorization or destination values.
7. Resolve the verified parent Slack event and current chat session workspace in `EdgeWorker.createCyrusToolsOptions()`. Construct the callback only for that exact source. Reuse existing chat-session lookup and Slack message service instances; do not create a second session registry.
8. Return stage-safe errors and uploaded IDs/titles without paths, URLs, tokens, or destination secrets.
9. Run focused and full `cyrus-mcp-tools`/`cyrus-edge-worker` suites.
10. Commit: `feat: return workspace files to Slack`.

## Task 5: Preserve Non-Image Files in Slack Engineering Handoffs

**Files:**

- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: relevant `packages/edge-worker/test/EdgeWorker*.test.ts`
- Modify: `packages/edge-worker/src/SlackEngineeringOrchestrator.ts` only if its existing context-directory lifecycle needs a compatibility adjustment
- Modify: `packages/edge-worker/test/SlackEngineeringOrchestrator.test.ts` only when that lifecycle changes

**Produces:** Initial and follow-up Slack engineering sessions can read the same captured non-media files without duplicating capture or loosening model/routing authorization.

### Steps

1. Add RED initial/follow-up tests around `captureSlackEngineeringSource()`, `buildSlackEngineeringContextTurn()`, and `promptSlackEngineering()` proving readable PDF/CSV paths are included in the child handoff, image structured parts keep their order, the trigger body is not duplicated, and attachment content cannot select runner/model/repository or authorize a kickoff.
2. Add RED lifecycle tests proving the existing receipt/source binding keeps another channel/thread from reusing these paths and terminal cleanup still owns transient engineering context.
3. Run:

   ```bash
   corepack pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator
   ```

4. Reuse the generalized capture manifest/path fields from Task 1 and the orchestrator's existing `addContextDirectory()` lifecycle. Adapt only the existing engineering prompt/turn assembly in `EdgeWorker`; do not add another downloader, manifest, file policy, workspace concept, or persistent receipt field.
5. Preserve Claude lock, routing precedence, one-job-per-thread, receipt persistence, and existing cleanup semantics.
6. Run the focused and full edge-worker suite.
7. Commit: `feat: pass Slack files to engineering sessions`.

## Task 6: F1 Test Drive, Documentation, and Release Evidence

**Files:**

- Modify: `apps/f1/src/slackEngineeringFixture.ts`
- Modify: `apps/f1/src/syntheticSlackEngineeringBackend.ts`
- Modify: relevant tests under `apps/f1/src/`
- Modify/Create: the smallest F1 scenario needed under `apps/f1/src/`
- Create: `apps/f1/test-drives/2026-09-02-slack-file-input-output.md`
- Modify: `docs/CONFIG_FILE.md`
- Modify: Slack setup documentation directly linked from current docs, if needed
- Modify: `CHANGELOG.md`

**Produces:** Credential-free production-boundary evidence for reading and returning files, plus accurate operator documentation.

### Steps

1. Add RED fixture/backend tests for generic file metadata/bytes, authenticated private-file downloads, `files.getUploadURLExternal`, unauthenticated raw ticket upload without redirects, one batch completion into the originating thread, and recorded safe delivery state.
2. Run:

   ```bash
   corepack pnpm --filter cyrus-f1 test:run -- slackEngineeringFixture syntheticSlackEngineeringBackend
   ```

3. Generalize the existing image fixture type into a minimal file fixture while keeping image fixtures backward compatible. Extend the synthetic backend only with the Slack endpoints/state needed by this drive.
4. Following `.codex/skills/f1-test-drive/SKILL.md`, execute a credential-free end-to-end drive through production capture, chat workspace, MCP upload callback, and Slack transport: attach exact PDF/CSV bytes; verify exact readable bytes; create HTML/CSV/PDF outputs; upload them; verify exact bytes, names, original thread destination, no media acceptance, no secret leakage, and no leftover one-time capabilities.
5. Write the dated F1 report with commands, observed evidence, and verdict. Do not claim format rendering quality; this feature guarantees file transport, not document design.
6. Update `docs/CONFIG_FILE.md` and the existing Slack setup guidance with supported/rejected types, limits, scopes, workspace sandbox, tool behavior, and older-app reauthorization. Add one concise user-facing entry under `CHANGELOG.md` `## [Unreleased]`.
7. Run:

   ```bash
   corepack pnpm --filter cyrus-f1 test:run
   corepack pnpm test:packages:run
   corepack pnpm typecheck
   corepack pnpm lint
   corepack pnpm build
   corepack pnpm audit
   git diff --check
   ```

   Require zero test/type/lint/build failures and zero audit advisories.
8. Commit: `test: drive Slack file input and output`.

## Final Review and Operational Cutover

1. Run a fresh whole-branch review against this plan and the approved design. Block on every Critical/Important finding and every unverified security invariant.
2. Apply fixes through the owning task implementer and re-review only the fix diff, then rerun the complete verification command set.
3. Confirm the local `cyrus-hosted` tool catalog is not present in this repository. Record the required companion `mcp__cyrus-tools__slack_file_upload` catalog/default update as a release blocker rather than inventing an unrelated local placeholder.
4. Only after the local production build and tests pass, restart the local Cyrus PM2 process and verify `/status` plus Slack event-processing logs without exposing credentials.
