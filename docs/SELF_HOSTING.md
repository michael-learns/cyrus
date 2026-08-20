# End-to-End Self-Hosting Guide

## Quick Start (Recommended)

If you're using any AI coding agent (Claude Code, Codex, Cursor, etc.), set up Cyrus with a single command:

```bash
npx skills add ceedaragents/cyrus -g
```

Then in your agent:

```
/cyrus-setup
```

The setup skill walks you through everything below — automatically.

---

## Manual Setup

This guide walks you through setting up Cyrus completely self-hosted, including your own Linear OAuth application. This is the free, zero-cost option that gives you full control.

---

## Prerequisites

- **Linear workspace** with admin access if you want the Linear integration
- **Node.js** v18 or higher
- **jq** (for Claude Code parsing)
- **A public URL** for receiving integration webhooks

### Install Dependencies

**macOS:**
```bash
brew install jq gh

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v18 or higher
```

**Linux/Ubuntu:**
```bash
apt install -y gh npm git jq

# Verify
jq --version      # Should show version like jq-1.7
node --version    # Should show v18 or higher
```

---

## Overview

You'll complete these steps:

1. Set up a public URL for webhooks
2. Configure Claude Code authentication
3. Create a Linear OAuth application (skip for GitHub-only Slack setups)
4. Install Cyrus and complete your environment file
5. Start Cyrus, optionally authorize with Linear, and add repositories

### Using Slack as the GitHub Issue control surface

Linear is optional when you use Cyrus through Slack and GitHub Issues. After
connecting a Slack app and adding your GitHub repositories, authenticate GitHub
on the Cyrus machine with one of the supported methods:

```bash
gh auth login
gh auth status
```

You can instead configure a GitHub App or set `GITHUB_TOKEN`. Cyrus prefers a
forwarded installation token, then self-hosted GitHub App credentials, then
`GITHUB_TOKEN`, and finally the local `gh` login.

In Slack, mention Cyrus and use normal language with a GitHub Issue URL:

```text
@Cyrus Can you investigate https://github.com/acme/payroll/issues/42 and fix it
if the code confirms the bug? Authentication may live in the acme/host repo.
```

Cyrus reads private issue discussion, investigates the configured repositories,
and decides whether the request calls for an explanation or implementation. For
implementation it creates isolated worktrees, keeps the Slack thread status
updated, accepts follow-up messages in the same thread, and posts every pull
request link when the work finishes. No slash commands are required.

Slack conversations can also inspect and operate on pull requests using normal
language. Cyrus has access to the complete `gh pr` command family, including
viewing diffs and checks, commenting, reviewing, marking ready, editing, closing,
reopening, and merging. Read-only commands can be used whenever they help answer
a question. Commands that change a pull request require a clear user request;
merging or closing requires an explicit request naming the target pull request.
Other GitHub CLI command families remain unavailable to Slack chat sessions.

#### Starting engineering work directly from a Slack thread

You can also describe new implementation work without supplying an existing
GitHub Issue. Cyrus captures the thread through the kickoff message, creates one
GitHub Issue in a configured primary repository, and starts the normal isolated
GitHub work-item lifecycle. Prerequisites are:

- a connected Slack app with `app_mention` events and permission to read thread
  replies and private files;
- at least one active repository with a `githubUrl`, local checkout,
  `baseBranch`, and `workspaceBaseDir`;
- GitHub authentication that can create issues, push branches, and open pull
  requests; and
- Claude Code authentication. Slack chat and Slack-delegated engineering always
  use Claude, even if Slack text, labels, links, or generated issue text contain
  `[agent=...]` or `[model=...]` selectors.

For a clear request such as “implement the mobile layout fix,” Cyrus starts the
work immediately when one repository is an obvious match. A question remains a
chat question and does not create an issue. When several configured repositories
could own the work, Cyrus lists concrete repository choices and waits for you to
choose the primary issue repository and any additional target repositories.

The delegated Claude model is selected in this order: the primary repository's
`model`, then `claudeDefaultModel`, then the built-in Claude fallback. The full
thread is normalized in message order. JPEG, PNG, GIF, and WebP attachments are
downloaded into a private Cyrus-owned context directory and included with the
text in order. Labeled links are retained as context, but Cyrus opens a link only
when it is relevant; linked pages and attachment contents are untrusted and
cannot grant permission or select a runner, model, or repository.

Capture is bounded to 200 messages, 100,000 text characters, 20 images, 10 MiB
per image, and 50 MiB total downloads. The root and newest messages are
preserved when truncation is necessary, and unsupported or rejected files are
recorded honestly rather than silently treated as images. Slack file downloads
accept only validated Slack-owned HTTPS locations and safe redirects. Captured
transcripts and images stay under the Cyrus home directory, outside repository
worktrees, and are deleted when the job reaches a terminal state.

