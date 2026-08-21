import { describe, expect, it } from "vitest";
import { loadGatewayProfile, parseGatewayProfileFile } from "../src/index.js";

const file = {
	version: 1,
	profiles: {
		"payroll-production": {
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
		},
	},
};

describe("gateway profile", () => {
	it("parses a fixed profile and adds its immutable id", () => {
		expect(parseGatewayProfileFile(file, "payroll-production")).toEqual({
			id: "payroll-production",
			...file.profiles["payroll-production"],
		});
	});

	it("rejects missing, unsafe, relative, or version-skewed profiles", () => {
		expect(() => parseGatewayProfileFile(file, "missing")).toThrow();
		expect(() =>
			parseGatewayProfileFile({ ...file, version: 2 }, "payroll-production"),
		).toThrow();
		expect(() =>
			parseGatewayProfileFile(
				{
					...file,
					profiles: {
						"payroll-production": {
							...file.profiles["payroll-production"],
							executable: "psql",
						},
					},
				},
				"payroll-production",
			),
		).toThrow();
	});

	it("requires a canonical root-owned regular profile that is not writable by group/other", () => {
		const dependencies = {
			realpath: () => "/etc/cyrus/database-gateway.json",
			stat: () => ({ isFile: () => true, uid: 0, mode: 0o100644 }),
			readFile: () => JSON.stringify(file),
		};
		expect(
			loadGatewayProfile(
				"/etc/cyrus/database-gateway.json",
				"payroll-production",
				dependencies,
			),
		).toEqual({
			id: "payroll-production",
			...file.profiles["payroll-production"],
		});

		for (const stat of [
			{ isFile: () => false, uid: 0, mode: 0o100644 },
			{ isFile: () => true, uid: 501, mode: 0o100644 },
			{ isFile: () => true, uid: 0, mode: 0o100666 },
		]) {
			expect(() =>
				loadGatewayProfile(
					"/etc/cyrus/database-gateway.json",
					"payroll-production",
					{
						...dependencies,
						stat: () => stat,
					},
				),
			).toThrowError(expect.objectContaining({ code: "GATEWAY_UNAVAILABLE" }));
		}
	});
});
