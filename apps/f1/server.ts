#!/usr/bin/env bun

/**
 * F1 Server - Testing Framework Server for Cyrus
 *
 * This server starts the EdgeWorker in CLI platform mode, providing
 * a complete testing environment for the Cyrus agent system without
 * external dependencies.
 *
 * Features:
 * - EdgeWorker configured with platform: "cli"
 * - Creates temporary directories for worktrees
 * - Beautiful colored connection info display
 * - Graceful shutdown on SIGINT/SIGTERM
 * - Zero `any` types
 *
 * Usage:
 *   CYRUS_PORT=3600 CYRUS_REPO_PATH=/path/to/repo bun run server.ts
 */

import { execFileSync } from "node:child_process";
import {
	appendFileSync,
	existsSync,
	mkdirSync,
	readFileSync,
	realpathSync,
	statSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, sep } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { getAllTools } from "cyrus-claude-runner";
import {
	type AgentRunnerConfig,
	type AgentSessionInfo,
	type AgentTurn,
	type EdgeWorkerConfig,
	getDefaultReposDir,
	getDefaultWorktreesDir,
	type IAgentRunner,
	type IMessageFormatter,
	type RepositoryConfig,
} from "cyrus-core";
import { EdgeWorker } from "cyrus-edge-worker";
import type { SlackWebhookEvent } from "cyrus-slack-event-transport";
import {
	normalizeSlackEngineeringFixture,
	type SlackEngineeringFixture,
} from "./src/slackEngineeringFixture.js";
import { SyntheticSlackEngineeringBackend } from "./src/syntheticSlackEngineeringBackend.js";
import {
	type SyntheticModelDecision,
	SyntheticSlackEngineeringModel,
} from "./src/syntheticSlackEngineeringModel.js";
import { bold, cyan, dim, gray, green, success } from "./src/utils/colors.js";

// ============================================================================
// CONFIGURATION
// ============================================================================

const CYRUS_PORT = Number.parseInt(process.env.CYRUS_PORT || "3600", 10);
const CYRUS_REPO_PATH = process.env.CYRUS_REPO_PATH || process.cwd();
const CYRUS_REPO_GITHUB_URL =
	process.env.CYRUS_REPO_GITHUB_URL ||
	"https://github.com/f1-test/primary-repo";
const CYRUS_HOME =
	process.env.CYRUS_HOME || join(tmpdir(), `cyrus-f1-${Date.now()}`);
const DEFAULT_REPOS_BASE_DIR = getDefaultReposDir(CYRUS_HOME);
const DEFAULT_WORKTREES_BASE_DIR = getDefaultWorktreesDir(CYRUS_HOME);
// Optional second repository path for multi-repo orchestration testing
const CYRUS_REPO_PATH_2 = process.env.CYRUS_REPO_PATH_2;
const CYRUS_REPO_GITHUB_URL_2 =
	process.env.CYRUS_REPO_GITHUB_URL_2 ||
	"https://github.com/f1-test/secondary-repo";
const MULTI_REPO_MODE = Boolean(CYRUS_REPO_PATH_2);
const SLACK_ENGINEERING_MODE = process.env.CYRUS_F1_SLACK_ENGINEERING === "1";
const nativeFetch = globalThis.fetch.bind(globalThis);

const formatter: IMessageFormatter = {
	formatTodoWriteParameter: (value) => value,
	formatTaskParameter: (name) => name,
	formatToolParameter: (name) => name,
	formatToolActionName: (name) => name,
	formatToolResult: (_name, _input, result) => result,
};

class SyntheticAgentRunner implements IAgentRunner {
	readonly supportsStreamingInput = true;
	readonly turns: AgentTurn[] = [];
	readonly streamMessages: string[] = [];
	readonly decisions: SyntheticModelDecision[] = [];
	private running = false;
	private resolveEngineering?: () => void;
	private policyTail = Promise.resolve();
	private readonly messages: ReturnType<IAgentRunner["getMessages"]> = [];
	private readonly temporaryImageDirectories = new Map<string, Set<symbol>>();

	constructor(
		readonly config: AgentRunnerConfig,
		readonly kind: "chat" | "engineering" | "standard",
		private readonly runPolicy?: (
			prompt: string,
		) => Promise<SyntheticModelDecision>,
	) {}

	async start(prompt: string): Promise<AgentSessionInfo> {
		this.streamMessages.push(prompt);
		return this.startCommon();
	}

