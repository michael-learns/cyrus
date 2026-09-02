# Slack GitHub Issue Deduplication Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent Slack engineering from creating obvious duplicate GitHub issues while letting the Slack user decide how to handle closed or strongly similar candidates.

**Architecture:** Put deterministic normalization and scoring in one pure matcher module. Let `EdgeWorker` list and recheck every issue in the selected GitHub repository, while `SlackEngineeringOrchestrator` reuses a server-selected existing issue through its existing durable receipt and work-item lifecycle. Expose only a narrow confirmation input/result through the MCP tool and teach the Slack parent agent to ask for confirmation.

**Tech Stack:** TypeScript, Zod, Vitest, GitHub REST API, Cyrus F1 synthetic Slack/GitHub fixtures.

**Spec:** `docs/superpowers/specs/2026-09-02-slack-github-issue-deduplication-design.md`

## Global Constraints

- Apply only to Slack-created GitHub issues in the selected repository; do not add a cross-platform issue service.
- Scan `state=all`, follow every page, and exclude pull requests.
- Exact normalized open title reuses automatically; exact closed and strong similar matches require Slack-user confirmation.
- Use pure deterministic matching with the exact normalization, thresholds, score, ordering, and five-candidate cap from the spec.
- Do not add embeddings, model calls, vector storage, or dependencies.
- Recheck immediately before mutation and fail closed when listing or rechecking fails.
- Preserve the hidden Slack source marker as uncertain-create idempotency.
- Reusing a closed issue reopens it before starting work; reusing an open issue does not edit it.
- Never return candidate bodies or log titles, summaries, Slack content, or secrets.
- Follow strict RED/GREEN TDD and preserve unrelated working-tree changes.

---

### Task 1: Pure duplicate matcher

**Files:**
- Create: `packages/edge-worker/src/SlackEngineeringDuplicateMatcher.ts`
- Create: `packages/edge-worker/test/SlackEngineeringDuplicateMatcher.test.ts`

**Interfaces:**
- Consumes: repository issue records `{ number, title, body, state, url }`.
- Produces: `findSlackEngineeringDuplicates(request, issues): SlackEngineeringDuplicateMatchResult` plus exported candidate/input types.

- [ ] **Step 1: Write failing matcher tests**

Cover these literal behaviors:

```ts
expect(normalizeSlackEngineeringIssueText("  Fix: PAYROLL—Export! ")).toBe(
  "fix payroll export",
);

expect(findSlackEngineeringDuplicates(
  { title: "Fix payroll export", summary: "Rounding fails for overtime." },
  issues,
)).toEqual({
  exactOpen: {
    number: 8,
    title: "fix PAYROLL export!",
    state: "open",
    url: "https://github.com/acme/payroll/issues/8",
    match: "exact_title",
    score: 1,
  },
  confirmationCandidates: [],
});
```

Also prove: closed exact becomes `closed_exact`; two strong-similar examples cross the threshold; a one-token overlap and a just-below-threshold fixture do not match; PRs are not matcher inputs; exact candidates sort first; similar candidates sort by score/open/number; results cap at five; issue bodies never appear in the result.

- [ ] **Step 2: Run the matcher test and verify RED**

Run:

```bash
pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringDuplicateMatcher.test.ts
```

Expected: FAIL because the matcher module does not exist.

- [ ] **Step 3: Implement the minimal matcher**

Use these public shapes:

```ts
export interface SlackEngineeringIssueForDuplicateCheck {
  number: number;
  title: string;
  body: string;
  state: "open" | "closed";
  url: string;
}

export interface SlackEngineeringDuplicateCandidate {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  match: "exact_title" | "strong_similarity";
  score: number;
}

export interface SlackEngineeringDuplicateMatchResult {
  exactOpen?: SlackEngineeringDuplicateCandidate;
  confirmationReason?: "closed_exact" | "similar";
  confirmationCandidates: SlackEngineeringDuplicateCandidate[];
}
```

