import {
	DATABASE_TOOL_ACTIVITY_LABEL,
	DATABASE_TOOL_PAYLOAD_REDACTION,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { ClaudeMessageFormatter } from "../src/formatter.js";

describe("ClaudeMessageFormatter sensitive tools", () => {
	it("never renders database connection, SQL, or row payloads", () => {
		const formatter = new ClaudeMessageFormatter();
		const input = {
			connectionId: "payroll-production",
			sql: "SELECT salary FROM employees",
		};
		const output = "salary\n999999\n";

		expect(formatter.formatToolParameter("database_query", input)).toBe(
			DATABASE_TOOL_PAYLOAD_REDACTION,
		);
		expect(formatter.formatToolActionName("database_query", input, false)).toBe(
			DATABASE_TOOL_ACTIVITY_LABEL,
		);
		expect(
			formatter.formatToolResult("database_query", input, output, false),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
	});
});
