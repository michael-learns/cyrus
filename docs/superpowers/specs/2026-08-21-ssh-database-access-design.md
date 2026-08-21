# SSH Database Access Design

## Goal

Allow Cyrus to inspect PostgreSQL and MySQL databases through an operator-
configured SSH connection while answering an authorized Slack channel or doing
engineering work started from that channel. The first release is read-only,
returns raw rows when requested, and never gives the model a general remote
shell.

## Scope

This release provides:

- named SSH database connections configured at the Cyrus workspace level;
- repository and Slack-channel routing for each connection;
- PostgreSQL and MySQL query execution through a restricted remote Cyrus
  database gateway and the remote native client;
- access from Slack chat and Slack-originated engineering jobs;
- bounded raw query results returned as untrusted model context;
- metadata-only auditing and secret-safe errors; and
- self-hosted setup documentation and an F1 test drive.

This release does not provide:

- database writes, migrations, stored-procedure execution, or arbitrary SSH;
- database access from standalone Linear or GitHub sessions;
- database credentials stored by Cyrus;
- SSH tunneling or a local database driver;
- automatic server provisioning; or
- a hosted settings form in this repository. The required `cyrus-tools`
  catalog/default-tool update must land in the owning `cyrus-hosted`
  repository before a hosted release.

## Threat Model

The design assumes the Cyrus host operator, the root-owned gateway profile,
and the selected model provider are trusted within the explicitly acknowledged
data-retention policy. It defends against:

- unauthorized or prompt-injected Slack, linked, issue, repository, and
  database-cell content;
- a different local model/MCP session trying to reuse or guess a privileged
  context;
- a denied Slack destination trying to steer a DB-capable engineering child;
- SQL that attempts database writes, privilege changes, file access, client
  metacommands, or remote shell execution;
- an overprivileged or incorrectly provisioned database profile, detected by
  mandatory preflight;
- malicious or malformed native-client output and unbounded rows/fields;
- a changed or spoofed SSH host; and
- configuration removal while a long-lived model session remains active.

A compromised Cyrus OS account or root on the remote gateway host is outside
the boundary: either can read the configured key/profile or modify trusted
code. Per-connection keys, a forced command, strict file modes, least-privilege
database roles, and host firewall rules limit the result but cannot make a
compromised host trustworthy.

## Chosen Architecture

Cyrus will expose two tools through its existing `cyrus-tools` MCP server:

```ts
database_connections_list(): {
  connections: Array<{
    id: string;
    name: string;
    engine: "postgres" | "mysql";
    repositories: string[];
  }>;
}

database_query(input: {
  connectionId: string;
  sql: string;
}): {
  connectionId: string;
  engine: "postgres" | "mysql";
  format: "csv" | "tsv";
  output: string;
  truncated: boolean;
};
```

The MCP callbacks derive the Slack channel and engineering source from the
server-side session context. Neither tool accepts a Slack channel, requester,
repository, SSH host, filesystem path, database name, client path, or remote
command from model input.

`database_query` delegates to a focused `SshDatabaseQueryService`. The service
validates authorization and SQL, constructs a fixed OpenSSH argument vector,
spawns `ssh` without a local shell, sends a versioned request through standard
input, and accepts one bounded JSON response. The SSH key is configured with a
mandatory forced command that runs the Cyrus database gateway on the remote
server. The gateway ignores `SSH_ORIGINAL_COMMAND`, revalidates the SQL, checks
the configured database privileges, invokes the fixed native client, and
returns the bounded response. The model never receives SSH credentials or a
general-purpose SSH execution primitive.

## Configuration

Add `databaseConnections` to `EdgeConfigSchema`:

```ts
type SshDatabaseConnection = {
  id: string;
  name: string;
  engine: "postgres" | "mysql";
  repositoryIds: string[];
  slackDestinations: Array<{
    teamId: string;
    channelId: string;
  }>;
  ssh: {
    host: string;
    user?: string;
    port?: number;
    identityFile: string;
    knownHostsFile: string;
  };
  database: {
    name: string;
    profile: string;
  };
  limits?: {
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
    maxRows?: number;
    maxOutputBytes?: number;
  };
  allowModelDataRetention: true;
};
```

Defaults are:

- `ssh.port`: `22`;
- `connectTimeoutMs`: `10_000`;
- `queryTimeoutMs`: `15_000`;
- `maxRows`: `100`; and
- `maxOutputBytes`: `32_768`.

