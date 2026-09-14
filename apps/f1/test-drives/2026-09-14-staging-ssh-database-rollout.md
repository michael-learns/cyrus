# Test Drive: YBO/YTO Staging SSH Database Rollout

**Date**: 2026-09-14  
**Goal**: Validate the Cyrus SSH database feature and the synthetic Slack-to-database boundary before installing the fork on the YBO and YTO staging gateways.  
**Protocol**: `.codex/skills/f1-test-drive/SKILL.md`

## Verification Results

### Fork and package checks

- [x] `pnpm install --frozen-lockfile` completed without changing the lockfile.
- [x] All package tests passed.
- [x] TypeScript checks passed.
- [x] The monorepo build passed.
- [x] The `cyrus-ssh-database` package tests passed.
- [ ] `pnpm audit` is clean. The existing dependency graph reports 13 advisories (4 high, 9 moderate); the operator explicitly allowed the source sync and rollout work to continue without folding unrelated dependency upgrades into this change.

### Synthetic F1 boundary

- [x] SSH database fixture coverage passed.
- [x] Synthetic Slack engineering model coverage passed.
- [x] Synthetic Slack backend coverage passed.
- [x] Database audit events remain observable at the synthetic Slack boundary.
- [x] No real Slack or database credentials were used by the F1 run.

The first selected F1 run exposed a stale synthetic Slack upload contract: the production transport sends Slack file API requests as URL-encoded forms, while the synthetic backend still parsed JSON. The backend and its direct test were updated to reflect the production protocol. Focused verification then passed with 18 tests, followed by the complete selected run:

```bash
pnpm --filter cyrus-f1 test:run -- sshDatabaseFixture syntheticSlackEngineeringModel syntheticSlackEngineeringBackend
```

Result: 5 files and 29 tests passed.

### Staging discovery

- [x] Administrative SSH reaches `staging-ybo-h` and `staging-yto-2`.
- [x] Nine gateway profiles and nine matching forced-command public keys are installed across the two hosts.
- [x] All nine target database logins resolve to the intended reader roles.
- [x] The gateway configuration and `.pgpass` files have restrictive ownership and modes.
- [ ] `/usr/local/bin/cyrus` exists on either gateway. The fork runtime still needs to be installed.
- [ ] The nine matching private keys exist on the Cyrus host. New dedicated pairs still need to be generated and their public halves installed.
- [ ] Cyrus has `databaseConnections` configured. The nine connections still need to be added.

### Database privilege gate

The exact Cyrus privilege preflight currently rejects all nine target databases. The discovered causes include database `TEMP` inherited from `PUBLIC`, tables with `PUBLIC UPDATE`, user routines with `PUBLIC EXECUTE`, and `PUBLIC CREATE` on some `public` schemas. The reader roles can also connect to databases outside the stated allowlist because those databases grant `PUBLIC CONNECT`.

No PostgreSQL ACL was changed during discovery. PostgreSQL has no per-role `DENY`, so revoking these `PUBLIC` privileges can affect application roles. A database-owner-reviewed impact plan is required before applying the ACL transaction; the gateway preflight must not be weakened.

## Verdict

**PASS for the local implementation and synthetic F1 boundary. NOT READY for live database queries until the gateway runtime, SSH keys, Cyrus connections, and PostgreSQL privilege gate are completed.**
