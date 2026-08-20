import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";
import { RunnerConfigBuilder } from "../src/RunnerConfigBuilder.js";

const logger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
	withContext() {
		return this;
	},
} as unknown as ILogger;

describe("EdgeWorker GitHub-only runner configuration", () => {
	it("builds a GitHub issue runner without a Linear workspace", async () => {
		const buildMcpConfig = vi.fn(() => ({
			"cyrus-tools": { type: "http" as const, url: "http://localhost/mcp" },
		}));
		const runnerConfigBuilder = new RunnerConfigBuilder(
			{ buildChatAllowedTools: () => [] },
			{
				buildMcpConfig,
				buildMergedMcpConfigPath: () => undefined,
			},
			{
				determineRunnerSelection: () => ({ runnerType: "claude" as const }),
				getDefaultModelForRunner: () => "opus",
				getDefaultFallbackModelForRunner: () => "sonnet",
			},
		);
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.logger = logger;
		worker.runnerConfigBuilder = runnerConfigBuilder;
		worker.skillsPluginResolver = {
			resolve: vi.fn().mockResolvedValue([]),
			discoverSkillNames: vi.fn().mockResolvedValue([]),
		};
		worker.config = { githubMcpConfigs: [] };
		worker.isWarmSessionsEnabled = vi.fn().mockReturnValue(false);
		worker.handleClaudeMessage = vi.fn();
		worker.handleClaudeError = vi.fn();
		worker.createAskUserQuestionCallback = vi.fn();

		const session = {
			issueId: "5206538038",
			issue: { identifier: "GH-yahshua-one-payroll-453" },
			workspace: {
				path: "/worktrees/GH-yahshua-one-payroll-453",
				isGitWorktree: true,
			},
		};
		const repository = {
			id: "github-yahshua-abba-yahshua-one-payroll",
			name: "yahshua-one-payroll",
			repositoryPath: "/repos/yahshua-one-payroll",
			workspaceBaseDir: "/worktrees",
			baseBranch: "main",
		};

		const result = await worker.buildAgentRunnerConfig(
			session,
			repository,
			"github-issue-slack-source",
			"system prompt",
			["Read(**)"],
			[repository.repositoryPath],
			[],
			undefined,
			[],
			"[agent=claude]",
			200,
			undefined,
			{},
			"github",
		);

		expect(buildMcpConfig).toHaveBeenCalledWith(
			repository.id,
			"",
			"github-issue-slack-source",
		);
		expect(result.config.mcpConfig).toEqual({
			"cyrus-tools": { type: "http", url: "http://localhost/mcp" },
		});
	});
});
