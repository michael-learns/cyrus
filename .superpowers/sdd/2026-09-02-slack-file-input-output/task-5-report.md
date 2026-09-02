# Task 5 Report: Preserve Non-Image Files in Slack Engineering Handoffs

## Status

Implemented and verified.

Initial Slack engineering handoffs now provide readable absolute paths for captured PDF/CSV and other non-image files while preserving supported images as ordered `local_image` parts. Follow-up captures are written to unique event-derived subdirectories beneath the initial receipt-owned Slack context root, so active runners retain their existing read authorization and terminal cleanup owns the complete transient tree.

## Files Changed

- `packages/edge-worker/src/EdgeWorker.ts`
- `packages/edge-worker/test/EdgeWorker.slack-engineering-lifecycle.test.ts`

No `SlackEngineeringOrchestrator` compatibility change was needed. Its existing receipt context-directory ownership and `addContextDirectory()` fallback were sufficient.

## TDD Evidence

### Initial / follow-up RED

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator
```

Output summary:

```text
Test Files  1 failed | 81 passed (82)
Tests       2 failed | 947 passed (949)
```

Expected failures:

- `assembles one captured transcript with readable non-image paths before ordered local images` — the received initial turn contained only the transcript and images; the expected absolute PDF/CSV path block was absent.
- `keeps a follow-up capture with readable PDF and CSV paths bound to the active receipt` — the old path called the plain-text orchestrator prompt because it only built structured turns for images.

### Failed-capture cleanup RED

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator
```

Output summary after correcting the test to inspect the partial file rather than attempting to read its directory:

```text
Test Files  1 failed | 81 passed (82)
Tests       1 failed | 949 passed (950)
AssertionError: promise resolved "'remove'" instead of rejecting
```

This proved a partially created follow-up event directory survived capture failure before the cleanup implementation.

### Focused GREEN

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator
```

Output:

```text
Test Files  82 passed (82)
Tests       950 passed (950)
Duration    6.92s
```

## Full Verification

### Edge-worker suite

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run
```

Output:

```text
Test Files  82 passed (82)
Tests       950 passed (950)
Duration    6.88s
```

### Edge-worker typecheck

Command:

```bash
corepack pnpm --filter cyrus-edge-worker typecheck
```

Output:

```text
> tsc --noEmit
```

Exit status: 0.

### Diff whitespace check

Command:

```bash
git diff --check
```

Output: empty; exit status 0.

## Implementation Notes

- Initial context assembly appends one host-generated `<slack_attachment_files>` block to the existing transcript. It lists effective MIME types and absolute local paths without reading attachment contents into the prompt, so the trigger body remains present exactly once.
- Supported JPEG/PNG/GIF/WebP parts remain ordered `local_image` entries in message/file order.
- The path block explicitly frames attachment content as untrusted and states that it cannot select runner/model/repository, authorize kickoff, change Slack source/receipt binding, or override instructions.
- Follow-up capture roots are deterministic hashes of trusted Slack team/channel/thread/event identity below `<initial-context>/followups/`. The event-derived subdirectory prevents overwriting the initial capture or a different event.
- Active runners use the already-authorized initial context root; successful follow-up captures remain beneath that root until terminal cleanup.
- Restored legacy receipts with no parent context use the existing `addContextDirectory()` fallback only for an inactive runner. An active runner with no pre-authorized root fails closed.
- A failed capture or rejected prompt removes only the new follow-up capture directory. It does not remove the receipt root or any prior capture.
- Cross-thread calls are rejected before capture, so another Slack parent session cannot reuse the receipt's paths.

## Self-Review

- **Path readability:** absolute paths resolve beneath a validated Slack context root; active runners already authorize that root and resumed runners rebuild allowed directories from the receipt.
- **Image ordering:** unchanged nested message/file iteration for initial turns; follow-up image filtering preserves source array order.
- **Untrusted framing:** attachment bytes are not interpolated; only server-generated MIME/path metadata is exposed with an explicit untrusted-data warning.
- **Source binding:** the existing parent-session receipt lookup remains the gate; cross-thread capture is denied before filesystem work.
- **Cleanup:** successful follow-ups are terminal-owned; failed follow-up capture/prompt paths are narrowly cleaned; terminal recursive cleanup covers retained nested files.
- **DRY/YAGNI:** reused `SlackConversationContextService`, the existing capture manifest/local paths, receipt context roots, `addContextDirectory()`, local-image leases, and terminal cleanup. Added no downloader, manifest, workspace, receipt field, policy, or lifecycle state.
- **Preserved behavior:** Claude-only lock, routing precedence, input validation before capture, one-active-job/idempotency, receipt persistence, Task 2 chat workspace behavior, and Task 4 upload-tool wiring were not changed.

## Concerns

None known. The fallback for old receipts intentionally refuses file-bearing follow-ups while their runner is active because that runner never received a read grant for the newly captured directory.

## Fix Round 1: Exact Receipt-Root Containment

### Finding

Follow-up results were checked only against the global `slack-context` directory. A malformed capture result could point at a sibling receipt directory, and the follow-up destination was constructed through the original receipt path rather than its pinned canonical target. Cleanup could consequently follow a substituted symlink into a sibling context.

### RED: sibling result and original-path construction

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.slack-engineering-lifecycle
```

Output summary:

```text
Test Files  1 failed | 81 passed (82)
Tests       2 failed | 950 passed (952)
```

Expected failures:

- `rejects a sibling capture result without prompting the child or deleting the sibling` resolved with the active receipt instead of rejecting, proving the sibling PDF path reached the child turn.
- `uses the canonical receipt root and never cleans a symlink-substituted sibling` received `<receipt-link>/followups/<event>` instead of `<canonical-root>/followups/<event>`.

### RED: canonical-root substitution cleanup

After strengthening the race fixture to replace the canonical root itself with a sibling symlink, the same focused command produced:

```text
Test Files  1 failed | 81 passed (82)
Tests       1 failed | 951 passed (952)
Error: ENOENT ... sibling/followups/<event>/partial
```

The sibling partial file was deleted, proving cleanup re-resolved the substituted root rather than honoring the pinned canonical identity.

### GREEN: focused lifecycle suite

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.slack-engineering-lifecycle
```

Output:

```text
Test Files  82 passed (82)
Tests       952 passed (952)
Duration    7.40s
```

### Full verification

Command:

```bash
corepack pnpm --filter cyrus-edge-worker test:run
```

Output:

```text
Test Files  82 passed (82)
Tests       952 passed (952)
Duration    7.53s
```

Command:

```bash
corepack pnpm --filter cyrus-edge-worker typecheck
```

Output:

```text
> tsc --noEmit
```

Exit status: 0.

Command:

```bash
git diff --check
```

Output: empty; exit status 0.

### Fix and self-review

- The receipt root is canonicalized and globally contained before capture.
- The unique event destination is constructed from that canonical root.
- Every returned follow-up directory, including text-only captures, must be a strict canonical descendant of the exact receipt root before any child turn is built or retained.
- The pinned canonical root string must still resolve to itself; canonical-root symlink substitution fails closed.
- Failure cleanup uses the same strict exact-root check. An unvalidated sibling result is never deleted.
- Legacy receipts without a stable root retain the previous global-root fallback and active-runner fail-closed behavior.
- The global `slack-context` canonical containment check remains as defense in depth and now handles macOS `/var` → `/private/var` aliases without relying on a mismatching lexical precheck.

Concerns: none known.
