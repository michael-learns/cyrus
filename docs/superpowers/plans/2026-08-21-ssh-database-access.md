# SSH Database Access Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use
> `superpowers:subagent-driven-development` (recommended) or
> `superpowers:executing-plans` to implement this plan.

**Goal:** Let Cyrus safely run bounded, read-only PostgreSQL and MySQL queries
through operator-configured SSH gateways from authorized Slack chat and
Slack-originated engineering sessions.

**Architecture:** A new `cyrus-ssh-database` package owns the versioned wire
protocol, dialect-aware SQL policy, privilege preflight, native-client output
framing, remote gateway, and local SSH query service. `cyrus-core` owns public
configuration schemas. `cyrus-edge-worker` derives immutable authorization
from verified Slack state, issues opaque MCP capabilities, gates receipt-backed
engineering control centrally, and filters sensitive tool payloads before any
Cyrus-owned persistence. `cyrus-mcp-tools` exposes only two atomic database
operations. The CLI supplies the forced-command `database-gateway` entrypoint.

**Tech Stack:** TypeScript, Zod 4, Node child processes, OpenSSH,
`node-sql-parser` 5.4.0, PostgreSQL `psql`, MySQL `mysql`, Vitest, pnpm, and the
existing F1 framework.

**Spec:**
`docs/superpowers/specs/2026-08-21-ssh-database-access-design.md`

## Global Constraints

- Follow `superpowers:test-driven-development`: observe every focused test fail
  for the intended reason before production code.
- Keep Claude as the Slack chat and Slack-engineering runner. Slack, issue,
  repository, link, image, and database content cannot select the runner/model
  or grant database access.
- Never expose general SSH, arbitrary commands, direct database credentials, or
  configurable native-client flags to the model.
- `database_connections_list` and `database_query` are both sensitive tools.
- Use `apply_patch` for source edits. Preserve unrelated user changes.
- Run `git diff --check` and focused tests before every task commit.
- Do not release hosted support until the external `cyrus-hosted` tool catalog
  lists both database tools.

## Task 1: Add and Normalize Database Configuration

**Files:**

