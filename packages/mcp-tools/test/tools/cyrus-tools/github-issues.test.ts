import { describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

describe("GitHub Issue orchestration tools", () => {
	it("registers GitHub tools without requiring a Linear client", () => {
		const githubIssues = {
			get: vi.fn(),
			start: vi.fn(),
			status: vi.fn(),
			prompt: vi.fn(),
			stop: vi.fn(),
		};
		const server = createCyrusToolsServer(undefined, { githubIssues });
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).toEqual([
			"github_issue_get",
			"github_issue_start",
			"github_issue_status",
			"github_issue_prompt",
			"github_issue_stop",
		]);
	});

	it("omits GitHub tools when the host did not wire GitHub callbacks", () => {
		const server = createCyrusToolsServer({} as never);
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).not.toContain("github_issue_start");
	});
});
