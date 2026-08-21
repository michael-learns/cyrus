import { realpathSync, statSync } from "node:fs";
import type { SshDatabaseConnection } from "cyrus-core";
import {
	GATEWAY_PROTOCOL_VERSION,
	MAX_GATEWAY_RESPONSE_BYTES,
} from "./constants.js";
import { DatabaseAccessError } from "./errors.js";
import { type ProcessRunner, runBoundedProcess } from "./process-runner.js";
import { decodeGatewayResponse, encodeGatewayRequest } from "./protocol.js";
import { validateAndBoundSql } from "./sql-policy.js";

export interface InspectedFile {
	canonicalPath: string;
	isFile: boolean;
	uid: number;
	mode: number;
}

export interface SshDatabaseQueryServiceDependencies {
	run?: ProcessRunner;
	inspectFile?: (path: string) => InspectedFile;
	sshExecutable?: string;
}

export interface SshDatabaseQueryResult {
	connectionId: string;
	engine: "postgres" | "mysql";
	format: "csv" | "tsv";
	output: string;
	truncated: boolean;
	rowCount: number;
	byteCount: number;
}

export class SshDatabaseQueryService {
	private readonly run: ProcessRunner;
	private readonly inspectFile: (path: string) => InspectedFile;
	private readonly sshExecutable: string;

	constructor(dependencies: SshDatabaseQueryServiceDependencies = {}) {
		this.run = dependencies.run ?? runBoundedProcess;
		this.inspectFile = dependencies.inspectFile ?? defaultInspectFile;
		this.sshExecutable = dependencies.sshExecutable ?? "/usr/bin/ssh";
	}

	async query(
		connection: SshDatabaseConnection,
		sql: string,
		signal?: AbortSignal,
	): Promise<SshDatabaseQueryResult> {
		validateAndBoundSql({
			engine: connection.engine,
			sql,
			maxSqlBytes: connection.limits.maxSqlBytes,
			maxRows: connection.limits.maxRows,
		});
		const identity = this.requireIdentityFile(connection.ssh.identityFile);
		const knownHosts = this.requireKnownHostsFile(
			connection.ssh.knownHostsFile,
		);
		const request = encodeGatewayRequest({
			version: GATEWAY_PROTOCOL_VERSION,
			profile: connection.database.profile,
			engine: connection.engine,
			sql,
			limits: {
				queryTimeoutMs: connection.limits.queryTimeoutMs,
				maxSqlBytes: connection.limits.maxSqlBytes,
				maxRows: connection.limits.maxRows,
				maxOutputBytes: connection.limits.maxOutputBytes,
			},
		});
		const target = connection.ssh.user
			? `${connection.ssh.user}@${connection.ssh.host}`
			: connection.ssh.host;
		const result = await this.run({
			file: this.sshExecutable,
			args: [
				"-F",
				"none",
				"-i",
				identity,
				"-p",
				String(connection.ssh.port),
				...sshOption("BatchMode=yes"),
				...sshOption("StrictHostKeyChecking=yes"),
				...sshOption(`UserKnownHostsFile=${knownHosts}`),
				...sshOption("GlobalKnownHostsFile=/dev/null"),
				...sshOption("IdentitiesOnly=yes"),
				...sshOption("IdentityAgent=none"),
				...sshOption("PasswordAuthentication=no"),
				...sshOption("KbdInteractiveAuthentication=no"),
				...sshOption("PreferredAuthentications=publickey"),
				...sshOption("ProxyCommand=none"),
				...sshOption("ProxyJump=none"),
				...sshOption("ControlMaster=no"),
				...sshOption("ControlPath=none"),
				...sshOption("KnownHostsCommand=none"),
				...sshOption("ClearAllForwardings=yes"),
				...sshOption("PermitLocalCommand=no"),
				...sshOption("RequestTTY=no"),
				...sshOption(
					`ConnectTimeout=${Math.max(1, Math.ceil(connection.limits.connectTimeoutMs / 1_000))}`,
				),
				target,
			],
			env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
			stdin: request,
			shell: false,
			timeoutMs:
				connection.limits.connectTimeoutMs +
				connection.limits.queryTimeoutMs +
				5_000,
			maxStdoutBytes: MAX_GATEWAY_RESPONSE_BYTES,
			maxStderrBytes: 4_096,
			signal,
			timeoutCode: "QUERY_TIMEOUT",
			spawnErrorCode: "SSH_UNAVAILABLE",
		});
		if (result.exitCode !== 0) throw classifySshFailure(result.stderr);
		const decoded = decodeGatewayResponse(
			result.stdout,
			connection.limits.maxOutputBytes,
		);
		return {
			connectionId: connection.id,
			engine: connection.engine,
			...decoded,
		};
	}

	private requireIdentityFile(path: string): string {
		const file = this.inspectFile(path);
		const currentUid = process.getuid?.();
		if (
			!file.isFile ||
			(currentUid !== undefined && file.uid !== currentUid) ||
			(file.mode & 0o077) !== 0
		) {
			throw invalidFile();
		}
		return file.canonicalPath;
	}

	private requireKnownHostsFile(path: string): string {
		const file = this.inspectFile(path);
		if (!file.isFile || (file.mode & 0o022) !== 0) throw invalidFile();
		return file.canonicalPath;
	}
}

function defaultInspectFile(path: string): InspectedFile {
	try {
		const canonicalPath = realpathSync(path);
		const stat = statSync(canonicalPath);
		return {
			canonicalPath,
			isFile: stat.isFile(),
			uid: stat.uid,
			mode: stat.mode,
		};
	} catch {
		throw invalidFile();
	}
}

function sshOption(value: string): ["-o", string] {
	return ["-o", value];
}

function invalidFile(): DatabaseAccessError {
	return new DatabaseAccessError(
		"GATEWAY_UNAVAILABLE",
		"The configured SSH identity is unavailable",
	);
}

function classifySshFailure(stderr: Uint8Array): DatabaseAccessError {
	const text = Buffer.from(stderr).toString("utf8").toLowerCase();
	if (text.includes("host key verification failed")) {
		return new DatabaseAccessError(
			"HOST_KEY_FAILED",
			"SSH host-key verification failed",
		);
	}
	if (text.includes("permission denied")) {
		return new DatabaseAccessError(
			"AUTHENTICATION_FAILED",
			"SSH authentication failed",
		);
	}
	if (text.includes("timed out")) {
		return new DatabaseAccessError(
			"CONNECTION_TIMEOUT",
			"The SSH connection timed out",
		);
	}
	return new DatabaseAccessError(
		"GATEWAY_UNAVAILABLE",
		"The database gateway is unavailable",
	);
}