- Modify: `packages/core/src/config-schemas.ts`
- Modify: `packages/core/src/config-types.ts`
- Modify: `packages/core/src/index.ts`
- Create: `packages/core/test/database-config-schema.test.ts`
- Modify: `packages/core/test/json-schema-export.test.ts`
- Modify: `packages/edge-worker/src/ConfigManager.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Create: `packages/edge-worker/test/ConfigManager.database-connections.test.ts`
- Create: `packages/edge-worker/test/EdgeWorker.database-config-paths.test.ts`

### Steps

1. Add RED schema tests for valid PostgreSQL/MySQL entries, literal
   `allowModelDataRetention: true`, defaults, duplicate IDs, safe identifiers,
   destination pairs, limits, and invalid ports/paths/tokens.
2. Add RED EdgeWorker tests proving `~/` path normalization at construction and
   hot reload, explicit clearing with `[]`, failed-candidate preservation, and
   `configChanged` emission.
3. Define/export `SshDatabaseConnectionSchema`, limit defaults/maxima, inferred
   types, and optional top-level `databaseConnections` in `EdgeConfigSchema`.
4. Add `databaseConnections` to `ConfigManager.loadConfigSafely()` and
   `detectGlobalConfigChanges()`, using nullish/explicit-array semantics so an
   empty list revokes access.
5. Normalize `identityFile` and `knownHostsFile` in
   `EdgeWorker.normalizeConfigPaths()` without mutating caller objects.
6. Export the field in generated JSON schema tests and run:
   `pnpm --filter cyrus-core test:run -- config-schemas json-schema-export` and
   `pnpm --filter cyrus-edge-worker test:run -- ConfigManager.database-connections EdgeWorker.database-config-paths`.
7. Commit: `feat: configure SSH database connections`.

## Task 2: Create the Versioned Database Package and SQL Policy

**Files:**

- Create: `packages/ssh-database/package.json`
- Create: `packages/ssh-database/tsconfig.json`
- Create: `packages/ssh-database/src/index.ts`
- Create: `packages/ssh-database/src/constants.ts`
- Create: `packages/ssh-database/src/errors.ts`
- Create: `packages/ssh-database/src/protocol.ts`
- Create: `packages/ssh-database/src/sql-policy.ts`
- Create: `packages/ssh-database/src/client-command-scanner.ts`
- Create: `packages/ssh-database/test/protocol.test.ts`
- Create: `packages/ssh-database/test/sql-policy.test.ts`
- Modify: `pnpm-lock.yaml`

### Steps

1. Add the package with `cyrus-core`, Zod, and `node-sql-parser@5.4.0`; regenerate
   the lockfile with the repository pnpm version.
2. Add RED protocol tests for the 96-KiB raw request cap, SQL byte cap before
   parsing, version/profile/engine matching, bounded base64 response framing,
   invalid UTF-8, and stable error schemas.
3. Add RED policy tests for one `SELECT` or read-only `WITH ... SELECT`, quoted
   text/comments/dollar quotes, token/depth/CTE/projection ceilings, and the
   derived-table `LIMIT maxRows + 1` rewrite.
4. Add RED denial tables for DML/DDL/transactions/grants, writable CTEs,
   `SELECT INTO`, locks, `COPY`, MySQL outfile/dumpfile, procedures, dynamic
   execution, and every client metacommand in the spec.
5. Add RED dialect function-policy tests for PostgreSQL advisory locks,
   notification/sleep/file/large-object/sequence/dblink/UDF calls and MySQL
   named-lock/sleep/benchmark/file/system-UDF/unreviewed calls.
6. Implement a conservative AST validator and independent client-command
   scanner. Canonicalize function names and fail closed on unsupported ASTs or
   unknown routine categories.
7. Export typed protocol, limits, `DatabaseAccessError`, validator, and rewrite
   helpers. Run `pnpm --filter cyrus-ssh-database test:run` and typecheck.
8. Run `pnpm audit`; do not add a root override unless the dependency policy's
   direct-dependency route cannot reach a patched graph.
9. Commit: `feat: add read-only database query policy`.

## Task 3: Implement Native Client Framing and Privilege Preflight

**Files:**

- Create: `packages/ssh-database/src/output/postgres-csv.ts`
- Create: `packages/ssh-database/src/output/mysql-batch.ts`
- Create: `packages/ssh-database/src/native-client.ts`
- Create: `packages/ssh-database/src/privilege-preflight.ts`
- Create: `packages/ssh-database/test/output.test.ts`
- Create: `packages/ssh-database/test/native-client.test.ts`
- Create: `packages/ssh-database/test/privilege-preflight.test.ts`

### Steps

1. Add RED incremental-parser tests for multiline RFC 4180 CSV, MySQL escapes,
   complete header/rows, `\\N`, very large fields, binary bytes, malformed data,
   invalid UTF-8, byte limits, and the discarded `maxRows + 1` row.
2. Add RED exact-argv/stdin tests for `psql --no-psqlrc --csv --quiet` with
   `ON_ERROR_STOP`, and noninteractive MySQL batch mode with reconnect/system
   commands disabled. Assert `shell: false`, fixed executable paths, scrubbed
   environment, read-only transaction, statement deadline, rollback, watchdog,
   and process-tree cancellation.
3. Add RED PostgreSQL preflight tests for superuser/creator/bypass-RLS,
   direct/transitive membership, `SET ROLE`, ownership, TEMP, routine execution,
   unsafe grants, RLS posture, and unsupported deadlines.
4. Add RED MySQL preflight tests for global/role/EXECUTE/FILE/PROCESS/TEMP/lock/
   replication/admin/mutation privileges and unsupported deadlines.
5. Implement incremental framing, fixed client batches, and fail-closed
   preflights that run on every forced-command invocation.
6. Run `pnpm --filter cyrus-ssh-database test:run` and typecheck.
7. Commit: `feat: enforce database privilege and output boundaries`.

## Task 4: Implement the Remote Gateway and Local SSH Service

**Files:**

- Create: `packages/ssh-database/src/gateway-profile.ts`
- Create: `packages/ssh-database/src/DatabaseGateway.ts`
- Create: `packages/ssh-database/src/SshDatabaseQueryService.ts`
- Create: `packages/ssh-database/test/DatabaseGateway.test.ts`
- Create: `packages/ssh-database/test/SshDatabaseQueryService.test.ts`
- Modify: `packages/ssh-database/src/index.ts`

### Steps

1. Add RED gateway-profile tests for root/operator-controlled file parsing,
   fixed engine/database/client/credentials, safe profile IDs, permissions, and
   protocol version mismatch.
2. Add RED query-service path tests for canonical regular files, key ownership,
   `0600`-equivalent identity modes, non-writable known-hosts, and symlinks/file
   substitution failures.
3. Add RED exact SSH argv tests for `-F none`, identity, port, batch mode, strict
   host keys, no global known hosts, agent/password/keyboard/proxy/jump/control/
   known-host command/local command/forwarding/TTY, fixed `user@host`, piped
   stdio, scrubbed environment, and `shell: false`.
4. Add RED timeout, abort, oversized stdout, bounded stderr, malformed response,
   version mismatch, host-key/auth/client/preflight/query error classification,
   and concurrent-call isolation tests.
5. Implement gateway request handling, SQL revalidation, preflight, client
   execution, `outputBase64` response, safe errors, and zero extra stdout.
6. Implement local connection resolution, SQL validation, SSH spawning,
   response cap/parse/decode, cancellation, and metadata-only audit callback.
7. Run package tests/typecheck and commit:
   `feat: run bounded database queries through SSH gateway`.

## Task 5: Add the Forced-Command CLI Entrypoint

**Files:**

- Create: `apps/cli/src/commands/DatabaseGatewayCommand.ts`
- Create: `apps/cli/src/commands/DatabaseGatewayCommand.test.ts`
- Modify: `apps/cli/src/app.ts`
- Modify: `apps/cli/package.json`
- Modify: `pnpm-lock.yaml`

### Steps

1. Add RED command tests for required `--config`/`--profile`, bounded stdin,
   exactly one JSON response, safe stderr/exit codes, ignored
   `SSH_ORIGINAL_COMMAND`, and no regular Cyrus application bootstrap.
2. Add `cyrus-ssh-database` to the CLI's direct dependencies.
3. Register `cyrus database-gateway --config <path> --profile <id>` before the
   default start path and delegate directly to `DatabaseGateway`.
4. Run `pnpm --filter cyrus-ai test:run -- DatabaseGatewayCommand`, build, and
   typecheck.
5. Commit: `feat: add forced SSH database gateway command`.

## Task 6: Expose Atomic Sensitive MCP Tools

**Files:**

- Modify: `packages/mcp-tools/src/tools/cyrus-tools/index.ts`
- Modify: `packages/mcp-tools/src/index.ts`
- Create: `packages/mcp-tools/test/tools/cyrus-tools/database.test.ts`

### Steps

1. Add RED SDK-level tests that list exact schemas for
   `database_connections_list()` and
   `database_query({ connectionId, sql })`, invoke callbacks, preserve bounded
   output, and return only stable safe errors.
2. Prove both tools are absent when database callbacks are absent, accept no
   destination/repository/host/path/profile/client/command fields, and do not
   log callback input/output.
3. Add a `database` callback group to `CyrusToolsOptions`, register both tools,
   and export their input/result types plus the shared sensitive-tool names.
4. Run `pnpm --filter cyrus-mcp-tools test:run -- database` and typecheck.
5. Commit: `feat: expose authorized database MCP tools`.

## Task 7: Harden MCP Context Capabilities

**Files:**

- Create: `packages/edge-worker/src/DatabaseAuthorizationContextService.ts`
- Create: `packages/edge-worker/test/DatabaseAuthorizationContextService.test.ts`
- Modify: `packages/edge-worker/src/McpConfigService.ts`
- Modify: `packages/edge-worker/test/EdgeWorker.feedback-delivery.test.ts`
- Create: `packages/edge-worker/test/McpConfigService.capabilities.test.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`

### Steps

1. Add RED tests for cryptographically random opaque context IDs, an always-
   present process-random bearer without `CYRUS_API_KEY`, constant-time header
   validation, expiry, bounded pruning, lifecycle revocation, and config-change
   revocation.
2. Add RED authorization-context tests for immutable Slack chat and
   Slack-engineering records derived from verified events/receipts, plus forged,
   stale, cross-session, missing, non-Slack, and deleted-connection failures.
3. Replace deterministic `repoId:parentSessionId` IDs and optional auth in
   `McpConfigService`; store the immutable authorization context beside the
   prebuilt server and make endpoint lookup fail closed.
4. Ensure no bearer, context ID, Slack token, or database configuration secret
   enters logs.
5. Run focused EdgeWorker tests/typecheck and commit:
   `fix: secure Cyrus MCP session capabilities`.

## Task 8: Authorize Slack Chat and Engineering Database Access

**Files:**

- Create: `packages/edge-worker/src/DatabaseAccessController.ts`
- Create: `packages/edge-worker/test/EdgeWorker.database-access.test.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: `packages/edge-worker/src/SlackEngineeringOrchestrator.ts`
- Modify: `packages/edge-worker/test/SlackEngineeringOrchestrator.test.ts`
- Modify: `packages/edge-worker/test/EdgeWorker.github-issue-work-item.test.ts`
- Modify: `packages/edge-worker/test/EdgeWorker.slack-engineering-lifecycle.test.ts`

