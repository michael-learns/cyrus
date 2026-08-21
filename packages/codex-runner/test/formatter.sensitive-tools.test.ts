import {
	DATABASE_TOOL_ACTIVITY_LABEL,
	DATABASE_TOOL_PAYLOAD_REDACTION,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { CodexMessageFormatter } from "../src/formatter.js";

describe("CodexMessageFormatter sensitive tools", () => {
	it("never renders database tool payloads", () => {
		const formatter = new CodexMessageFormatter();
		const input = { connectionId: "payroll", sql: "SELECT secret FROM users" };
		expect(
			formatter.formatToolParameter("database_connections_list", input),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
		expect(
			formatter.formatToolActionName("database_connections_list", input, false),
		).toBe(DATABASE_TOOL_ACTIVITY_LABEL);
		expect(
			formatter.formatToolResult(
				"database_connections_list",
				input,
				"payroll-production",
				false,
			),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
	});
});
