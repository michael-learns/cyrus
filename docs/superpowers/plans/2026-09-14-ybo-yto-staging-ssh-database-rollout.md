# YBO/YTO Staging SSH Database Rollout Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Publish the complete local Cyrus fork, deploy that exact fork revision as the restricted database gateway on YBO and YTO staging, configure nine channel-scoped SSH database connections, and prove the integration safely end to end.

**Architecture:** GitHub becomes the source of truth for the code already running locally plus the pending background-work fix. Each Ubuntu gateway builds an immutable, root-owned checkout of the exact merged fork revision and exposes a stable `/usr/local/bin/cyrus` wrapper. The Cyrus host owns one private key per database and pins each gateway host key; the gateway owns only the matching forced-command public keys, root-owned profiles, and `cyrus-db` credentials. Database permissions must pass Cyrus's unchanged fail-closed preflight before live Slack access is enabled.

**Tech Stack:** Git/GitHub CLI, pnpm 10.33.1, Node.js 22.23.2, TypeScript, PM2, OpenSSH Ed25519 keys, PostgreSQL/psql, Cyrus F1, Vitest, Ubuntu 22.04 amd64, macOS Cyrus host.

**Spec:** `docs/superpowers/specs/2026-08-21-ssh-database-access-design.md`

## Global Constraints

- Preserve and include the six existing uncommitted pending-background-work files as a distinct commit; do not squash them into the SSH database commits.
- Treat the current six-file source diff as the Slack runtime snapshot. During GitHub synchronization, do not edit those six files beyond appending the eventual PR link to the two existing changelog entries. If their existing tests fail, stop and report instead of changing runtime behavior.
- Do not rebuild or restart the Slack PM2 process until GitHub `main` contains the captured runtime source and its Git tree matches the local synchronized tree.
- Never print, commit, upload, or copy private keys, `.pgpass` contents, Slack tokens, GitHub credentials, or database rows into logs or artifacts.
- Rotate the Slack bot token exposed during process inspection before the final PM2 restart; update `~/.cyrus/.env` without displaying either token.
- Deploy only an exact commit merged into `michael-learns/cyrus`; never deploy an uncommitted working tree.
- Keep `/usr/local/bin/cyrus`, `/opt/cyrus/releases/**`, `/etc/cyrus/database-gateway.json`, Node.js, and psql root-owned and not group/other writable.
- Keep private database keys only on the Cyrus host with mode `0600`; install only public keys on YBO/YTO.
- Keep the SQL-policy and privilege-preflight implementation unchanged. Fix database grants rather than weakening the gateway.
- Use Slack team `T0ATUR70Y3C` and channel `C0BQ6FETXH6` for every connection.
- Use repository `github-yahshua-abba-yto` for YTO connections and `github-yahshua-abba-ybo` for YBO connections.
- Run the repository's F1 protocol during validation and preserve its report under `apps/f1/test-drives/`.
- Do not mutate PostgreSQL `PUBLIC` privileges until a read-only impact query identifies every affected login and the result is reviewed.

---

### Task 1: Preserve the rollout plan and finish the pending-work commit

**Files:**