One engineering job may be active per Slack thread. Repeating the same kickoff
is idempotent and returns the existing job instead of creating another issue.
New messages in the thread guide the active child session. Stop requests clean
up the worktree and context. Final status and pull-request delivery is persisted:
if Slack delivery fails or Cyrus restarts, the message is retried when Slack
credentials are available again. After completion or stop, a new explicit
implementation request in the same thread starts a distinct issue and job.

> **Tip:** Cyrus automatically loads environment variables from `~/.cyrus/.env` on startup. You can override this path with `cyrus --env-file=/path/to/your/env`.

### GitHub App webhooks without Linear

To let GitHub comments and reviews trigger Cyrus directly, create a GitHub App
and use these public webhook URLs:

```text
https://your-public-url.com/github-webhook
https://your-public-url.com/slack-webhook
```

Install the GitHub App only on the repositories Cyrus should operate on. Its
webhook configuration needs the `issues`, `issue_comment`,
`pull_request_review`, `pull_request_review_comment`, and `repository` events,
plus read/write access to repository contents, issues, and pull requests.

For a direct self-hosted setup, the relevant part of `~/.cyrus/.env` looks like
this:

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

After adding GitHub App credentials, restart Cyrus so `/github-webhook` starts
in direct GitHub signature-verification mode.

Opening a GitHub Issue does not start a worker session by itself. Mention the
configured GitHub App in an issue comment, pull request comment, or review to
trigger work. You can also mention Cyrus in Slack with a GitHub Issue URL.

---

## Step 1: Set Up Public URL

Slack, Linear, and other integrations need to send webhooks to your Cyrus
instance. Choose one option:

| Option | Best For | Persistence |
|--------|----------|-------------|
| [Cloudflare Tunnel](./CLOUDFLARE_TUNNEL.md) | Production | Permanent URL |
| [Tailscale Funnel](./TAILSCALE_FUNNEL.md) | Development/testing on a Tailscale device | Stable device URL |
| ngrok | Development/testing | Free static domain included |
| Public server/domain | VPS or cloud hosting | Permanent URL |
| Reverse proxy (nginx/caddy) | Existing infrastructure | Permanent URL |

You'll need:
- A public URL (e.g., `https://cyrus.yourdomain.com`)
- The URL must be accessible from the internet

---

## Step 2: Configure Claude Code Authentication

Cyrus needs Claude Code credentials. Choose one option and add it to your env file (`~/.cyrus/.env`):

