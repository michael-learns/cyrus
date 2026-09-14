# SSH Database Access

Cyrus can run bounded, read-only PostgreSQL and MySQL queries while answering
an authorized Slack channel or completing engineering work started there. The
model never gets a general SSH tool, remote command field, private key, or
database credentials.

This is a self-hosted feature. Do not enable it for data that may not be sent
to your configured Claude provider and allowed Slack channel.

## How the boundary works

1. Cyrus authorizes the exact Slack workspace/channel and relevant repository.
2. Cyrus validates one `SELECT` or read-only `WITH ... SELECT`, adds row and
   byte bounds, and starts OpenSSH with a fixed no-shell argument list.
3. A dedicated SSH key can run only `cyrus database-gateway` for one named
   profile. The gateway ignores `SSH_ORIGINAL_COMMAND`.
4. The gateway validates the request again, proves the database account is
   strictly read-only, runs a fixed native client, and returns one bounded
   protocol response.

The database account is the final read-only boundary. Do not use an application
owner, migration account, administrator, or shared operations account.

## 1. Install the gateway host

Install the same Cyrus CLI build on the Cyrus host and gateway host. Gateway
protocol version 1 rejects a different protocol version instead of falling
back. Version 1 checks required capabilities rather than a numeric database
version allowlist:

- PostgreSQL needs a `psql` client with `--csv` and a server that enforces
  `statement_timeout`.
- MySQL needs a client supporting batch/raw, disabled named commands, disabled
  reconnect, and a server that exposes and enforces `MAX_EXECUTION_TIME`.

An incompatible client or server fails closed. Install native clients from
your database vendor or operating-system packages, then keep them patched.

Create a dedicated operating-system user. It needs a normal minimal shell so
OpenSSH can execute the forced command, but no password login or sudo access:

```sh
sudo useradd --create-home --shell /bin/sh cyrus-db
sudo passwd --lock cyrus-db
sudo install -d -o cyrus-db -g cyrus-db -m 0700 /home/cyrus-db/.ssh
sudo install -d -o root -g root -m 0755 /etc/cyrus
```

Use equivalent account-management commands on distributions without
`useradd`. The gateway config and Cyrus executable must be root-owned and not
group/other writable.

## 2. Create a strictly read-only database account

The commands below are templates. Replace identifiers and coordinate any
`PUBLIC` or owner default-privilege changes with your database administrator.

### PostgreSQL

Run as a database administrator:

```sql
CREATE ROLE cyrus_payroll_reader
  LOGIN
  PASSWORD 'replace-with-a-generated-secret'
  NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

REVOKE ALL ON DATABASE payroll FROM cyrus_payroll_reader;
REVOKE TEMPORARY ON DATABASE payroll FROM PUBLIC;
GRANT CONNECT ON DATABASE payroll TO cyrus_payroll_reader;

\connect payroll
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
GRANT USAGE ON SCHEMA reporting TO cyrus_payroll_reader;
GRANT SELECT ON ALL TABLES IN SCHEMA reporting TO cyrus_payroll_reader;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA reporting FROM cyrus_payroll_reader;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA reporting FROM cyrus_payroll_reader;
REVOKE EXECUTE ON ALL PROCEDURES IN SCHEMA reporting FROM PUBLIC;
REVOKE EXECUTE ON ALL PROCEDURES IN SCHEMA reporting FROM cyrus_payroll_reader;

ALTER DEFAULT PRIVILEGES FOR ROLE reporting_owner IN SCHEMA reporting
  GRANT SELECT ON TABLES TO cyrus_payroll_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting_owner IN SCHEMA reporting
  REVOKE ALL ON SEQUENCES FROM cyrus_payroll_reader;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting_owner IN SCHEMA reporting
  REVOKE EXECUTE ON FUNCTIONS FROM PUBLIC;
ALTER DEFAULT PRIVILEGES FOR ROLE reporting_owner IN SCHEMA reporting
  REVOKE EXECUTE ON FUNCTIONS FROM cyrus_payroll_reader;
```

