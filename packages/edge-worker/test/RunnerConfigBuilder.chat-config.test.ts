import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	type IChatToolResolver,
	type IMcpConfigProvider,
	type IRunnerSelector,
	RunnerConfigBuilder,
} from "../src/RunnerConfigBuilder.js";

const silentLogger: ILogger = {
	debug: () => {},
	info: () => {},
	warn: () => {},
	error: () => {},
} as unknown as ILogger;

function makeBuilder(
	buildMcpConfig = () => ({}),
	hasDatabaseAuthorizationForConfig?: () => boolean,
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => ["Read(**)"],
	};
	const mcpConfigProvider: IMcpConfigProvider = {
		buildMcpConfig,
		buildMergedMcpConfigPath: () => undefined,
		hasDatabaseAuthorizationForConfig,
	};
	const runnerSelector: IRunnerSelector = {
		determineRunnerSelection: () => ({ runnerType: "claude" as const }),
		getDefaultModelForRunner: () => "",
		getDefaultFallbackModelForRunner: () => "",
	};
	return new RunnerConfigBuilder(
		chatToolResolver,
		mcpConfigProvider,
		runnerSelector,
	);
}

describe("RunnerConfigBuilder.buildChatConfig", () => {
	it("loads cyrus-tools for GitHub-only chat sessions without a Linear workspace", () => {
		const buildMcpConfig = vi.fn(() => ({
			"cyrus-tools": { type: "http" as const, url: "http://localhost/mcp" },
		}));
		const builder = makeBuilder(buildMcpConfig);
		const repository = {
			id: "repo-1",
			name: "private-repo",
			repositoryPath: "/repos/private-repo",
			workspaceBaseDir: "/worktrees",
			baseBranch: "main",
		} as never;

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			repository,
			repositoryPaths: ["/repos/private-repo"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(buildMcpConfig).toHaveBeenCalledWith("repo-1", "", "sess-1");
		expect(config.mcpConfig).toEqual({
			"cyrus-tools": { type: "http", url: "http://localhost/mcp" },
		});
	});

	it("includes autoMemoryDirectory in allowedDirectories so the session can read existing memory files (CYPACK-1197)", () => {
		const builder = makeBuilder();
		const cyrusHome = "/tmp/cyrus-home-test";
		const workspacePath = join(cyrusHome, "slack-workspaces", "thread-x");
		const repositoryPaths = ["/repo/one", "/repo/two"];

		const config = builder.buildChatConfig({
			workspacePath,
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome,
			platformName: "slack",
			repositoryPaths,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		const expectedAutoMemoryDir = join(cyrusHome, "slack-memory");
		expect(config.autoMemoryDirectory).toBe(expectedAutoMemoryDir);
		expect(config.allowedDirectories).toEqual([
			workspacePath,
			expectedAutoMemoryDir,
			...repositoryPaths,
		]);
	});

	it("marks database-capable chat sessions to disable remote transcript mirroring", () => {
		const builder = makeBuilder(
			() => ({
				"cyrus-tools": { type: "http" as const, url: "http://localhost/mcp" },
			}),
			() => true,
		);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			repository: {
				id: "repo-1",
				name: "repo",
				repositoryPath: "/repo",
				workspaceBaseDir: "/worktrees",
				baseBranch: "main",
			},
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.disableRemoteSessionStore).toBe(true);
	});

	it("passes managed skill plugins and scoped skill names to chat runner configs", () => {
		const builder = makeBuilder();
		const plugins = [{ type: "local" as const, path: "/cyrus/user-skills" }];

		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			plugins,
			skills: ["agent-browser", "test-user-skills"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.plugins).toEqual(plugins);
		expect(config.skills).toEqual(["agent-browser", "test-user-skills"]);
	});
});