- Create: `docs/superpowers/plans/2026-09-14-ybo-yto-staging-ssh-database-rollout.md`
- Modify: `CHANGELOG.md`
- Modify: `packages/claude-runner/src/ClaudeRunner.ts`
- Modify: `packages/claude-runner/src/types.ts`
- Modify: `packages/claude-runner/test/pending-work-lifecycle.test.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: `packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts`

**Interfaces:**

- Consumes: current local `main` at `1954e05a5a769f06ce7c63725b6efc51fa56121d`, 74 commits ahead of `origin/main`.
- Produces: a clean local branch with the rollout plan committed separately from the cohesive pending-background-work fix.

- [ ] **Step 1: Confirm the working tree contains only the seven expected paths**

```bash
git status --short
```

Expected: the six pending-work paths above plus this plan file, with no other paths.

- [ ] **Step 2: Capture the exact source snapshot currently represented in the Slack build**

```bash
shasum -a 256 CHANGELOG.md packages/claude-runner/src/ClaudeRunner.ts packages/claude-runner/src/types.ts packages/claude-runner/test/pending-work-lifecycle.test.ts packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts > /tmp/cyrus-slack-runtime-source.sha256
git diff --binary -- CHANGELOG.md packages/claude-runner/src/ClaudeRunner.ts packages/claude-runner/src/types.ts packages/claude-runner/test/pending-work-lifecycle.test.ts packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts > /tmp/cyrus-slack-runtime-source.patch
```

Expected: six hashes and a non-empty recoverable patch. These files contain the same pending-work and completion markers found in the currently loaded `packages/claude-runner/dist/ClaudeRunner.js` and `packages/edge-worker/dist/EdgeWorker.js`.

- [ ] **Step 3: Commit the approved rollout plan**

```bash
git add docs/superpowers/plans/2026-09-14-ybo-yto-staging-ssh-database-rollout.md
git commit -m "docs: plan YBO and YTO SSH database rollout"
```

- [ ] **Step 4: Run focused pending-work tests before committing that feature**

```bash
pnpm --filter cyrus-claude-runner test:run -- pending-work-lifecycle
pnpm --filter cyrus-edge-worker test:run -- EdgeWorker.github-issue-work-item
git diff --check
```

Expected: both Vitest commands pass and `git diff --check` prints nothing.

- [ ] **Step 5: Review the exact pending-work diff for timeout cleanup, duplicate Slack status suppression, and refreshed GitHub credentials**

```bash
git diff --check
git diff -- packages/claude-runner/src/ClaudeRunner.ts packages/claude-runner/src/types.ts packages/claude-runner/test/pending-work-lifecycle.test.ts packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts CHANGELOG.md
```

Expected: no unrelated database, config, credential, or deployment changes.

- [ ] **Step 6: Confirm the runtime source hashes are unchanged, then commit the pending-work fix as its own unit**

```bash
shasum -a 256 -c /tmp/cyrus-slack-runtime-source.sha256
git add CHANGELOG.md packages/claude-runner/src/ClaudeRunner.ts packages/claude-runner/src/types.ts packages/claude-runner/test/pending-work-lifecycle.test.ts packages/edge-worker/src/EdgeWorker.ts packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts
git commit -m "fix: bound pending background work completion"
```

- [ ] **Step 7: Confirm a clean, auditable result**

```bash
git status --short
git log -3 --oneline
```

Expected: clean status; the pending-work commit immediately follows the plan commit without altering the earlier SSH database commits.

---

### Task 2: Validate the complete fork revision before publishing

**Files:**

- Create: `apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md`
- Verify: all workspaces covered by the monorepo commands.

**Interfaces:**

- Consumes: the clean revision produced by Task 1.
- Produces: a checked-in F1 record and a revision that passes install, audit, tests, typecheck, and build.

- [ ] **Step 1: Verify dependency reproducibility and security**

```bash
pnpm install --frozen-lockfile
pnpm audit
```

Expected: the lockfile does not change and the audit reports zero advisories.

- [ ] **Step 2: Run full package verification**

```bash
pnpm test:packages:run
pnpm typecheck
pnpm build
git diff --check
```

Expected: every command exits zero.

- [ ] **Step 3: Re-run the gateway-focused checks**

```bash
pnpm --filter cyrus-ssh-database test:run
pnpm --filter cyrus-ssh-database typecheck
pnpm --filter cyrus-ai test:run -- DatabaseGatewayCommand
```

Expected: 123 SSH-database tests and the CLI gateway tests pass.

- [ ] **Step 4: Run the credential-free F1 database path**

```bash
pnpm --filter cyrus-f1 test:run -- sshDatabaseFixture syntheticSlackEngineeringModel syntheticSlackEngineeringBackend
pnpm --filter cyrus-f1 typecheck
```

Expected: connection listing, bounded queries, wrong-channel denial, ambiguity handling, write rejection, truncation, untrusted-row handling, engineering handoff, restart revocation, and zero synthetic external requests all pass.

- [ ] **Step 5: Run the hermetic OpenSSH/PostgreSQL drive when Docker images are available**

```bash
node apps/f1/test-drives/assets/2026-08-21-ssh-database-hermetic.mjs
```

Expected: PostgreSQL and OpenSSH report success, write rejection is true, and temporary containers are removed. If cached images are unavailable, record that limitation and rely on the focused production-path fixture plus the later real staging drive.

- [ ] **Step 6: Write the F1 report with commands, exact pass/fail counts, and no secrets or database rows**

Create `apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md` using the format required by `.codex/skills/f1-test-drive/SKILL.md`. Record issue-tracker, EdgeWorker, renderer, Slack/database fixture, cleanup, and retrospective results.

- [ ] **Step 7: Commit the verification report**

```bash
git add apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md
git commit -m "test: validate staging SSH database rollout"
```

---

### Task 3: Synchronize the fork through a reviewable GitHub pull request

**Files:**

- Modify: `CHANGELOG.md` only to attach the new PR link to the SSH-database and pending-background-work entries.

**Interfaces:**

- Consumes: the fully verified local history from Task 2 and remote `main` at `0d988951d97ac98884531ca78abd2ffcb08a64fc`.
- Produces: a merged GitHub revision used verbatim by the local Slack service and both gateways.

- [ ] **Step 1: Confirm the remote has not moved and remains an ancestor**

```bash
git fetch origin main
git merge-base --is-ancestor origin/main HEAD
git rev-list --left-right --count origin/main...HEAD
```

Expected: ancestor check exits zero and the right-hand count contains the local-only history with zero commits unique to remote.

- [ ] **Step 2: Create and publish the rollout branch**

```bash
git switch -c codex/staging-ssh-db-rollout
git push -u origin codex/staging-ssh-db-rollout
```

- [ ] **Step 3: Open a PR without squashing the existing local commit history**

```bash
gh pr create --repo michael-learns/cyrus --base main --head codex/staging-ssh-db-rollout --title "Sync local Cyrus fork and stage SSH database access" --body "This synchronizes the committed local fork that currently powers Slack, includes the pending-background-work fix as a separate commit, and prepares the restricted YBO/YTO staging SSH database rollout.

