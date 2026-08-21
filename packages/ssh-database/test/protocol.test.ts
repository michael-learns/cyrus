import { describe, expect, it } from "vitest";
import {
	DatabaseAccessError,
	decodeGatewayRequest,
	decodeGatewayResponse,
	encodeGatewayResponse,
	GATEWAY_PROTOCOL_VERSION,
	MAX_GATEWAY_REQUEST_BYTES,
} from "../src/index.js";

const request = {
	version: GATEWAY_PROTOCOL_VERSION,
	profile: "payroll-production",
	engine: "postgres" as const,
	sql: "SELECT id FROM employees",
	limits: {
		queryTimeoutMs: 15_000,
		maxSqlBytes: 16_384,
		maxRows: 100,
		maxOutputBytes: 32_768,
	},
};

describe("SSH database gateway protocol", () => {
	it("decodes a bounded versioned request", () => {
		expect(
			decodeGatewayRequest(Buffer.from(JSON.stringify(request)), {
				expectedProfile: "payroll-production",
				expectedEngine: "postgres",
			}),
		).toEqual(request);
	});

	it("caps the raw request frame before JSON parsing", () => {
		const frame = Buffer.alloc(MAX_GATEWAY_REQUEST_BYTES + 1, 0x7b);
		expect(() =>
			decodeGatewayRequest(frame, {
				expectedProfile: "payroll-production",
				expectedEngine: "postgres",
			}),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));
	});

	it("checks extracted SQL bytes before SQL parsing", () => {
		const frame = Buffer.from(
			JSON.stringify({ ...request, sql: `SELECT '${"x".repeat(16_385)}'` }),
		);
		expect(() =>
			decodeGatewayRequest(frame, {
				expectedProfile: "payroll-production",
				expectedEngine: "postgres",
			}),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));
	});

	it.each([
		{ version: 999 },
		{ profile: "other-profile" },
		{ engine: "mysql" },
	])("rejects mismatched protocol identity", (override) => {
		expect(() =>
			decodeGatewayRequest(
				Buffer.from(JSON.stringify({ ...request, ...override })),
				{
					expectedProfile: "payroll-production",
					expectedEngine: "postgres",
				},
			),
		).toThrow(DatabaseAccessError);
	});

	it("base64-frames and decodes a bounded UTF-8 success response", () => {
		const frame = encodeGatewayResponse({
			version: GATEWAY_PROTOCOL_VERSION,
			success: true,
			format: "csv",
			output: "id,name\n1,Ada\n",
			truncated: false,
			rowCount: 1,
			byteCount: 14,
		});
		expect(JSON.parse(frame.toString("utf8"))).toEqual(
			expect.objectContaining({
				outputBase64: Buffer.from("id,name\n1,Ada\n").toString("base64"),
			}),
		);
		expect(decodeGatewayResponse(frame, 32_768)).toEqual({
			format: "csv",
			output: "id,name\n1,Ada\n",
			truncated: false,
			rowCount: 1,
			byteCount: 14,
		});
	});

	it("rejects oversized framing and invalid UTF-8 output", () => {
		const oversized = Buffer.from(
			JSON.stringify({ outputBase64: "x".repeat(1000) }),
		);
		expect(() => decodeGatewayResponse(oversized, 8)).toThrowError(
			expect.objectContaining({ code: "OUTPUT_INVALID" }),
		);

		const invalid = Buffer.from(
			JSON.stringify({
				version: GATEWAY_PROTOCOL_VERSION,
				success: true,
				format: "csv",
				outputBase64: Buffer.from([0xc3, 0x28]).toString("base64"),
				truncated: false,
				rowCount: 0,
				byteCount: 2,
			}),
		);
		expect(() => decodeGatewayResponse(invalid, 32_768)).toThrowError(
			expect.objectContaining({ code: "OUTPUT_INVALID" }),
		);
	});

	it("round-trips only stable safe gateway failures", () => {
		const frame = encodeGatewayResponse({
			version: GATEWAY_PROTOCOL_VERSION,
			success: false,
			error: {
				code: "PRIVILEGE_CHECK_FAILED",
				message: "Database profile is unavailable",
			},
		});
		expect(() => decodeGatewayResponse(frame, 32_768)).toThrowError(
			expect.objectContaining({
				code: "PRIVILEGE_CHECK_FAILED",
				message: "Database profile is unavailable",
			}),
		);
	});
});
