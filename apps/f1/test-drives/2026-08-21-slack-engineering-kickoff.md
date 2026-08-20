# F1 Test Drive: Slack Engineering Kickoff

**Date:** 2026-08-21 (Asia/Manila; server UTC logs span 2026-08-20)
**Goal:** Validate Slack thread capture through GitHub work-item completion,
delivery retry/restart, and a distinct post-completion request without external
credentials or external writes.
**Test repos:** `/tmp/cyrus-f1-slack-fixround1-6qLARi/primary` and
`/tmp/cyrus-f1-slack-fixround1-6qLARi/secondary`
**Cyrus home:** `/tmp/cyrus-f1-slack-fixround1-6qLARi/cyrus-home`

The 2026-08-21 date follows the controller's explicit date ruling after the
environment advanced from August 20 to August 21. Fixture asset names retain
their original August 20 planning date.

## Boundary

This was a synthetic-network F1 drive, not a live Slack, GitHub, or Claude run.
The F1 backend replaced Slack Web API responses/file bytes, GitHub REST
responses, and Claude inference. It blocked and recorded any unexpected external
request; every reported snapshot contained `externalRequests: []`. No external
issue or pull request was created.

The exercised code remained production code for Slack thread pagination and
permalink lookup, conversation normalization, labeled-link extraction, secure
image validation/download, transcript/manifest persistence, engineering
orchestration and receipt persistence, GitHub work-item/worktree startup,
runner/model configuration, follow-up routing, idempotency, terminal cleanup,
Slack delivery persistence, and restart replay. A deterministic synthetic model
derived question, ambiguity, repository selection, kickoff, follow-up, status,
and stop intent from the raw Slack conversation. It listed and invoked the real
registered `engineering_*` MCP tools through the official MCP client transport,
exercising tool registration, JSON schemas, and production callbacks. The
delegated synthetic Claude runner recorded the exact structured turn/config,
made a local disposable commit, and waited for explicit completion control. The
synthetic GitHub boundary returned the PR URL only after production code detected
that local commit.

## Setup and commands

```bash
pnpm --filter cyrus-edge-worker build
pnpm --filter cyrus-f1 build

./apps/f1/f1 init-test-repo --path /tmp/.../primary
./apps/f1/f1 init-test-repo --path /tmp/.../secondary
git clone --bare /tmp/.../primary /tmp/.../primary-origin.git
git clone --bare /tmp/.../secondary /tmp/.../secondary-origin.git
git -C /tmp/.../primary remote add origin /tmp/.../primary-origin.git
git -C /tmp/.../secondary remote add origin /tmp/.../secondary-origin.git
git -C /tmp/.../primary push -u origin main
git -C /tmp/.../secondary push -u origin main

CYRUS_PORT=3600 \
CYRUS_HOME=/tmp/cyrus-f1-slack-fixround1-6qLARi/cyrus-home \
CYRUS_REPO_PATH=/tmp/cyrus-f1-slack-fixround1-6qLARi/primary \
CYRUS_REPO_PATH_2=/tmp/cyrus-f1-slack-fixround1-6qLARi/secondary \
CYRUS_REPO_MODEL=claude-f1-repo-model \
CYRUS_CLAUDE_MODEL=claude-f1-default \
CYRUS_DEFAULT_RUNNER=codex \
CYRUS_F1_SLACK_ENGINEERING=1 \
bun run apps/f1/server.ts

CYRUS_PORT=3600 ./apps/f1/f1 ping
CYRUS_PORT=3600 ./apps/f1/f1 status
CYRUS_PORT=3600 ./apps/f1/f1 run-slack-engineering-fixture -f <fixture.json>
```

The fixture command was run with the nine files named
`apps/f1/test-drives/assets/2026-08-20-slack-engineering-*.json`. The server was
stopped and restarted with the same `CYRUS_HOME` between failed delivery and the
restart-status fixture.

## Scenario results

| Scenario | Result | Evidence |
| --- | --- | --- |
| Health and status | PASS | `ping` healthy; server status `ready`. |
| Non-starting question | PASS | Chat accepted the question; synthetic GitHub issue count remained 0. |
| Ambiguous repository | PASS | Production repository listing returned both configured repos and routing hints; issue count remained 0 pending a choice. |
| MCP registration/schema/callback path | PASS | The model listed all six `engineering_*` tools and invoked them through the official MCP client. Missing-tool coverage fails closed, and registered schemas validate arguments. |
| Primary plus multi-repo routing | PASS | Receipt targeted `f1-test/primary-repo` and `f1-test/secondary-repo`; a real local two-repo worktree was created. |
| Ordered text/image/link context | PASS | Structured turn contained issue text, then normalized transcript with the labeled acceptance-criteria link, then a canonical absolute PNG path under the private capture directory. |
| Exactly one issue and retry | PASS | First kickoff created issue 1; identical retry retained the same source key/issue and issue count stayed 1. |
| Claude lock/model precedence | PASS | Global default runner was deliberately `codex`; both Slack runners were recorded as Claude. Chat used `claude-f1-default`; delegated work used repository model `claude-f1-repo-model`. Slack/issue `[agent=codex]` and `[model=untrusted-model]` selectors did not change them. Focused unit coverage separately proves repository model → `claudeDefaultModel` → `opus` fallback. |
| Active follow-up guidance | PASS | Latest authoritative Slack text, “Also keep the legend visible below 480px,” and its image reached the child in order. The image was validated and exclusively staged beneath a fresh random directory such as `initial-context/.followup-wpUUJT/image-001.png`; the separate source capture was cleaned. |
| PR/final delivery | PASS (synthetic boundary) | Production commit detection found the local synthetic commit, GitHub boundary returned PR 101, and the persisted Slack message contained the final summary and PR link. No live push/PR occurred. |
| Failed delivery and restart | PASS | First Slack post was recorded `ok: false`; receipt restored after restart. A later verified Slack event triggered production replay and the identical post was recorded `ok: true`. |
| Restored MCP status | PASS | After restart, `engineering_status` resolved the persisted receipt by verified Slack team/channel/thread identity and returned `awaiting_review`, issue 1, delivered status, and PR 101. |
| Terminal context cleanup | PASS | `context_cleaned` audit emitted and no capture files remained under `slack-context` after terminal completion. |
| New request after completion | PASS | New kickoff in the same Slack thread used a different source key and created synthetic issue 2/worktree 2. |
| Stop cleanup | PASS | New job reached `stopped`; its local worktree no longer existed and terminal delivery completed. |
| Unexpected external traffic | PASS | Every backend snapshot reported an empty `externalRequests` list. |

