import type {
	AgentRunnerConfig,
	EdgeWorkerConfig,
	SDKMessage,
} from "cyrus-core";
import { DATABASE_TOOL_PAYLOAD_REDACTION } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

const config: EdgeWorkerConfig = {
	cyrusHome: "/tmp/cyrus-sensitive-message-test",
	repositories: [],
};

function databaseUse(): SDKMessage {
	return {
		type: "assistant",
		message: {
			role: "assistant",
			content: [
				{
					type: "tool_use",
					id: "db-tool-1",
					name: "mcp__cyrus-tools__database_query",
					input: {
						connectionId: "payroll-production",
						sql: "SELECT salary FROM employees",
					},
				},
			],
		},
		parent_tool_use_id: null,
		session_id: "provider-session",
		uuid: "assistant-1",
	} as SDKMessage;
}

function databaseResult(): SDKMessage {
	return {
		type: "user",
		message: {
			role: "user",
			content: [
				{
					type: "tool_result",
					tool_use_id: "db-tool-1",
					content: "salary\n999999\n",
				},
			],
		},
		parent_tool_use_id: null,
		session_id: "provider-session",
		uuid: "user-1",
		tool_use_result: { output: "salary\n999999\n" },
	} as SDKMessage;
}

describe("EdgeWorker database-sensitive messages", () => {
	it("redacts tool inputs and correlated rows before activity consumers", async () => {
		const worker = new EdgeWorker(config);
		const handleClaudeMessage = vi.fn().mockResolvedValue(undefined);
		(worker as any).agentSessionManager = { handleClaudeMessage };

		await (worker as any).handleClaudeMessage(
			"session-1",
			databaseUse(),
			"repo",
		);
		await (worker as any).handleClaudeMessage(
			"session-1",
			databaseResult(),
			"repo",
		);

		expect(handleClaudeMessage).toHaveBeenCalledTimes(2);
		const serialized = JSON.stringify(handleClaudeMessage.mock.calls);
		expect(serialized).not.toContain("payroll-production");
		expect(serialized).not.toContain("SELECT salary");
		expect(serialized).not.toContain("999999");
		expect(serialized).toContain(DATABASE_TOOL_PAYLOAD_REDACTION);
	});

	it("never attaches the remote SessionStore to database-capable runners", () => {
		const worker = new EdgeWorker(config);
		const sessionStore = { append: vi.fn(), load: vi.fn() };
		(worker as any).claudeSessionStore = sessionStore;
		const base: AgentRunnerConfig = {
			cyrusHome: config.cyrusHome,
			workingDirectory: "/tmp",
		};

		const sensitive = (worker as any).createRunnerForType("claude", {
			...base,
			disableRemoteSessionStore: true,
		});
		const ordinary = (worker as any).createRunnerForType("claude", base);

		expect((sensitive as any).config.sessionStore).toBeUndefined();
		expect((ordinary as any).config.sessionStore).toBe(sessionStore);
	});
});
