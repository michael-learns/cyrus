# Task 1: Generalize Secure Slack Attachment Capture

## Implementation

- Added `SlackFilePolicy` as the small shared owner of the 20-file, 10 MiB image, 25 MiB other-file, 100 MiB aggregate, and 15-second limits; supported image types; and audio/video detection by declared MIME, response MIME, extension, detected type, and representative magic bytes.
- Extended `SlackConversationContextService.capture()` with optional `captureRoot` and `eventId`. Successful regular files are staged under `attachments/<safe-event>/file-NNN.<extension>`; supported and validated images retain their existing ordered `images/image-NNN.<extension>` contract.
- Kept Slack HTTPS host authorization, manual redirect validation, per-request timeout, streaming limits, and redaction. Rejected and partial downloads continue charging the aggregate received-byte budget.
- Updated the previous image-only tests for the new 100 MiB aggregate budget and added coverage for regular document/binary capture, all media rejection signals, caller-owned staging, 20-file limit, and the non-image 25 MiB limit.

## Files

- `packages/edge-worker/src/SlackFilePolicy.ts`
- `packages/edge-worker/test/SlackFilePolicy.test.ts`
- `packages/edge-worker/src/SlackConversationContextService.ts`
- `packages/edge-worker/test/SlackConversationContextService.test.ts`

## TDD evidence

### RED

Command:

```sh
corepack pnpm --filter cyrus-edge-worker test:run -- SlackFilePolicy SlackConversationContextService
```

Relevant output before implementation:

```text
FAIL test/SlackFilePolicy.test.ts
Error: Cannot find module '../src/SlackFilePolicy.js'

FAIL SlackConversationContextService > captures regular non-media files into a caller-owned safe attachment directory
Expected downloaded staged attachment paths; received skipped files with no localPath.
```

This confirmed the policy module and generic capture behavior did not exist.

### GREEN

Command:

```sh
corepack pnpm --filter cyrus-edge-worker test:run -- SlackFilePolicy SlackConversationContextService
```

Relevant output:

```text
Test Files  80 passed (80)
Tests  915 passed (915)
```

Typecheck:

```sh
corepack pnpm --filter cyrus-edge-worker typecheck
```

Result: passed.

## Full edge-worker suite

Command:

```sh
corepack pnpm --filter cyrus-edge-worker test:run
```

Result:

```text
Test Files  80 passed (80)
Tests  915 passed (915)
```

The suite was run with localhost-binding permission because `EgressProxy` tests cannot bind a local port under the default sandbox; that environment-only failure disappeared when rerun with the required permission.

## Self-review

- Completeness: all requested accepted categories (PDF, TXT, CSV, HTML, XLSX, PPTX, ZIP, executable, unknown binary), media signals, limits, redirects, timeout, image mismatch, and redaction are covered across policy and capture tests.
- Security: no token or private file URL enters staged paths, manifests, transcripts, or warning logs; initial and redirected URLs remain exact HTTPS `files.slack.com` only; redirect bodies are cancelled; stream and aggregate budgets are enforced.
- DRY/YAGNI: one focused policy module owns values and media recognition. Capture remains sequential and reuses its existing download controls—no generic MIME framework, parallel downloader, or unrelated refactor.
- Test quality: external HTTP is the only mocked boundary; capture assertions use real temporary directories and bytes; expected names, paths, counts, and limits are hand-derived.

## Concerns

None.