Example:

```json
{
  "databaseConnections": [
    {
      "id": "payroll-production",
      "name": "Payroll production (read-only)",
      "engine": "postgres",
      "repositoryIds": ["one-payroll", "one-payroll-api"],
      "slackDestinations": [
        {
          "teamId": "T0123456789",
          "channelId": "C0123456789"
        }
      ],
      "ssh": {
        "host": "payroll-db",
        "identityFile": "~/.cyrus/ssh/payroll_ed25519",
        "knownHostsFile": "~/.cyrus/ssh/known_hosts"
      },
      "database": {
        "name": "payroll",
        "profile": "payroll-production"
      },
      "allowModelDataRetention": true
    }
  ]
}
```

`host`, `user`, database name, connection ID, and remote profile use
conservative character allowlists and may not begin with `-`. They are
operator-controlled values, never model-controlled values.

`identityFile` and `knownHostsFile` are path-bearing config fields.
`EdgeWorker.normalizeConfigPaths()` resolves `~/` for constructor and
hot-reload paths. `ConfigManager` includes `databaseConnections` in both its
load whitelist and global-change detector. Reload parses and migrates the
complete file with `EdgeConfigSchema.safeParse`, validates every connection
into a candidate immutable map, and swaps the map only after complete success.
An omitted or empty field clears the connections. Every tool call resolves the
connection against the latest map, so removal or destination/repository
changes revoke access immediately.

Before use, the query service canonicalizes configured files and verifies:

- every supplied path exists and resolves to a regular file;
- the identity file is owned by the Cyrus process user on POSIX systems;
- the identity file has no group or other permission bits;
- known-hosts files are not group/other writable; and
- duplicate connection IDs are rejected by schema validation.

An explicit identity and known-hosts file are mandatory in version 1. Cyrus
does not read default OpenSSH config, discover default keys, use an SSH agent,
or accept password/keyboard-interactive authentication.

`allowModelDataRetention: true` is a required acknowledgement rather than a
default. Database results necessarily enter the selected model provider's
context and local Claude session transcript; raw rows posted to Slack are also
durable Slack content. A connection without the literal acknowledgement is
invalid.

## Authorization, Capabilities, and Routing

A Slack chat may list or query a connection only when its verified
`{teamId, channelId}` pair appears in `slackDestinations`. User identity is
audited but is not an authorization input, per the approved channel-only
policy. Qualifying the channel with its Slack workspace prevents ID confusion
across multiple workspaces and Enterprise Grid.

Channel destination is the Slack-chat authorization boundary. Repository IDs
are routing metadata for chat because a transient Slack chat is intentionally
repo-agnostic: a channel-authorized connection is listed when at least one of
its repositories is active in the Cyrus workspace. The list response includes
configured repository names so Claude can route from explicit names/links and
conversation context. When more than one permitted connection is plausible,
Claude asks the user to choose by name. Repository routing can only narrow the
channel-authorized set; it never widens it.

A Slack-originated engineering job may use a connection only when:

1. its persisted `SlackEngineeringReceipt.teamId` and `channelId` pair is
   allowed;
2. at least one connection repository participates in the work item; and
3. the receipt is the verified source associated with the child session.

Slack engineering work items use source-keyed IDs and one immutable receipt.
Database capability is attached only when the child work item maps to exactly
one receipt. Generic GitHub work items and work items with no receipt receive no
database capability. The existing generic GitHub issue prompt/start paths must
also reject cross-channel control of a DB-capable Slack work item: a prompt,
subscriber attachment, stop, or resume from another Slack destination cannot
enter or influence that child session, even when it names the generated issue.
Restart recovery reconstructs this restriction from the persisted receipt and
work-item metadata.

Standalone Linear sessions, GitHub webhook sessions, and engineering work not
originating from Slack receive no database callbacks in this release. Missing
or unverifiable session context fails closed and exposes neither connection
metadata nor query access.

Quoted Slack messages, linked pages, GitHub issue text, database cell contents,
and repository files cannot authorize access, select a hidden connection, or
expand the allowed destination/repository scope.

Each `cyrus-tools` MCP configuration uses a cryptographically random context ID
and a process-random local bearer token, including self-hosted installations
without `CYRUS_API_KEY`. The ID is an opaque capability, never
`repoId:sessionId`. Its immutable server-side `DatabaseAuthorizationContext`
contains:

```ts
type DatabaseAuthorizationContext = {
  capabilityId: string;
  platform: "slack" | "slack-engineering";
  teamId: string;
  channelId: string;
  userId: string;
  parentSessionId: string;
  workItemId?: string;
  repositoryIds: string[];
  issuedAt: number;
  expiresAt: number;
};
```

Chat context is captured while `ChatSessionHandler` has queued the verified
event before runner/MCP construction. Engineering context is resolved from the
unique persisted receipt and work item. The MCP endpoint requires both the
random context and local bearer, revalidates the latest connection config on
every operation, expires inactive capabilities, and revokes them when a
session terminates, a work item becomes terminal, or authorization config
changes.

## Read-Only Query Policy

The database account configured on the remote server is the hard read-only
security boundary. The remote gateway runs a mandatory privilege preflight
before accepting each query. A long-lived gateway implementation may cache
success only while the profile file identity and database-role fingerprint are
unchanged; the forced-command CLI performs the check for every invocation.

PostgreSQL provisioning requires:

- a dedicated `LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION
  NOBYPASSRLS` role;
- no inherited privileged role memberships;
- `CONNECT` only on the selected database, `USAGE` only on selected schemas,
  and `SELECT` only on intended tables/views;
- no `TEMP` database privilege and no sequence mutation privileges;
- no executable user-defined routines through direct, role, or `PUBLIC`
  grants, with safe default privileges for future routines; and
- row-level security policies that apply to the role when table rows require
  tenant or subject restrictions.

MySQL provisioning requires a dedicated account with database/table-level
`SELECT` and, when needed, `SHOW VIEW` only. It must have no global privileges,
role inheritance beyond the reviewed read-only role, `EXECUTE`, `FILE`,
`PROCESS`, `CREATE TEMPORARY TABLES`, locking, replication, administrative,
schema mutation, or data mutation privileges.

The gateway preflight checks the current identity, dangerous role/account
attributes, inherited roles, effective routine execution, database/schema/table
grants, temporary-object privileges, and engine support for a server-side
statement deadline. A failed or indeterminate check rejects the connection.
Documentation includes exact creation, revoke, default-privilege, inspection,
and teardown commands and explicitly forbids application-owner or
administrative credentials.

Cyrus and the remote gateway both apply defense in depth:

- exactly one SQL statement is accepted;
- a dialect-aware parser must produce one supported read-only AST;
- string literals, quoted identifiers, line comments, block comments, and
  PostgreSQL dollar-quoted strings are tokenized without treating their content
  as SQL commands;
- mutation, DDL, privilege, transaction-control, file, dynamic-execution, and
  stored-procedure tokens are rejected outside quoted content; and
- PostgreSQL writable CTEs, `SELECT INTO`, `COPY`, and MySQL
  `INTO OUTFILE`/`DUMPFILE` are rejected.

Before the native client sees input, a separate client-command scanner rejects
every unquoted backslash command and PostgreSQL `psql` metacommand, plus MySQL
`system`, `source`, `tee`, `pager`, `delimiter`, `charset`, executable/version
comments (`/*! ... */`), and optimizer-comment forms that can alter execution.
The gateway invokes command-string mode rather than an interactive command
stream, enables MySQL `--binary-mode` while disabling named/system commands and
reconnect, disables client startup files, and passes model SQL only as a single
no-shell argument to the native client.

Supported statement families are `SELECT`, read-only `WITH ... SELECT`,
`EXPLAIN` of a supported statement, and metadata reads needed for each engine.
The validator is intentionally conservative: an unfamiliar construct is
rejected rather than guessed safe. The validator is not presented as a
replacement for database permissions.

The remote client receives a read-only transaction batch:

- PostgreSQL: `BEGIN READ ONLY`, a local statement timeout, the validated
  statement, then `ROLLBACK`;
- MySQL: a verified session execution timeout, `START TRANSACTION READ ONLY`,
  the validated statement, then `ROLLBACK`.

PostgreSQL runs with `--no-psqlrc`, `--csv`, `--quiet`, and
`ON_ERROR_STOP=1`. MySQL runs with `--batch`, a column header,
`--skip-reconnect`, disabled client commands, and noninteractive mode. Supported
server and client version ranges are documented and checked during preflight;
an engine/version without an enforceable database-side deadline is rejected.
Neither engine executes operator or model text through a shell.

## SSH Process Boundary

The service invokes OpenSSH with a fixed option set equivalent to:

```text
ssh
  -F none
  -i <canonical identity path>
  -p <configured port>
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=<canonical known-hosts path>
  -o GlobalKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes
  -o IdentityAgent=none
  -o PasswordAuthentication=no
  -o KbdInteractiveAuthentication=no
  -o PreferredAuthentications=publickey
  -o ProxyCommand=none
  -o ProxyJump=none
  -o ControlMaster=no
  -o ControlPath=none
  -o KnownHostsCommand=none
  -o ClearAllForwardings=yes
  -o PermitLocalCommand=no
  -o RequestTTY=no
  -o ConnectTimeout=<bounded seconds>
  <configured user@host>
```

No remote command is accepted from the model. The connection's public key is
installed on the server with a forced command equivalent to:

```text
restrict,command="/usr/local/bin/cyrus database-gateway --config /etc/cyrus/database-gateway.json --profile payroll-production" ssh-ed25519 ...
```

The forced command ignores `SSH_ORIGINAL_COMMAND`; `restrict` disables PTY,
agent, port, and X11 forwarding. The gateway profile fixes engine, database,
native client path, credentials mechanism, limits, and deterministic locale/
UTF-8 settings. This forced command is mandatory, not optional hardening.

The local subprocess uses piped stdin/stdout/stderr, a scrubbed environment,
and no local shell. It sends one bounded JSON request containing the SQL and
expected profile/engine. The gateway returns one bounded JSON response and no
other stdout. Interactive password or host-key prompts cannot appear. The
process group is terminated on timeout, abort, or excessive protocol output.
A bounded stderr tail is held only in memory to classify failures and is never
returned verbatim or logged.

PostgreSQL `statement_timeout` and MySQL's verified session deadline are the
database-side termination guarantee. The remote gateway also wraps the native
client in a watchdog and disables reconnect. Local SSH termination is cleanup,
not the sole cancellation mechanism. Gateway integration tests verify that a
disconnected or timed-out request closes the database session and does not
leave a running query.

Database access happens in the EdgeWorker service, not in model-created Bash
processes. The SDK sandbox and its egress proxy therefore do not authorize or
mediate this connection; the configured connection list is the service-level
network allowlist. Giving this capability does not widen the model's filesystem
permission to `~/.ssh` or grant the model general SSH egress. Operators must
also allow the configured SSH destination in host-level firewall policy.

## Results and Untrusted Data

PostgreSQL output is returned as RFC 4180 CSV and MySQL output as escaped batch
text with a TSV-compatible shape. The result preserves unredacted field values
and headers, as approved for allowed Slack destinations, while documenting
MySQL's `\\N` NULL and backslash escape representation. Binary values are
rejected in version 1; client and database encoding must be UTF-8.

The remote gateway enforces both row and byte limits before constructing its
response. PostgreSQL uses an incremental RFC 4180 record parser; MySQL uses an
incremental batch-escape parser. Both count bytes before decoding, bound the
in-progress record as well as retained output, preserve a header only when it
is complete, reject malformed/invalid-UTF-8 output, and retain complete rows
only. When the next row would exceed a limit the gateway stops the client,
returns the complete retained rows, and sets `truncated: true`.

The local service independently caps the entire SSH protocol response before
JSON parsing. The tool response labels the payload as untrusted database
content. Database values cannot issue instructions, authorize work, select
tools, or change repository scope.

The Slack system prompt tells Claude to:

- use database access only when it materially helps answer or implement the
  user's request;
- state which named connection was queried;
- render requested raw rows in a code block;
- state when output was truncated; and
- never intentionally copy production rows into a GitHub issue, PR
  description, commit, repository file, or durable activity.

Engineering system prompts repeat the no-copy rule, but prompts are not treated
as a data-loss-prevention boundary. The implementation marks
`database_query` as a sensitive tool at the normalized runner-message boundary
and suppresses its SQL input and row output from activities, generic tool
formatters, telemetry, errors, Slack activity/status updates, summaries,
receipts, GitHub issue bodies, and remote Cyrus session mirroring. Suppression
is tested for Claude, Gemini, Codex, and Cursor message shapes even though
Slack-originated engineering remains Claude-locked.

Some persistence is inherent and is stated plainly:

- the model provider receives the query and result;
- the local runner/Claude transcript may retain them for session continuity;
- raw rows included in a Slack reply are retained by Slack; and
- the model could still reproduce data in generated text despite system
  instructions.

