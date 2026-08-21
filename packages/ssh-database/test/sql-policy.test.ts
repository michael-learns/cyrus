import { describe, expect, it } from "vitest";
import { assertNoClientCommands, validateAndBoundSql } from "../src/index.js";

function validate(engine: "postgres" | "mysql", sql: string) {
	return validateAndBoundSql({
		engine,
		sql,
		maxSqlBytes: 65_536,
		maxRows: 100,
	});
}

describe("read-only SQL policy", () => {
	it.each([
		"postgres",
		"mysql",
	] as const)("accepts SELECT and read-only CTE for %s and applies a hard row bound", (engine) => {
		expect(validate(engine, "SELECT id, name FROM employees").boundedSql).toBe(
			"SELECT * FROM (SELECT id, name FROM employees) AS cyrus_bounded LIMIT 101",
		);
		expect(
			validate(
				engine,
				"WITH active AS (SELECT id FROM employees WHERE active = 1) SELECT id FROM active",
			).boundedSql,
		).toContain("AS cyrus_bounded LIMIT 101");
	});

	it("does not treat quoted text or PostgreSQL dollar strings as commands", () => {
		expect(() =>
			validate(
				"postgres",
				"SELECT 'DELETE FROM users', \"DROP\", $$UPDATE employees$$ AS note /* INSERT */",
			),
		).not.toThrow();
	});

	it.each([
		"SELECT 1; SELECT 2",
		"INSERT INTO employees(id) VALUES (1)",
		"UPDATE employees SET active = false",
		"DELETE FROM employees",
		"CREATE TABLE stolen(id int)",
		"DROP TABLE employees",
		"GRANT SELECT ON employees TO public",
		"BEGIN",
		"COPY employees TO '/tmp/employees'",
		"WITH changed AS (DELETE FROM employees RETURNING id) SELECT id FROM changed",
		"SELECT id INTO copied_employees FROM employees",
		"SELECT * FROM employees FOR UPDATE",
		"CALL refresh_payroll()",
		"EXPLAIN SELECT * FROM employees",
		"SHOW TABLES",
	])("rejects unsupported or mutating PostgreSQL: %s", (sql) => {
		expect(() => validate("postgres", sql)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it.each([
		"SELECT * FROM employees INTO OUTFILE '/tmp/employees'",
		"SELECT * FROM employees INTO DUMPFILE '/tmp/employees'",
		"SELECT * FROM employees FOR UPDATE",
		"DO SLEEP(1)",
		"SHOW DATABASES",
	])("rejects unsupported or mutating MySQL: %s", (sql) => {
		expect(() => validate("mysql", sql)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it.each([
		"SELECT pg_advisory_lock(1)",
		"SELECT pg_try_advisory_lock(1)",
		"SELECT pg_notify('channel', 'payload')",
		"SELECT pg_sleep(1)",
		"SELECT pg_read_file('/etc/passwd')",
		"SELECT pg_read_binary_file('/etc/passwd')",
		"SELECT pg_ls_dir('/')",
		"SELECT pg_stat_file('/etc/passwd')",
		"SELECT lo_import('/tmp/x')",
		"SELECT lo_export(1, '/tmp/x')",
		"SELECT nextval('employee_id_seq')",
		"SELECT setval('employee_id_seq', 9)",
		"SELECT dblink_connect('host=elsewhere')",
		"SELECT custom_extension_function(id) FROM employees",
	])("rejects side-effecting or unreviewed PostgreSQL functions: %s", (sql) => {
		expect(() => validate("postgres", sql)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it.each([
		"SELECT GET_LOCK('payroll', 1)",
		"SELECT RELEASE_LOCK('payroll')",
		"SELECT RELEASE_ALL_LOCKS()",
		"SELECT SLEEP(1)",
		"SELECT BENCHMARK(1000, SHA1('x'))",
		"SELECT LOAD_FILE('/etc/passwd')",
		"SELECT sys_exec('id')",
		"SELECT sys_eval('id')",
		"SELECT custom_udf(id) FROM employees",
	])("rejects side-effecting or unreviewed MySQL functions: %s", (sql) => {
		expect(() => validate("mysql", sql)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it("allows a deliberately small reviewed built-in function set", () => {
		expect(() =>
			validate(
				"postgres",
				"SELECT count(*), lower(name) FROM employees GROUP BY name",
			),
		).not.toThrow();
		expect(() =>
			validate(
				"mysql",
				"SELECT COUNT(*), LOWER(name) FROM employees GROUP BY name",
			),
		).not.toThrow();
	});

	it.each([
		["postgres", "\\! id"],
		["postgres", "\\copy employees to '/tmp/x'"],
		["postgres", "\\gexec"],
		["postgres", "\\i /tmp/script.sql"],
		["postgres", "SELECT :'variable'"],
		["mysql", "system id"],
		["mysql", "source /tmp/script.sql"],
		["mysql", "tee /tmp/output"],
		["mysql", "pager less"],
		["mysql", "delimiter $$"],
		["mysql", "charset latin1"],
		["mysql", "SELECT /*!50000 SLEEP(1) */ 1"],
		["mysql", "SELECT /*+ SET_VAR(max_execution_time=0) */ 1"],
	] as const)("rejects %s client command input: %s", (engine, sql) => {
		expect(() => assertNoClientCommands(engine, sql)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it("enforces SQL size and parser-complexity ceilings", () => {
		expect(() =>
			validateAndBoundSql({
				engine: "postgres",
				sql: `SELECT '${"x".repeat(1024)}'`,
				maxSqlBytes: 128,
				maxRows: 100,
			}),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));

		const columns = Array.from(
			{ length: 513 },
			(_, index) => `${index} AS c${index}`,
		).join(", ");
		expect(() => validate("postgres", `SELECT ${columns}`)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);

		const ctes = Array.from(
			{ length: 33 },
			(_, index) => `c${index} AS (SELECT ${index} AS n)`,
		).join(", ");
		expect(() =>
			validate("postgres", `WITH ${ctes} SELECT n FROM c32`),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));

		const excessiveTokens = Array.from({ length: 4_100 }, () => "1").join(
			" + ",
		);
		expect(() =>
			validate("postgres", `SELECT ${excessiveTokens}`),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));

		const excessiveDepth = `${"SELECT * FROM (".repeat(65)}SELECT 1${") AS nested".repeat(65)}`;
		expect(() => validate("postgres", excessiveDepth)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});
});