Repeat `ALTER DEFAULT PRIVILEGES FOR ROLE ...` for every role that can create
objects in an allowed schema. The reader must not own a database, schema,
table, view, sequence, or routine and must not belong to another role. If rows
need tenant/subject filtering, enable and force row-level security and test the
policy as this exact role.

Inspect before enabling:

```sql
\du+ cyrus_payroll_reader
\l+ payroll
\dn+ reporting
\dp reporting.*
SELECT * FROM information_schema.role_routine_grants
WHERE grantee IN ('cyrus_payroll_reader', 'PUBLIC');
```

The gateway runs a stricter catalog preflight on every connection and rejects
membership, ownership, TEMP/CREATE, table writes, sequence mutation, routine
execution, superuser-style attributes, bypass-RLS, or missing deadlines.

To revoke and remove the account:

```sql
REVOKE ALL PRIVILEGES ON ALL TABLES IN SCHEMA reporting FROM cyrus_payroll_reader;
REVOKE ALL PRIVILEGES ON SCHEMA reporting FROM cyrus_payroll_reader;
REVOKE CONNECT ON DATABASE payroll FROM cyrus_payroll_reader;
DROP OWNED BY cyrus_payroll_reader;
DROP ROLE cyrus_payroll_reader;
```

Also remove every matching `ALTER DEFAULT PRIVILEGES ... GRANT SELECT` before
recreating a role with the same name.

### MySQL

Run as a database administrator. Restrict the account host to the gateway's
source address instead of `%`:

```sql
CREATE USER 'cyrus_payroll_reader'@'10.20.0.15'
  IDENTIFIED BY 'replace-with-a-generated-secret'
  REQUIRE SSL;
REVOKE ALL PRIVILEGES, GRANT OPTION
  FROM 'cyrus_payroll_reader'@'10.20.0.15';
GRANT SELECT, SHOW VIEW ON payroll.*
  TO 'cyrus_payroll_reader'@'10.20.0.15';
SHOW GRANTS FOR 'cyrus_payroll_reader'@'10.20.0.15';
```

Do not grant global privileges, roles, `EXECUTE`, `FILE`, `PROCESS`, temporary
table, locking, replication, administration, schema mutation, or data mutation
privileges. Connect as the new user and run `SELECT CURRENT_USER();`; copy its
exact result into `expectedRole` in the gateway profile.

To remove it:

```sql
REVOKE SELECT, SHOW VIEW ON payroll.*
  FROM 'cyrus_payroll_reader'@'10.20.0.15';
DROP USER 'cyrus_payroll_reader'@'10.20.0.15';
```

## 3. Store credentials on the gateway

For PostgreSQL, create a `.pgpass` file owned by `cyrus-db`, mode `0600`:

```text
db.internal.example:5432:payroll:cyrus_payroll_reader:generated-secret
```

For MySQL, create a client defaults file owned by `cyrus-db`, mode `0600`:

```ini
[client]
password=generated-secret
ssl-mode=VERIFY_IDENTITY
ssl-ca=/etc/cyrus/database-ca.pem
```

Example installation:

```sh
sudo install -o cyrus-db -g cyrus-db -m 0600 payroll.pgpass /etc/cyrus/payroll.pgpass
sudo install -o cyrus-db -g cyrus-db -m 0600 payroll.mysql.cnf /etc/cyrus/payroll.mysql.cnf
```

Never put database passwords in `~/.cyrus/config.json`, the forced command, or
the SSH public-key comment.

## 4. Create the root-owned gateway profile

PostgreSQL example `/etc/cyrus/database-gateway.json`:

```json
{
  "version": 1,
  "profiles": {
    "payroll-production": {
      "engine": "postgres",
      "database": "payroll",
      "host": "db.internal.example",
      "port": 5432,
      "user": "cyrus_payroll_reader",
      "expectedRole": "cyrus_payroll_reader",
      "executable": "/usr/lib/postgresql/14/bin/psql",
      "credentialsFile": "/etc/cyrus/payroll.pgpass",
      "limits": {
        "queryTimeoutMs": 15000,
        "maxSqlBytes": 16384,
        "maxRows": 100,
        "maxOutputBytes": 32768
      }
    }
  }
}
```

MySQL profile entry:

```json
{
  "engine": "mysql",
  "database": "payroll",
  "host": "db.internal.example",
  "port": 3306,
  "user": "cyrus_payroll_reader",
  "expectedRole": "cyrus_payroll_reader@10.20.0.15",
  "executable": "/usr/bin/mysql",
  "credentialsFile": "/etc/cyrus/payroll.mysql.cnf",
  "limits": {
    "queryTimeoutMs": 15000,
    "maxSqlBytes": 16384,
    "maxRows": 100,
    "maxOutputBytes": 32768
  }
}
```

Install it with:

```sh
sudo install -o root -g cyrus-db -m 0640 database-gateway.json /etc/cyrus/database-gateway.json
sudo chown root:root /usr/local/bin/cyrus /usr/lib/postgresql/14/bin/psql /usr/bin/mysql
sudo chmod go-w /usr/local/bin/cyrus /usr/lib/postgresql/14/bin/psql /usr/bin/mysql
```

The loader requires the profile file to be root-owned and not group/other
writable; the forced-command user must also be able to read it, so a dedicated
`cyrus-db` group and mode `0640` are appropriate. It requires the native client
to be root-owned and not group/other writable. The credentials file must be
owned by the gateway process user and have no group/other permissions.

On Debian and Ubuntu, point `executable` at the versioned PostgreSQL client
reported by `pg_config --bindir` (for example,
`/usr/lib/postgresql/14/bin/psql`). Do not use `/usr/bin/psql`: that path is the
`pg_wrapper` helper, which depends on environment lookup that Cyrus deliberately
removes when launching the database client.

## 5. Install one forced SSH key per connection

Create a dedicated Ed25519 key on the Cyrus host and pin the gateway host key:

```sh
install -d -m 0700 ~/.cyrus/ssh
ssh-keygen -t ed25519 -f ~/.cyrus/ssh/payroll_ed25519 -N ''
chmod 0600 ~/.cyrus/ssh/payroll_ed25519
ssh-keyscan -t ed25519 db-gateway.internal.example > ~/.cyrus/ssh/payroll_known_hosts
chmod 0644 ~/.cyrus/ssh/payroll_known_hosts
```

Verify the `ssh-keyscan` fingerprint through a trusted, separate channel before
using it. On the gateway, append exactly one line to
`/home/cyrus-db/.ssh/authorized_keys` (replace the public key):

```text
restrict,command="/usr/local/bin/cyrus database-gateway --config /etc/cyrus/database-gateway.json --profile payroll-production" ssh-ed25519 AAAAC3... cyrus-payroll-production
```

Then enforce ownership and modes:

```sh
sudo chown cyrus-db:cyrus-db /home/cyrus-db/.ssh/authorized_keys
sudo chmod 0600 /home/cyrus-db/.ssh/authorized_keys
```

For defense in depth, add an `sshd_config` match block and reload SSH safely:

```text
Match User cyrus-db
    AuthenticationMethods publickey
    PasswordAuthentication no
    KbdInteractiveAuthentication no
    PermitTTY no
    DisableForwarding yes
    X11Forwarding no
```

Do not add a remote command to the local Cyrus config. OpenSSH sends only the
protocol frame on stdin; the forced command is selected by `authorized_keys`.

## 6. Configure Cyrus

Add `databaseConnections` to `~/.cyrus/config.json` using the example in
[CONFIG_FILE.md](./CONFIG_FILE.md). `identityFile` must be a regular file owned
by the Cyrus process user with mode `0600` or stricter. `knownHostsFile` must be
a regular file owned by the Cyrus process user or root and cannot be
group/other writable. Parent directories must be owned by the Cyrus user or
root and non-writable by other users; a root-owned sticky temporary directory
is the only writable exception. `~/` paths are supported.