Verification is recorded in apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md and includes package tests, typecheck, build, the credential-free Slack/database fixture, and the hermetic OpenSSH/PostgreSQL drive when locally available.

Deployment uses this PR's exact merged SHA in root-owned gateway checkouts. Database access remains disabled until all nine profiles pass Cyrus's unchanged privilege preflight. Rollback restores the dated Cyrus config and authorized_keys backups and repoints /opt/cyrus/current without restoring unsafe database grants."
```

- [ ] **Step 4: Add the actual PR link to both Unreleased changelog entries**

Capture the PR metadata with `PR_NUMBER=$(gh pr view --json number -q .number)` and `PR_URL=$(gh pr view --json url -q .url)`. Use `apply_patch` to append the resulting `([#$PR_NUMBER]($PR_URL))` link to the SSH-database `Added` entry and pending-background-work `Fixed` entry.

- [ ] **Step 5: Verify and publish the changelog-only commit**

```bash
git diff --check
git add CHANGELOG.md
git commit -m "docs: link staging database rollout PR"
git push
```

- [ ] **Step 6: Confirm GitHub checks pass, then merge with history preserved**

```bash
gh pr checks --repo michael-learns/cyrus --watch
gh pr merge --repo michael-learns/cyrus --merge --delete-branch
git switch main
git pull --ff-only origin main
```

Expected: the PR is merged, local `main` equals `origin/main`, and the tree is clean. If branch protection or checks reject the merge, stop and report rather than bypassing them.

- [ ] **Step 7: Capture the immutable rollout revision**

```bash
git rev-parse HEAD
git tag -a staging-ssh-db-2026-09-14 -m "YBO/YTO staging SSH database rollout"
git push origin staging-ssh-db-2026-09-14
```

Use the resulting commit SHA for every deployment command below.

- [ ] **Step 8: Prove GitHub contains the synchronized local source before any deployment work**

```bash
test "$(git rev-parse HEAD)" = "$(git rev-parse origin/main)"
git diff --exit-code origin/main -- .
git status --short
```

Expected: identical local/remote commit IDs, no tree diff, and a clean working tree. The two changelog lines may differ from the pre-PR runtime snapshot only by their appended PR links; the five runtime/test files must still match `/tmp/cyrus-slack-runtime-source.sha256` exactly.

---

### Task 4: Install the exact fork revision on YTO and YBO gateways

**Files:**

- Create remotely: `/opt/node/node-v22.23.2-linux-x64/`
- Create remotely: `/opt/cyrus/releases/$ROLLOUT_SHA/`, where `ROLLOUT_SHA` is resolved from the signed rollout tag in Step 1.
- Create remotely: `/usr/local/bin/cyrus`
- Preserve remotely: `/etc/cyrus/database-gateway.json`
- Preserve remotely: `/home/cyrus-db/.pgpass`

**Interfaces:**

- Consumes: the immutable Git tag and SHA from Task 3.
- Produces: identical root-owned gateway installations on Ubuntu 22.04 amd64, callable by the existing forced commands.

- [ ] **Step 1: Record the rollout SHA locally and verify the tag resolves to it**

```bash
ROLLOUT_SHA=$(git rev-parse staging-ssh-db-2026-09-14^{commit})
test "$ROLLOUT_SHA" = "$(git rev-parse HEAD)"
```

- [ ] **Step 2: Download and verify Node.js 22.23.2 independently on each gateway**

Run through both `hetzner-staging-yto` and `hetzner-staging-ybo`:

```bash
cd /tmp
curl -fsSLO https://nodejs.org/dist/v22.23.2/node-v22.23.2-linux-x64.tar.xz
curl -fsSLO https://nodejs.org/dist/v22.23.2/SHASUMS256.txt
grep ' node-v22.23.2-linux-x64.tar.xz$' SHASUMS256.txt | sha256sum --check --strict
```

Expected: checksum reports `OK`. Stop on any mismatch.

- [ ] **Step 3: Install the root-owned runtime and activate the repository pnpm version**

```bash
sudo install -d -o root -g root -m 0755 /opt/node
sudo tar -xJf /tmp/node-v22.23.2-linux-x64.tar.xz -C /opt/node
sudo ln -sfn /opt/node/node-v22.23.2-linux-x64/bin/node /usr/local/bin/node
sudo ln -sfn /opt/node/node-v22.23.2-linux-x64/bin/corepack /usr/local/bin/corepack
sudo /usr/local/bin/corepack prepare pnpm@10.33.1 --activate
/usr/local/bin/node --version
/usr/local/bin/corepack pnpm --version
```

Expected: Node `v22.23.2` and pnpm `10.33.1`.

- [ ] **Step 4: Clone and build the exact GitHub revision into an immutable release directory**

```bash
sudo install -d -o root -g root -m 0755 /opt/cyrus/releases
sudo git clone https://github.com/michael-learns/cyrus.git "/opt/cyrus/releases/$ROLLOUT_SHA"
sudo git -C "/opt/cyrus/releases/$ROLLOUT_SHA" checkout --detach "$ROLLOUT_SHA"
sudo /usr/local/bin/corepack pnpm --dir "/opt/cyrus/releases/$ROLLOUT_SHA" install --frozen-lockfile
sudo /usr/local/bin/corepack pnpm --dir "/opt/cyrus/releases/$ROLLOUT_SHA" build
sudo chmod -R go-w "/opt/cyrus/releases/$ROLLOUT_SHA"
```

- [ ] **Step 5: Install the stable forced-command wrapper atomically**

Create a root-owned mode-`0755` `/usr/local/bin/cyrus` wrapper whose complete content is:

```sh
#!/bin/sh
set -eu
exec /usr/local/bin/node /opt/cyrus/current/apps/cli/dist/src/app.js "$@"
```

Then activate the release:

```bash
sudo ln -sfn "/opt/cyrus/releases/$ROLLOUT_SHA" /opt/cyrus/current
sudo chown -h root:root /opt/cyrus/current
sudo chown root:root /usr/local/bin/cyrus
sudo chmod 0755 /usr/local/bin/cyrus
```

- [ ] **Step 6: Verify gateway installation integrity on both hosts**

```bash
sudo -u cyrus-db /usr/local/bin/cyrus --version
sudo stat -Lc '%n mode=%a uid=%u gid=%g' /usr/local/bin/cyrus /usr/local/bin/node /usr/bin/psql
sudo git -C /opt/cyrus/current rev-parse HEAD
```

Expected: version `0.2.68`, safe ownership/modes, and the exact rollout SHA on both hosts.

---

### Task 5: Rotate and install one Cyrus-host-owned key per database

**Files:**

- Create locally: `~/.cyrus/ssh/yto-staging-db4` through `yto-staging-db7`
- Create locally: `~/.cyrus/ssh/ybo-staging-db` through `ybo-staging-db5`
- Create locally: `~/.cyrus/ssh/yto_known_hosts`
- Create locally: `~/.cyrus/ssh/ybo_known_hosts`
- Modify remotely: `/home/cyrus-db/.ssh/authorized_keys` on both gateways

**Interfaces:**

- Consumes: installed gateway command and the nine profile IDs already present remotely.
- Produces: nine private keys held only by the Cyrus process user and nine matching forced public keys.

- [ ] **Step 1: Back up the existing authorized key files recoverably**

```bash
ssh hetzner-staging-yto 'sudo cp -p /home/cyrus-db/.ssh/authorized_keys /home/cyrus-db/.ssh/authorized_keys.pre-rollout-2026-09-14'
ssh hetzner-staging-ybo 'sudo cp -p /home/cyrus-db/.ssh/authorized_keys /home/cyrus-db/.ssh/authorized_keys.pre-rollout-2026-09-14'
```

- [ ] **Step 2: Create the trusted local key directory**

```bash
install -d -m 0700 ~/.cyrus/ssh
```

- [ ] **Step 3: Generate exactly nine headless Ed25519 keys locally**

Generate keys named after these profile IDs with empty passphrases and matching comments:

```text
yto-staging-db4
yto-staging-db5
yto-staging-db6
yto-staging-db7
ybo-staging-db
ybo-staging-db2
ybo-staging-db3
ybo-staging-db4
ybo-staging-db5
```

```bash
for PROFILE in yto-staging-db4 yto-staging-db5 yto-staging-db6 yto-staging-db7 ybo-staging-db ybo-staging-db2 ybo-staging-db3 ybo-staging-db4 ybo-staging-db5; do
  test ! -e "$HOME/.cyrus/ssh/$PROFILE"
  test ! -e "$HOME/.cyrus/ssh/$PROFILE.pub"
  ssh-keygen -t ed25519 -f "$HOME/.cyrus/ssh/$PROFILE" -N '' -C "cyrus-$PROFILE"
  chmod 0600 "$HOME/.cyrus/ssh/$PROFILE"
  chmod 0644 "$HOME/.cyrus/ssh/$PROFILE.pub"
done
```

Abort if any target already exists; never overwrite a private key.

- [ ] **Step 4: Pin and independently verify both gateway host keys**

```bash
ssh-keyscan -t ed25519 5.223.75.18 > ~/.cyrus/ssh/yto_known_hosts
ssh-keyscan -t ed25519 5.223.57.195 > ~/.cyrus/ssh/ybo_known_hosts
chmod 0644 ~/.cyrus/ssh/yto_known_hosts ~/.cyrus/ssh/ybo_known_hosts
ssh-keygen -lf ~/.cyrus/ssh/yto_known_hosts
ssh-keygen -lf ~/.cyrus/ssh/ybo_known_hosts
```

Compare each fingerprint with `sudo ssh-keygen -lf /etc/ssh/ssh_host_ed25519_key.pub` obtained over the already authenticated admin connection. Stop if either differs.

- [ ] **Step 5: Build replacement authorized-key files containing only restricted forced commands**

```bash
KEY_STAGE=$(mktemp -d)
chmod 0700 "$KEY_STAGE"
for PROFILE in yto-staging-db4 yto-staging-db5 yto-staging-db6 yto-staging-db7; do
  PUBLIC_KEY=$(awk '{print $1" "$2" "$3}' "$HOME/.cyrus/ssh/$PROFILE.pub")
  printf 'restrict,command="/usr/local/bin/cyrus database-gateway --config /etc/cyrus/database-gateway.json --profile %s" %s\n' "$PROFILE" "$PUBLIC_KEY" >> "$KEY_STAGE/yto_authorized_keys"
done
for PROFILE in ybo-staging-db ybo-staging-db2 ybo-staging-db3 ybo-staging-db4 ybo-staging-db5; do
  PUBLIC_KEY=$(awk '{print $1" "$2" "$3}' "$HOME/.cyrus/ssh/$PROFILE.pub")
  printf 'restrict,command="/usr/local/bin/cyrus database-gateway --config /etc/cyrus/database-gateway.json --profile %s" %s\n' "$PROFILE" "$PUBLIC_KEY" >> "$KEY_STAGE/ybo_authorized_keys"
done
chmod 0600 "$KEY_STAGE/yto_authorized_keys" "$KEY_STAGE/ybo_authorized_keys"
test "$(wc -l < "$KEY_STAGE/yto_authorized_keys" | tr -d ' ')" = 4
test "$(wc -l < "$KEY_STAGE/ybo_authorized_keys" | tr -d ' ')" = 5
```

Do not add shells, forwarding, agents, PTYs, passwords, or arbitrary remote commands.

- [ ] **Step 6: Install the complete files atomically and verify ownership/counts**

```bash
scp "$KEY_STAGE/yto_authorized_keys" hetzner-staging-yto:/tmp/cyrus-authorized-keys.new
scp "$KEY_STAGE/ybo_authorized_keys" hetzner-staging-ybo:/tmp/cyrus-authorized-keys.new
ssh hetzner-staging-yto 'sudo install -o cyrus-db -g cyrus-db -m 0600 /tmp/cyrus-authorized-keys.new /home/cyrus-db/.ssh/authorized_keys && rm /tmp/cyrus-authorized-keys.new'
ssh hetzner-staging-ybo 'sudo install -o cyrus-db -g cyrus-db -m 0600 /tmp/cyrus-authorized-keys.new /home/cyrus-db/.ssh/authorized_keys && rm /tmp/cyrus-authorized-keys.new'
```

Then run:

```bash
ssh hetzner-staging-yto 'sudo ssh-keygen -lf /home/cyrus-db/.ssh/authorized_keys && sudo stat -c "%a %U:%G %n" /home/cyrus-db/.ssh/authorized_keys'
ssh hetzner-staging-ybo 'sudo ssh-keygen -lf /home/cyrus-db/.ssh/authorized_keys && sudo stat -c "%a %U:%G %n" /home/cyrus-db/.ssh/authorized_keys'
```

Expected: four YTO fingerprints, five YBO fingerprints, and `600 cyrus-db:cyrus-db`.

---

### Task 6: Resolve PostgreSQL privilege-preflight failures without weakening Cyrus

**Files:**

- Preserve remotely: `/etc/cyrus/database-gateway.json`
- Modify: PostgreSQL grants only after read-only impact review.

**Interfaces:**

- Consumes: YTO reader `cyrus_yto_staging_reader`, YBO reader `cyrus_ybo_staging_reader`, and the existing Cyrus preflight SQL.
- Produces: all nine profiles with zero unsafe flags and access only to their declared databases.

- [ ] **Step 1: Save a metadata-only before-state for each cluster**

Run Cyrus's exact `POSTGRES_PRIVILEGE_PREFLIGHT_SQL` as the reader on all nine databases and record only booleans/counts. Also list non-template databases where `has_database_privilege(current_user, datname, 'CONNECT')` is true. Do not record table names, row values, passwords, or connection strings.

The observed before-state is: every database inherits `PUBLIC TEMP`, one table per database grants `PUBLIC UPDATE`, and user routines inherit `PUBLIC EXECUTE`; `staging_db7`, YBO `staging_db`, `staging_db3`, and `staging_db4` also inherit `PUBLIC CREATE` on schema `public`. Database ACL defaults also give both readers `CONNECT` to every non-template database in their cluster.

- [ ] **Step 2: Identify the grant source for each failing capability**

As the PostgreSQL administrator, inspect direct and `PUBLIC` grants responsible for:

```text
hasDatabaseTemp=true
hasSchemaCreate=true
hasTableWrite=true
hasUserRoutineExecute=true
out-of-scope CONNECT=true
```

Record affected grantee names and privilege types only. Because PostgreSQL has no per-role `DENY`, stop for impact review if removing `PUBLIC CONNECT`, `PUBLIC TEMP`, schema `CREATE`, table writes, or routine `EXECUTE` would affect application roles.

- [ ] **Step 3: Generate and review an explicit least-privilege SQL change set**

Generate a transaction-wrapped SQL file containing one explicit `REVOKE` or compensating `GRANT` per database/schema/table/routine/default-privilege ACL discovered in Step 2. The post-state must retain only `CONNECT`, schema `USAGE`, and table `SELECT` for the Cyrus reader. It must remove reader/PUBLIC-derived `TEMP`, schema creation, table mutation, sequence mutation, and user-routine execution and correct owner default privileges. For every out-of-scope database, it must remove effective `CONNECT` from the Cyrus reader while explicitly regranting every non-Cyrus application role that the impact report proves depended on the removed `PUBLIC` grant. Print the generated SQL for human review with role/object names but no data or credentials; do not execute it in this step.

- [ ] **Step 4: Apply the reviewed SQL atomically, one database at a time**

Execute each transaction with `psql --set=ON_ERROR_STOP=1`. After each commit, immediately run the preflight and connection-scope checks for that database/cluster. On the first mismatch, stop and restore the captured ACLs before touching another database.

- [ ] **Step 5: Re-run the exact Cyrus preflight against all nine profiles**

Expected for each profile:

```text
currentRole=cyrus_yto_staging_reader on YTO; currentRole=cyrus_ybo_staging_reader on YBO
isSuperuser=false
canCreateDb=false
canCreateRole=false
isReplication=false
canBypassRls=false
membershipCount=0
ownedObjectCount=0
hasDatabaseCreate=false
hasDatabaseTemp=false
hasSchemaCreate=false
hasTableWrite=false
hasSequenceMutation=false
hasUserRoutineExecute=false
deadlineSupported=true
```

Expected connect sets: YTO only `staging_db4` through `staging_db7`; YBO only `staging_db` through `staging_db5`.

---

### Task 7: Configure nine connections on the Cyrus host and rotate the exposed Slack token

**Files:**

- Modify locally: `~/.cyrus/config.json`
- Modify locally: `~/.cyrus/.env`
- Back up locally: timestamped copies under `~/.cyrus/backups/staging-ssh-db-2026-09-14/`

**Interfaces:**

- Consumes: nine verified keys, two pinned host files, exact profiles, corrected database grants, and the shared Slack destination.
- Produces: nine hot-reloadable connections scoped to the YTO/YBO repositories and one Slack channel.

- [ ] **Step 1: Back up current local configuration and record PM2 state**

```bash
install -d -m 0700 ~/.cyrus/backups/staging-ssh-db-2026-09-14
cp -p ~/.cyrus/config.json ~/.cyrus/backups/staging-ssh-db-2026-09-14/config.json
cp -p ~/.cyrus/.env ~/.cyrus/backups/staging-ssh-db-2026-09-14/.env
pm2 jlist | jq '[.[] | {name,status:.pm2_env.status,cwd:.pm2_env.pm_cwd,script:.pm2_env.pm_exec_path}]'
```

- [ ] **Step 2: Add the four YTO and five YBO `databaseConnections` entries**

Use these immutable mappings:

```text
YTO host=5.223.75.18 user=cyrus-db knownHosts=~/.cyrus/ssh/yto_known_hosts repository=github-yahshua-abba-yto
YBO host=5.223.57.195 user=cyrus-db knownHosts=~/.cyrus/ssh/ybo_known_hosts repository=github-yahshua-abba-ybo
Slack team=T0ATUR70Y3C channel=C0BQ6FETXH6
Connection/profile/database pairs:
yto-staging-db4/staging_db4
yto-staging-db5/staging_db5
yto-staging-db6/staging_db6
yto-staging-db7/staging_db7
ybo-staging-db/staging_db
ybo-staging-db2/staging_db2
ybo-staging-db3/staging_db3
ybo-staging-db4/staging_db4
ybo-staging-db5/staging_db5
```

Each entry uses engine `postgres`, identity `~/.cyrus/ssh/$PROFILE` where `$PROFILE` is the exact connection/profile ID in the mapping, limits `{connectTimeoutMs:10000,queryTimeoutMs:15000,maxSqlBytes:16384,maxRows:100,maxOutputBytes:32768}`, and literal `allowModelDataRetention:true`.

- [ ] **Step 3: Validate JSON and the production schema before reload**

```bash
jq empty ~/.cyrus/config.json
node --input-type=module -e 'import fs from "node:fs"; import { EdgeConfigSchema } from "./packages/core/dist/index.js"; EdgeConfigSchema.parse(JSON.parse(fs.readFileSync(process.env.HOME+"/.cyrus/config.json","utf8"))); console.log("config valid")'
```

- [ ] **Step 4: Rotate the exposed Slack bot token without printing it**

Create a replacement Slack token through the workspace's normal credential process, update only `SLACK_BOT_TOKEN` in `~/.cyrus/.env`, preserve mode `0600`, and revoke the old token. Do not pass the new token on a command line or include it in PM2 inspection output.

- [ ] **Step 5: Build the exact merged local revision and restart PM2 once**

```bash
test "$(git rev-parse HEAD)" = "$(git rev-parse staging-ssh-db-2026-09-14^{commit})"
pnpm build
pm2 restart cyrus --update-env
pm2 save
pm2 jlist | jq '[.[] | select(.name=="cyrus") | {name,status:.pm2_env.status,cwd:.pm2_env.pm_cwd,script:.pm2_env.pm_exec_path,restarts:.pm2_env.restart_time}]'
```

Expected: Cyrus returns `online` using this checkout's `apps/cli/dist/src/app.js`.

---

### Task 8: Prove forced-command, authorization, and Slack behavior end to end

**Files:**

- Modify: `apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md` with final staging results only; never include SQL rows or secrets.

**Interfaces:**

- Consumes: synchronized fork, installed gateways, corrected roles, keys, and local config.
- Produces: a PASS/FAIL acceptance record and a reversible production-ready staging setup.

- [ ] **Step 1: Test every forced key through `SshDatabaseQueryService`**

Invoke a bounded `SELECT current_database(), current_user` through each of the nine configured connections. Expected: exact database and reader names match the profile mapping; no password, shell, forwarding, agent, or arbitrary remote command is available.

- [ ] **Step 2: Confirm local policy rejects a write before SSH**

Submit one `UPDATE` through the database query service with a process spy or audit observation. Expected: `QUERY_REJECTED` and no SSH process starts. Do not target or mutate a real table.

- [ ] **Step 3: Confirm authorization boundaries using the F1 Slack fixture**

Re-run the credential-free fixture and verify the approved team/channel plus matching repository sees the intended connections, while a wrong channel, unverifiable session, Linear-only session, generic GitHub session, and wrong repository see none.

- [ ] **Step 4: Run the approved-channel live Slack smoke**

In `T0ATUR70Y3C` / `C0BQ6FETXH6`, ask Cyrus to list authorized read-only connections without querying. Expected: exactly five YBO and four YTO display names. Then query `SELECT current_database(), current_user` once per connection and confirm the exact mapping.

- [ ] **Step 5: Verify metadata-only audit behavior**

Inspect Cyrus logs for `database_connections_list` and `database_query` audit events. Expected fields: team/channel/user, repository IDs, connection ID, engine, duration, row count, byte count, truncation, success/error code. Confirm SQL, rows, credentials, key paths, SSH stderr, and tokens are absent.

- [ ] **Step 6: Record the final staging drive and commit it**

Update the F1 report with sanitized PASS/FAIL results, cleanup, limitations, and rollback evidence, then run:

```bash
git diff --check
git add apps/f1/test-drives/2026-09-14-staging-ssh-database-rollout.md
git commit -m "test: record live staging database verification"
git push origin main
```

If repository policy requires PRs for post-rollout evidence, push `codex/staging-ssh-db-evidence` and merge it through a documentation-only PR instead of pushing `main` directly.

---

### Task 9: Exercise and document rollback before declaring completion

**Files:**

- Verify: local config backup, remote authorized-key backups, and previous gateway release target.

**Interfaces:**

- Consumes: all rollout artifacts.
- Produces: a tested recovery path with no orphaned credentials.

- [ ] **Step 1: Verify capability revocation by temporarily loading an empty connection list in a copied test config**

Use schema validation and a non-production EdgeWorker/F1 instance to prove `databaseConnections: []` immediately removes both database tools from the session capability. Do not remove the live connections during this test.

- [ ] **Step 2: Record the operational rollback order**

```text
1. Restore ~/.cyrus/config.json from the dated backup and restart PM2.
2. Restore each remote authorized_keys.pre-rollout-2026-09-14 file.
3. Repoint /opt/cyrus/current to the previous release if one exists; otherwise remove databaseConnections while retaining the new gateway binary.
4. Revoke/delete the nine new local private keys only after their public keys are no longer authorized.
5. Keep corrected least-privilege database grants; do not restore unsafe privileges merely to roll back Cyrus.
6. Revoke any superseded Slack token and verify Cyrus health.
```

- [ ] **Step 3: Final verification**

```bash
git status --short
git log -1 --decorate --oneline
pm2 jlist | jq '[.[] | select(.name=="cyrus") | {name,status:.pm2_env.status,restarts:.pm2_env.restart_time}]'
ssh hetzner-staging-yto 'sudo git -C /opt/cyrus/current rev-parse HEAD; sudo -u cyrus-db /usr/local/bin/cyrus --version'
ssh hetzner-staging-ybo 'sudo git -C /opt/cyrus/current rev-parse HEAD; sudo -u cyrus-db /usr/local/bin/cyrus --version'
```

Completion requires a clean repository, synchronized GitHub main/tag, online PM2 service, identical gateway SHAs, nine successful reader identity queries, correct negative authorization tests, safe audit logs, and a complete F1 report.
