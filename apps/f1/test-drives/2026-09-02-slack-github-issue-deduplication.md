# F1 Test Drive: Slack GitHub Issue Deduplication

**UTC date/time:** 2026-09-02T16:05:47Z  
**Local date/time:** 2026-09-03T00:05:47+0800 (PST)  
**Goal:** Verify Slack engineering duplicate decisions through the production `EdgeWorker` MCP/tool path without external GitHub or Slack resources.  
**Test repository:** A fresh `f1-test/primary-repo` fixture and temporary local repository per scenario under `/tmp/cyrus-f1-deduplication-*`.

## Protocol and Boundaries

- Each scenario created a fresh synthetic backend, temporary Cyrus home, local repository directory, `EdgeWorker`, linked MCP server/client, and verified Slack parent event.
- Calls entered through `engineering_create_and_start` on the MCP server options produced by `EdgeWorker`. Tests did not call the duplicate matcher or `SlackEngineeringOrchestrator` directly.
- Slack context capture and child runner startup were deterministic local boundaries. GitHub list, create, read, and reopen requests used the synthetic HTTP backend.
- Candidate evidence below intentionally excludes issue bodies.

## RED

Command:

```bash
corepack pnpm --filter cyrus-f1 test:run -- syntheticSlackEngineeringBackend
```

At 2026-09-02T16:04:34Z (2026-09-03 00:04:34 +0800), the new coverage failed as expected:

- Pagination/closed seeding received HTTP 502 because issue PATCH did not exist.
- Exact-open, similar, and no-match MCP scenarios reached duplicate matching but failed because list records omitted `title` and `state`.
- The broad Vitest selector also ran another test file concurrently; its temporary global `fetch` use caused one unrelated Slack upload failure. Subsequent focused evidence used the exact test path.

## GREEN

Focused command:

```bash
corepack pnpm --filter cyrus-f1 exec vitest run src/syntheticSlackEngineeringBackend.test.ts
```

Result at 2026-09-02T16:05:25Z: **15 tests passed, 0 failed**.

Package typecheck:

```bash
corepack pnpm --filter cyrus-f1 typecheck
```

Result: exit 0.

## Scenario Evidence

### Exact open reuse

- Seed: 1 open issue, number 1.
- Request title: `fix PAYROLL export!`.
- Result shape: `{ status: "in_progress", issueNumber: 1, issueReused: true }`.
- Final: 1 issue, number 1 remains open.
- Verdict: **PASS** — count unchanged.

### Exact closed confirmation and reuse

- Seed: 1 closed issue, number 1.
- First result shape: `{ status: "confirmation_required", reason: "closed_exact", issueRepository: "f1-test/primary-repo", candidates: [{ number: 1, title: "Fix checkout timeout", state: "closed", url: "https://github.com/f1-test/primary-repo/issues/1", match: "exact_title", score: 1 }] }`.
- Confirmed input: `{ action: "reuse_existing", issueNumber: 1 }`.
- Reuse result shape: `{ status: "in_progress", issueNumber: 1, issueReused: true }`.
- Final: 1 issue, number 1 reopened to open.
- Verdict: **PASS** — confirmation returned, issue reopened, count unchanged.

### Similar confirmation and explicit create

- Seed: 1 open issue, number 1.
- First result shape: `{ status: "confirmation_required", reason: "similar", candidates: [{ number: 1, title: "Fix payroll export failure", state: "open", url: "https://github.com/f1-test/primary-repo/issues/1", match: "strong_similarity", score: 0.8 }] }`.
- Confirmed input: `{ action: "create_new", issueNumber: 1 }`.
- Create result shape: `{ status: "in_progress", issueNumber: 2 }` with no true `issueReused` flag.
- Final: 2 open issues.
- Verdict: **PASS** — exactly one issue added.

### No match

- Seed: 1 unrelated open issue, number 1.
- Result shape: `{ status: "in_progress", issueNumber: 2 }`.
- Final: 2 open issues.
- Verdict: **PASS** — exactly one issue added.

### All-issues pagination

- Seed: 101 issues; issue 101 closed.
- Page 1 request: `state=all&per_page=100` returned 100 issues and a `rel="next"` link.
- Page 2 returned issue 101 with number, title, body, state, and `html_url` in the GitHub list shape.
- Verdict: **PASS** — open and closed issues remain visible across pages.

## Cleanup and Safety

- Every MCP client and server was closed in `finally` cleanup.
- Every temporary Cyrus home and repository was recursively removed.
- The synthetic backend recorded no unexpected external request in the scenarios that assert that boundary.
- No real Slack messages, GitHub issues, repositories, or child agent sessions were created.

## Final Retrospective

The synthetic backend now models the GitHub behavior required by production duplicate checks: issue state persistence, complete list records, `state=all` filtering, pagination links, and issue-state PATCH. All four product decisions are covered through the real MCP registration and `EdgeWorker` orchestration entrypoint.
