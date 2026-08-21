#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SshDatabaseQueryService } from "../../../../packages/ssh-database/dist/index.js";

const root = resolve(import.meta.dirname, "../../../..");
const directory = mkdtempSync(join(tmpdir(), "cyrus-db-hermetic-"));
const postgresContainer = `cyrus-f1-postgres-${process.pid}`;
const mysqlContainer = `cyrus-f1-mysql-${process.pid}`;
const port = 42000 + (process.pid % 1000);
let sshd;

function run(file, args, options = {}) {
	const result = spawnSync(file, args, { encoding: "utf8", ...options });
	if (result.status !== 0) {
		throw new Error(
			`${file} ${args.join(" ")} failed: ${result.stderr || result.stdout}`,
		);
	}
	return result.stdout.trim();
}

function cleanup() {
	if (sshd && !sshd.killed) sshd.kill("SIGTERM");
	spawnSync("docker", ["rm", "-f", postgresContainer], { stdio: "ignore" });
	spawnSync("docker", ["rm", "-f", mysqlContainer], { stdio: "ignore" });
	rmSync(directory, { recursive: true, force: true });
}

process.once("SIGINT", () => {
	cleanup();
	process.exit(130);
});
process.once("SIGTERM", () => {
	cleanup();
	process.exit(143);
});