	async startStreaming(prompt?: string): Promise<AgentSessionInfo> {
		if (prompt) {
			this.streamMessages.push(prompt);
			this.schedulePolicy(prompt);
		}
		this.running = true;
		return this.info();
	}

	async startTurn(turn: AgentTurn): Promise<AgentSessionInfo> {
		this.turns.push(structuredClone(turn));
		this.running = true;
		this.commitSyntheticChange();
		if (this.kind === "engineering") {
			await new Promise<void>((resolve) => {
				this.resolveEngineering = resolve;
			});
		}
		return this.finish();
	}

	addStreamMessage(message: string): void {
		this.streamMessages.push(message);
		this.schedulePolicy(message);
	}

	addStreamTurn(turn: AgentTurn): void {
		for (const part of turn) {
			if (part.type !== "local_image") continue;
			const canonicalImage = realpathSync(part.path);
			const allowed = [
				...(this.config.allowedDirectories ?? []),
				...this.temporaryImageDirectories.keys(),
			].some((directory) => {
				const fromDirectory = relative(realpathSync(directory), canonicalImage);
				return (
					fromDirectory !== ".." &&
					!fromDirectory.startsWith(`..${sep}`) &&
					!isAbsolute(fromDirectory)
				);
			});
			if (!allowed) throw new Error("Local image path is not allowed");
			readFileSync(canonicalImage);
		}
		this.turns.push(structuredClone(turn));
	}

	allowLocalImageDirectory(directory: string): { release(): void } {
		let canonicalDirectory: string;
		try {
			canonicalDirectory = realpathSync(directory);
			if (!statSync(canonicalDirectory).isDirectory()) throw new Error();
		} catch {
			throw new Error("Unable to authorize local image directory");
		}
		const token = Symbol("f1-local-image-directory-lease");
		const leases =
			this.temporaryImageDirectories.get(canonicalDirectory) ?? new Set();
		leases.add(token);
		this.temporaryImageDirectories.set(canonicalDirectory, leases);
		let released = false;
		return {
			release: () => {
				if (released) return;
				released = true;
				const active = this.temporaryImageDirectories.get(canonicalDirectory);
				active?.delete(token);
				if (active?.size === 0)
					this.temporaryImageDirectories.delete(canonicalDirectory);
			},
		};
	}

	completeEngineering(): void {
		this.messages.push({
			type: "result",
			subtype: "success",
			is_error: false,
			duration_ms: 1,
			duration_api_ms: 1,
			num_turns: 1,
			result:
				"Implemented the synthetic F1 change and opened the pull request.",
			session_id: `f1-${this.kind}`,
			total_cost_usd: 0,
			stop_reason: null,
			usage: {},
			modelUsage: {},
			permission_denials: [],
			uuid: `f1-${this.kind}-result`,
		} as unknown as ReturnType<IAgentRunner["getMessages"]>[number]);
		this.running = false;
		this.resolveEngineering?.();
		this.resolveEngineering = undefined;
	}

	waitForPolicy(): Promise<void> {
		return this.policyTail;
	}

	completeStream(): void {}
	isStreaming(): boolean {
		return this.running;
	}
	stop(): void {
		this.running = false;
		this.resolveEngineering?.();
	}
	isRunning(): boolean {
		return this.running;
	}
	getMessages(): ReturnType<IAgentRunner["getMessages"]> {
		return [...this.messages];
	}
	getFormatter(): IMessageFormatter {
		return formatter;
	}

	private async startCommon(): Promise<AgentSessionInfo> {
		this.running = true;
		return this.kind === "chat" ? this.info() : this.finish();
	}

	private finish(): AgentSessionInfo {
		this.running = false;
		return this.info();
	}

	private info(): AgentSessionInfo {
		return {
			sessionId: `f1-${this.kind}`,
			startedAt: new Date(),
			isRunning: this.running,
		};
	}

	private schedulePolicy(prompt: string): void {
		if (!this.runPolicy) return;
		this.policyTail = this.policyTail.then(async () => {
			this.decisions.push(await this.runPolicy!(prompt));
		});
	}