### Steps

1. Add RED chat tests for exact `{teamId, channelId}` matching, active-repo
   filtering, ambiguity, hidden-ID non-enumeration, and immediate hot-reload
   revocation.
2. Add RED engineering tests requiring receipt destination, repository overlap,
   unique persisted receipt, restart recovery, and exact connection filtering.
3. Add RED confused-deputy tests for generic MCP, controller HTTP/RPC, GitHub
   webhook/comment, and unrelated Slack attempts to start, prompt, stop, resume,
   or subscribe to a receipt-backed work item.
4. Add an unforgeable process-local receipt control capability issued only by
   `SlackEngineeringOrchestrator`. Require its exact receipt/source binding in
   centralized work-item start/prompt/stop/resume/subscriber methods; rebuild
   restrictions from receipts after restart without persisting the secret.
5. Implement `DatabaseAccessController` to list authorized connections and call
   `SshDatabaseQueryService`; it accepts only `connectionId` and SQL from MCP.
6. Wire database callbacks into `createCyrusToolsOptions()` only for verified
   Slack chat or eligible receipt-backed engineering contexts.
7. Run the focused EdgeWorker lifecycle/access suites and commit:
   `feat: authorize Slack database diagnostics`.

## Task 9: Suppress Sensitive Database Tool Payloads

