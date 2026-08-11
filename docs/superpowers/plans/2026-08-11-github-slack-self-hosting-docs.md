# GitHub and Slack Self-Hosting Documentation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make GitHub Issues plus Slack self-hosting accurate and usable without Linear.

**Architecture:** Update the existing public self-hosting, Funnel, and config-reference documents in place. Update the canonical `skills/` setup instructions; `.claude`, `.codex`, and `.opencode` consume them through symlinks, so no harness-specific copies are edited.

**Tech Stack:** Markdown, pnpm workspace scripts, GitHub App manifest JSON, Tailscale Funnel, pm2.

## Global Constraints

- Preserve the existing Linear flow; document GitHub + Slack as a separate path.
- Never include real tokens, webhook secrets, OAuth codes, or private keys in examples.
- Keep GitHub App installation scoped to repositories chosen by the operator.
- Do not recommend `cyrus self-add-repo` for GitHub-only installations because it requires Linear credentials.

---

### Task 1: Correct the public self-hosting and Funnel guides

**Files:**
- Modify: `docs/SELF_HOSTING.md`
- Modify: `docs/TAILSCALE_FUNNEL.md`

**Interfaces:**
- Consumes: `CYRUS_BASE_URL`, `CYRUS_HOST_EXTERNAL`, the `/slack-webhook` and `/github-webhook` routes.
- Produces: a no-Linear GitHub + Slack setup path that links to the detailed Funnel guide.

- [ ] **Step 1: Add a GitHub + Slack setup path to `docs/SELF_HOSTING.md`**

  Place it after the existing Slack control-surface explanation. Include this minimal environment shape, using placeholders only:

  ```dotenv
  CYRUS_BASE_URL=https://your-machine.your-tailnet.ts.net
  CYRUS_SERVER_PORT=3456
  CYRUS_HOST_EXTERNAL=true
  SLACK_BOT_TOKEN=xoxb-...
  SLACK_SIGNING_SECRET=...
  GITHUB_WEBHOOK_SECRET=...
  GITHUB_APP_ID=...
  GITHUB_BOT_USERNAME=...
  ```

  State that the GitHub App webhook URL is `CYRUS_BASE_URL/github-webhook`,
  Slack's Event Subscriptions URL is `CYRUS_BASE_URL/slack-webhook`, and the
  GitHub App must be installed only on selected repositories.

- [ ] **Step 2: Document trigger behavior and persistence in `docs/SELF_HOSTING.md`**

  State that issue opening alone does not start a worker session. Explain that
  a comment or review mentioning the configured GitHub App is the explicit
  GitHub trigger, while Slack can initiate work from a GitHub Issue URL.

  Replace the bare pm2 startup example with a short explanation that `pm2
  startup` prints a platform-specific command. On macOS, that command creates
  a launchd job for the current user, requires `sudo`, and only restores the
  pm2 process list; it does not grant Cyrus new integration permissions.

- [ ] **Step 3: Extend `docs/TAILSCALE_FUNNEL.md` with GitHub routing**

  In the webhook URL section, add:

  ```text
  https://your-machine.your-tailnet.ts.net/github-webhook
  ```

  Label it as the GitHub App webhook endpoint. State that successful direct
  GitHub delivery requires `CYRUS_HOST_EXTERNAL=true` and a non-empty
  `GITHUB_WEBHOOK_SECRET`.

- [ ] **Step 4: Validate public documentation links and commands**

  Run:

  ```bash
  rg -n 'github-webhook|slack-webhook|self-add-repo|pm2 startup' docs/SELF_HOSTING.md docs/TAILSCALE_FUNNEL.md
  git diff --check -- docs/SELF_HOSTING.md docs/TAILSCALE_FUNNEL.md
  ```

- [ ] **Step 5: Commit the public documentation changes**

  ```bash
  git add docs/SELF_HOSTING.md docs/TAILSCALE_FUNNEL.md
  git commit -m "docs: clarify GitHub and Slack self-hosting"
  ```

### Task 2: Document GitHub-only repository configuration

**Files:**
- Modify: `docs/CONFIG_FILE.md`

**Interfaces:**
- Consumes: `RepositoryConfigSchema` fields in `packages/core/src/config-schemas.ts`.
- Produces: a valid repository example with no `linearWorkspaceId`.

- [ ] **Step 1: Update the repository field description**

  Change the `linearWorkspaceId` description to say it is optional and only
  required for Linear-routed repositories. Do not list it among required
  GitHub-only repository fields.

