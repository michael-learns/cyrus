#!/usr/bin/env node
import { spawn, spawnSync } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir, userInfo } from "node:os";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { SshDatabaseQueryService } from "../../../../packages/ssh-database/dist/index.js";

const root = resolve(import.meta.dirname, "../../../..");
const directory = mkdtempSync(join(tmpdir(), "cyrus-db-hermetic-"));
const container = `cyrus-f1-postgres-${process.pid}`;
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
	spawnSync("docker", ["rm", "-f", container], { stdio: "ignore" });
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
	const mysqlImage = images.find((image) => /^(mysql|mariadb):/.test(image));

	run("docker", [
		"run",
		"-d",
		"--name",
		container,
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
				container,
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
		["exec", "-i", container, "psql", "-U", "postgres", "-d", "f1db"],
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

	const key = join(directory, "id_ed25519");
	const hostKey = join(directory, "ssh_host_ed25519_key");
	run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", key]);
	run("ssh-keygen", ["-q", "-t", "ed25519", "-N", "", "-f", hostKey]);
	chmodSync(key, 0o600);

	const psqlWrapper = join(directory, "psql-wrapper");
	writeFileSync(
		psqlWrapper,
		`#!/bin/sh\nexec /usr/local/bin/docker exec -e PGPASSWORD=f1-reader ${container} psql "$@"\n`,
		{ mode: 0o700 },
	);
	const credentials = join(directory, "pgpass");
	writeFileSync(credentials, "*:*:*:f1_reader:f1-reader\n", { mode: 0o600 });
	const gateway = join(directory, "gateway.mjs");
	writeFileSync(
		gateway,
		`import { realpathSync, statSync } from "node:fs";
import { DatabaseGateway, NativeDatabaseExecutor } from ${JSON.stringify(`file://${join(root, "packages/ssh-database/dist/index.js")}`)};
const chunks=[]; for await (const chunk of process.stdin) chunks.push(chunk);
const profile={id:"f1-postgres",engine:"postgres",database:"f1db",user:"f1_reader",expectedRole:"f1_reader",executable:${JSON.stringify(psqlWrapper)},credentialsFile:${JSON.stringify(credentials)},limits:{queryTimeoutMs:2000,maxSqlBytes:16384,maxRows:2,maxOutputBytes:32768}};
const inspectFile=(path)=>{const canonicalPath=realpathSync(path);const stat=statSync(canonicalPath);return {canonicalPath,isFile:stat.isFile(),uid:path===profile.executable?0:process.getuid(),mode:stat.mode};};
process.stdout.write(await new DatabaseGateway(profile,new NativeDatabaseExecutor({inspectFile})).handle(Buffer.concat(chunks)));
`,
	);
	const authorizedKeys = join(directory, "authorized_keys");
	const publicKey = run("sh", ["-c", `cat '${key}.pub'`]);
	writeFileSync(
		authorizedKeys,
		`command="${process.execPath} ${gateway}",no-agent-forwarding,no-port-forwarding,no-pty,no-user-rc,no-X11-forwarding ${publicKey}\n`,
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
	const connection = {
		id: "f1-postgres",
		name: "F1 PostgreSQL",
		engine: "postgres",
		repositoryIds: ["primary"],
		slackDestinations: [{ teamId: "T_F1", channelId: "C_DATABASE" }],
		ssh: {
			host: "127.0.0.1",
			user: userInfo().username,
			port,
			identityFile: key,
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
	const selected = await service.query(
		connection,
		"SELECT id, name FROM evidence ORDER BY id",
	);
	let writeCode;
	try {
		await service.query(connection, "DELETE FROM evidence");
	} catch (error) {
		writeCode = error.code;
	}
	console.log(
		JSON.stringify(
			{
				postgres: { selected, writeRejected: writeCode === "QUERY_REJECTED" },
				mysql: mysqlImage
					? {
							attempted: false,
							reason:
								"cached image present but no MySQL gateway client image is defined by this drive",
						}
					: {
							attempted: false,
							reason:
								"no cached mysql/mariadb image; network pulls are forbidden",
						},
				openSsh: true,
				cleanupTarget: container,
			},
			null,
			2,
		),
	);
} finally {
	cleanup();
}
