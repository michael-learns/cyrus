import {
	DATABASE_TOOL_ACTIVITY_LABEL,
	DATABASE_TOOL_PAYLOAD_REDACTION,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { GeminiMessageFormatter } from "../src/formatter.js";

describe("GeminiMessageFormatter sensitive tools", () => {
	it("never renders database tool payloads", () => {
		const formatter = new GeminiMessageFormatter();
		const input = { connectionId: "payroll", sql: "SELECT secret FROM users" };
		expect(
			formatter.formatToolParameter("mcp__cyrus-tools__database_query", input),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
		expect(
			formatter.formatToolActionName(
				"mcp__cyrus-tools__database_query",
				input,
				false,
			),
		).toBe(DATABASE_TOOL_ACTIVITY_LABEL);
		expect(
			formatter.formatToolResult(
				"mcp__cyrus-tools__database_query",
				input,
				"secret\nvalue\n",
				false,
			),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
	});
});