- [ ] **Step 2: Add a GitHub-only repository example**

  Add this schema-valid shape near the core repository fields:

  ```json
  {
    "repositories": [
      {
        "id": "github-repo-id",
        "name": "api",
        "repositoryPath": "/Users/you/.cyrus/repos/api",
        "githubUrl": "https://github.com/your-org/api",
        "baseBranch": "main",
        "workspaceBaseDir": "/Users/you/.cyrus/worktrees",
        "isActive": true
      }
    ]
  }
  ```

  Explain that this path is for GitHub + Slack without Linear and requires the
  repository to be cloned locally before starting Cyrus.

- [ ] **Step 3: Validate the example against the documented schema**

  Compare every key in the example with `RepositoryConfigSchema` and run:

  ```bash
  git diff --check -- docs/CONFIG_FILE.md
  ```

- [ ] **Step 4: Commit the configuration reference change**

  ```bash
  git add docs/CONFIG_FILE.md
  git commit -m "docs: add GitHub-only repository configuration"
  ```

### Task 3: Correct the canonical GitHub and repository setup skills

**Files:**
- Modify: `skills/cyrus-setup-github/SKILL.md`
- Modify: `skills/cyrus-setup-repository/SKILL.md`

**Interfaces:**
- Consumes: GitHub App manifest validation and the CLI's `self-add-repo`
  requirement for Linear credentials.
- Produces: agent instructions that generate a valid GitHub App and avoid the
  Linear-only repository command for GitHub-only setups.

- [ ] **Step 1: Fix the GitHub App manifest event list**

  Remove only `"organization"` from `default_events` in
  `skills/cyrus-setup-github/SKILL.md`. Keep `issues`, `issue_comment`,
  `pull_request_review`, `pull_request_review_comment`, and `repository`.
  Add a note that `organization` is deliberately absent because the manifest
  does not request the organization permission GitHub requires for that event.

- [ ] **Step 2: Add restart and selected-installation guidance**

  After credential verification, state that Cyrus must be restarted to start
  `/github-webhook` in direct signature-verification mode. In the installation
  step, tell the operator to select the specific configured repositories rather
  than choosing all organization repositories by default.

- [ ] **Step 3: Add the GitHub-only caveat to the repository skill**

  Before the `cyrus self-add-repo` command, state that it requires Linear
  credentials and is only for Linear-linked repositories. Direct GitHub + Slack
  users to the GitHub-only `config.json` example in `docs/CONFIG_FILE.md`.

- [ ] **Step 4: Verify canonical-skill propagation and copy**

  Confirm the harness paths remain symlinks to `skills/` and run:

  ```bash
  ls -ld .claude/skills/cyrus-setup-github .codex/skills/cyrus-setup-github .opencode/skills/cyrus-setup-github
  rg -n '"organization"|signature-verification|Linear credentials' skills/cyrus-setup-github/SKILL.md skills/cyrus-setup-repository/SKILL.md
  git diff --check -- skills/cyrus-setup-github/SKILL.md skills/cyrus-setup-repository/SKILL.md
  ```

- [ ] **Step 5: Commit the shared skill changes**

  ```bash
  git add skills/cyrus-setup-github/SKILL.md skills/cyrus-setup-repository/SKILL.md
  git commit -m "docs: support GitHub-only self-hosted setup"
  ```

### Task 4: Run documentation-focused verification

**Files:**
- Verify: `docs/SELF_HOSTING.md`
- Verify: `docs/TAILSCALE_FUNNEL.md`
- Verify: `docs/CONFIG_FILE.md`
- Verify: `skills/cyrus-setup-github/SKILL.md`
- Verify: `skills/cyrus-setup-repository/SKILL.md`

**Interfaces:**
- Consumes: completed documentation and skill updates.
- Produces: an evidence-backed final handoff.

- [ ] **Step 1: Check for invalid app manifest content**

  Run:

  ```bash
  rg -n '"organization"' skills/cyrus-setup-github/SKILL.md
  ```

  Expected: no matches in the manifest event list.

- [ ] **Step 2: Run repository Markdown and formatting checks**

  Run:

  ```bash
  pnpm lint
  git diff --check HEAD~3..HEAD
  git status --short
  ```

- [ ] **Step 3: Commit any documentation-only corrections found during verification**

  ```bash
  git add docs skills
  git commit -m "docs: verify GitHub and Slack self-hosting guidance"
  ```
