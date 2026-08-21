import {
	decodeGatewayResponse,
	encodeGatewayRequest,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayProfile,
	MAX_GATEWAY_REQUEST_BYTES,
} from "cyrus-ssh-database";
import { describe, expect, it, vi } from "vitest";
import { DatabaseGatewayCommand } from "./DatabaseGatewayCommand.js";

const profile: GatewayProfile = {
	id: "payroll-production",
	engine: "postgres",
	database: "payroll",
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

async function* input(...chunks: Uint8Array[]) {
	for (const chunk of chunks) yield chunk;
}

describe("DatabaseGatewayCommand", () => {
	it("loads the fixed profile and writes exactly one gateway response", async () => {
		const request = encodeGatewayRequest({
			version: GATEWAY_PROTOCOL_VERSION,
			profile: profile.id,
			engine: profile.engine,
			sql: "SELECT 1 AS value",
			limits: profile.limits,
		});
		const writes: Buffer[] = [];
		const loadProfile = vi.fn().mockReturnValue(profile);
		const executor = {
			preflight: vi.fn().mockResolvedValue(undefined),
			query: vi.fn().mockResolvedValue({
				output: "value\n1\n",
				rowCount: 1,
				byteCount: 8,
				truncated: false,
			}),
		};
		const command = new DatabaseGatewayCommand({
			stdin: input(request.subarray(0, 8), request.subarray(8)),
			writeStdout: (chunk) => writes.push(Buffer.from(chunk)),
			loadProfile,
			createExecutor: () => executor,
		});

		await expect(
			command.execute({
				configPath: "/etc/cyrus/database-gateway.json",
				profileId: "payroll-production",
			}),
		).resolves.toBe(0);
		expect(loadProfile).toHaveBeenCalledWith(
			"/etc/cyrus/database-gateway.json",
			"payroll-production",
		);
		expect(writes).toHaveLength(1);
		expect(decodeGatewayResponse(writes[0] as Buffer, 32_768)).toEqual({
			format: "csv",
			output: "value\n1\n",
			rowCount: 1,
			byteCount: 8,
			truncated: false,
		});
	});

	it("rejects an oversized raw frame before profile/query work", async () => {
		const writes: Buffer[] = [];
		const loadProfile = vi.fn();
		const command = new DatabaseGatewayCommand({
			stdin: input(Buffer.alloc(MAX_GATEWAY_REQUEST_BYTES + 1, 0x78)),
			writeStdout: (chunk) => writes.push(Buffer.from(chunk)),
			loadProfile,
			createExecutor: vi.fn(),
		});

		await expect(
			command.execute({
				configPath: "/etc/cyrus/gateway.json",
				profileId: "payroll",
			}),
		).resolves.toBe(0);
		expect(loadProfile).not.toHaveBeenCalled();
		expect(() =>
			decodeGatewayResponse(writes[0] as Buffer, 32_768),
		).toThrowError(expect.objectContaining({ code: "QUERY_REJECTED" }));
	});

	it("ignores SSH_ORIGINAL_COMMAND and emits no secret error text", async () => {
		const previous = process.env.SSH_ORIGINAL_COMMAND;
		process.env.SSH_ORIGINAL_COMMAND = "cat /etc/passwd; password=secret";
		const writes: Buffer[] = [];
		try {
			const command = new DatabaseGatewayCommand({
				stdin: input(Buffer.from("{}")),
				writeStdout: (chunk) => writes.push(Buffer.from(chunk)),
				loadProfile: () => {
					throw new Error("password=secret");
				},
				createExecutor: vi.fn(),
			});
			await command.execute({
				configPath: "/etc/cyrus/gateway.json",
				profileId: "payroll",
			});
			expect(Buffer.concat(writes).toString()).not.toContain("secret");
			expect(Buffer.concat(writes).toString()).not.toContain("passwd");
		} finally {
			if (previous === undefined) delete process.env.SSH_ORIGINAL_COMMAND;
			else process.env.SSH_ORIGINAL_COMMAND = previous;
		}
	});
});
