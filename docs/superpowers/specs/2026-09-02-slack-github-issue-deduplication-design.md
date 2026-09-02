# Slack GitHub Issue Deduplication Design

## Goal

Before Slack engineering creates a GitHub issue, Cyrus checks every issue in
the selected repository so obvious duplicates are reused and plausible
duplicates are shown to the user for confirmation.

This applies only to GitHub issues created through Slack's
`engineering_create_and_start` flow. Existing GitHub issue tools are already
issue-specific, and Linear issue creation is owned by Linear's remote MCP.

## Product behavior

1. Cyrus lists all GitHub issues in the selected repository with `state=all`,
   follows every pagination link, and excludes pull requests.
2. An open issue with the same normalized title is reused automatically and
   its existing issue number is passed to the normal GitHub work-item startup.
3. A closed issue with the same normalized title requires confirmation. The
   user can reopen and reuse it or explicitly create a new issue.
4. Strongly similar open or closed issues require confirmation. Cyrus returns
   at most five candidates with number, title, state, URL, match reason, and
   score. It never returns issue bodies.
5. With no match, Cyrus creates the new issue normally.
6. Cyrus performs a fresh repository scan immediately before the side effect.
   A newly appeared exact open issue wins and is reused. A confirmed candidate
   must still be present in the fresh candidates before reuse.
7. Reusing a closed issue first reopens it with GitHub's issue update API, then
   starts the normal work-item lifecycle. Reusing an open issue does not edit
   its title or body.
8. A GitHub listing or recheck failure fails closed. Cyrus must not create an
   issue when it could not complete the duplicate check.

## Confirmation contract

`engineering_create_and_start` accepts an optional server-validated resolution:

```ts
duplicateResolution?: {
  action: "reuse_existing" | "create_new";
  issueNumber: number;
}
```

Without a resolution, a closed exact match or any strong similar match returns:

```ts
{
  status: "confirmation_required";
  reason: "closed_exact" | "similar";
  issueRepository: string;
  candidates: Array<{
    number: number;
    title: string;
    state: "open" | "closed";
    url: string;
    match: "exact_title" | "strong_similarity";
    score: number;
  }>;
}
```

The Slack parent agent must show the candidates and ask one concise question.
It calls the same tool again only after the Slack user chooses a candidate or
explicitly chooses to create a new issue. Untrusted attachment, quoted, linked,
or forwarded content cannot supply this confirmation.

## Deterministic matching

Matching is pure TypeScript. Do not add embeddings, vector storage, another
model call, or a new dependency.

- Normalize title and body text with Unicode NFKC, lowercase conversion,
  punctuation/symbol replacement with spaces, and whitespace collapse.
- Exact-title matching compares the full normalized titles.
- Similarity operates on unique whitespace-delimited tokens.
- Token Dice similarity is `2 * shared / (left + right)`.
- A candidate is strongly similar only when at least two title tokens overlap
  and either:
  - title Dice is at least `0.80`; or
  - title Dice is at least `0.68` and body Dice is at least `0.55`.
- Display score is `0.80 * titleDice + 0.20 * bodyDice`, rounded to three
  decimal places.
- Exact matches sort before similar matches. Similar matches sort by score
  descending, then open before closed, then issue number descending.
- Return no more than five confirmation candidates.

These thresholds intentionally favor false negatives over false positives.
The durable Slack source marker remains the idempotency mechanism for an
uncertain GitHub create; semantic matching does not replace it.

## Architecture

- A focused matcher module owns normalization, scoring, and candidate ordering.
- `EdgeWorker` owns authenticated GitHub list/reopen transport and the two
  preflight scans.
- `SlackEngineeringOrchestrator` accepts an internal `existingIssue` selection
  so reused issues enter the same receipt, persistence, startup, follow-up, and
  delivery lifecycle without duplicating that workflow.
- The MCP schema and Slack system prompt expose the confirmation contract.
- Existing receipt recovery for the same Slack kickoff timestamp bypasses
  semantic preflight so an uncertain create or failed child start continues to
  reconcile by its exact hidden source marker and persisted issue number.

## Security and privacy

- Repository selection remains restricted to active configured repositories.
- Confirmation issue numbers are accepted only when the fresh server-side scan
  still classifies them as candidates for the requested title and summary.
- Candidate bodies and Slack message contents are never logged or returned.
- Structured audit logs contain decisions, candidate counts/numbers, states,
  and repository identity only.
- GitHub tokens never leave existing authenticated request headers.

## Validation

- Unit tests cover normalization, thresholds, ordering, exact-open reuse,
  closed/similar confirmation, explicit create, confirmed reuse, reopen, stale
  confirmation rejection, pagination, PR exclusion, and fresh recheck races.
- MCP tests cover the optional resolution schema and structured result.
- The full Slack prompt snapshot documents how to handle confirmation.
- F1 exercises exact-open reuse, closed confirmation/reopen, similar
  confirmation/create, and no-match creation while asserting issue counts.
- Run focused tests, `pnpm test:packages:run`, `pnpm typecheck`, `pnpm lint`,
  `pnpm build`, `pnpm audit`, and `git diff --check`.