	private commitSyntheticChange(): void {
		if (this.kind !== "engineering") return;
		const candidates = [
			this.config.workingDirectory,
			...(this.config.allowedDirectories ?? []),
		].filter((value): value is string => Boolean(value));
		const worktree = candidates.find((candidate) => {
			try {
				return (
					execFileSync(
						"git",
						["-C", candidate, "rev-parse", "--is-inside-work-tree"],
						{
							encoding: "utf8",
							stdio: ["ignore", "pipe", "ignore"],
						},
					).trim() === "true" && candidate.includes("worktrees")
				);
			} catch {
				return false;
			}
		});
		if (!worktree) return;
		appendFileSync(
			join(worktree, ".f1-slack-engineering-proof"),
			"validated\n",
		);
		execFileSync("git", ["-C", worktree, "add", ".f1-slack-engineering-proof"]);
		execFileSync("git", [
			"-C",
			worktree,
			"-c",
			"user.name=F1 Validation",
			"-c",
			"user.email=f1@example.invalid",
			"commit",
			"-m",
			"test: synthetic Slack engineering change",
		]);
	}
}

// Validate port
if (Number.isNaN(CYRUS_PORT) || CYRUS_PORT < 1 || CYRUS_PORT > 65535) {
	console.error(`❌ Invalid CYRUS_PORT: ${process.env.CYRUS_PORT}`);
	console.error("   Port must be between 1 and 65535");
	process.exit(1);
}

// Validate repository path
if (!existsSync(CYRUS_REPO_PATH)) {
	console.error(`❌ Repository path does not exist: ${CYRUS_REPO_PATH}`);
	console.error("   Set CYRUS_REPO_PATH to a valid directory");
	process.exit(1);
}

// ============================================================================
// DIRECTORY SETUP
// ============================================================================

/**
 * Create required directories for F1 testing
 */
function setupDirectories(): void {
	const requiredDirs = [
		CYRUS_HOME,
		DEFAULT_REPOS_BASE_DIR,
		DEFAULT_WORKTREES_BASE_DIR,
		join(CYRUS_HOME, "mcp-configs"),
		join(CYRUS_HOME, "state"),
	];

	for (const dir of requiredDirs) {
		if (!existsSync(dir)) {
			mkdirSync(dir, { recursive: true });
		}
	}
}

// ============================================================================
// EDGEWORKER CONFIGURATION
// ============================================================================

/**
 * Create EdgeWorker configuration for CLI platform
 */