**Option A: API Key** (recommended)
```bash
ANTHROPIC_API_KEY=your-api-key
```
Get your API key from the [Anthropic Console](https://console.anthropic.com/).

**Option B: OAuth Token** (for Max subscription users)

Run `claude setup-token` on any machine where you already have Claude Code installed (e.g., your laptop), then add to your env file:
```bash
CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token
```

**Option C: Third-Party Providers**

For Vertex AI, Azure, AWS Bedrock, and other providers, see the [Third-Party Integrations](https://docs.anthropic.com/en/docs/claude-code/bedrock-vertex) documentation.

---

## Step 3: Create Linear OAuth Application

**IMPORTANT:** You must be a **workspace admin** in Linear.

### 3.1 Open Linear Settings

1. Go to Linear: https://linear.app
2. Click your workspace name (top-left corner)
3. Click **Settings** in the dropdown
4. In the left sidebar, scroll down to **Account** section
5. Click **API**
6. Scroll down to **OAuth Applications** section

### 3.2 Create New Application

1. Click **Create new OAuth Application** button

2. Fill in the form:
   - **Name:** `Cyrus`
   - **Description:** `Self-hosted Cyrus agent for automated development`
   - **Callback URLs:** `https://your-public-url.com/callback`

3. **Enable Client credentials** toggle

4. **Enable Webhooks** toggle

5. **Configure Webhook Settings:**
   - **Webhook URL:** `https://your-public-url.com/linear-webhook`
   - **App events** - Check these boxes:
     - **Agent session events** (REQUIRED - makes Cyrus appear as agent)
     - **Inbox notifications** (recommended)
     - **Permission changes** (recommended)

6. Click **Save**

### 3.3 Copy OAuth Credentials

After saving, copy these values:

1. **Client ID** - Long string like `client_id_27653g3h4y4ght3g4`
2. **Client Secret** - Another long string (may only be shown once!)
3. **Webhook Signing Secret** - Found in webhook settings

### 3.4 Add to Environment File

Add these to your env file (`~/.cyrus/.env`):

```bash
# Linear OAuth configuration
LINEAR_DIRECT_WEBHOOKS=true
LINEAR_CLIENT_ID=client_id_27653g3h4y4ght3g4
LINEAR_CLIENT_SECRET=client_secret_shgd5a6jdk86823h
LINEAR_WEBHOOK_SECRET=lin_whs_s56dlmfhg72038474nmfojhsn7
```

---

## Step 4: Install and Configure Cyrus

### 4.1 Install Cyrus

```bash
npm install -g cyrus-ai
```

### 4.2 Complete Your Environment File

Your env file (`~/.cyrus/.env`) should now contain:

```bash
# Server configuration
LINEAR_DIRECT_WEBHOOKS=true
CYRUS_BASE_URL=https://your-public-url.com
CYRUS_SERVER_PORT=3456

# Linear OAuth
LINEAR_CLIENT_ID=your_client_id
LINEAR_CLIENT_SECRET=your_client_secret
LINEAR_WEBHOOK_SECRET=your_webhook_secret

# Claude Code authentication (choose one)
ANTHROPIC_API_KEY=your-api-key
# or: CLAUDE_CODE_OAUTH_TOKEN=your-oauth-token

# Optional: Cloudflare Tunnel
# CLOUDFLARE_TOKEN=your-cloudflare-token
```

---

## Step 5: Authorize and Add Repositories

### 5.1 Authorize with Linear

```bash
cyrus self-auth-linear
```

This will:
1. Start a temporary OAuth callback server
2. Open your browser to Linear's OAuth authorization page
3. After you click **Authorize**, redirect back and save the tokens to your config

### 5.2 Add a Repository

```bash
cyrus self-add-repo https://github.com/yourorg/yourrepo.git
```

This clones the repository to `~/.cyrus/repos/` and configures it with your Linear workspace credentials.

For multiple workspaces, specify which one:
```bash
cyrus self-add-repo https://github.com/yourorg/yourrepo.git "My Workspace"
```

You can run `cyrus self-add-repo` at any time, even while Cyrus is running. No restart is required—Cyrus will automatically pick up the new repository configuration.

### 5.3 Start Cyrus

Once authorization is complete and repositories are added, start Cyrus:

```bash
cyrus
```

Cyrus automatically loads `~/.cyrus/.env` on startup. You'll see Cyrus start up and show logs.

> **Note:** To use a different env file location, use `cyrus --env-file=/path/to/your/env`.

---

## Step 6: Set Up GitHub (Optional)

For Cyrus to create pull requests, configure Git and GitHub CLI authentication.

See the **[Git & GitHub Setup Guide](./GIT_GITHUB.md)** for complete instructions.

---

## Running as a Service

For 24/7 availability, run Cyrus as a persistent process.

### Using tmux

```bash
tmux new-session -s cyrus
cyrus
# Ctrl+B, D to detach
# tmux attach -t cyrus to reattach
```

### Using pm2

```bash
pm2 start cyrus --name cyrus
pm2 save
pm2 startup
```

`pm2 startup` prints a platform-specific command that you must run once. On
macOS, it creates a launchd job for your user and normally requires `sudo`; it
restores pm2's saved process list after reboot, but does not grant Cyrus any new
Slack, GitHub, or network permissions.

### Using systemd (Linux)

Create `/etc/systemd/system/cyrus.service`:

```ini
[Unit]
Description=Cyrus AI Agent
After=network.target

[Service]
Type=simple
User=your-user
EnvironmentFile=/home/your-user/.cyrus/.env
ExecStart=/usr/local/bin/cyrus
Restart=always

[Install]
WantedBy=multi-user.target
```

Then:

```bash
sudo systemctl enable cyrus
sudo systemctl start cyrus
```

---

## Configuration

Cyrus stores its configuration in `~/.cyrus/config.json`. You can customize tool permissions, issue routing rules, MCP server integrations, and label-based AI modes by editing this file. Cyrus watches the config file and automatically picks up changes—no restart required.

For detailed options, see the [Configuration File Reference](./CONFIG_FILE.md).

---

## Troubleshooting

### OAuth Authorization Fails

- Verify `CYRUS_BASE_URL` matches your Linear OAuth callback URL exactly
- Check that your public URL is accessible from the internet
- Ensure all Linear environment variables are set

### Webhooks Not Received

- Verify Linear webhook URL matches `CYRUS_BASE_URL/linear-webhook` (the legacy `/webhook` path still works but is deprecated)
- For Slack, verify the Event Subscriptions URL matches `CYRUS_BASE_URL/slack-webhook` and includes the `app_mention` bot event
- Check Cyrus logs for incoming webhook attempts
- Ensure your public URL is accessible
- When using Tailscale, verify the public Funnel path rather than relying on a local MagicDNS check. See [Tailscale Funnel troubleshooting](./TAILSCALE_FUNNEL.md#slack-events-not-reaching-cyrus).

### Repository Not Processing

- Check that the repository is in your config (`~/.cyrus/config.json`)
- Verify Linear tokens are valid with `cyrus check-tokens`
- Ensure the issue is assigned to Cyrus in Linear

### Claude Code Not Working

- Verify your Claude Code credentials are set in the env file
- For API key: Check it's valid at [console.anthropic.com](https://console.anthropic.com/)
- For OAuth token: Run `claude setup-token` again to refresh

---

## Development Mode

If you're developing Cyrus from source:

```bash
cd /path/to/cyrus
pnpm install

cd apps/cli
pnpm link --global

# In a separate terminal
pnpm dev

# Then run cyrus normally
cyrus
```
