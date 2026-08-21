import { realpathSync, statSync } from "node:fs";
import type { DatabaseGatewayExecutor } from "./DatabaseGateway.js";
import { DatabaseAccessError } from "./errors.js";
import type { GatewayProfile } from "./gateway-profile.js";
import { buildNativeClientInvocation } from "./native-client.js";
import { parseMysqlBatchOutput } from "./output/mysql-batch.js";
import { parsePostgresCsvOutput } from "./output/postgres-csv.js";
import type { FramedDatabaseOutput } from "./output/types.js";
import {
	assertMysqlPrivilegePreflight,
	assertPostgresPrivilegePreflight,
	POSTGRES_PRIVILEGE_PREFLIGHT_SQL,
	type PostgresPrivilegePreflight,
} from "./privilege-preflight.js";
import {
	type ProcessInvocation,
	type ProcessRunner,
	runBoundedProcess,
} from "./process-runner.js";
import type { ValidatedSql } from "./sql-policy.js";

interface InspectedGatewayFile {
	canonicalPath: string;
	isFile: boolean;
	uid: number;
	mode: number;
}

export interface NativeDatabaseExecutorDependencies {
	run?: ProcessRunner;
	inspectFile?: (path: string) => InspectedGatewayFile;
}

export class NativeDatabaseExecutor implements DatabaseGatewayExecutor {
	private readonly run: ProcessRunner;
	private readonly inspectFile: (path: string) => InspectedGatewayFile;

	constructor(dependencies: NativeDatabaseExecutorDependencies = {}) {
		this.run = dependencies.run ?? runBoundedProcess;
		this.inspectFile = dependencies.inspectFile ?? defaultInspectFile;
	}

	async preflight(
		profile: GatewayProfile,
		signal?: AbortSignal,
	): Promise<void> {
		const secured = this.secureProfile(profile);
		if (secured.engine === "postgres") {
			const result = await this.run(
				this.commandInvocation(
					secured,
					POSTGRES_PRIVILEGE_PREFLIGHT_SQL,
					signal,
				),
			);
			if (result.exitCode !== 0) privilegeFailed();
			assertPostgresPrivilegePreflight(
				parsePostgresPreflight(result.stdout),
				secured.expectedRole,
			);
			return;
		}

		const identity = await this.run(
			this.commandInvocation(
				secured,
				"SELECT CURRENT_USER() AS currentAccount, @@max_execution_time IS NOT NULL AS deadlineSupported",
				signal,
			),
		);
		const grants = await this.run(
			this.commandInvocation(secured, "SHOW GRANTS FOR CURRENT_USER", signal),
		);
		if (identity.exitCode !== 0 || grants.exitCode !== 0) privilegeFailed();
		const identityRows = parseMysqlLines(identity.stdout);
		const header = identityRows[0]?.split("\t");
		const row = identityRows[1]?.split("\t");
		if (
			header?.[0] !== "currentAccount" ||
			header[1] !== "deadlineSupported" ||
			!row?.[0]
		) {
			privilegeFailed();
		}
		const grantRows = parseMysqlLines(grants.stdout);
		assertMysqlPrivilegePreflight(
			{
				currentAccount: row[0],
				deadlineSupported: row[1] === "1",
				grants: grantRows.slice(1),
			},
			secured.expectedRole,
		);
	}

	async query(
		profile: GatewayProfile,
		query: ValidatedSql & {
			queryTimeoutMs: number;
			maxRows: number;
			maxOutputBytes: number;
		},
		signal?: AbortSignal,
	): Promise<FramedDatabaseOutput> {
		const secured = this.secureProfile(profile);
		const invocation = buildNativeClientInvocation({
			engine: secured.engine,
			executable: secured.executable,
			database: secured.database,
			host: secured.host,
			port: secured.port,
			user: secured.user,
			credentialsFile: secured.credentialsFile,
			boundedSql: query.boundedSql,
			queryTimeoutMs: query.queryTimeoutMs,
		});
		const result = await this.run({
			...invocation,
			timeoutMs: query.queryTimeoutMs + 5_000,
			maxStdoutBytes: 1_572_864,
			maxStderrBytes: 4_096,
			signal,
			timeoutCode: "QUERY_TIMEOUT",
			spawnErrorCode: "REMOTE_CLIENT_MISSING",
		});
		if (result.exitCode !== 0) {
			throw new DatabaseAccessError(
				"QUERY_FAILED",
				"The database query could not be completed",
			);
		}
		const chunks = singleChunk(result.stdout);
		return secured.engine === "postgres"
			? parsePostgresCsvOutput(chunks, query)
			: parseMysqlBatchOutput(chunks, query);
	}