Cyrus does not automatically add the query/result to receipts, GitHub issue
bodies, PR metadata, or activities. Remote Cyrus session mirroring is disabled
for any session that receives a database capability. Operators must not enable
the feature for data they may not send to their selected model provider or
allowed Slack destination; the required `allowModelDataRetention` flag records
that decision.

## Errors and Auditing

Tools return stable, safe error categories:

- `CONNECTION_NOT_ALLOWED`;
- `CONNECTION_NOT_FOUND`;
- `QUERY_REJECTED`;
- `SSH_UNAVAILABLE`;
- `HOST_KEY_FAILED`;
- `AUTHENTICATION_FAILED`;
- `CONNECTION_TIMEOUT`;
- `QUERY_TIMEOUT`;
- `GATEWAY_UNAVAILABLE`;
- `GATEWAY_VERSION_UNSUPPORTED`;
- `PRIVILEGE_CHECK_FAILED`;
- `REMOTE_CLIENT_MISSING`;
- `OUTPUT_INVALID`;
- `REQUEST_CANCELLED`;
- `QUERY_FAILED`.

Not-found and not-allowed failures use the same external message so a caller
cannot enumerate hidden connection IDs. Truncation is a successful bounded
result with `truncated: true`, not a query failure.

User-facing messages identify the connection display name only after
authorization succeeds and provide safe remediation without including SQL,
result data, private paths, raw SSH command lines, or remote stderr.

Audit logs contain only:

- event name;
- connection ID;
- engine;
- Slack team/channel/user IDs;
- repository IDs;
- session/work-item ID;
- duration;
- returned row and byte counts;
- truncation flag; and
- success or stable error category.

SQL text, database output, local key/config paths, remote usernames/hosts, and
credentials are never logged.

## Components and Ownership

### `cyrus-core`

- Defines and exports the connection schema and inferred types.
- Validates defaults, uniqueness, identifiers, ports, limits, and safe
  operator-controlled tokens.
- Adds the top-level config field without changing existing configurations.

### SSH database package and remote gateway

- Owns the shared request/response protocol, SQL policy, client-command
  scanner, privilege checks, output framing, limits, and stable errors.
- Exposes the local `SshDatabaseQueryService` used by EdgeWorker.
- Ships the `cyrus database-gateway` CLI entrypoint used as the mandatory
  remote forced command.
- Keeps local and gateway policy versions compatible and rejects version skew
  rather than silently weakening checks.

### `cyrus-edge-worker`

- Adds `SshDatabaseQueryService` and a small SQL policy module.
- Normalizes configured paths and hot reloads connections.
- Resolves verified Slack chat and Slack-engineering authorization context.
- Supplies database callbacks to `CyrusToolsOptions` only for eligible
  sessions.
- Issues random MCP context capabilities and an always-present process-local
  bearer, and revokes them on lifecycle/config changes.
- Suppresses sensitive database tool payloads from activities and remote
  session mirroring.
- Adds self-describing Slack and engineering prompt guidance.

### `cyrus-mcp-tools`

- Defines exact schemas for `database_connections_list` and `database_query`.
- Registers tools only when database callbacks are present.
- Converts callback results and stable failures to MCP content without logging
  payloads.

### Documentation and F1

- `docs/CONFIG_FILE.md` documents config, server prerequisites, grants, SSH
  hardening, and privacy implications.
- The owning `cyrus-hosted` repository adds both tools to its
  `KNOWN_MCP_TOOLS["mcp__cyrus-tools"]` catalog before hosted release.
- `CHANGELOG.md` describes the user-visible capability under Unreleased.
- F1 uses a fake `ssh` executable and deterministic PostgreSQL/MySQL output; it
  performs no external SSH or database request.

## Testing and Validation

Tests must be written and observed failing before production changes.

### Configuration tests

- valid PostgreSQL/MySQL connections and defaults;
- duplicate IDs, unsafe identifiers, invalid ports, and invalid limits;
- `~/` normalization at construction and hot reload;
- full-schema ConfigManager reload, deletion/revocation, failed-candidate
  preservation, and config-change emission; and
- key/known-hosts ownership, modes, file types, and canonical paths.

### SQL policy tests

- supported `SELECT`, CTE, metadata, and `EXPLAIN` queries for both engines;
- comments, escaped strings, identifiers, and PostgreSQL dollar quotes;
- multiple statements;
- DML, DDL, privileges, transaction control, file operations, writable CTEs,
  stored procedures, dynamic execution, and side-effecting constructs; and
