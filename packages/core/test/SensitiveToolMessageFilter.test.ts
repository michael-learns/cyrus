import { describe, expect, it } from "vitest";
import type { SDKMessage } from "../src/agent-runner-types.js";
import {
	DATABASE_TOOL_PAYLOAD_REDACTION,
	isSensitiveDatabaseToolName,
	SensitiveToolMessageFilter,
} from "../src/SensitiveToolMessageFilter.js";

function assistant(name: string, id: string, input: unknown): SDKMessage {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [{ type: "tool_use", id, name, input }],
		},
		parent_tool_use_id: null,
		session_id: "provider-session",
		uuid: `assistant-${id}`,
	} as SDKMessage;
}

function result(id: string, content: string): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [{ type: "tool_result", tool_use_id: id, content }],
		},
		parent_tool_use_id: null,
		session_id: "provider-session",
		uuid: `result-${id}`,
		tool_use_result: {},
	} as SDKMessage;
}

describe("SensitiveToolMessageFilter", () => {
	it("recognizes direct and provider-normalized database MCP names", () => {
		expect(isSensitiveDatabaseToolName("database_query")).toBe(true);
		expect(isSensitiveDatabaseToolName("database_connections_list")).toBe(true);
		expect(
			isSensitiveDatabaseToolName("mcp__cyrus-tools__database_query"),
		).toBe(true);
		expect(
			isSensitiveDatabaseToolName("mcp_cyrus-tools_database_connections_list"),
		).toBe(true);
		expect(isSensitiveDatabaseToolName("engineering_status")).toBe(false);
	});

	it.each([
		"mcp__cyrus-tools__database_query",
		"database_connections_list",
	])("redacts %s input and its correlated result", (name) => {
		const filter = new SensitiveToolMessageFilter();
		const use = filter.filter(
			"session-1",
			assistant(name, "tool-1", {
				connectionId: "payroll-production",
				sql: "SELECT salary FROM employees",
			}),
		);
		const toolResult = filter.filter(
			"session-1",
			result("tool-1", "salary\n999999\n"),
		);

		expect(JSON.stringify(use)).not.toContain("salary");
		expect(JSON.stringify(use)).not.toContain("payroll-production");
		expect(JSON.stringify(use)).toContain(DATABASE_TOOL_PAYLOAD_REDACTION);
		expect(JSON.stringify(toolResult)).not.toContain("999999");
		expect(JSON.stringify(toolResult)).toContain(
			DATABASE_TOOL_PAYLOAD_REDACTION,
		);
	});

	it("handles mixed blocks without mutating the provider transcript", () => {
		const original = assistant("database_query", "tool-1", {
			sql: "SELECT secret FROM payroll",
		}) as Extract<SDKMessage, { type: "assistant" }>;
		(original.message.content as unknown[]).unshift({
			type: "text",
			text: "Checking the configured database.",
		});
		const filter = new SensitiveToolMessageFilter();
		const filtered = filter.filter("session-1", original);

		expect(JSON.stringify(filtered)).not.toContain("SELECT secret");
		expect(JSON.stringify(filtered)).toContain(
			"Checking the configured database",
		);
		expect(JSON.stringify(original)).toContain("SELECT secret");
	});

	it("keeps correlation isolated by Cyrus session and leaves normal tools alone", () => {
		const filter = new SensitiveToolMessageFilter();
		const normal = assistant("Read", "read-1", { file_path: "README.md" });
		expect(filter.filter("session-1", normal)).toBe(normal);
		filter.filter(
			"session-1",
			assistant("database_query", "db-1", { sql: "SELECT 1" }),
		);
		expect(
			filter.filter("session-2", result("db-1", "ordinary result")),
		).toEqual(result("db-1", "ordinary result"));
		filter.clearSession("session-1");
		expect(filter.filter("session-1", result("db-1", "after clear"))).toEqual(
			result("db-1", "after clear"),
		);
	});
});