try {
	const images = run("docker", [
		"image",
		"ls",
		"--format",
		"{{.Repository}}:{{.Tag}}",
	]).split("\n");
	if (!images.includes("postgres:16-alpine")) {
		throw new Error(
			"postgres:16-alpine is not cached; refusing network image pulls",
		);
	}
	const mysqlImage = images.find((image) => /^mysql:/.test(image));
	if (!mysqlImage) {
		throw new Error(
			"a MySQL image is not cached; refusing network image pulls",
		);
	}

	run("docker", [
		"run",
		"-d",
		"--name",
		postgresContainer,
		"-e",
		"POSTGRES_PASSWORD=f1-admin",
		"-e",
		"POSTGRES_DB=f1db",
		"postgres:16-alpine",
	]);
	for (let attempt = 0; attempt < 40; attempt++) {
		const ready = spawnSync(
			"docker",
			[
				"exec",
				postgresContainer,
				"psql",
				"-U",
				"postgres",
				"-d",
				"f1db",
				"-c",
				"SELECT 1",
			],
			{ stdio: "ignore" },
		);
		if (ready.status === 0) break;
		await delay(250);
		if (attempt === 39) throw new Error("PostgreSQL did not become ready");
	}
	run(
		"docker",
		["exec", "-i", postgresContainer, "psql", "-U", "postgres", "-d", "f1db"],
		{
			input: `CREATE ROLE f1_reader LOGIN PASSWORD 'f1-reader';
CREATE TABLE evidence(id integer primary key, name text);
INSERT INTO evidence VALUES (1, 'Ada'), (2, 'Grace');
REVOKE CREATE, TEMP ON DATABASE f1db FROM PUBLIC;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
REVOKE EXECUTE ON ALL FUNCTIONS IN SCHEMA public FROM PUBLIC;
REVOKE UPDATE ON pg_catalog.pg_settings FROM PUBLIC;
GRANT CONNECT ON DATABASE f1db TO f1_reader;
GRANT USAGE ON SCHEMA public TO f1_reader;
GRANT SELECT ON evidence TO f1_reader;
`,
		},
	);
	run("docker", [
		"run",
		"-d",
		"--name",
		mysqlContainer,
		"-e",
		"MYSQL_ROOT_PASSWORD=f1-admin",
		"-e",
		"MYSQL_DATABASE=f1db",
		mysqlImage,
	]);
	for (let attempt = 0; attempt < 80; attempt++) {
		const ready = spawnSync(
			"docker",
			[
				"exec",
				mysqlContainer,
				"mysql",
				"--user=root",
				"--password=f1-admin",
				"--execute=SELECT 1",
			],
			{ stdio: "ignore" },
		);
		if (ready.status === 0) break;
		await delay(500);
		if (attempt === 79) throw new Error("MySQL did not become ready");
	}
	run(
		"docker",
		[
			"exec",
			"-i",
			mysqlContainer,
			"mysql",
			"--user=root",
			"--password=f1-admin",
			"f1db",
		],
		{
			input: `CREATE USER 'f1_reader'@'localhost' IDENTIFIED BY 'f1-reader';
CREATE TABLE evidence(id integer primary key, name varchar(64));
INSERT INTO evidence VALUES (1, 'Ada'), (2, 'Grace');
GRANT SELECT, SHOW VIEW ON f1db.* TO 'f1_reader'@'localhost';
FLUSH PRIVILEGES;
`,
		},
	);

	const postgresKey = join(directory, "id_postgres_ed25519");
	const mysqlKey = join(directory, "id_mysql_ed25519");
	const hostKey = join(directory, "ssh_host_ed25519_key");
	run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", postgresKey]);
	run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", mysqlKey]);
	run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
	chmodSync(postgresKey, 0o600);
	chmodSync(mysqlKey, 0o600);

	const psqlWrapper = join(directory, "psql-wrapper");
	writeFileSync(
		psqlWrapper,
		`#!/bin/sh\nexec /usr/local/bin/docker exec -e PGPASSWORD=f1-reader ${postgresContainer} psql "$@"\n`,
		{ mode: 0o700 },
	);
	const mysqlWrapper = join(directory, "mysql-wrapper");
	writeFileSync(
		mysqlWrapper,
		`#!/bin/sh\ncase "$1" in --defaults-extra-file=*) shift ;; *) exit 64 ;; esac\nexec /usr/local/bin/docker exec -e MYSQL_PWD=f1-reader ${mysqlContainer} mysql "$@"\n`,
		{ mode: 0o700 },
	);
	const postgresCredentials = join(directory, "pgpass");
	const mysqlCredentials = join(directory, "mysql.cnf");
	writeFileSync(postgresCredentials, "*:*:*:f1_reader:f1-reader\n", {
		mode: 0o600,
	});
	writeFileSync(mysqlCredentials, "[client]\npassword=f1-reader\n", {
		mode: 0o600,
	});
	const postgresGateway = join(directory, "postgres-gateway.mjs");
	writeFileSync(
		postgresGateway,
		`import { realpathSync, statSync } from "node:fs";
import { DatabaseGateway, NativeDatabaseExecutor } from ${JSON.stringify(`file://${join(root, "packages/ssh-database/dist/index.js")}`)};
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const profile={id:"f1-postgres",engine:"postgres",database:"f1db",user:"f1_reader",expectedRole:"f1_reader",executable:${JSON.stringify(psqlWrapper)},credentialsFile:${JSON.stringify(postgresCredentials)},limits:{queryTimeoutMs:2000,maxSqlBytes:16384,maxRows:2,maxOutputBytes:32768}};
const inspectFile=(path)=>{const canonicalPath=realpathSync(path);const stat=statSync(canonicalPath);return {canonicalPath,isFile:stat.isFile(),uid:path===profile.executable?0:process.getuid(),mode:stat.mode};};
process.stdout.write(await new DatabaseGateway(profile,new NativeDatabaseExecutor({inspectFile})).handle(Buffer.concat(chunks)));
`,
	);
	const mysqlGateway = join(directory, "mysql-gateway.mjs");
	writeFileSync(
		mysqlGateway,
		`import { realpathSync, statSync } from "node:fs";
import { DatabaseGateway, NativeDatabaseExecutor } from ${JSON.stringify(`file://${join(root, "packages/ssh-database/dist/index.js")}`)};
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const profile={id:"f1-mysql",engine:"mysql",database:"f1db",user:"f1_reader",expectedRole:"f1_reader@localhost",executable:${JSON.stringify(mysqlWrapper)},credentialsFile:${JSON.stringify(mysqlCredentials)},limits:{queryTimeoutMs:2000,maxSqlBytes:16384,maxRows:2,maxOutputBytes:32768}};
const inspectFile=(path)=>{const canonicalPath=realpathSync(path);const stat=statSync(canonicalPath);return {canonicalPath,isFile:stat.isFile(),uid:path===profile.executable?0:process.getuid(),mode:stat.mode};};
process.stdout.write(await new DatabaseGateway(profile,new NativeDatabaseExecutor({inspectFile})).handle(Buffer.concat(chunks)));
`,
	);
	const authorizedKeys = join(directory, "authorized_keys");
	const postgresPublicKey = run("sh", ["-c", `cat '${postgresKey}.pub'`]);
	const mysqlPublicKey = run("sh", ["-c", `cat '${mysqlKey}.pub'`]);
	writeFileSync(
		authorizedKeys,
		`command="${process.execPath} ${postgresGateway}",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ${postgresPublicKey}\ncommand="${process.execPath} ${mysqlGateway}",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ${mysqlPublicKey}\n`,
		{ mode: 0o600 },
	);
	const sshdConfig = join(directory, "sshd_config");
	writeFileSync(
		sshdConfig,
		`Port ${port}
ListenAddress 127.0.0.1
HostKey ${hostKey}
PidFile ${join(directory, "sshd.pid")}
AuthorizedKeysFile ${authorizedKeys}
PasswordAuthentication no
KbdInteractiveAuthentication no
PubkeyAuthentication yes
PermitRootLogin no
StrictModes no
UsePAM no
AllowUsers ${userInfo().username}
Subsystem sftp internal-sftp
`,
	);
	sshd = spawn("/usr/sbin/sshd", ["-D", "-e", "-f", sshdConfig], {
		stdio: ["ignore", "ignore", "pipe"],
	});
	let sshError = "";
	sshd.stderr.on("data", (chunk) => {
		sshError += chunk;
	});
	await delay(500);
	if (sshd.exitCode !== null) throw new Error(`sshd exited: ${sshError}`);
	const knownHosts = join(directory, "known_hosts");
	const hostPublic = run("ssh-keygen", ["-y", "-f", hostKey]);
	writeFileSync(knownHosts, `[127.0.0.1]:${port} ${hostPublic}\n`, {
		mode: 0o644,
	});

	const service = new SshDatabaseQueryService();
	const postgresConnection = {
		id: "f1-postgres",
		name: "F1 PostgreSQL",
		engine: "postgres",
		repositoryIds: ["primary"],
		slackDestinations: [{ teamId: "T_F1", channelId: "C_DATABASE" }],
		ssh: {
			host: "127.0.0.1",
			user: userInfo().username,
			port,
			identityFile: postgresKey,
			knownHostsFile: knownHosts,
		},
		database: { name: "f1db", profile: "f1-postgres" },
		limits: {
			connectTimeoutMs: 2000,
			queryTimeoutMs: 2000,
			maxSqlBytes: 16384,
			maxRows: 2,
			maxOutputBytes: 32768,
		},
		allowModelDataRetention: true,
	};
	const mysqlConnection = {
		...postgresConnection,
		id: "f1-mysql",
		name: "F1 MySQL",
		engine: "mysql",
		ssh: { ...postgresConnection.ssh, identityFile: mysqlKey },
		database: { name: "f1db", profile: "f1-mysql" },
	};
	const postgresSelected = await service.query(
		postgresConnection,
		"SELECT id, name FROM evidence ORDER BY id",
	);
	const mysqlSelected = await service.query(
		mysqlConnection,
		"SELECT id, name FROM evidence ORDER BY id",
	);
	let postgresWriteCode;
	try {
		await service.query(postgresConnection, "DELETE FROM evidence");
	} catch (error) {
		postgresWriteCode = error.code;
	}
	let mysqlWriteCode;
	try {
		await service.query(mysqlConnection, "DELETE FROM evidence");
	} catch (error) {
		mysqlWriteCode = error.code;
	}
	console.log(
		JSON.stringify(
			{
				postgres: {
					selected: postgresSelected,
					writeRejected: postgresWriteCode === "QUERY_REJECTED",
				},
				mysql: {
					attempted: true,
					image: mysqlImage,
					selected: mysqlSelected,
					writeRejected: mysqlWriteCode === "QUERY_REJECTED",
				},
				openSsh: true,
				cleanupTargets: [postgresContainer, mysqlContainer],
			},
			null,
			2,
		),
	);
} finally {
	cleanup();
}