- `psql` `\\!`, `\\copy`, `\\gexec`, includes and variables; MySQL `system`,
  `source`, `tee`, `pager`, `delimiter`, executable/version comments, and
  commands hidden in nested comments; and
- the exact read-only batches sent to both clients.

### SSH service tests

- exact SSH argv and versioned protocol request for PostgreSQL and MySQL;
- `-F none`, explicit identity, `shell: false`, batch mode, strict host keys,
  disabled agents/passwords/proxies/control sockets, no forwarding, and no TTY;
- connection, query, abort, row, and byte limits;
- process-tree termination and cleanup;
- gateway version mismatch and malformed/oversized protocol responses;
- incremental complete-row truncation for multiline CSV, escaped MySQL batch
  rows, very large fields, NULL, binary, and invalid UTF-8;
- mandatory PostgreSQL/MySQL privilege preflight, routine execution grants,
  inherited roles, temporary-object privileges, row-level-security posture,
  and unsupported statement deadlines;
- stable error classification and secret-safe logs; and
- concurrent queries without shared mutable credentials or output.

### Authorization and tool tests

- allowed and denied `{teamId, channelId}` destinations;
- repository overlap and ambiguity;
- verified Slack-originated engineering jobs before and after restart;
- random, expiring MCP capabilities; process-local bearer enforcement; forged,
  stale, cross-session, and post-config-revocation access;
- cross-channel prompt/start/stop/subscriber attempts against a DB-capable work
  item;
- rejection for standalone Linear/GitHub sessions and missing context;
- exact MCP schemas and payloads;
- database content treated as untrusted context; and
- sensitive-tool suppression across all normalized runner message shapes;
- no SQL/results in receipts, issue bodies, activities, remote session
  mirroring, telemetry, summaries, or logs; and
- explicit evidence for the documented remaining provider/local/Slack
  retention.

### Required gates

- focused package tests for core, MCP tools, Claude runner boundaries, and edge
  worker;
- a credential-free F1 drive for Slack chat query, PostgreSQL, MySQL, denied
  channel, engineering handoff, restart, truncation, and injection attempts;
- hermetic integration tests using disposable OpenSSH, PostgreSQL, and MySQL
  services for forced-command behavior, native-client command handling,
  privilege rejection, statement cancellation, and output framing, with no
  external infrastructure;
- the complete package test suite;
- typecheck, lint, and build;
- `pnpm audit` with zero advisories; and
- a final security-focused code review.

## Operator Setup Required

For each server, the operator must provide:

1. A dedicated remote OS account and a per-connection SSH key whose
   `authorized_keys` entry uses `restrict` plus the forced Cyrus database
   gateway command.
2. A pinned host key in the configured `knownHostsFile`.
3. The matching Cyrus database gateway version and its root-owned,
   non-writable profile file installed on the server.
4. PostgreSQL `psql` or MySQL `mysql` at the gateway profile's absolute path,
   within the documented supported version range.
5. A dedicated read-only database account satisfying the exact privilege
   checklist and gateway preflight.
6. Remote noninteractive authentication through `.pgpass`, `.my.cnf`, or an
   equivalent server-side mechanism readable only by the remote OS account.
7. Cyrus config containing the connection, repository IDs, allowed Slack
   team/channel pairs, and explicit model-retention acknowledgement.
8. Host firewall access from Cyrus to the configured SSH address.

Version 1 does not support SSH config files, agents, bastion `ProxyJump`, or
password prompts. Operators needing a bastion can terminate the restricted SSH
connection at a reachable gateway host that runs the forced database command.

## Acceptance Criteria

The feature is complete when an authorized Slack destination can use a
configured PostgreSQL or MySQL connection to return bounded unredacted rows,
and a fix started from that Slack thread can use the same connection as
diagnostic context. Another Slack team/channel or unrelated engineering work
cannot discover or influence the capability. No model-controlled value can
alter the SSH destination, local credential paths, forced command, remote
profile, or native executable. Write and shell-escape attempts fail at the
local policy, remote gateway policy, forced-command boundary, and database
privilege boundary. Queries, results, credentials, and secret paths do not
appear in activities, remote Cyrus session mirroring, receipts, GitHub issue/PR
metadata, telemetry, summaries, or logs; documented provider/local-runner/Slack
retention remains explicit. All required tests and validation gates pass
without contacting external infrastructure.