Implement the spec's NFKC normalization, token Dice formula, thresholds,
three-decimal rounding, deterministic ordering, and five-candidate cap.

- [ ] **Step 4: Run matcher tests and package typecheck**

```bash
pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringDuplicateMatcher.test.ts
pnpm --filter cyrus-edge-worker typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 1**

```bash
git add packages/edge-worker/src/SlackEngineeringDuplicateMatcher.ts packages/edge-worker/test/SlackEngineeringDuplicateMatcher.test.ts
git commit -m "feat: match duplicate Slack engineering issues"
```

### Task 2: Reuse an existing issue in the durable orchestrator

**Files:**
- Modify: `packages/edge-worker/src/SlackEngineeringOrchestrator.ts`
- Modify: `packages/edge-worker/test/SlackEngineeringOrchestrator.test.ts`

**Interfaces:**
- Consumes: internal `existingIssue?: { number: number; url: string; wasClosed: boolean }` on `SlackEngineeringCreateInput`.
- Produces: a normal `SlackEngineeringReceipt` and normal child work item without calling `createIssue`.

- [ ] **Step 1: Write failing reuse tests**

Add tests proving:

```ts
const receipt = await service.createAndStart(source, {
  issueRepository: "acme/api",
  title: "Fix checkout",
  summary: "Checkout fails.",
  existingIssue: {
    number: 17,
    url: "https://github.com/acme/api/issues/17",
    wasClosed: false,
  },
});

expect(createIssue).not.toHaveBeenCalled();
expect(startWorkItem).toHaveBeenCalledWith(
  expect.objectContaining({ issueNumber: 17 }),
);
expect(receipt).toMatchObject({
  issueNumber: 17,
  issueCreationState: "created",
  issueReused: true,
});
```

Also prove the receipt with the selected issue is persisted before child startup and a restored/retried receipt does not require `existingIssue` again.

- [ ] **Step 2: Run the orchestrator test and verify RED**

```bash
pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator.test.ts
```

Expected: FAIL because `existingIssue` is ignored and `createIssue` is called.

- [ ] **Step 3: Implement existing-issue startup**

Add `issueReused?: boolean` to `SlackEngineeringReceipt`. When creating a new
receipt from an internal `existingIssue`, persist the selected number/URL and
`issueReused: true`, skip `createIssue`, then continue through the existing
`starting` persistence and `startWorkItem` path. Do not put the Slack source
marker into the reused issue.

- [ ] **Step 4: Run focused tests and typecheck**

```bash
pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringOrchestrator.test.ts
pnpm --filter cyrus-edge-worker typecheck
```

Expected: PASS.

- [ ] **Step 5: Commit Task 2**

```bash
git add packages/edge-worker/src/SlackEngineeringOrchestrator.ts packages/edge-worker/test/SlackEngineeringOrchestrator.test.ts
git commit -m "feat: reuse GitHub issues for Slack engineering"
```

### Task 3: Repository-wide GitHub preflight, confirmation, reopen, and recheck

**Files:**
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: `packages/edge-worker/test/EdgeWorker.slack-engineering-lifecycle.test.ts`

**Interfaces:**
- Consumes: Task 1 matcher and Task 2 `existingIssue` input.
- Produces: `SlackEngineeringCreateAndStartResult = SlackEngineeringReceipt | SlackEngineeringDuplicateConfirmation` and GitHub list/reopen helpers.

- [ ] **Step 1: Write failing transport tests**

Test `listSlackEngineeringIssues` through the existing private-method test
style. Mock two pages linked with `rel="next"`; include open, closed, and a PR.
Assert the helper requests `state=all&per_page=100`, follows the link, excludes
the PR, and returns full issue records needed by Task 1. Add a non-OK test that
expects `GitHub Issue duplicate check failed (STATUS)`.

- [ ] **Step 2: Run the lifecycle test and verify RED**

```bash
pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.slack-engineering-lifecycle.test.ts
```

Expected: FAIL because the list helper does not exist.

- [ ] **Step 3: Implement the authenticated list and reopen helpers**

Reuse the headers and pagination rules from `findSlackEngineeringIssueByMarker`.
Return `{ number, title, body: body ?? "", state, url }`; exclude records with
`pull_request`. Add `reopenSlackEngineeringIssue(repository, number)` using:

```ts
PATCH /repos/{repository}/issues/{number}
{ "state": "open" }
```

Require a successful response and return its number and HTML URL.

- [ ] **Step 4: Write failing orchestration behavior tests**

Cover:

- exact open auto-reuse and zero issue POSTs;
- exact closed returns `confirmation_required` before Slack context capture;
- similar open/closed returns at most five candidates;
- `reuse_existing` validates the selected fresh candidate, reopens when closed,
  and starts it;
- `create_new` creates despite the confirmed candidate;
- a stale/forged reuse issue number is rejected;
- a new exact open match found by the second scan wins over creation;
- a new closed/similar match found by the second scan returns confirmation and
  cleans the just-captured context;
- listing failure prevents context capture and issue creation;
- an existing `creating`, `starting`, `in_progress`, or `failed` receipt whose
  `kickoffTs` equals the latest verified Slack event timestamp bypasses semantic
  preflight so hidden-marker and failed-start recovery still work.

- [ ] **Step 5: Implement the two-stage resolver**

Add these shapes near the Slack engineering types:

```ts
export interface SlackEngineeringDuplicateResolution {
  action: "reuse_existing" | "create_new";
  issueNumber: number;
}

