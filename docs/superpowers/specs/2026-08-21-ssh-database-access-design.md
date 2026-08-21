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
- PostgreSQL and MySQL query execution through the remote native client;
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
- a hosted settings UI. The serializable config and runtime support are the
  source of truth; hosted UI catalog work can follow in its owning repository.

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
spawns `ssh` without a local shell, sends the SQL batch through standard input,
and returns bounded stdout. The model never receives SSH credentials or a
general-purpose SSH execution primitive.

## Configuration

Add `databaseConnections` to `EdgeConfigSchema`:

```ts
type SshDatabaseConnection = {
  id: string;
  name: string;
  engine: "postgres" | "mysql";
  repositoryIds: string[];
  slackChannelIds: string[];
  ssh: {
    host: string;
    user?: string;
    port?: number;
    configPath?: string;
    identityFile?: string;
    knownHostsFile: string;
  };
  database: {
    name: string;
    clientPath?: string;
  };
  limits?: {
    connectTimeoutMs?: number;
    queryTimeoutMs?: number;
    maxRows?: number;
    maxOutputBytes?: number;
  };
};
```

Defaults are:

- `ssh.port`: `22`;
- PostgreSQL `database.clientPath`: `/usr/bin/psql`;
- MySQL `database.clientPath`: `/usr/bin/mysql`;
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
      "slackChannelIds": ["C0123456789"],
      "ssh": {
        "host": "payroll-db",
        "configPath": "~/.cyrus/ssh/config",
        "identityFile": "~/.cyrus/ssh/payroll_ed25519",
        "knownHostsFile": "~/.cyrus/ssh/known_hosts"
      },
      "database": {
        "name": "payroll",
        "clientPath": "/usr/bin/psql"
      }
    }
  ]
}
```

`host`, `user`, database name, connection ID, and client path use conservative
character allowlists and may not begin with `-`. The configured client path is
an operator-controlled value, never a model-controlled value.

`configPath`, `identityFile`, and `knownHostsFile` are path-bearing config
fields. `EdgeWorker.normalizeConfigPaths()` resolves `~/` for constructor and
hot-reload paths. `ConfigManager` includes `databaseConnections` in both its
load whitelist and global-change detector. Reload replaces the complete
connection list atomically for new tool calls.

Before use, the query service canonicalizes configured files and verifies:

- every supplied path exists and resolves to a regular file;
- the identity file is owned by the Cyrus process user on POSIX systems;
- the identity file has no group or other permission bits;
- SSH config and known-hosts files are not group/other writable; and
- duplicate connection IDs are rejected by schema validation.

SSH-agent authentication is supported by omitting `identityFile`. An explicit
`knownHostsFile` remains mandatory.

## Authorization and Routing

A Slack chat may list or query a connection only when its verified Slack
channel ID appears in `slackChannelIds`. User identity is audited but is not an
authorization input, per the approved channel-only policy.

The chat session may use a connection when at least one of its configured
`repositoryIds` is active in the workspace. The list response includes the
configured repository names so Claude can choose using the conversation and
repository routing context. If more than one permitted connection is plausible,
Claude asks the user to choose by name.

A Slack-originated engineering job may use a connection only when:

1. its persisted `SlackEngineeringReceipt.channelId` is allowed;
2. at least one connection repository participates in the work item; and
3. the receipt is the verified source associated with the child session.

Standalone Linear sessions, GitHub webhook sessions, and engineering work not
originating from Slack receive no database callbacks in this release. Missing
or unverifiable session context fails closed and exposes neither connection
metadata nor query access.

Quoted Slack messages, linked pages, GitHub issue text, database cell contents,
and repository files cannot authorize access, select a hidden connection, or
expand the allowed channel/repository scope.

## Read-Only Query Policy

The database account configured on the remote server is the hard read-only
security boundary. PostgreSQL roles must have only the required `CONNECT`,
`USAGE`, and `SELECT` grants. MySQL accounts must have only the required
`SELECT`, `SHOW VIEW`, and equivalent metadata grants. The documentation will
include example grants and explicitly forbid reusing an application owner or
administrative account.

Cyrus also applies defense in depth before connecting:

- exactly one SQL statement is accepted;
- the first significant token must describe a supported read operation;
- string literals, quoted identifiers, line comments, block comments, and
  PostgreSQL dollar-quoted strings are tokenized without treating their content
  as SQL commands;
- mutation, DDL, privilege, transaction-control, file, dynamic-execution, and
  stored-procedure tokens are rejected outside quoted content; and
- PostgreSQL writable CTEs, `SELECT INTO`, `COPY`, and MySQL
  `INTO OUTFILE`/`DUMPFILE` are rejected.

Supported statement families are `SELECT`, read-only `WITH ... SELECT`,
`EXPLAIN` of a supported statement, and metadata reads needed for each engine.
The validator is intentionally conservative: an unfamiliar construct is
rejected rather than guessed safe. The validator is not presented as a
replacement for database permissions.

The remote client receives a read-only transaction batch:

- PostgreSQL: `BEGIN READ ONLY`, a local statement timeout, the validated
  statement, then `ROLLBACK`;
- MySQL: session execution timeout where supported, `START TRANSACTION READ
  ONLY`, the validated statement, then `ROLLBACK`.

PostgreSQL runs with `--no-psqlrc`, `--csv`, `--quiet`, and
`ON_ERROR_STOP=1`. MySQL runs with `--batch`, a column header, and noninteractive
mode. Neither engine executes operator or model text through a local shell.

## SSH Process Boundary

The service invokes OpenSSH with a fixed option set equivalent to:

```text
ssh
  -F <canonical config path, when configured>
  -i <canonical identity path, when configured>
  -p <configured port>
  -o BatchMode=yes
  -o StrictHostKeyChecking=yes
  -o UserKnownHostsFile=<canonical known-hosts path>
  -o GlobalKnownHostsFile=/dev/null
  -o IdentitiesOnly=yes            # only when identityFile is configured
  -o ClearAllForwardings=yes
  -o PermitLocalCommand=no
  -o RequestTTY=no
  -o ConnectTimeout=<bounded seconds>
  <configured user@host>
  <fixed engine client and fixed arguments>
