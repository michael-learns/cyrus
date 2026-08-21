import { describe, expect, it } from "vitest";
import {
	assertMysqlPrivilegePreflight,
	assertPostgresPrivilegePreflight,
	POSTGRES_PRIVILEGE_PREFLIGHT_SQL,
} from "../src/index.js";

const postgresSafe = {
	currentRole: "cyrus_payroll_ro",
	isSuperuser: false,
	canCreateDb: false,
	canCreateRole: false,
	isReplication: false,
	canBypassRls: false,
	membershipCount: 0,
	ownedObjectCount: 0,
	hasDatabaseCreate: false,
	hasDatabaseTemp: false,
	hasSchemaCreate: false,
	hasTableWrite: false,
	hasSequenceMutation: false,
	hasUserRoutineExecute: false,
	deadlineSupported: true,
};

describe("database privilege preflight", () => {
	it("accepts only the exact dedicated PostgreSQL role with no dangerous capability", () => {
		expect(() =>
			assertPostgresPrivilegePreflight(postgresSafe, "cyrus_payroll_ro"),
		).not.toThrow();
		expect(POSTGRES_PRIVILEGE_PREFLIGHT_SQL).toContain("pg_auth_members");
		expect(POSTGRES_PRIVILEGE_PREFLIGHT_SQL).toContain("pg_class");
		expect(POSTGRES_PRIVILEGE_PREFLIGHT_SQL).toContain(
			"has_function_privilege",
		);
	});

	it.each([
		["currentRole", "other_role"],
		["isSuperuser", true],
		["canCreateDb", true],
		["canCreateRole", true],
		["isReplication", true],
		["canBypassRls", true],
		["membershipCount", 1],
		["ownedObjectCount", 1],
		["hasDatabaseCreate", true],
		["hasDatabaseTemp", true],
		["hasSchemaCreate", true],
		["hasTableWrite", true],
		["hasSequenceMutation", true],
		["hasUserRoutineExecute", true],
		["deadlineSupported", false],
	] as const)("rejects unsafe PostgreSQL preflight field %s", (field, value) => {
		expect(() =>
			assertPostgresPrivilegePreflight(
				{ ...postgresSafe, [field]: value },
				"cyrus_payroll_ro",
			),
		).toThrowError(expect.objectContaining({ code: "PRIVILEGE_CHECK_FAILED" }));
	});

	it("accepts only USAGE plus database/table SELECT and SHOW VIEW for MySQL", () => {
		expect(() =>
			assertMysqlPrivilegePreflight(
				{
					currentAccount: "cyrus_payroll_ro@localhost",
					deadlineSupported: true,
					grants: [
						"GRANT USAGE ON *.* TO `cyrus_payroll_ro`@`localhost`",
						"GRANT SELECT, SHOW VIEW ON `payroll`.* TO `cyrus_payroll_ro`@`localhost`",
					],
				},
				"cyrus_payroll_ro@localhost",
				"payroll",
			),
		).not.toThrow();
	});

	it("rejects MySQL SELECT grants outside the configured database", () => {
		expect(() =>
			assertMysqlPrivilegePreflight(
				{
					currentAccount: "cyrus_payroll_ro@localhost",
					deadlineSupported: true,
					grants: [
						"GRANT SELECT ON `payroll`.* TO `cyrus_payroll_ro`@`localhost`",
						"GRANT SELECT ON `other_database`.`employees` TO `cyrus_payroll_ro`@`localhost`",
					],
				},
				"cyrus_payroll_ro@localhost",
				"payroll",
			),
		).toThrowError(expect.objectContaining({ code: "PRIVILEGE_CHECK_FAILED" }));
	});

	it.each([
		"GRANT ALL PRIVILEGES ON *.* TO `cyrus_payroll_ro`@`localhost`",
		"GRANT SELECT, FILE ON *.* TO `cyrus_payroll_ro`@`localhost`",
		"GRANT SELECT, INSERT ON `payroll`.* TO `cyrus_payroll_ro`@`localhost`",
		"GRANT EXECUTE ON PROCEDURE `payroll`.`refresh` TO `cyrus_payroll_ro`@`localhost`",
		"GRANT `admin_role`@`%` TO `cyrus_payroll_ro`@`localhost`",
	])("rejects unsafe MySQL grant: %s", (grant) => {
		expect(() =>
			assertMysqlPrivilegePreflight(
				{
					currentAccount: "cyrus_payroll_ro@localhost",
					deadlineSupported: true,
					grants: [grant],
				},
				"cyrus_payroll_ro@localhost",
				"payroll",
			),
		).toThrowError(expect.objectContaining({ code: "PRIVILEGE_CHECK_FAILED" }));
	});

	it("rejects MySQL account mismatch and missing deadline support", () => {
		expect(() =>
			assertMysqlPrivilegePreflight(
				{
					currentAccount: "other@localhost",
					deadlineSupported: true,
					grants: [],
				},
				"cyrus_payroll_ro@localhost",
				"payroll",
			),
		).toThrow();
		expect(() =>
			assertMysqlPrivilegePreflight(
				{
					currentAccount: "cyrus_payroll_ro@localhost",
					deadlineSupported: false,
					grants: [],
				},
				"cyrus_payroll_ro@localhost",
				"payroll",
			),
		).toThrow();
	});
});
