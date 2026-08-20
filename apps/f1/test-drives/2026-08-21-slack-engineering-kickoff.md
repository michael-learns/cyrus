# F1 Test Drive: Slack Engineering Kickoff

**Date:** 2026-08-21 (Asia/Manila; server UTC logs span 2026-08-20)
**Goal:** Validate Slack thread capture through GitHub work-item completion,
delivery retry/restart, and a distinct post-completion request without external
credentials or external writes.
**Test repos:** `/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/primary` and
`/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/secondary`
**Cyrus home:** `/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/cyrus-home`

## Boundary

This was a synthetic-network F1 drive, not a live Slack, GitHub, or Claude run.
The F1 backend replaced Slack Web API responses/file bytes, GitHub REST
responses, and Claude execution. It blocked and recorded any unexpected external
request; every reported snapshot contained `externalRequests: []`. No external
issue or pull request was created.

The exercised code remained production code for Slack thread pagination and
permalink lookup, conversation normalization, labeled-link extraction, secure
image validation/download, transcript/manifest persistence, engineering
orchestration and receipt persistence, GitHub work-item/worktree startup,
runner/model configuration, follow-up routing, idempotency, terminal cleanup,
Slack delivery persistence, and restart replay. The synthetic Claude runner
recorded the exact structured turn/config, made a local disposable commit, and
waited for an explicit completion action. The synthetic GitHub boundary returned
the PR URL only after production code detected that local commit.

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
CYRUS_HOME=/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/cyrus-home \
CYRUS_REPO_PATH=/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/primary \
CYRUS_REPO_PATH_2=/tmp/cyrus-f1-slack-engineering-drive-XM6YCa/secondary \
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
| Primary plus multi-repo routing | PASS | Receipt targeted `f1-test/primary-repo` and `f1-test/secondary-repo`; a real local two-repo worktree was created. |
| Ordered text/image/link context | PASS | Structured turn contained issue text, then normalized transcript with the labeled acceptance-criteria link, then a canonical absolute PNG path under the private capture directory. |
| Exactly one issue and retry | PASS | First kickoff created issue 1; identical retry retained the same source key/issue and issue count stayed 1. |
| Claude lock/model precedence | PASS | Global default runner was deliberately `codex`; both Slack runners were recorded as Claude. Chat used `claude-f1-default`; delegated work used repository model `claude-f1-repo-model`. Slack/issue `[agent=codex]` and `[model=untrusted-model]` selectors did not change them. Focused unit coverage separately proves repository model → `claudeDefaultModel` → `opus` fallback. |
| Active follow-up guidance | PASS | Latest authoritative Slack text, “Also keep the legend visible below 480px,” reached the active child in a production-shaped GitHub issue comment; the supplied untrusted summary was ignored. |
| PR/final delivery | PASS (synthetic boundary) | Production commit detection found the local synthetic commit, GitHub boundary returned PR 101, and the persisted Slack message contained the final summary and PR link. No live push/PR occurred. |
| Failed delivery and restart | PASS | First Slack post was recorded `ok: false`; receipt restored after restart. A later verified Slack event triggered production replay and the identical post was recorded `ok: true`. |
| Terminal context cleanup | PASS | `context_cleaned` audit emitted and no capture files remained under `slack-context` after terminal completion. |
| New request after completion | PASS | New kickoff in the same Slack thread used a different source key and created synthetic issue 2/worktree 2. |
| Stop cleanup | PASS | New job reached `stopped`; its local worktree no longer existed and terminal delivery completed. |
| Unexpected external traffic | PASS | Every backend snapshot reported an empty `externalRequests` list. |

## RED/GREEN finding during the drive

The first kickoff exposed that a downloaded manifest image path was passed to the
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

## Limitations

- Slack HMAC/proxy signature verification, real Slack pagination behavior,
  actual private-file CDN redirects, rate limits, and workspace permissions were
  not live-tested here; their production consumers received faithful fixture
  response shapes and focused package tests cover those branches.
- Claude inference and Anthropic SDK transport were not invoked. The drive proves
  Claude runner selection/config and exact ordered structured input at the runner
  boundary; Claude SDK payload conversion is covered by `ClaudeRunner.test.ts`.
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
