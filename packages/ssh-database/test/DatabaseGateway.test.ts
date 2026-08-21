import { describe, expect, it, vi } from "vitest";
import {
	DatabaseGateway,
	decodeGatewayResponse,
	encodeGatewayRequest,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayProfile,
} from "../src/index.js";

const profile: GatewayProfile = {
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

describe("DatabaseGateway", () => {
	it("revalidates, preflights, runs a bounded query, and base64-frames output", async () => {
		const executor = {
			preflight: vi.fn().mockResolvedValue(undefined),
			query: vi.fn().mockResolvedValue({
				output: "id,name\n1,Ada\n",
				rowCount: 1,
				byteCount: 14,
				truncated: false,
			}),
		};
		const gateway = new DatabaseGateway(profile, executor);
		const response = await gateway.handle(
			encodeGatewayRequest({
				version: GATEWAY_PROTOCOL_VERSION,
				profile: profile.id,
				engine: profile.engine,
				sql: "SELECT id, name FROM employees",
				limits: profile.limits,
			}),
		);

		expect(executor.preflight).toHaveBeenCalledWith(profile, undefined);
		expect(executor.query).toHaveBeenCalledWith(
			profile,
			expect.objectContaining({
				boundedSql:
					"SELECT * FROM (SELECT id, name FROM employees) AS cyrus_bounded LIMIT 101",
			}),
			undefined,
		);
		expect(decodeGatewayResponse(response, 32_768)).toEqual({
			format: "csv",
			output: "id,name\n1,Ada\n",
			rowCount: 1,
			byteCount: 14,
			truncated: false,
		});
	});

	it("uses the stricter configured limit and rejects before preflight", async () => {
		const executor = { preflight: vi.fn(), query: vi.fn() };
		const gateway = new DatabaseGateway(profile, executor);
		const response = await gateway.handle(
			encodeGatewayRequest({
				version: GATEWAY_PROTOCOL_VERSION,
				profile: profile.id,
				engine: profile.engine,
				sql: "DELETE FROM employees",
				limits: profile.limits,
			}),
		);

		expect(executor.preflight).not.toHaveBeenCalled();
		expect(() => decodeGatewayResponse(response, 32_768)).toThrowError(
			expect.objectContaining({ code: "QUERY_REJECTED" }),
		);
	});

	it("returns only stable safe failures when preflight or query fails", async () => {
		const gateway = new DatabaseGateway(profile, {
			preflight: vi
				.fn()
				.mockRejectedValue(new Error("password=secret host=db.internal")),
			query: vi.fn(),
		});
		const response = await gateway.handle(
			encodeGatewayRequest({
				version: GATEWAY_PROTOCOL_VERSION,
				profile: profile.id,
				engine: profile.engine,
				sql: "SELECT 1",
				limits: profile.limits,
			}),
		);
		expect(response.toString()).not.toContain("secret");
		expect(response.toString()).not.toContain("db.internal");
		expect(() => decodeGatewayResponse(response, 32_768)).toThrowError(
			expect.objectContaining({ code: "QUERY_FAILED" }),
		);
	});
});
