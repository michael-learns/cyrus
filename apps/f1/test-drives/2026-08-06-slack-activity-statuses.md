# Test Drive: Slack Activity Statuses

**Date**: 2026-08-06
**Goal**: Verify that Slack chat activity tracking survives a real runner lifecycle, including background work, while the broader issue pipeline remains healthy.
**Test Repo**: `/var/folders/h1/v9mrb6fj7r19flpv4l66gdpc0000gn/T/f1-slack-status.XXXXXX.SctA7qDDsj/repo`

## Verification Results

### Issue-Tracker
- [x] Routed issue created with the `primary` label
- [x] Issue ID returned and metadata accessible
- [x] Session completed with a final response

### EdgeWorker
- [x] Label routing selected the F1 repository
- [x] Git worktree created for `DEF-3`
- [x] Thought, action, and response activities tracked
- [x] Session stopped cleanly

### Slack Chat
- [x] Synthetic Slack event dispatched
- [x] Isolated Slack workspace and shared auto-memory directory created
- [x] Tool and assistant messages flowed through `ChatSessionHandler`
- [x] Intermediate result was deferred while one background task remained
- [x] Background task completed and produced the final response
- [x] Missing Slack token degraded safely without an unhandled error
- [x] Real status API payloads, throttling, refresh, sanitization, and clearing covered by package tests

### Renderer
- [x] Thought, action, and response activities were coherent
- [x] Pagination returned the expected second page
- [x] Final response activity was present

## Session Log

- Started a fresh F1 server on port `3600`.
- Dispatched Slack thread `C_STATUS_TEST:1786023304.808` with a repository-comparison request.
- The chat runner emitted 66 messages and naturally spawned one background agent.
- Cyrus held the reply after the intermediate result, recorded pending work, then completed after the background result.
- Created routed issue `DEF-3`; its worktree and 14 activities included repository routing, reads, thoughts, actions, and a final response.
- Stopped all issue sessions and shut down the F1 server gracefully.

## Final Retrospective

The complete Slack runner lifecycle passed, including the pending-background-work path most likely to leave a stale status. F1 intentionally omits a Slack bot token, so it validates safe no-op behavior rather than rendering in Slack; the Web API contract and timer behavior are covered deterministically by unit tests, with the local Tailscale-backed app reserved for final visual confirmation.