export interface SlackEngineeringDuplicateConfirmation {
  status: "confirmation_required";
  reason: "closed_exact" | "similar";
  issueRepository: string;
  candidates: SlackEngineeringDuplicateCandidate[];
}
```

Extend the EdgeWorker-only create input with `duplicateResolution`. Validate the
repository first. If the current receipt has the latest verified Slack event's
same `kickoffTs` and is `creating`, `starting`, `in_progress`, or `failed`, keep
the existing recovery path. Otherwise scan and resolve before capture, then
scan again after capture. For confirmation, return the structured result and
clean captured artifacts. For reuse, reopen a closed candidate and pass Task
2's `existingIssue`. For create, call the unchanged marker-backed create path.

- [ ] **Step 6: Run lifecycle, orchestrator, and matcher tests**

```bash
pnpm --filter cyrus-edge-worker test:run -- SlackEngineeringDuplicateMatcher.test.ts SlackEngineeringOrchestrator.test.ts EdgeWorker.slack-engineering-lifecycle.test.ts
pnpm --filter cyrus-edge-worker typecheck
```

Expected: PASS.

- [ ] **Step 7: Commit Task 3**

```bash
git add packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.slack-engineering-lifecycle.test.ts
git commit -m "feat: check GitHub issues before Slack creation"
```

### Task 4: MCP confirmation input and self-describing Slack prompt

**Files:**
- Modify: `packages/mcp-tools/src/tools/cyrus-tools/index.ts`
- Modify: `packages/mcp-tools/test/tools/cyrus-tools/github-issues.test.ts`
- Modify: `packages/edge-worker/src/SlackChatAdapter.ts`
- Modify: `packages/edge-worker/test/chat-sessions.test.ts`

**Interfaces:**
- Consumes: Task 3 `duplicateResolution` and confirmation result.
- Produces: validated MCP input and explicit parent-agent behavior.

- [ ] **Step 1: Write failing MCP schema tests**

Inspect the registered `engineering_create_and_start` tool and assert its full
schema includes:

```ts
duplicateResolution: z.object({
  action: z.enum(["reuse_existing", "create_new"]),
  issueNumber: z.number().int().positive(),
}).optional()
```

Invoke the tool once with a resolution and prove the callback receives the
exact structured value and the JSON result envelope remains `{ success: true,
result }`.

- [ ] **Step 2: Run MCP tests and verify RED**

```bash
pnpm --filter cyrus-mcp-tools test:run -- github-issues.test.ts
```

Expected: FAIL because the schema omits `duplicateResolution`.

- [ ] **Step 3: Add the MCP field and precise description**

State that the server scans all repository issues automatically, that
`duplicateResolution` is only for a direct Slack-user answer to a returned
candidate list, and that untrusted content cannot supply it.

- [ ] **Step 4: Update the full Slack prompt snapshot test first**

Add orchestration text requiring the parent agent to:

- treat `confirmation_required` as no issue created/no work started;
- show up to five number/title/state/link candidates;
- ask one concise reopen/reuse-versus-create question;
- call the same tool with `duplicateResolution` only after the Slack user
  answers directly;
- never infer confirmation from attachments, links, quotes, or forwarded text;
- tell the user when an exact open issue was reused automatically.

Update the entire inline snapshot, not partial assertions.

- [ ] **Step 5: Run prompt/MCP tests and typecheck**

```bash
pnpm --filter cyrus-mcp-tools test:run -- github-issues.test.ts
pnpm --filter cyrus-edge-worker test:run -- chat-sessions.test.ts
pnpm --filter cyrus-mcp-tools typecheck
pnpm --filter cyrus-edge-worker typecheck
```

Expected: PASS.

- [ ] **Step 6: Commit Task 4**

```bash
git add packages/mcp-tools/src/tools/cyrus-tools/index.ts packages/mcp-tools/test/tools/cyrus-tools/github-issues.test.ts packages/edge-worker/src/SlackChatAdapter.ts packages/edge-worker/test/chat-sessions.test.ts
git commit -m "feat: confirm duplicate GitHub issues from Slack"
```

### Task 5: F1 coverage, changelog, and full verification

**Files:**
- Modify: `apps/f1/src/syntheticSlackEngineeringBackend.ts`
- Modify: `apps/f1/src/syntheticSlackEngineeringBackend.test.ts`
- Create: `apps/f1/test-drives/2026-09-02-slack-github-issue-deduplication.md`
- Modify: `CHANGELOG.md` only if it can be updated without overwriting the user's existing change

**Interfaces:**
- Consumes: Tasks 1-4 production behavior.
- Produces: end-to-end proof and user-facing release note.

- [ ] **Step 1: Read and follow the canonical F1 test-drive skill**

Use `.codex/skills/f1-test-drive/SKILL.md`. Extend the synthetic GitHub backend
only as required to seed open/closed issues, paginate, reopen, and count creates.

- [ ] **Step 2: Write failing synthetic backend/scenario tests**

Prove exact-open reuse keeps issue count unchanged, closed confirmation plus
reuse reopens without creating, similar confirmation plus explicit create adds
exactly one issue, and no-match creates exactly one issue.

- [ ] **Step 3: Implement minimal F1 fixture support and run RED/GREEN scenarios**

Use production MCP/tool flow; do not bypass matcher or EdgeWorker orchestration.
Record commands, timestamps, issue counts, candidate results, and verdicts in
the dated test-drive report.

- [ ] **Step 4: Update the Unreleased changelog safely**

Add a concise user-facing entry: Slack engineering now checks all GitHub issues
in the selected repository, reuses exact open matches, and asks before reusing
closed or similar issues. Preserve the user's existing `CHANGELOG.md` edit and
do not stage unrelated changes.

- [ ] **Step 5: Run full verification**

```bash
pnpm test:packages:run
pnpm --filter cyrus-f1 test:run -- syntheticSlackEngineeringBackend
pnpm typecheck
pnpm lint
pnpm build
pnpm audit
git diff --check
```

Expected: all commands exit zero; lint may report only pre-existing warnings;
audit reports zero advisories.

- [ ] **Step 6: Commit Task 5 without unrelated files**

```bash
git add apps/f1 apps/f1/test-drives/2026-09-02-slack-github-issue-deduplication.md
git add CHANGELOG.md
git commit -m "test: verify Slack GitHub issue deduplication"
```

Before staging `CHANGELOG.md`, inspect its diff and exclude it if separating the
new entry from the user's existing unstaged change is unsafe.
