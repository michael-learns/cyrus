# GitHub and Slack Self-Hosting Documentation

## Goal

Make the GitHub Issues plus Slack setup path accurate for self-hosted Cyrus,
without requiring Linear.

## Scope

- Update the public self-hosting and configuration guides.
- Update the canonical shared setup skills used by each harness.
- Preserve the existing Linear setup path; this change documents the separate
  GitHub-only route rather than removing Linear support.

## Documentation Changes

### Public guides

- `docs/SELF_HOSTING.md` will include a GitHub + Slack quick path covering
  Claude authentication, a public webhook endpoint, Slack, GitHub App setup,
  selected-repository installation, and pm2 persistence.
- It will state that a new GitHub Issue does not automatically start work.
  A supported issue, pull request, or review comment that mentions the GitHub
  App is the explicit trigger.
- It will explain the macOS pm2 startup command: it installs a launchd job for
  the current user and requires `sudo`; it does not grant Cyrus new access.
- `docs/TAILSCALE_FUNNEL.md` will list both Slack and GitHub webhook paths and
  retain the public-relay verification guidance.
- `docs/CONFIG_FILE.md` will document that `linearWorkspaceId` is optional and
  give a GitHub-only repository configuration example.

### Shared setup skills

- `skills/cyrus-setup-github/SKILL.md` will remove the unsupported
  `organization` event from the GitHub App manifest. The remaining events cover
  issues, issue comments, pull request reviews, pull request review comments,
  and repository events.
- The GitHub skill will explicitly tell operators to restart Cyrus after adding
  GitHub App credentials so it starts in direct signature-verification mode.
- `skills/cyrus-setup-repository/SKILL.md` will state that
  `cyrus self-add-repo` needs Linear credentials. It will direct GitHub-only
  operators to the config-file instructions instead of suggesting that command.

## Safety and Operational Rules

- Do not print or paste app tokens, webhook secrets, private keys, or OAuth
  codes into documentation examples.
- GitHub App installation must be limited to the repositories the operator
  selects; do not recommend installing it on every organization repository by
  default.
- Keep Funnel exposure limited to Cyrus's HTTPS route and continue verifying
  webhook signatures.

## Validation

- Check Markdown links and command examples for consistency with the existing
  CLI and webhook routes.
- Run formatting or Markdown checks available in the repository.
- Review the resulting diff to ensure it changes documentation and shared skill
  instructions only.
