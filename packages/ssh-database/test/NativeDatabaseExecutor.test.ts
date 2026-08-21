import { describe, expect, it, vi } from "vitest";
import {
	type GatewayProfile,
	NativeDatabaseExecutor,
	POSTGRES_PRIVILEGE_PREFLIGHT_SQL,
} from "../src/index.js";

const postgresProfile: GatewayProfile = {
	id: "payroll-production",
	engine: "postgres",
	database: "payroll",
	host: "/var/run/postgresql",
	port: 5432,
	user: "cyrus_payroll_ro",
	expectedRole: "cyrus_payroll_ro",
	executable: "/usr/bin/psql",
	credentialsFile: "/var/lib/cyrus-db/.pgpass",
	limits: {
		queryTimeoutMs: 15_000,
		maxSqlBytes: 16_384,
		maxRows: 100,
		maxOutputBytes: 32_768,
	},
};

const safeFiles = (path: string) => ({
	canonicalPath: path,
	isFile: true,
	uid: path.startsWith("/usr/") ? 0 : (process.getuid?.() ?? 0),
	mode: path.startsWith("/usr/") ? 0o100755 : 0o100600,
});

describe("NativeDatabaseExecutor", () => {
	it("runs and validates PostgreSQL preflight before query execution", async () => {
		const header = [
			"currentRole",
			"isSuperuser",
			"canCreateDb",
			"canCreateRole",
			"isReplication",
			"canBypassRls",
			"membershipCount",
			"ownedObjectCount",
			"hasDatabaseCreate",
			"hasDatabaseTemp",
			"hasSchemaCreate",
			"hasTableWrite",
			"hasSequenceMutation",
			"hasUserRoutineExecute",
			"deadlineSupported",
		].join(",");
		const row = "cyrus_payroll_ro,f,f,f,f,f,0,0,f,f,f,f,f,f,t";
		const run = vi.fn().mockResolvedValue({
			stdout: Buffer.from(`${header}\n${row}\n`),
			stderr: Buffer.alloc(0),
			exitCode: 0,
		});
		const executor = new NativeDatabaseExecutor({
			run,
			inspectFile: safeFiles,
		});

		await expect(executor.preflight(postgresProfile)).resolves.toBeUndefined();
		expect(run.mock.calls[0]?.[0].args).toContain(
			`--command=${POSTGRES_PRIVILEGE_PREFLIGHT_SQL}`,
		);
	});

	it("runs MySQL identity/deadline and SHOW GRANTS checks", async () => {
		const profile: GatewayProfile = {
			...postgresProfile,
			engine: "mysql",
			executable: "/usr/bin/mysql",
			credentialsFile: "/var/lib/cyrus-db/mysql.cnf",
			expectedRole: "cyrus_payroll_ro@localhost",
		};
		const run = vi
			.fn()
			.mockResolvedValueOnce({
				stdout: Buffer.from(
					"currentAccount\tdeadlineSupported\ncyrus_payroll_ro@localhost\t1\n",
				),
				stderr: Buffer.alloc(0),
				exitCode: 0,
			})
			.mockResolvedValueOnce({
				stdout: Buffer.from(
					"Grants for cyrus_payroll_ro@localhost\nGRANT USAGE ON *.* TO `cyrus_payroll_ro`@`localhost`\nGRANT SELECT, SHOW VIEW ON `payroll`.* TO `cyrus_payroll_ro`@`localhost`\n",
				),
				stderr: Buffer.alloc(0),
				exitCode: 0,
			});
		const executor = new NativeDatabaseExecutor({
			run,
			inspectFile: safeFiles,
		});

		await expect(executor.preflight(profile)).resolves.toBeUndefined();
		expect(run).toHaveBeenCalledTimes(2);
		expect(run.mock.calls[1]?.[0].args).toContain(
			"--execute=SHOW GRANTS FOR CURRENT_USER",
		);
	});

	it("runs the fixed query invocation and incrementally frames output", async () => {
		const run = vi.fn().mockResolvedValue({
			stdout: Buffer.from("id\n1\n2\n3\n"),
			stderr: Buffer.alloc(0),
			exitCode: 0,
		});
		const executor = new NativeDatabaseExecutor({
			run,
			inspectFile: safeFiles,
		});

		await expect(
			executor.query(postgresProfile, {
				normalizedSql: "SELECT id FROM employees",
				boundedSql:
					"SELECT * FROM (SELECT id FROM employees) AS cyrus_bounded LIMIT 3",
				queryTimeoutMs: 15_000,
				maxRows: 2,
				maxOutputBytes: 1024,
			}),
		).resolves.toEqual({
			output: "id\n1\n2\n",
			rowCount: 2,
			byteCount: 7,
			truncated: true,
		});
	});

	it("rejects unsafe executable and credential files before spawning", async () => {
		const run = vi.fn();
		const executor = new NativeDatabaseExecutor({
			run,
			inspectFile: (path) => ({ ...safeFiles(path), mode: 0o100666 }),
		});
		await expect(executor.preflight(postgresProfile)).rejects.toMatchObject({
			code: "GATEWAY_UNAVAILABLE",
		});
		expect(run).not.toHaveBeenCalled();
	});
});