**Files:**

- Create: `packages/core/src/SensitiveToolMessageFilter.ts`
- Create: `packages/core/test/SensitiveToolMessageFilter.test.ts`
- Modify: `packages/core/src/index.ts`
- Modify: `packages/claude-runner/src/formatter.ts`
- Modify: `packages/gemini-runner/src/formatter.ts`
- Modify: `packages/codex-runner/src/formatter.ts`
- Modify: `packages/cursor-runner/src/formatter.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Create: `packages/edge-worker/test/EdgeWorker.database-sensitive-messages.test.ts`
- Create: `packages/claude-runner/test/formatter.sensitive-tools.test.ts`
- Modify: formatter tests in:
  `packages/gemini-runner/test/formatter.test.ts`,
  `packages/codex-runner/test/formatter.test.ts`, and
  `packages/cursor-runner/test/formatter.test.ts`

### Steps

1. Add RED replay tests for Claude/Gemini/Codex/Cursor normalized tool-use and
   tool-result shapes, including result correlation by tool-use ID and both
   database tools.
2. Add RED EdgeWorker tests proving no connection-list payload, SQL, or rows
   enter activities, Slack status/activity replies, summaries, receipt/issue
   assembly, telemetry, errors, or logs; assert only the enumerated metadata
   audit record remains.
3. Add RED runner construction tests proving database-capable sessions never
   receive `HttpSessionStore`, while ordinary sessions retain existing remote
   mirroring behavior.
4. Implement a per-session filter before every Cyrus-owned message consumer and
   replace sensitive payloads with a fixed redacted activity. Do not alter the
   provider/local transcript needed for the active model session.
5. Run core, all formatter, and focused EdgeWorker tests. Commit:
   `fix: suppress database payload persistence`.

## Task 10: Add Self-Describing Prompts and Operator Documentation

**Files:**

- Modify: `packages/edge-worker/src/SlackChatAdapter.ts`
- Modify: `packages/edge-worker/test/chat-sessions.test.ts`
- Modify: `packages/edge-worker/src/EdgeWorker.ts`
- Modify: relevant full-string prompt test under `packages/edge-worker/test/`
- Modify: `docs/CONFIG_FILE.md`
- Create: `docs/SSH_DATABASE_ACCESS.md`
- Modify: `CHANGELOG.md`

### Steps

1. Add RED full-string prompt assertions for when to list/query, named
   connection disclosure, truncation, untrusted results, raw-row rendering,
   channel/repository boundaries, and the no-automatic-copy warning.
2. Update Slack chat and Slack-engineering system prompts without enabling
   database tools for Linear/GitHub-only sessions.
3. Document local Cyrus config and both remote gateway profile formats, exact
   `authorized_keys` forced-command syntax, key/known-hosts permissions,
   supported client/server versions, PostgreSQL/MySQL least-privilege creation,
   revoke/default-privilege/preflight/teardown commands, firewall rules,
   retention warning, and troubleshooting.
4. Document that hosted release is blocked until `cyrus-hosted` adds
   `database_connections_list` and `database_query` to
   `KNOWN_MCP_TOOLS["mcp__cyrus-tools"]` and its per-platform defaults.
5. Add an Unreleased user-facing changelog entry. Run prompt/doc checks and
   commit: `docs: explain SSH database access setup`.

## Task 11: Add F1 and Hermetic Integration Coverage

**Files:**

- Create: `apps/f1/src/sshDatabaseFixture.ts`
- Create: `apps/f1/src/sshDatabaseFixture.test.ts`
- Modify: `apps/f1/src/syntheticSlackEngineeringBackend.ts`
- Modify: `apps/f1/src/syntheticSlackEngineeringModel.ts`
- Create: `apps/f1/test-drives/assets/2026-08-21-ssh-database-hermetic.mjs`
- Create: `apps/f1/test-drives/2026-08-21-ssh-database-access.md`
- Modify: `apps/f1/test-drives/README.md`

### Steps

1. Add RED credential-free F1 tests that invoke the real MCP tools from raw
   Slack prompts for PostgreSQL/MySQL, denied channel, routing ambiguity,
   truncation, injection, engineering handoff, restart, and control hijacking.
2. Use a fake `ssh` binary for deterministic production-path F1 and assert zero
   external network requests plus exact gateway frames and audit metadata.
3. Add a hermetic Docker/OpenSSH drive with disposable PostgreSQL and MySQL,
   forced keys/commands, read-only roles, seeded non-secret data, write/escape/
   privilege rejection, timeout cancellation, output framing, and cleanup.
4. Run the F1 skill protocol and record exact commands, environment, results,
   pagination/search evidence, and limitations in the dated test-drive report.
5. Commit: `test: validate SSH database access end to end`.

## Task 12: Full Verification and Security Review

### Steps

1. Run changed-package suites, then `pnpm test:packages:run`.
2. Run `pnpm typecheck`, `pnpm lint`, and `pnpm build`.
3. Run `pnpm audit` and require zero advisories.
4. Run `git diff --check` and inspect the complete branch diff for secrets,
   raw database payload logging, arbitrary command construction, unsafe path
   handling, and unrelated changes.
5. Use `superpowers:requesting-code-review` for a final security-focused review.
   Fix every Critical/Important finding with RED-to-GREEN evidence and re-review.
6. Re-run the full gates after the final fix and keep the worktree clean.
7. Use `superpowers:finishing-a-development-branch` and present the safe handoff
   options. Do not merge without the user's explicit instruction.

## Configuration Needed From the User After Implementation

No values are needed to build or test the feature. To enable a real connection,
request only:

- SSH host, port, and restricted remote username;
- local per-connection private-key path and pinned known-hosts path;
- database engine, display name, database name, and gateway profile ID;
- Cyrus repository IDs allowed to use it;
- Slack workspace/team ID and channel ID pairs allowed to use it; and
- confirmation that sending query/results to the configured Claude provider
  and allowed Slack channel is acceptable.

The user must also install the matching Cyrus CLI on the gateway host, create
the strict read-only database account, install the forced `authorized_keys`
entry, and create the root-owned gateway profile using the documentation from
Task 10.
