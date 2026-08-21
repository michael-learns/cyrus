import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import {
	createCyrusToolsServer,
	SENSITIVE_DATABASE_TOOL_NAMES,
} from "../../../src/tools/cyrus-tools/index.js";

async function connect(database: {
	connectionsList: () => Promise<unknown>;
	query: (input: { connectionId: string; sql: string }) => Promise<unknown>;
}) {
	const server = createCyrusToolsServer(undefined, { database });
	const client = new Client({ name: "database-tool-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

describe("database MCP tools", () => {
	it("registers exact schemas only when authorized callbacks are supplied", async () => {
		const { client } = await connect({
			connectionsList: vi.fn(),
			query: vi.fn(),
		});
		const tools = await client.listTools();
		const databaseTools = tools.tools.filter((tool) =>
			tool.name.startsWith("database_"),
		);

		expect(databaseTools.map((tool) => tool.name)).toEqual([
			"database_connections_list",
			"database_query",
		]);
		expect(databaseTools[0]?.inputSchema).toEqual({
			type: "object",
			properties: {},
			additionalProperties: false,
			$schema: "http://json-schema.org/draft-07/schema#",
		});
		expect(databaseTools[1]?.inputSchema).toEqual(
			expect.objectContaining({
				type: "object",
				required: ["connectionId", "sql"],
				additionalProperties: false,
				properties: {
					connectionId: expect.objectContaining({ type: "string" }),
					sql: expect.objectContaining({ type: "string", maxLength: 65_536 }),
				},
			}),
		);
		expect(SENSITIVE_DATABASE_TOOL_NAMES).toEqual([
			"database_connections_list",
			"database_query",
		]);
	});

	it("omits both tools when database callbacks are absent", () => {
		const server = createCyrusToolsServer();
		const names = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);
		expect(names).not.toContain("database_connections_list");
		expect(names).not.toContain("database_query");
	});

	it("invokes atomic callbacks without accepting authority or SSH fields", async () => {
		const connectionsList = vi.fn().mockResolvedValue({
			connections: [
				{
					id: "payroll-production",
					name: "Payroll production",
					engine: "postgres",
					repositories: ["payroll"],
				},
			],
		});
		const query = vi.fn().mockResolvedValue({
			connectionId: "payroll-production",
			engine: "postgres",
			format: "csv",
			output: "id\n1\n",
			truncated: false,
		});
		const { client } = await connect({ connectionsList, query });

		const listed = await client.callTool({
			name: "database_connections_list",
			arguments: {},
		});
		expect(JSON.parse((listed.content[0] as { text: string }).text)).toEqual({
			success: true,
			result: await connectionsList.mock.results[0]?.value,
		});

		await client.callTool({
			name: "database_query",
			arguments: { connectionId: "payroll-production", sql: "SELECT 1" },
		});
		expect(query).toHaveBeenCalledWith({
			connectionId: "payroll-production",
			sql: "SELECT 1",
		});

		const rejected = await client.callTool({
			name: "database_query",
			arguments: {
				connectionId: "payroll-production",
				sql: "SELECT 1",
				channelId: "C-FAKE",
				host: "attacker",
				command: "id",
			},
		});
		expect(rejected.isError).toBe(true);
		expect(query).toHaveBeenCalledTimes(1);
	});

	it("returns stable failures without leaking unexpected callback errors", async () => {
		const { client } = await connect({
			connectionsList: vi.fn().mockRejectedValue(new Error("token=secret")),
			query: vi.fn().mockRejectedValue({
				code: "QUERY_REJECTED",
				message: "Only a bounded read-only query is allowed",
			}),
		});
		const unexpected = await client.callTool({
			name: "database_connections_list",
			arguments: {},
		});
		const expected = await client.callTool({
			name: "database_query",
			arguments: {
				connectionId: "payroll-production",
				sql: "DELETE FROM employees",
			},
		});
		expect((unexpected.content[0] as { text: string }).text).not.toContain(
			"secret",
		);
		expect(
			JSON.parse((unexpected.content[0] as { text: string }).text),
		).toEqual({
			success: false,
			error: {
				code: "QUERY_FAILED",
				message: "The database request could not be completed",
			},
		});
		expect(JSON.parse((expected.content[0] as { text: string }).text)).toEqual({
			success: false,
			error: {
				code: "QUERY_REJECTED",
				message: "Only a bounded read-only query is allowed",
			},
		});
	});
});