The configured repository IDs must exist and be active. Each destination is an
exact Slack workspace/team ID plus channel ID pair. Database tools are absent
from Linear-only, GitHub-webhook, generic GitHub engineering, denied Slack, and
unverifiable sessions.

Hosted Cyrus must not expose this feature until the external `cyrus-hosted`
repository adds both `database_connections_list` and `database_query` to
`KNOWN_MCP_TOOLS["mcp__cyrus-tools"]` and the appropriate per-platform default
tool lists. Runtime support in this repository alone is not a hosted release.

## 7. Lock down the network

At minimum:

- allow the Cyrus host to reach only the gateway's SSH address and port;
- allow gateway SSH ingress only from the Cyrus host's fixed address;
- allow the gateway to reach only the selected database address and port;
- allow database ingress only from the gateway;
- deny the gateway's other outbound traffic unless operationally required; and
- monitor authentication, gateway failures, and the metadata-only Cyrus audit
  event without logging SQL, rows, credentials, private paths, hosts, or SSH
  stderr.

The Claude sandbox/egress proxy does not mediate this service-level SSH
connection. Your host firewall is part of the security boundary.

## Retention and results

Database results are untrusted input. They cannot authorize engineering work,
select another repository or connection, expand permissions, or issue model
instructions. Cyrus can show requested raw rows in a Slack code block and says
when output was truncated.

Some persistence is unavoidable:

- the configured Claude provider receives the SQL and result;
- the local Claude session transcript may retain them for continuity;
- raw rows included in a Slack reply are retained by Slack; and
- the model can reproduce values in generated text.

Cyrus redacts database tool payloads and later model-generated content in the
same database turn from activities, generic formatter output, Slack status
updates, telemetry, errors, receipts, automatic issue assembly, durable
summaries, and hosted session mirroring. The direct final Slack reply remains
available so Cyrus can show rows when the user explicitly asks. Prompts also
tell the model not to copy production data into issues, PRs, commits, or
repository files, but prompts are not a complete data-loss-prevention boundary.

## Troubleshooting

- `The database connection is unavailable`: verify the exact Slack team and
  channel IDs, active repository IDs, and that the connection still exists.
  Hidden and missing connections intentionally return the same message.
- `HOST_KEY_FAILED`: rebuild the pinned known-hosts entry only after verifying
  the new fingerprint out of band. Never disable strict host-key checking.
- `AUTHENTICATION_FAILED`: check the key's owner/mode and its exact forced
  `authorized_keys` line. Do not enable passwords or an SSH agent.
- `PRIVILEGE_CHECK_FAILED`: connect as the reader and inspect effective grants,
  role memberships, ownership, TEMP/CREATE, routine execution, RLS bypass, and
  server-side deadline support. Do not bypass the preflight.
- `GATEWAY_VERSION_UNSUPPORTED`: install the same Cyrus CLI build on both hosts.
- `REMOTE_CLIENT_MISSING`: verify the configured absolute client path and its
  root ownership/mode.
- `QUERY_REJECTED`: submit exactly one supported `SELECT` or read-only
  `WITH ... SELECT`. `SHOW`, `EXPLAIN`, stored routines, client commands,
  writes, locks, file access, and unfamiliar constructs are rejected.
- Timeouts or truncated output: narrow the query or lower its cost. Do not raise
  limits before reviewing the data and load implications.

## Teardown checklist

1. Remove the connection from `~/.cyrus/config.json` or set
   `databaseConnections` to `[]` and let Cyrus reload it.
2. Remove the connection's public key from `authorized_keys`.
3. Remove the local private key and pinned known-hosts file.
4. Revoke default privileges and current grants, then drop the database role.
5. Delete the gateway profile and credentials file.
6. Remove the firewall rules and OS account if no other profile uses them.