	private secureProfile(profile: GatewayProfile): GatewayProfile {
		const executable = this.inspectFile(profile.executable);
		const credentials = this.inspectFile(profile.credentialsFile);
		const currentUid = process.getuid?.();
		if (
			!executable.isFile ||
			executable.uid !== 0 ||
			(executable.mode & 0o022) !== 0 ||
			!credentials.isFile ||
			(currentUid !== undefined && credentials.uid !== currentUid) ||
			(credentials.mode & 0o077) !== 0
		) {
			throw new DatabaseAccessError(
				"GATEWAY_UNAVAILABLE",
				"The database gateway profile is unavailable",
			);
		}
		return {
			...profile,
			executable: executable.canonicalPath,
			credentialsFile: credentials.canonicalPath,
		};
	}

	private commandInvocation(
		profile: GatewayProfile,
		command: string,
		signal?: AbortSignal,
	): ProcessInvocation {
		const common = {
			timeoutMs: profile.limits.queryTimeoutMs + 5_000,
			maxStdoutBytes: 65_536,
			maxStderrBytes: 4_096,
			signal,
			timeoutCode: "QUERY_TIMEOUT" as const,
			spawnErrorCode: "REMOTE_CLIENT_MISSING" as const,
			shell: false as const,
		};
		if (profile.engine === "postgres") {
			return {
				...common,
				file: profile.executable,
				args: [
					"--no-psqlrc",
					"--csv",
					"--quiet",
					"--set=ON_ERROR_STOP=1",
					...(profile.host ? [`--host=${profile.host}`] : []),
					...(profile.port ? [`--port=${profile.port}`] : []),
					`--username=${profile.user}`,
					`--dbname=${profile.database}`,
					`--command=${command}`,
				],
				env: {
					LANG: "C.UTF-8",
					LC_ALL: "C.UTF-8",
					PGPASSFILE: profile.credentialsFile,
				},
			};
		}
		return {
			...common,
			file: profile.executable,
			args: [
				`--defaults-extra-file=${profile.credentialsFile}`,
				"--batch",
				"--raw",
				"--column-names",
				"--skip-reconnect",
				"--binary-mode",
				"--named-commands=FALSE",
				...(profile.host ? [`--host=${profile.host}`] : []),
				...(profile.port ? [`--port=${profile.port}`] : []),
				`--user=${profile.user}`,
				`--database=${profile.database}`,
				`--execute=${command}`,
			],
			env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
		};
	}
}

function parsePostgresPreflight(bytes: Uint8Array): PostgresPrivilegePreflight {
	const lines = decodeUtf8(bytes).trimEnd().split(/\r?\n/);
	const headers = lines[0]?.split(",");
	const values = lines[1]?.split(",");
	if (
		!headers ||
		!values ||
		headers.length !== values.length ||
		lines.length !== 2
	) {
		privilegeFailed();
	}
	const record = Object.fromEntries(
		headers.map((header, index) => [header, values[index]]),
	);
	return {
		currentRole: required(record, "currentRole"),
		isSuperuser: pgBoolean(record, "isSuperuser"),
		canCreateDb: pgBoolean(record, "canCreateDb"),
		canCreateRole: pgBoolean(record, "canCreateRole"),
		isReplication: pgBoolean(record, "isReplication"),
		canBypassRls: pgBoolean(record, "canBypassRls"),
		membershipCount: pgInteger(record, "membershipCount"),
		ownedObjectCount: pgInteger(record, "ownedObjectCount"),
		hasDatabaseCreate: pgBoolean(record, "hasDatabaseCreate"),
		hasDatabaseTemp: pgBoolean(record, "hasDatabaseTemp"),
		hasSchemaCreate: pgBoolean(record, "hasSchemaCreate"),
		hasTableWrite: pgBoolean(record, "hasTableWrite"),
		hasSequenceMutation: pgBoolean(record, "hasSequenceMutation"),
		hasUserRoutineExecute: pgBoolean(record, "hasUserRoutineExecute"),
		deadlineSupported: pgBoolean(record, "deadlineSupported"),
	};
}

function parseMysqlLines(bytes: Uint8Array): string[] {
	return decodeUtf8(bytes).trimEnd().split(/\r?\n/);
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		privilegeFailed();
	}
}

function required(
	record: Record<string, string | undefined>,
	key: string,
): string {
	const value = record[key];
	if (!value) privilegeFailed();
	return value;
}

function pgBoolean(
	record: Record<string, string | undefined>,
	key: string,
): boolean {
	const value = required(record, key);
	if (value !== "t" && value !== "f") privilegeFailed();
	return value === "t";
}

function pgInteger(
	record: Record<string, string | undefined>,
	key: string,
): number {
	const value = required(record, key);
	if (!/^\d+$/.test(value)) privilegeFailed();
	return Number(value);
}

async function* singleChunk(bytes: Uint8Array): AsyncGenerator<Uint8Array> {
	yield bytes;
}

function defaultInspectFile(path: string): InspectedGatewayFile {
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
		throw new DatabaseAccessError(
			"GATEWAY_UNAVAILABLE",
			"The database gateway profile is unavailable",
		);
	}
}

function privilegeFailed(): never {
	throw new DatabaseAccessError(
		"PRIVILEGE_CHECK_FAILED",
		"The configured database role is not strictly read-only",
	);
}