## Activity protocol verification

Slack delegation has no issue-tracker activity timeline, so activity rendering
was validated separately and explicitly with the standard F1 issue/session APIs:

```bash
CYRUS_PORT=3600 ./apps/f1/f1 create-issue --title "Validate activity rendering" --description "Inspect a synthetic rate limiter task and report coherent activity output."
CYRUS_PORT=3600 ./apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 ./apps/f1/f1 prompt-session --session-id session-1 --message "Use F1 Test Repository"
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 1 --offset 1
CYRUS_PORT=3600 ./apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0 --search "repository"
CYRUS_PORT=3600 ./apps/f1/f1 stop-session --session-id session-1
```

The full view returned four coherent timestamped activity payloads (elicitation,
prompt, and two thoughts). The paginated view returned the second prompt only
and reported `Showing 1 of 4`. Search returned the three activities containing
“repository”. This standard activity drive used the synthetic standard runner;
it does not claim a Slack activity timeline or live model inference.

## RED/GREEN finding during the drive

The original drive exposed that a downloaded manifest image path was passed to the
delegated turn as relative `images/image-001.png` and the capture directory was
not in the runner's allowed directories. Focused tests were changed first and
failed for both conditions. The minimal production fix canonicalized capture
paths against `capture.directory` and included the receipt's context directories
in the delegated runner configuration. Focused tests then passed, packages were
rebuilt, and the final F1 kickoff recorded the absolute path under
`.../slack-context/.../images/image-001.png`.

The initial restart fixture also failed to replay because the test-only route
bypassed the Slack transport emitter that normally invokes replay. The F1 route
was corrected to call the same production event replay callback before chat
dispatch. Repeating the restart probe produced the failed-then-successful pair.

Fix Round 1 replaced fixture-authored actions with raw Slack conversations and
real MCP invocations. The first MCP test was RED because zero-argument tool calls
sent no argument object and failed input validation; sending `{}` produced GREEN.
A repository display-name fixture initially remained ambiguous, proving the model
was deriving selection from raw text; repository URL-slug matching then made it
GREEN. A restart status probe initially returned no current work because the chat
parent session ID changed; resolving by verified Slack thread identity made the
probe GREEN. A repository-collision test initially recovered an issue with the
same marker from the wrong repository; applying both marker and repository query
constraints made it GREEN.

Fix Round 2 required synthetic marker recovery to parse both an exact `repo:`
constraint and an exact source marker. Marker-only, repository-only, and wrong
repository probes return no match; only the exact pair recovers the issue. Its
RED returned issue 1 for a marker-only query, and the tightened parser made all
four cases GREEN.

The follow-up staging regression created `initial-context/followups` as a symlink
to an outside directory. Its RED either targeted that predictable path or failed
the real ClaudeRunner permission boundary. GREEN uses `mkdtemp` for a fresh
non-symlink `.followup-*` directory beneath the canonical initial context,
creates each file exclusively, validates each canonical destination beneath both
the staging directory and Slack context root, and never writes through the
attacker symlink. The fresh Fix Round 2 F1 drive at
`/tmp/cyrus-f1-slack-fixround2-q7Uvl0` recorded the follow-up image at
`.followup-wpUUJT/image-001.png`, kept issue count at one across retry, reported
`externalRequests: []`, and removed the complete initial context on MCP stop.

## Limitations

- Slack HMAC/proxy signature verification, real Slack pagination behavior,
  actual private-file CDN redirects, rate limits, and workspace permissions were
  not live-tested here; their production consumers received faithful fixture
  response shapes and focused package tests cover those branches.
- Claude inference and Anthropic SDK transport were not invoked. The deterministic
  policy proves prompt-to-tool intent, MCP registration/schema/callback execution,
  runner selection/config, and exact ordered structured input. Claude SDK payload
  conversion and image path acceptance are covered at the real ClaudeRunner
  boundary by focused tests.
- GitHub authentication, remote issue creation, branch push, and PR creation were
  not live-tested. The production work-item lifecycle used local git worktrees;
  the external GitHub API was synthetic by design.
- The public linked page was retained as relevant labeled context but not fetched;
  this drive does not claim live web-link retrieval.

## Retrospective

All planned credential-free scenarios passed after the two F1-discovered harness
and integration corrections. The most valuable result was the image path/allow
directory defect: unit-level component coverage had not exposed the mismatch
between capture-relative manifests and Claude's filesystem gate.
