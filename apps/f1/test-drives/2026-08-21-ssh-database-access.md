# Test Drive: SSH Database Access

**Date:** 2026-08-21
**Objective:** Validate credential-free Slack-to-MCP database access, hardened SSH framing, authorization, audit metadata, and a hermetic OpenSSH/PostgreSQL gateway.
**Test repository:** `/tmp/cyrus-f1-ssh-db.26HS5b/repo` (removed after the drive)

## Environment

- macOS, Node `v22.23.2`, pnpm `10.33.1`
- Docker client/server `29.4.0`
- `/usr/sbin/sshd` and cached `postgres:16-alpine`
- No cached MySQL/MariaDB image and no host MySQL client
- No real Slack, GitHub, SSH, or database credentials

## Verification Results

### Credential-free production-path F1

- [x] Raw Slack prompts invoked the real registered `database_connections_list` and `database_query` MCP tools.
- [x] PostgreSQL CSV and MySQL TSV gateway responses traversed authorization, SQL policy, hardened SSH argv construction, real process spawning, protocol decode, and the synthetic model.
- [x] Exact request frames included protocol version, profile, engine, SQL, and configured bounds.
- [x] Exact audit records contained Slack/session/connection metadata, row count, byte count, and truncation state, but no SQL or returned rows.
- [x] Wrong-channel access returned no connections and did not invoke SSH.
- [x] An unnamed choice across two connections caused an ambiguity response and did not invoke SSH.
- [x] Truncation propagated from the gateway response.
- [x] Multi-statement write injection was rejected by the SQL policy before SSH.
- [x] A Slack engineering handoff used database evidence and then the registered engineering tool.
- [x] Restart revoked the old capability and a new raw status prompt used the engineering status tool.
- [x] A malicious database row containing stop/delete instructions did not call `engineering_stop` or alter control flow.
- [x] The synthetic network boundary recorded zero external requests.

Command and result:

```text
pnpm --filter cyrus-f1 test:run -- sshDatabaseFixture syntheticSlackEngineeringModel syntheticSlackEngineeringBackend
Test Files  4 passed (4)
Tests       19 passed (19)
```

TypeScript verification:

```text
pnpm --filter cyrus-f1 typecheck
exit 0
```

### Hermetic Docker/OpenSSH drive

Command:

```text
node apps/f1/test-drives/assets/2026-08-21-ssh-database-hermetic.mjs
```

The drive started a disposable `postgres:16-alpine` container, seeded two non-secret rows, created a narrowly granted login, revoked public TEMP/schema-create/routine execution and the PostgreSQL 16 `pg_settings` write grant, launched a loopback OpenSSH daemon with a generated forced-command key, and invoked `SshDatabaseQueryService` through that forced command. It returned:

```json
{
  "postgres": {
    "selected": {
      "connectionId": "f1-postgres",
      "engine": "postgres",
      "format": "csv",
      "output": "id,name\n1,Ada\n2,Grace\n",
      "truncated": false,
      "rowCount": 2,
      "byteCount": 22
    },
    "writeRejected": true
  },
  "mysql": {
    "attempted": false,
    "reason": "no cached mysql/mariadb image; network pulls are forbidden"
  },
  "openSsh": true
}
```

`docker ps -a --filter name=cyrus-f1-postgres` returned no containers after the drive, proving cleanup ran.

The drive uses the production gateway, native-client, privilege-preflight, framing, SSH query service, and OpenSSH forced-command paths. The temporary wrapper that maps the native `psql` argv into `docker exec` uses the executor's file-inspection seam because a non-root test process cannot create a root-owned executable. That is the only file-ownership check not exercised by this drive; unit coverage validates it separately.

### F1 protocol and renderer smoke

Commands:

```text
apps/f1/f1 init-test-repo --path /tmp/cyrus-f1-ssh-db.26HS5b/repo
CYRUS_PORT=3600 CYRUS_REPO_PATH=/tmp/cyrus-f1-ssh-db.26HS5b/repo CYRUS_HOME=/tmp/cyrus-f1-ssh-db.26HS5b/home bun run apps/f1/server.ts
CYRUS_PORT=3600 apps/f1/f1 ping
CYRUS_PORT=3600 apps/f1/f1 status
CYRUS_PORT=3600 apps/f1/f1 create-issue --title 'SSH database F1 renderer smoke' --description 'Do not edit files. Reply exactly: SSH-DB-F1-OK'
CYRUS_PORT=3600 apps/f1/f1 start-session --issue-id issue-1
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --limit 10 --offset 0
CYRUS_PORT=3600 apps/f1/f1 view-session --session-id session-1 --search SSH-DB-F1-OK
CYRUS_PORT=3600 apps/f1/f1 stop-session --session-id session-1
```

- [x] Server health and status passed.
- [x] Issue `issue-1` / `DEF-1` and session `session-1` were created.
- [x] Pagination rendered the one repository-selection elicitation activity.
- [x] Search returned zero activities for `SSH-DB-F1-OK`, as expected because execution stopped at repository selection.
- [x] Session stop and SIGINT shutdown were clean.

## Limitations

- The deterministic F1 fixture fully covers MySQL selection, exact request framing, TSV response decoding, audit metadata, authorization, and policy rejection, but it does not run a real MySQL server/client.
- The hermetic drive intentionally does not pull images or packages from the network. With no cached MySQL/MariaDB image or client, MySQL server privilege preflight and native-client execution remain unvalidated in this environment.
- Timeout cancellation is covered by the package's focused process/service tests, not the successful Docker drive; PostgreSQL sleep functions are intentionally rejected by SQL policy before execution.
- The basic F1 renderer smoke validates CLI pagination/search mechanics, while the credential-free integration test validates database behavior directly and deterministically.

## Conclusion

PASS for the credential-free PostgreSQL/MySQL production-path fixture and the real OpenSSH/PostgreSQL hermetic path. MySQL Docker/native-client coverage is explicitly incomplete because the required cached artifacts were unavailable and external traffic was prohibited.
