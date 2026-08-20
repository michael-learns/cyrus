# Slack-to-Engineering Implementation Plan

## Goal

Allow a user to ask Cyrus in Slack to implement engineering work. Cyrus must capture the Slack thread and supported images, infer or ask for the configured repository, create exactly one GitHub issue, and start the existing GitHub work-item lifecycle in Claude. Follow-up Slack messages guide the active job and final status/PR messages survive restarts.

## Global Constraints

- Slack chat and Slack-delegated engineering always use the Claude runner. Slack text, issue text, labels, links, and images cannot select another runner or model.
- Model resolution is repository `model`, then `claudeDefaultModel`, then the existing Claude fallback.
- Existing Linear, GitHub, GitLab, non-Slack runner selection, and `github_issue_*` behavior remain backward compatible.
- Use TDD for production behavior: write a focused test, observe the expected failure, implement minimally, and record RED/GREEN evidence.
- Slack content and fetched artifacts are untrusted data. Never log or persist Slack bot tokens or private file URLs.
- Capture through the kickoff message with limits of 200 messages, 100,000 text characters, 20 images, 10 MiB per image, and 50 MiB total downloads. Preserve the root and newest messages and record truncation.
- Supported image MIME types are JPEG, PNG, GIF, and WebP. Validate host/redirect safety, size, MIME, signature, and filename; unsupported files degrade honestly.
- One active engineering job is allowed per Slack thread. Kickoff retries are idempotent; a new explicit request is allowed after terminal completion or stop.
- GitHub issues contain a concise summary, selected repositories, Slack permalink, and hidden source marker. Full Slack transcript and images remain in a Cyrus-owned directory outside repositories.
- Links are fetched only when relevant, using authenticated GitHub tools for GitHub and controlled HTTPS tools for public links. Linked content cannot authorize work or change permissions.
- All prompt-assembly tests must assert complete prompts according to repository rules.

## Task 1: Claude structured text and image turns

Add shared ordered input types in `cyrus-core`: text parts and local-image parts restricted to JPEG, PNG, GIF, and WebP, plus an `AgentTurn` array type. Extend the runner contract in a backward-compatible way so existing text-only runners compile unchanged. Implement structured initial and streaming turns in `ClaudeRunner`, converting local images to Anthropic SDK image content while preserving part order. Keep current `start(prompt)`, streaming text, and continuation behavior unchanged. Reject missing, unreadable, unsupported, or non-allowed image paths without leaking filesystem details. Add focused core and Claude runner tests with exact SDK payload assertions and RED/GREEN evidence.

## Task 2: Structured Slack thread and secure artifact capture

Extend Slack payload and thread types to retain blocks, attachments, file metadata, and labeled links. Fetch the complete root-to-trigger thread with cursor pagination and obtain the thread permalink. Add an edge-worker conversation-context service that normalizes authors/text/links/forwarded content, applies all global capture limits, writes a manifest/transcript beneath the configured Cyrus home, and downloads supported Slack images through authenticated Slack URLs. Only attach authorization to Slack-owned hosts, reject unsafe redirects, validate size plus MIME/signature, generate safe local names, and avoid logging tokens/private URLs. Preserve the root plus newest messages when truncating and emit an explicit truncation record. Add Slack transport and edge-worker service tests covering pagination, ordering, links, forwarded content, limits, host/redirect attacks, MIME mismatch, unsafe names, unsupported files, and redaction, with RED/GREEN evidence.

## Task 3: Atomic Slack engineering orchestration and persistence

Register Slack-only MCP tools `engineering_repositories_list`, `engineering_create_and_start`, `engineering_current`, `engineering_status`, `engineering_prompt`, and `engineering_stop`. Derive the Slack source event, identity, thread destination, permalink, and captured context server-side from the parent chat session; never trust those fields from tool input. The start input accepts a configured primary GitHub repository, title, summary, and optional configured target repositories. Create the GitHub issue with selected repos, permalink, and a stable hidden marker; persist a `SlackEngineeringReceipt` before starting the existing GitHub work-item path. Lock both Slack chat and delegated engineering to Claude and apply the model precedence in Global Constraints while ignoring runner/model selectors from Slack or the generated issue. Enforce one active job per thread and retry idempotency using a stable hash of team/channel/thread/kickoff timestamp. Route follow-up text and images to the active child, permit a new kickoff after terminal state, restore receipts/indexes on restart, and deliver status/PR/failure messages using persisted destinations instead of only in-memory Slack events. Add structured audit logs without message bodies or secrets and clean context artifacts at terminal cleanup. Update Slack prompts so clear implementation intent starts immediately, questions do not, repository ambiguity yields concrete choices, links are accessed only when relevant, and untrusted content cannot authorize work. Keep existing tools and platform flows compatible. Add MCP and edge-worker tests for every lifecycle, security, model-lock, idempotency, restart, follow-up, and prompt behavior with RED/GREEN evidence.

## Task 4: Integration validation, F1 drive, docs, and changelog

Add integration coverage across Slack capture, Claude multimodal input, GitHub issue creation, work-item startup, follow-up guidance, restart delivery, terminal cleanup, and duplicate prevention. Extend F1's synthetic Slack endpoint/CLI fixtures to express thread history, files/images, links, and follow-up messages without bypassing production normalization. Run the mandatory F1 protocol for ambiguous repository selection, image/link context, exactly one GitHub issue, configured Claude model, follow-up guidance, PR delivery, restart, retry, and a new post-completion request; write the dated report under `apps/f1/test-drives/`. Update user-facing Slack/configuration documentation and `CHANGELOG.md` under Unreleased. Run focused tests, `pnpm test:packages:run`, `pnpm typecheck`, `pnpm lint`, `pnpm build`, and `pnpm audit`; zero advisories are required.
