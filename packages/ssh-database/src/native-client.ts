import { isAbsolute } from "node:path";
import type { DatabaseEngine } from "./client-command-scanner.js";
import { DatabaseAccessError } from "./errors.js";

export interface NativeClientInput {
	engine: DatabaseEngine;
	executable: string;
	database: string;
	host?: string;
	port?: number;
	user: string;
	credentialsFile: string;
	boundedSql: string;
	queryTimeoutMs: number;
}

export interface NativeClientInvocation {
	file: string;
	args: string[];
	env: Record<string, string>;
	shell: false;
}

export function buildNativeClientInvocation(
	input: NativeClientInput,
): NativeClientInvocation {
	if (!isAbsolute(input.executable) || !isAbsolute(input.credentialsFile)) {
		throw new DatabaseAccessError(
			"GATEWAY_UNAVAILABLE",
			"The database gateway profile is invalid",
		);
	}
	if (input.engine === "postgres") {
		const batch = `BEGIN READ ONLY;\nSET LOCAL statement_timeout = '${input.queryTimeoutMs}ms';\n${input.boundedSql};\nROLLBACK;`;
		return {
			file: input.executable,
			args: [
				"--no-psqlrc",
				"--csv",
				"--quiet",
				"--set=ON_ERROR_STOP=1",
				...(input.host ? [`--host=${input.host}`] : []),
				...(input.port ? [`--port=${input.port}`] : []),
				`--username=${input.user}`,
				`--dbname=${input.database}`,
				`--command=${batch}`,
			],
			env: {
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				PGPASSFILE: input.credentialsFile,
				PGCONNECT_TIMEOUT: String(
					Math.max(1, Math.ceil(input.queryTimeoutMs / 1_000)),
				),
			},
			shell: false,
		};
	}

	const batch = `SET SESSION MAX_EXECUTION_TIME=${input.queryTimeoutMs};\nSTART TRANSACTION READ ONLY;\n${input.boundedSql};\nROLLBACK;`;
	return {
		file: input.executable,
		args: [
			`--defaults-extra-file=${input.credentialsFile}`,
			"--batch",
			"--raw",
			"--column-names",
			"--skip-reconnect",
			"--binary-mode",
			"--named-commands=FALSE",
			...(input.host ? [`--host=${input.host}`] : []),
			...(input.port ? [`--port=${input.port}`] : []),
			`--user=${input.user}`,
			`--database=${input.database}`,
			`--execute=${batch}`,
		],
		env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
		shell: false,
	};
}
