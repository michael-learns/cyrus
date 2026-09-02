import { describe, expect, it } from "vitest";
import {
	GITHUB_DEFAULT_ALLOWED_TOOLS,
	LINEAR_DEFAULT_ALLOWED_TOOLS,
	SLACK_DEFAULT_ALLOWED_TOOLS,
} from "../src/allowed-tools-defaults.js";

describe("platform default allowed tools", () => {
	it("gives Slack chat the minimal file-generation capabilities", () => {
		expect(SLACK_DEFAULT_ALLOWED_TOOLS).toEqual([
			"Read",
			"Write",
			"Edit",
			"Bash",
			"Bash(git -C * pull)",
			"Bash(gh pr:*)",
			"WebFetch",
			"WebSearch",
			"SendMessage",
			"ScheduleWakeup",
			"Task",
			"TaskCreate",
			"TaskUpdate",
			"TaskGet",
			"TaskList",
			"TaskOutput",
			"TaskStop",
			"Monitor",
			"Skill",
			"ToolSearch",
			"mcp__linear",
			"mcp__cyrus-tools",
			"mcp__cyrus-docs",
			"mcp__slack",
		]);
	});

	it("does not change the Linear or GitHub file and execution defaults", () => {
		for (const tools of [
			LINEAR_DEFAULT_ALLOWED_TOOLS,
			GITHUB_DEFAULT_ALLOWED_TOOLS,
		]) {
			expect(tools.slice(0, 6)).toEqual([
				"Read",
				"Edit",
				"Write",
				"NotebookEdit",
				"Bash",
				"Task",
			]);
		}
	});
});