function createEdgeWorkerConfig(): EdgeWorkerConfig {
	// Create primary test repository configuration
	const repository: RepositoryConfig = {
		id: "f1-test-repo",
		name: "F1 Test Repository",
		repositoryPath: CYRUS_REPO_PATH,
		baseBranch: "main",
		githubUrl: CYRUS_REPO_GITHUB_URL,
		linearWorkspaceId: "cli-workspace",
		workspaceBaseDir: DEFAULT_WORKTREES_BASE_DIR,
		isActive: true,
		...(process.env.CYRUS_REPO_MODEL && {
			model: process.env.CYRUS_REPO_MODEL,
		}),
		// Routing configuration for multi-repo support
		routingLabels: ["primary", "main-repo"],
		teamKeys: ["PRIMARY"],
		// Label-based system prompt configuration for F1 testing
		// This enables testing of label-based orchestrator/debugger/builder/scoper modes
		labelPrompts: {
			debugger: {
				labels: ["bug", "Bug", "debugger", "Debugger"],
			},
			builder: {
				labels: ["feature", "Feature", "builder", "Builder", "enhancement"],
			},
			scoper: {
				labels: ["scope", "Scope", "scoper", "Scoper", "research", "Research"],
			},
			orchestrator: {
				labels: ["orchestrator", "Orchestrator"],
			},
			"graphite-orchestrator": {
				labels: ["graphite-orchestrator"],
			},
			graphite: {
				labels: ["graphite", "Graphite"],
			},
		},
	};

	const repositories: RepositoryConfig[] = [repository];

	// Add second repository if multi-repo mode is enabled
	if (MULTI_REPO_MODE && CYRUS_REPO_PATH_2) {
		const secondaryRepository: RepositoryConfig = {
			id: "f1-test-repo-secondary",
			name: "F1 Secondary Repository",
			repositoryPath: CYRUS_REPO_PATH_2,
			baseBranch: "main",
			githubUrl: CYRUS_REPO_GITHUB_URL_2,
			linearWorkspaceId: "cli-workspace", // Same workspace for routing test
			workspaceBaseDir: join(DEFAULT_WORKTREES_BASE_DIR, "secondary"),
			isActive: true,
			...(process.env.CYRUS_REPO_MODEL_2 && {
				model: process.env.CYRUS_REPO_MODEL_2,
			}),
			// Different routing labels for second repo
			routingLabels: ["secondary", "backend"],
			teamKeys: ["SECONDARY"],
			projectKeys: ["Backend Project"],
			labelPrompts: {
				debugger: {
					labels: ["bug", "Bug"],
				},
				builder: {
					labels: ["feature", "Feature"],
				},
			},
		};
		repositories.push(secondaryRepository);
	}

	const config: EdgeWorkerConfig = {
		platform: "cli" as const,
		repositories,
		cyrusHome: CYRUS_HOME,
		serverPort: CYRUS_PORT,
		serverHost: "localhost",
		claudeDefaultModel: process.env.CYRUS_CLAUDE_MODEL || "sonnet",
		claudeDefaultFallbackModel: "haiku",
		// Env-gated runner selection for harness validation (default unchanged).
		// e.g. CYRUS_DEFAULT_RUNNER=codex to exercise the Codex (app-server) path.
		...(process.env.CYRUS_DEFAULT_RUNNER && {
			defaultRunner: process.env.CYRUS_DEFAULT_RUNNER as
				| "claude"
				| "gemini"
				| "codex"
				| "cursor",
		}),
		codexDefaultModel: process.env.CODEX_MODEL || "gpt-5.5",
		// Enable all tools including Edit(**), Bash, etc. for full testing capability
		linearAllowedTools: getAllTools(),
		// CLI platform needs a linearWorkspaces entry so the CLIIssueTrackerService
		// gets created for the workspace ID referenced in the repository configs
		linearWorkspaces: {
			"cli-workspace": {
				linearToken: "cli-mode-no-token-needed",
			},
		},
		// Enable egress proxy sandbox when CYRUS_SANDBOX=1 is set.
		// The proxy only intercepts Bash-spawned subprocess traffic (git, gh, npm, etc.).
		// Claude's inference API, MCP servers, and built-in file tools bypass the proxy.
		//
		// No networkPolicy = allow-all mode (passthrough with logging).
		// To test deny-all + explicit allows with transforms, set CYRUS_SANDBOX_POLICY=1.
		...(process.env.CYRUS_SANDBOX === "1" && {
			sandbox: {
				enabled: true,
				httpProxyPort: 19080,
				socksProxyPort: 19081,
				logRequests: true,
				// User-defined policy: deny-all default, explicit allows with transforms.
				// Only enabled with CYRUS_SANDBOX_POLICY=1 since F1 test repos lack
				// GitHub remotes and don't need network restrictions.
				...(process.env.CYRUS_SANDBOX_POLICY === "1" && {
					networkPolicy: {
						allow: {
							"github.com": [
								{
									transform: [
										{
											headers: {
												"X-Cyrus-Egress": "verified",
											},
										},
									],
								},
							],
							"api.github.com": [
								{
									transform: [
										{
											headers: {
												"X-Cyrus-Egress": "verified",
											},
										},
									],
								},
							],
							// Subprocess dependencies (npm, etc.)
							"registry.npmjs.org": [],
						},
					},
				}),
			},
		}),
	};

	return config;
}

// ============================================================================
// SERVER STARTUP
// ============================================================================

/**
 * Display beautiful server connection info
 */
function displayConnectionInfo(): void {
	const divider = gray("─".repeat(60));

	console.log(`\n${divider}`);
	console.log(bold(green("  🏎️  F1 Testing Framework Server")));
	console.log(divider);
	console.log(success("Server started successfully"));
	console.log("");
	console.log(
		`  ${cyan("Server:")}    ${bold(`http://localhost:${CYRUS_PORT}`)}`,
	);
	console.log(
		`  ${cyan("RPC:")}       ${bold(`http://localhost:${CYRUS_PORT}/cli/rpc`)}`,
	);
	console.log(`  ${cyan("Platform:")}  ${bold("cli")}`);
	console.log(`  ${cyan("Cyrus Home:")} ${dim(CYRUS_HOME)}`);
	console.log(`  ${cyan("Repository:")} ${dim(CYRUS_REPO_PATH)}`);
	if (MULTI_REPO_MODE) {
		console.log(
			`  ${cyan("Multi-Repo:")} ${bold("enabled")} (${dim(CYRUS_REPO_PATH_2 || "")})`,
		);
		console.log(
			dim("  Routing context will be included in orchestrator prompts"),
		);
	}
	console.log("");
	console.log(dim("  Press Ctrl+C to stop the server"));
	console.log(`${divider}\n`);
}

