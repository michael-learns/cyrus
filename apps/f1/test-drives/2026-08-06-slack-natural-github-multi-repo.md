# Test Drive: Natural Slack GitHub Work

**Date**: 2026-08-06
**Goal**: Verify that a normal Slack conversation can inspect a private GitHub Issue, start coordinated work in two repositories, accept mid-run guidance, and return every pull request without special commands.
**Primary Repo**: `michael-learns/cyrus-github-issues-f1` (private)
**Secondary Repo**: `michael-learns/cyrus-github-issues-f1-secondary` (private)
**Source Issue**: [michael-learns/cyrus-github-issues-f1#4](https://github.com/michael-learns/cyrus-github-issues-f1/issues/4)

## Verification Results

### Natural Slack Conversation

- [x] A plain-language request to investigate the private issue used the GitHub issue tool automatically
- [x] Investigation explained the two-repository change without starting implementation
- [x] A plain-language follow-up to proceed started the work item without a slash command or magic keyword
- [x] A mid-run Slack message was delivered to the active implementation session
- [x] The final response returned both pull request links
- [x] Repeating the request returned the existing result instead of creating duplicate work

### Agent And Repository Access

- [x] The Slack conversation and child implementation session both used `claude-opus-5`
- [x] The Slack session remained read-only and used the narrow Cyrus GitHub orchestration tools
- [x] The implementation session received normal engineering tools, including file editing, shell, Git, GitHub CLI, and web tools
- [x] GitHub credentials were passed to the child session as `GH_TOKEN` and `GITHUB_TOKEN`
- [x] Cyrus created one coordinated worktree containing both repositories on the same branch name
- [x] Both pull requests link the source issue with its full `Fixes owner/repo#number` reference

### Results

- [x] Primary pull request: [michael-learns/cyrus-github-issues-f1#5](https://github.com/michael-learns/cyrus-github-issues-f1/pull/5)
- [x] Secondary pull request: [michael-learns/cyrus-github-issues-f1-secondary#1](https://github.com/michael-learns/cyrus-github-issues-f1-secondary/pull/1)
- [x] Cyrus posted both pull request links back to the source issue
- [x] Each repository received only its intended README change
- [x] The mid-run instruction changed both README links to full GitHub URLs
- [x] Only one open pull request exists in each test repository after the repeated request

## Session Log

```text
Slack: "investigate ... but do not implement anything yet"
Result: private issue and both repositories inspected; no branch or PR created

Slack: "Go ahead and take care of it across both repositories"
Result: one multi-repository GitHub work item started

Slack: "please make the links in both READMEs use the full GitHub repository URLs"
Result: guidance delivered to the running child session and applied to both PRs

Primary PR:   https://github.com/michael-learns/cyrus-github-issues-f1/pull/5
Secondary PR: https://github.com/michael-learns/cyrus-github-issues-f1-secondary/pull/1

Slack: "take care of issue 4 again and include both repositories"
Result: "Already done" with the same PR links; no duplicate job or PRs
```

## Automated Coverage

```text
cyrus-mcp-tools: 22 tests passed
cyrus-core: 137 tests passed
cyrus-github-event-transport: 124 tests passed
cyrus-edge-worker: 781 tests passed
All package test suites passed
Build and TypeScript checks passed
```

## Final Retrospective

The Slack-only workflow passed end to end against real private GitHub repositories. Cyrus made the important distinction between investigation and implementation from ordinary conversation, kept the chat agent narrowly permissioned, delegated actual coding to a full engineering session, handled cross-repository work, and accepted guidance while that session was running.

The F1 run intentionally removed the Slack bot token so it could not post test messages into the real workspace. In that mode, final Slack posting safely becomes a no-op; the Web API calls, delegated status ownership, completion message, and status clearing are covered by package tests. A final visual smoke test can be done in the local Tailscale-backed Slack app after restarting Cyrus with this build.
