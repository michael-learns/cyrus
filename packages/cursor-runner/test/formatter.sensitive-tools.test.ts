import {
	DATABASE_TOOL_ACTIVITY_LABEL,
	DATABASE_TOOL_PAYLOAD_REDACTION,
} from "cyrus-core";
import { describe, expect, it } from "vitest";
import { CursorMessageFormatter } from "../src/formatter.js";

describe("CursorMessageFormatter sensitive tools", () => {
	it("never renders database tool payloads", () => {
		const formatter = new CursorMessageFormatter();
		const input = { connectionId: "payroll", sql: "SELECT secret FROM users" };
		expect(formatter.formatToolParameter("database_query", input)).toBe(
			DATABASE_TOOL_PAYLOAD_REDACTION,
		);
		expect(formatter.formatToolActionName("database_query", input, false)).toBe(
			DATABASE_TOOL_ACTIVITY_LABEL,
		);
		expect(
			formatter.formatToolResult("database_query", input, "secret", false),
		).toBe(DATABASE_TOOL_PAYLOAD_REDACTION);
	});
});