/**
 * Main server startup function
 */
async function startServer(): Promise<void> {
	try {
		// Setup directories
		setupDirectories();
		const syntheticBackend = SLACK_ENGINEERING_MODE
			? new SyntheticSlackEngineeringBackend(
					join(CYRUS_HOME, "state", "f1-slack-engineering-backend.json"),
				)
			: undefined;
		if (syntheticBackend) {
			globalThis.fetch = syntheticBackend.fetch;
			process.env.GITHUB_TOKEN = "ghs-f1-synthetic";
		}

		// Create EdgeWorker configuration
		const config = createEdgeWorkerConfig();

		// Initialize EdgeWorker
		const edgeWorker = new EdgeWorker(config);
		const syntheticRunners: SyntheticAgentRunner[] = [];
		if (syntheticBackend) {
			const workerWithRunnerFactory = edgeWorker as unknown as {
				createRunnerForType: (
					runnerType: "claude" | "gemini" | "codex" | "cursor",
					config: AgentRunnerConfig,
				) => IAgentRunner;
			};
			workerWithRunnerFactory.createRunnerForType = (
				runnerType,
				runnerConfig,
			) => {
				const kind = runnerConfig.workingDirectory?.includes("slack-workspaces")
					? "chat"
					: runnerType === "claude"
						? "engineering"
						: "standard";
				const runPolicy =
					kind === "chat"
						? async (prompt: string) => {
								const mcp = runnerConfig.mcpConfig?.["cyrus-tools"];
								if (!mcp || mcp.type !== "http" || !mcp.url)
									throw new Error(
										"F1 chat runner did not receive the cyrus-tools MCP server",
									);
								const client = new Client({
									name: "cyrus-f1-synthetic-model",
									version: "1.0.0",
								});
								const transport = new StreamableHTTPClientTransport(
									new URL(mcp.url),
									{
										requestInit: { headers: mcp.headers },
										fetch: nativeFetch,
									},
								);
								try {
									await client.connect(transport);
									return await new SyntheticSlackEngineeringModel(
										client,
									).respond(prompt);
								} finally {
									await client.close();
								}
							}
						: undefined;
				const runner = new SyntheticAgentRunner(runnerConfig, kind, runPolicy);
				syntheticRunners.push(runner);
				return runner;
			};
		}

		// Setup graceful shutdown
		const shutdown = async (signal: string): Promise<void> => {
			console.log(`\n\n${dim(`Received ${signal}, shutting down...`)}`);
			try {
				await edgeWorker.stop();
				console.log(success("Server stopped gracefully"));
				process.exit(0);
			} catch (error) {
				console.error(`❌ Error during shutdown: ${error}`);
				process.exit(1);
			}
		};

		process.on("SIGINT", () => shutdown("SIGINT"));
		process.on("SIGTERM", () => shutdown("SIGTERM"));

		// Register F1 test-only HTTP route for dispatching synthetic Slack chat events
		// BEFORE starting EdgeWorker — Fastify rejects new routes after listen().
		// Exercises the Slack → ChatSessionHandler → ClaudeRunner code path without
		// going through Slack signature verification.
		const fastify = edgeWorker
			.getSharedApplicationServer()
			.getFastifyInstance();
		fastify.post("/cli/dispatch-chat", async (request, reply) => {
			const body =
				(request.body as {
					channel?: string;
					user?: string;
					text?: string;
					threadTs?: string;
				}) ?? {};
			const ts = `${Date.now() / 1000}`;
			const channel = body.channel ?? "C_F1_CHAN";
			const event: SlackWebhookEvent = {
				eventType: "app_mention",
				eventId: `f1-${ts}`,
				teamId: "f1-test-team",
				slackBotToken: undefined,
				payload: {
					type: "app_mention",
					user: body.user ?? "U_F1_USER",
					text: body.text ?? "hello",
					ts,
					channel,
					...(body.threadTs ? { thread_ts: body.threadTs } : {}),
					event_ts: ts,
				},
			};
			try {
				await edgeWorker.dispatchChatTestEvent(event);
				const threadKey = `${channel}:${body.threadTs || ts}`;
				reply.send({ ok: true, eventId: event.eventId, threadKey });
			} catch (err) {
				const message = err instanceof Error ? err.message : String(err);
				reply.code(500).send({ ok: false, error: message });
			}
		});

		if (syntheticBackend) {
			fastify.post("/cli/slack-engineering", async (request, reply) => {
				const body = request.body as {
					fixture?: SlackEngineeringFixture;
					control?: "complete";
					failSlackDelivery?: boolean;
				};
				try {
					syntheticBackend.failSlackDelivery =
						body.failSlackDelivery ?? syntheticBackend.failSlackDelivery;
					let threadKey: string | undefined;
					let parentSessionId: string | undefined;
					if (body.fixture) {
						const normalized = normalizeSlackEngineeringFixture(body.fixture);
						const fixtureThreadTs =
							body.fixture.threadTs ?? body.fixture.kickoffTs;
						syntheticBackend.setThread(
							body.fixture.channel,
							fixtureThreadTs,
							normalized.messages,
						);
						for (const [id, file] of normalized.files) {
							syntheticBackend.setFile(id, file.bytes, file.mimeType);
						}
						const replayHarness = edgeWorker as unknown as {
							replayPendingSlackEngineeringDeliveriesForEvent: (
								event: SlackWebhookEvent,
							) => Promise<void>;
						};
						await replayHarness.replayPendingSlackEngineeringDeliveriesForEvent(
							normalized.event,
						);
						if (body.control !== "complete")
							await edgeWorker.dispatchChatTestEvent(normalized.event);
						threadKey = `${body.fixture.channel}:${fixtureThreadTs}`;
						parentSessionId = edgeWorker
							.listChatThreads()
							.find((thread) => thread.threadKey === threadKey)?.sessionId;
					}

					if (!parentSessionId && body.control !== "complete") {
						throw new Error(
							"fixture must resolve an active Slack parent session",
						);
					}
					let result: unknown;
					if (body.control === "complete") {
						const runner = [...syntheticRunners]
							.reverse()
							.find((candidate) => candidate.kind === "engineering");
						if (!runner) throw new Error("no synthetic engineering runner");
						runner.completeEngineering();
						await new Promise((resolve) => setTimeout(resolve, 300));
						result = { completed: true };
					} else {
						const runner = [...syntheticRunners]
							.reverse()
							.find((candidate) => candidate.kind === "chat");
						if (!runner) throw new Error("no synthetic chat runner");
						await runner.waitForPolicy();
						result = runner.decisions.at(-1);
					}

					reply.send({
						ok: true,
						threadKey,
						parentSessionId,
						result,
						backend: syntheticBackend.snapshot(),
						runners: syntheticRunners.map((runner) => ({
							kind: runner.kind,
							model: runner.config.model,
							fallbackModel: runner.config.fallbackModel,
							workingDirectory: runner.config.workingDirectory,
							turns: runner.turns,
							streamMessages: runner.streamMessages,
							decisions: runner.decisions,
						})),
					});
				} catch (error) {
					reply.code(400).send({
						ok: false,
						error: error instanceof Error ? error.message : String(error),
						backend: syntheticBackend.snapshot(),
					});
				}
			});
		}

		// List active chat threads (threadKey → sessionId)
		fastify.get("/cli/chat-threads", async (_request, reply) => {
			reply.send({ ok: true, threads: edgeWorker.listChatThreads() });
		});

		// Fetch the last assistant reply for a chat thread (polled by F1 to
		// observe agent output when no real Slack channel is available).
		fastify.get("/cli/chat-thread", async (request, reply) => {
			const query = (request.query as { threadKey?: string }) ?? {};
			if (!query.threadKey) {
				reply.code(400).send({ ok: false, error: "threadKey required" });
				return;
			}
			const result = edgeWorker.getChatThreadLastReply(query.threadKey);
			if (!result) {
				reply
					.code(404)
					.send({ ok: false, error: `thread not found: ${query.threadKey}` });
				return;
			}
			reply.send({ ok: true, threadKey: query.threadKey, ...result });
		});

		// Start EdgeWorker
		await edgeWorker.start();

		// Display connection info
		displayConnectionInfo();
	} catch (error) {
		console.error(`❌ Failed to start server: ${error}`);
		if (error instanceof Error) {
			console.error(dim(`   ${error.message}`));
			if (error.stack) {
				console.error(dim(error.stack));
			}
		}
		process.exit(1);
	}
}

// ============================================================================
// RUN
// ============================================================================

startServer();
