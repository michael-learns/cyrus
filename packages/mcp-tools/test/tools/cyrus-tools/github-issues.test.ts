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

describe("Slack engineering orchestration tools", () => {
	it("registers the six tools only when verified Slack engineering callbacks are supplied", () => {
		const engineering = {
			repositoriesList: vi.fn(),
			createAndStart: vi.fn(),
			current: vi.fn(),
			status: vi.fn(),
			prompt: vi.fn(),
			stop: vi.fn(),
		};
		const server = createCyrusToolsServer(undefined, { engineering });
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).toEqual([
			"engineering_repositories_list",
			"engineering_create_and_start",
			"engineering_current",
			"engineering_status",
			"engineering_prompt",
			"engineering_stop",
		]);
	});

	it("does not expose engineering tools to sessions without verified Slack callbacks", () => {
		const server = createCyrusToolsServer(undefined, {
			parentSessionId: "linear-parent",
		});
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).not.toContain("engineering_create_and_start");
	});
});
