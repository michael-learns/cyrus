# Slack Thread Parent Context — F1 Test Drive

**Date:** 2026-08-21
**Result:** PASS

## Goal

Prove that mentioning Cyrus in a Slack thread carries the parent issue card and
supported screenshots into the normal Claude chat turn. This covers messages
whose top-level Slack `text` is empty and whose useful body lives in an ordinary
attachment.

## Production Path Exercised

1. A production-shaped Slack thread contains an attachment-only GitHub issue
   card and a PNG.
2. `SlackChatAdapter` fetches the thread through the mention.
3. `SlackConversationContextService` preserves the ordinary attachment and
   validates/downloads the image through the bounded Slack file path.
4. `ChatSessionHandler` leases the capture directory to the runner, supplies an
   ordered text/image turn, revokes the lease, and removes the capture.
5. The synthetic boundary records no unexpected external request.

## Verification

```text
pnpm --filter cyrus-f1 exec vitest run \
  src/slackChatThreadContext.test.ts \
  src/slackEngineeringFixture.test.ts

Test Files  2 passed (2)
Tests       3 passed (3)
```

The drive asserted the full issue-card body reached the runner, the PNG bytes
were readable only while the temporary lease was active, the user question was
the final text part, the image media type was retained, the lease was revoked,
the downloaded file was deleted, and `externalRequests` remained empty.

## Read-only Live Payload Checks

Two existing Slack threads were fetched without posting or mutating Slack:

- The reported attachment-only thread produced 3,454 characters of context and
  included both the issue number and the named failing function.
- An existing screenshot thread produced ordered `text`, `local_image`, `text`
  parts with one validated PNG, followed by successful artifact cleanup.

No Claude inference, GitHub mutation, issue creation, pull request, merge, or
deployment was performed during the live checks.
