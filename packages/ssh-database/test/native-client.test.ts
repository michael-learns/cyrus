import { describe, expect, it } from "vitest";
import { buildNativeClientInvocation } from "../src/index.js";

describe("native database client invocation", () => {
	it("keeps the PostgreSQL SELECT last so psql returns its rows", () => {
		const invocation = buildNativeClientInvocation({
			engine: "postgres",
			executable: "/usr/bin/psql",
			database: "payroll",
			host: "/var/run/postgresql",
			port: 5432,
			user: "cyrus_payroll_ro",
			credentialsFile: "/var/lib/cyrus-db/.pgpass",
			boundedSql:
				"SELECT * FROM (SELECT id FROM employees) AS cyrus_bounded LIMIT 101",
			queryTimeoutMs: 15_000,
		});

		expect(invocation).toEqual({
			file: "/usr/bin/psql",
			args: [
				"--no-psqlrc",
				"--csv",
				"--quiet",
				"--set=ON_ERROR_STOP=1",
				"--host=/var/run/postgresql",
				"--port=5432",
				"--username=cyrus_payroll_ro",
				"--dbname=payroll",
				"--command=BEGIN READ ONLY;\nSET LOCAL statement_timeout = '15000ms';\nSELECT * FROM (SELECT id FROM employees) AS cyrus_bounded LIMIT 101;",
			],
			env: {
				LANG: "C.UTF-8",
				LC_ALL: "C.UTF-8",
				PGPASSFILE: "/var/lib/cyrus-db/.pgpass",
				PGCONNECT_TIMEOUT: "15",
			},
			shell: false,
		});
	});

	it("builds a fixed noninteractive MySQL command and read-only batch", () => {
		const invocation = buildNativeClientInvocation({
			engine: "mysql",
			executable: "/usr/bin/mysql",
			database: "payroll",
			host: "127.0.0.1",
			port: 3306,
			user: "cyrus_payroll_ro",
			credentialsFile: "/var/lib/cyrus-db/mysql.cnf",
			boundedSql:
				"SELECT * FROM (SELECT id FROM employees) AS cyrus_bounded LIMIT 101",
			queryTimeoutMs: 15_000,
		});

		expect(invocation).toEqual({
			file: "/usr/bin/mysql",
			args: [
				"--defaults-extra-file=/var/lib/cyrus-db/mysql.cnf",
				"--batch",
				"--raw",
				"--column-names",
				"--skip-reconnect",
				"--binary-mode",
				"--named-commands=FALSE",
				"--host=127.0.0.1",
				"--port=3306",
				"--user=cyrus_payroll_ro",
				"--database=payroll",
				"--execute=SET SESSION MAX_EXECUTION_TIME=15000;\nSTART TRANSACTION READ ONLY;\nSELECT * FROM (SELECT id FROM employees) AS cyrus_bounded LIMIT 101;\nROLLBACK;",
			],
			env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
			shell: false,
		});
	});

	it("never accepts a relative executable or credentials path", () => {
		expect(() =>
			buildNativeClientInvocation({
				engine: "postgres",
				executable: "psql",
				database: "payroll",
				user: "cyrus_ro",
				credentialsFile: ".pgpass",
				boundedSql: "SELECT 1",
				queryTimeoutMs: 1_000,
			}),
		).toThrowError(expect.objectContaining({ code: "GATEWAY_UNAVAILABLE" }));
	});
});
