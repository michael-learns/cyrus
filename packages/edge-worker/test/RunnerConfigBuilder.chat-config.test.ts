import { join } from "node:path";
import type { ILogger } from "cyrus-core";
import { describe, expect, it, vi } from "vitest";
import {
	globalGitConfigPaths,
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
	chatAllowedTools: string[] = ["Read(**)"],
): RunnerConfigBuilder {
	const chatToolResolver: IChatToolResolver = {
		buildChatAllowedTools: () => chatAllowedTools,
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
	it("scopes only bare Write and Edit tools to the absolute chat workspace", () => {
		const builder = makeBuilder(() => ({}), undefined, [
			"Read",
			"Write",
			"Edit",
			"Bash",
			"Write(//custom/output/**)",
			"Edit(//custom/source/**)",
		]);

		const config = builder.buildChatConfig({
			workspacePath: "/var/cyrus/slack-workspaces/C1_1700",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/var/cyrus",
			platformName: "slack",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.allowedTools).toEqual([
			"Read",
			"Write(//var/cyrus/slack-workspaces/C1_1700/**)",
			"Edit(//var/cyrus/slack-workspaces/C1_1700/**)",
			"Bash",
			"Write(//custom/output/**)",
			"Edit(//custom/source/**)",
		]);
		expect(config.allowedTools).not.toContain("Write");
		expect(config.allowedTools).not.toContain("Edit");
	});

	it("enforces a fail-closed chat sandbox while preserving egress network settings", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Read", "Bash"]);
		const config = builder.buildChatConfig({
			workspacePath: "/var/cyrus/slack-workspaces/C1_1700",
			workspaceName: "slack-thread-x",
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/var/cyrus",
			platformName: "slack",
			repositoryPaths: ["/repos/one", "/repos/two", "/repos/one"],
			sandboxSettings: {
				enabled: true,
				network: { httpProxyPort: 43110, socksProxyPort: 43111 },
				filesystem: {
					allowRead: ["/should/not/escape"],
					allowWrite: ["/should/not/be/writable"],
				},
			} as any,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.sandbox).toEqual({
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: true,
			allowUnsandboxedCommands: false,
			network: {
				httpProxyPort: 43110,
				socksProxyPort: 43111,
				allowedDomains: [
					"github.com",
					"api.github.com",
					"codeload.github.com",
					"objects.githubusercontent.com",
				],
			},
			filesystem: {
				allowRead: [
					"/var/cyrus/slack-workspaces/C1_1700",
					"/var/cyrus/slack-memory",
					"/repos/one",
					"/repos/two",
					...globalGitConfigPaths(),
				],
				denyRead: ["~/"],
				allowWrite: [
					"/var/cyrus/slack-workspaces/C1_1700",
					"/repos/one",
					"/repos/two",
				],
			},
		});
	});

	it("rewrites github SSH remotes to HTTPS and supplies the token by helper", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Bash"]);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: undefined,
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			repositoryPaths: ["/repos/one"],
			githubToken: "ghs_exampletoken",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		const env = config.additionalEnv ?? {};
		expect(env.CYRUS_GITHUB_TOKEN).toBe("ghs_exampletoken");
		expect(env.GIT_CONFIG_COUNT).toBe("4");
		// Inherited helpers are cleared first; osxkeychain cannot reach the
		// keychain from inside the sandbox and noisily fails on every call.
		expect(env.GIT_CONFIG_KEY_0).toBe("credential.helper");
		expect(env.GIT_CONFIG_VALUE_0).toBe("");
		expect(env.GIT_CONFIG_KEY_1).toBe("url.https://github.com/.insteadOf");
		expect(env.GIT_CONFIG_VALUE_1).toBe("git@github.com:");
		expect(env.GIT_CONFIG_KEY_2).toBe("url.https://github.com/.insteadOf");
		expect(env.GIT_CONFIG_VALUE_2).toBe("ssh://git@github.com/");
		expect(env.GIT_CONFIG_KEY_3).toBe("credential.https://github.com.helper");
		// The token reaches git through the environment, never written to a
		// repository's config on disk.
		expect(env.GIT_CONFIG_VALUE_3).toContain("$CYRUS_GITHUB_TOKEN");
		expect(env.GIT_CONFIG_VALUE_3).not.toContain("ghs_exampletoken");
	});

	it("omits git HTTPS environment when no GitHub token is available", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Bash"]);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: undefined,
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			repositoryPaths: ["/repos/one"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.additionalEnv).toBeUndefined();
	});

	it("pre-approves github hosts so headless sessions are not denied", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Bash"]);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: undefined,
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			sandboxSettings: {
				enabled: true,
				network: {
					httpProxyPort: 43110,
					allowedDomains: ["internal.example.com"],
				},
			} as any,
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		// Operator-configured domains and ports survive; github hosts are added.
		expect(config.sandbox.network?.httpProxyPort).toBe(43110);
		expect(config.sandbox.network?.allowedDomains).toEqual([
			"internal.example.com",
			"github.com",
			"api.github.com",
			"codeload.github.com",
			"objects.githubusercontent.com",
		]);
	});

	it("allows reading the global git config so git can run at all", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Bash"]);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: undefined,
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		for (const path of globalGitConfigPaths()) {
			expect(config.sandbox.filesystem?.allowRead).toContain(path);
		}
	});

	it("grants write access to configured clones so chat sessions can pull", () => {
		const builder = makeBuilder(() => ({}), undefined, ["Bash(git -C * pull)"]);
		const config = builder.buildChatConfig({
			workspacePath: "/tmp/slack-workspace",
			workspaceName: undefined,
			systemPrompt: "test",
			sessionId: "sess-1",
			cyrusHome: "/tmp/cyrus-home-test",
			platformName: "slack",
			repositoryPaths: ["/repos/one", "/repos/two"],
			logger: silentLogger,
			onMessage: () => {},
			onError: () => {},
		});

		expect(config.sandbox.filesystem?.allowWrite).toEqual([
			"/tmp/slack-workspace",
			"/repos/one",
			"/repos/two",
		]);
	});

	it("enables the mandatory sandbox even when no egress proxy is configured", () => {
		const config = makeBuilder(() => ({}), undefined, ["Bash"]).buildChatConfig(
			{
				workspacePath: "/tmp/slack-workspace",
				workspaceName: undefined,
				systemPrompt: "test",
				sessionId: "sess-1",
				cyrusHome: "/tmp/cyrus-home-test",
				platformName: "slack",
				logger: silentLogger,
				onMessage: () => {},
				onError: () => {},
			},
		);

		expect(config.sandbox).toEqual({
			enabled: true,
			failIfUnavailable: true,
			autoAllowBashIfSandboxed: true,
			allowUnsandboxedCommands: false,
			network: {
				allowedDomains: [
					"github.com",
					"api.github.com",
					"codeload.github.com",
					"objects.githubusercontent.com",
				],
			},
			filesystem: {
				allowRead: [
					"/tmp/slack-workspace",
					"/tmp/cyrus-home-test/slack-memory",
					...globalGitConfigPaths(),
				],
				denyRead: ["~/"],
				allowWrite: ["/tmp/slack-workspace"],
			},
		});
	});

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
			...globalGitConfigPaths(),
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
