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
- [x] Both gateways run fork version `0.2.68` from signed rollout revision 2, commit `861aedb0ccbad226f770c5bf9878ca49812b8722`.
- [x] The nine matching private keys exist only on the Cyrus host with mode `0600`; their public halves replaced the gateway forced-key files after recoverable backups were created.
- [x] Both gateway host keys are pinned locally and match fingerprints obtained through the pre-existing authenticated admin connections.
- [x] The gateway profile is root-owned and group-readable only by `cyrus-db`; the configured PostgreSQL executable is the root-owned versioned binary rather than Ubuntu's environment-dependent `pg_wrapper`.
- [x] Both SSH daemons enforce public-key-only authentication, no TTY, no forwarding, and no X11 for `cyrus-db`; syntax and admin access were verified after reload.
- [x] Cyrus has nine schema-valid `databaseConnections`, all scoped to Slack team `T0ATUR70Y3C` and channel `C0BQ6FETXH6`.

### Database privilege gate

The first exact Cyrus privilege preflight rejected all nine target databases. The discovered causes included database `TEMP` inherited from `PUBLIC`, tables with `PUBLIC UPDATE`, user routines with `PUBLIC EXECUTE`, and `PUBLIC CREATE` on some `public` schemas. The reader roles could also connect to databases outside the stated allowlist because those databases granted `PUBLIC CONNECT`.

The metadata-only impact review found one non-superuser login on YTO (`yto_viewer`) and no non-superuser application login on YBO. No application sessions were active during the change. `yto_viewer` received explicit equivalents of its inherited privileges before `PUBLIC` access was removed. The readers now connect only to their declared databases.

All nine target databases pass Cyrus's unchanged privilege preflight and a real forced-key identity query. The verified identities are `cyrus_yto_staging_reader` on `staging_db4` through `staging_db7` and `cyrus_ybo_staging_reader` on `staging_db` through `staging_db5`. A final cluster-wide check found that PostgreSQL's template databases still inherited `PUBLIC CONNECT`; that access was removed on both staging clusters. The resulting effective `CONNECT` set is exactly four YTO and five YBO application databases, with every other database denied. Each target database also reports no `CREATE` privilege on `public` and no effective table-write privilege for its Cyrus reader. A real attempted `UPDATE` was rejected locally as `QUERY_REJECTED` before SSH.

### Real-host defect found and fixed

The first real query exposed a PostgreSQL client batching bug: the trailing
`ROLLBACK` in one `psql --command` batch became the final libpq result and hid
the preceding SELECT output. A regression test was first observed failing, then
the batch was changed to end with the bounded SELECT. The connection closes
with an uncommitted read-only transaction, which PostgreSQL rolls back. Full
package tests, typecheck, build, and the selected 29-test F1 run passed before
the patched commit was signed, pushed, built, and activated on both gateways.

### Activation gate

The old Slack OAuth tokens were revoked, the app was reinstalled with its
existing scopes, and the replacement bot token passed Slack `auth.test` for
team `T0ATUR70Y3C`. The nine-connection candidate replaced the live config,
passed `EdgeConfigSchema`, and retains mode `0600`. PM2 was restarted once with
the updated environment, saved, and remains online on Cyrus `0.2.68`.

After Cyrus was added to `C0BQ6FETXH6`, the first approved-channel smoke found
that a clean CLI startup dropped `databaseConnections` while assembling the
initial `EdgeWorkerConfig`. The existing hot-reload path handled the field, but
the CLI's startup path did not, so the Slack session correctly failed closed and
registered no database tools. A CLI regression test reproduced the omission,
then `WorkerService` was updated to pass the parsed connections into the worker.
The regression test, all package tests, typecheck, build, and the selected
29-test F1 run passed. The metadata-only Slack smoke must be repeated after the
fixed CLI is committed, pushed, and restarted.

## Verdict

**PASS for implementation, synthetic F1, gateway runtime, SSH hardening, exact database scope, all nine forced-key identity queries, Slack token rotation, live config installation, and PM2 activation. The first approved-channel smoke found and regression-tested a clean-start configuration bug; the only remaining acceptance check is repeating that smoke after deploying the fix.**