```

The subprocess uses piped stdin/stdout/stderr and no local shell. Model SQL is
written only to stdin. Interactive password or host-key prompts cannot appear.
The process is terminated on timeout, abort, excessive output, or excessive
rows. A bounded stderr tail is held only in memory to classify failures and is
never returned verbatim or logged.

Database access happens in the EdgeWorker service, not in model-created Bash
processes. The SDK sandbox and its egress proxy therefore do not authorize or
mediate this connection; the configured connection list is the service-level
network allowlist. Giving this capability does not widen the model's filesystem
permission to `~/.ssh` or grant the model general SSH egress. Operators must
also allow the configured SSH destination in host-level firewall policy.

## Results and Untrusted Data

PostgreSQL output is returned as CSV and MySQL output as tab-separated text.
The result preserves the remote client's raw field values and headers, as
approved for allowed Slack channels. Cyrus does not redact columns.

The service enforces both row and byte limits. It retains complete rows only;
when the next row would exceed a limit it terminates the process, returns the
complete retained rows, and sets `truncated: true`. The tool response labels
the payload as untrusted database content. Database values cannot issue
instructions, authorize work, select tools, or change repository scope.

The Slack system prompt tells Claude to:

- use database access only when it materially helps answer or implement the
  user's request;
- state which named connection was queried;
- render requested raw rows in a code block;
- state when output was truncated; and
- never copy production rows into a GitHub issue, PR description, commit,
  repository file, or durable activity.

Engineering system prompts repeat the no-persistence rule. Results remain in
the active model turn only and are not added to Slack engineering receipts or
GitHub issue bodies. Normal Claude session storage may retain model context as
part of provider operation; documentation must state that operators should not
enable this feature for data they are prohibited from sending to their model
provider.

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
- `REMOTE_CLIENT_MISSING`;
- `QUERY_FAILED`.

Not-found and not-allowed failures use the same external message so a caller
cannot enumerate hidden connection IDs. Truncation is a successful bounded
result with `truncated: true`, not a query failure.

User-facing messages identify the connection display name and safe remediation
without including SQL, result data, private paths, raw SSH command lines, or
remote stderr.

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

### `cyrus-edge-worker`

- Adds `SshDatabaseQueryService` and a small SQL policy module.
- Normalizes configured paths and hot reloads connections.
- Resolves verified Slack chat and Slack-engineering authorization context.
- Supplies database callbacks to `CyrusToolsOptions` only for eligible
  sessions.
- Adds self-describing Slack and engineering prompt guidance.

### `cyrus-mcp-tools`

- Defines exact schemas for `database_connections_list` and `database_query`.
- Registers tools only when database callbacks are present.
- Converts callback results and stable failures to MCP content without logging
  payloads.

### Documentation and F1

- `docs/CONFIG_FILE.md` documents config, server prerequisites, grants, SSH
  hardening, and privacy implications.
- `CHANGELOG.md` describes the user-visible capability under Unreleased.
- F1 uses a fake `ssh` executable and deterministic PostgreSQL/MySQL output; it
  performs no external SSH or database request.

## Testing and Validation

Tests must be written and observed failing before production changes.

### Configuration tests

- valid PostgreSQL/MySQL connections and defaults;
- duplicate IDs, unsafe identifiers, invalid ports, and invalid limits;
- `~/` normalization at construction and hot reload;
- ConfigManager load preservation and config-change emission; and
- key/config/known-hosts ownership, modes, file types, and canonical paths.

### SQL policy tests

- supported `SELECT`, CTE, metadata, and `EXPLAIN` queries for both engines;
- comments, escaped strings, identifiers, and PostgreSQL dollar quotes;
- multiple statements;
- DML, DDL, privileges, transaction control, file operations, writable CTEs,
  stored procedures, dynamic execution, and side-effecting constructs; and
- the exact read-only batches sent to both clients.

### SSH service tests

- exact argv and stdin for PostgreSQL and MySQL;
- `shell: false`, batch mode, strict host keys, no forwarding, and no TTY;
- SSH-agent and explicit-identity modes;
- connection, query, abort, row, and byte limits;
- process-tree termination and cleanup;
- complete-row truncation for CSV and TSV;
- stable error classification and secret-safe logs; and
- concurrent queries without shared mutable credentials or output.

### Authorization and tool tests

- allowed and denied Slack channels;
- repository overlap and ambiguity;
- verified Slack-originated engineering jobs before and after restart;
- rejection for standalone Linear/GitHub sessions and missing context;
- exact MCP schemas and payloads;
- database content treated as untrusted context; and
- no SQL/results in receipts, issue bodies, activities, or logs.

### Required gates

- focused package tests for core, MCP tools, Claude runner boundaries, and edge
  worker;
- a credential-free F1 drive for Slack chat query, PostgreSQL, MySQL, denied
  channel, engineering handoff, restart, truncation, and injection attempts;
- the complete package test suite;
- typecheck, lint, and build;
- `pnpm audit` with zero advisories; and
- a final security-focused code review.

## Operator Setup Required

For each server, the operator must provide:

1. A dedicated remote OS account or restricted SSH key accepted by that
   account.
2. A pinned host key in the configured `knownHostsFile`.
3. PostgreSQL `psql` or MySQL `mysql` installed at the configured remote path.
4. A dedicated read-only database account.
5. Remote noninteractive authentication through `.pgpass`, `.my.cnf`, or an
   equivalent server-side mechanism readable only by the remote OS account.
6. Cyrus config containing the connection, repository IDs, and allowed Slack
   channel IDs.

The recommended SSH `authorized_keys` entry restricts the key to the database
client wrapper or an operator-owned command dispatcher and disables agent,
port, and X11 forwarding plus PTY allocation. Cyrus's fixed client invocation
is still safe without that restriction, but the server-side restriction limits
damage if the local Cyrus host or key is compromised.

## Acceptance Criteria

The feature is complete when an authorized Slack message can use a configured
PostgreSQL or MySQL connection to return bounded raw rows, and a fix started
from that Slack thread can use the same connection as private diagnostic
context. An unauthorized channel or unrelated repository cannot discover the
connection. No model-controlled value can alter the SSH destination, local
credential paths, or remote executable. Write attempts fail before connection
and at the database permission boundary. Queries, results, credentials, and
secret paths do not appear in logs or durable Cyrus/GitHub state. All required
tests and validation gates pass without contacting a real SSH server or
database.
