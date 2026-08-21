import {
	createHash,
	randomBytes,
	randomUUID,
	timingSafeEqual,
} from "node:crypto";
import type { LinearClient } from "@linear/sdk";
import type { McpServerConfig } from "cyrus-claude-runner";
import type { IIssueTrackerService, RepositoryConfig } from "cyrus-core";
import {
	type CyrusToolsOptions,
	createCyrusToolsServer,
} from "cyrus-mcp-tools";
import {
	type DatabaseAuthorizationContext,
	type DatabaseAuthorizationContextInput,
	DatabaseAuthorizationContextService,
} from "./DatabaseAuthorizationContextService.js";

type CyrusToolsMcpContextEntry = {
	contextId: string;
	repositoryId: string;
	linearToken?: string;
	linearClient?: LinearClient;
	parentSessionId?: string;
	databaseAuthorizationContext?: DatabaseAuthorizationContext;
	prebuiltServer?: ReturnType<typeof createCyrusToolsServer>;
	createdAt: number;
	lastAccessAt: number;
	expiresAt: number;
};

export interface McpConfigServiceOptions {
	now?: () => number;
	contextTtlMs?: number;
	maxContexts?: number;
}

const DEFAULT_CONTEXT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONTEXTS = 500;

/**
 * Dependencies injected into McpConfigService from the EdgeWorker.
 */
export interface McpConfigServiceDeps {
	/** Retrieve the stored Linear API token for a workspace */
	getLinearTokenForWorkspace: (workspaceId: string) => string | null;
	/** Retrieve the issue tracker service for a workspace (must expose getClient()) */
	getIssueTracker: (
		workspaceId: string,
	) => (IIssueTrackerService & { getClient?: () => LinearClient }) | undefined;
	/** Get the HTTP URL where the cyrus-tools MCP endpoint is registered */
	getCyrusToolsMcpUrl: () => string;
	/** Factory that creates CyrusToolsOptions with session callbacks */
	createCyrusToolsOptions: (
		parentSessionId?: string,
		databaseAuthorizationContext?: DatabaseAuthorizationContext,
	) => CyrusToolsOptions;
	/** Derive database authority from server-verified session state only. */
	resolveDatabaseAuthorizationContext?: (input: {
		capabilityId: string;
		repositoryId: string;
		parentSessionId?: string;
	}) => DatabaseAuthorizationContextInput | undefined;
}

/**
 * Single source of truth for MCP server configuration assembly.
 *
 * Handles:
 * - Building inline MCP server configs (Linear, cyrus-tools, Slack)
 * - Merging file-based MCP config paths from repositories
 * - Cyrus-tools MCP context lifecycle management
 *
 * Both EdgeWorker (issue sessions) and ChatSessionHandler (chat sessions)
 * consume this service instead of duplicating MCP config logic.
 */
export class McpConfigService {
	private deps: McpConfigServiceDeps;
	private contexts = new Map<string, CyrusToolsMcpContextEntry>();
	private readonly localBearer = randomBytes(32).toString("base64url");
	private readonly now: () => number;
	private readonly contextTtlMs: number;
	private readonly maxContexts: number;
	private readonly databaseAuthorizationContexts: DatabaseAuthorizationContextService;

	constructor(
		deps: McpConfigServiceDeps,
		options: McpConfigServiceOptions = {},
	) {
		this.deps = deps;
		this.now = options.now ?? Date.now;
		this.contextTtlMs = options.contextTtlMs ?? DEFAULT_CONTEXT_TTL_MS;
		this.maxContexts = options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
		this.databaseAuthorizationContexts =
			new DatabaseAuthorizationContextService({
				now: this.now,
				ttlMs: this.contextTtlMs,
				maxContexts: this.maxContexts,
			});
	}

	/**
	 * Build MCP configuration with automatic Linear server injection and cyrus-tools over Fastify MCP.
	 * Workspace-level servers (Linear, cyrus-tools, Slack) are configured once using workspace-level token.
	 *
	 * Whether the agent can actually CALL into any of these servers is gated
	 * by the per-platform allowed-tools array (`teams.{linear,slack,github}_allowed_tools`),
	 * not by anything done here — so it's safe to always spin them up when
	 * their underlying transport credentials exist (Slack inline via
	 * `SLACK_BOT_TOKEN`, Linear via the workspace's Linear token, etc.).
	 *
	 * @param repoId - Repository ID for MCP context scoping
	 * @param linearWorkspaceId - Linear workspace ID (from webhook.organizationId or repo config)
	 * @param parentSessionId - Parent session ID for cyrus-tools context
	 */
	buildMcpConfig(
		repoId: string,
		linearWorkspaceId: string,
		parentSessionId?: string,
	): Record<string, McpServerConfig> {
		const contextId = randomUUID();
		const databaseAuthorizationInput =
			this.deps.resolveDatabaseAuthorizationContext?.({
				capabilityId: contextId,
				repositoryId: repoId,
				parentSessionId,
			});
		const databaseAuthorizationContext = databaseAuthorizationInput
			? this.databaseAuthorizationContexts.issue(
					contextId,
					databaseAuthorizationInput,
				)
			: undefined;

		// Prebuild one SDK server for this context so callback wiring remains deterministic.
		const linearToken = this.deps.getLinearTokenForWorkspace(linearWorkspaceId);
		const issueTracker = this.deps.getIssueTracker(linearWorkspaceId);
		const linearClient =
			linearToken && issueTracker?.getClient
				? issueTracker.getClient()
				: undefined;
		const prebuiltServer = createCyrusToolsServer(
			linearClient,
			this.deps.createCyrusToolsOptions(
				parentSessionId,
				databaseAuthorizationContext,
			),
		);

		const now = this.now();
		this.contexts.set(contextId, {
			contextId,
			repositoryId: repoId,
			linearToken: linearToken ?? undefined,
			linearClient,
			parentSessionId,
			databaseAuthorizationContext,
			prebuiltServer,
			createdAt: now,
			lastAccessAt: now,
			expiresAt: now + this.contextTtlMs,
		});
		this.pruneContexts(this.maxContexts);

		const cyrusToolsAuthorizationHeader = this.getAuthorizationHeaderValue();

		// Workspace-level MCP servers — configured once regardless of repo count
		// https://linear.app/docs/mcp
		const mcpConfig: Record<string, McpServerConfig> = {
			"cyrus-tools": {
				type: "http",
				url: this.deps.getCyrusToolsMcpUrl(),
				headers: {
					"x-cyrus-mcp-context-id": contextId,
					Authorization: cyrusToolsAuthorizationHeader,
				},
			},
			"cyrus-docs": {
				type: "http",
				url: "https://atcyrus.com/docs/mcp",
			},
		};
		if (linearToken) {
			mcpConfig.linear = {
				type: "http",
				url: "https://mcp.linear.app/mcp",
				headers: { Authorization: `Bearer ${linearToken}` },
			};
		}

		// Inject the Slack MCP server whenever SLACK_BOT_TOKEN is available —
		// per-platform availability is enforced upstream by the allowed-tools
		// array. https://github.com/korotovsky/slack-mcp-server
		const slackBotToken = process.env.SLACK_BOT_TOKEN?.trim();
		if (slackBotToken) {
			mcpConfig.slack = {
				command: "npx",
				args: ["-y", "slack-mcp-server@1.2.3", "--transport", "stdio"],
				env: {
					SLACK_MCP_XOXB_TOKEN: slackBotToken,
				},
			};
		}

		return mcpConfig;
	}

	/**
	 * Merge mcpConfigPath from multiple repositories into a single list.
	 * For same-name .mcp.json servers across repos, last wins (handled by Claude's merge behavior).
	 */
	buildMergedMcpConfigPath(
		repositories: RepositoryConfig | RepositoryConfig[],
	): string | string[] | undefined {
		const repoArray = Array.isArray(repositories)
			? repositories
			: [repositories];

		if (repoArray.length === 1) {
			return repoArray[0]!.mcpConfigPath;
		}

		// Collect all mcpConfigPaths from each repo into a flat list
		const allPaths: string[] = [];
		for (const repo of repoArray) {
			if (!repo.mcpConfigPath) continue;
			if (Array.isArray(repo.mcpConfigPath)) {
				allPaths.push(...repo.mcpConfigPath);
			} else {
				allPaths.push(repo.mcpConfigPath);
			}
		}

		if (allPaths.length === 0) return undefined;
		if (allPaths.length === 1) return allPaths[0];
		return allPaths;
	}

	/**
	 * Look up a stored cyrus-tools MCP context by its ID.
	 * Used by the MCP endpoint handler to retrieve prebuilt servers.
	 */
	getContext(contextId: string): CyrusToolsMcpContextEntry | undefined {
		const context = this.contexts.get(contextId);
		if (!context) return undefined;
		const now = this.now();
		if (context.expiresAt <= now) {
			this.contexts.delete(contextId);
			this.databaseAuthorizationContexts.revoke(contextId);
			return undefined;
		}
		if (
			context.databaseAuthorizationContext &&
			!this.databaseAuthorizationContexts.get(
				contextId,
				context.parentSessionId,
			)
		) {
			this.contexts.delete(contextId);
			return undefined;
		}
		context.lastAccessAt = now;
		context.expiresAt = now + this.contextTtlMs;
		return context;
	}

	/** Resolve a still-valid database authorization capability for one session. */
	getDatabaseAuthorizationContext(
		capabilityId: string,
		parentSessionId: string,
	): DatabaseAuthorizationContext | undefined {
		return this.databaseAuthorizationContexts.get(
			capabilityId,
			parentSessionId,
		);
	}

	/**
	 * Clear the prebuilt server from a context entry (after first use).
	 */
	clearPrebuiltServer(contextId: string): void {
		const context = this.contexts.get(contextId);
		if (context) {
			context.prebuiltServer = undefined;
		}
	}

	/**
	 * Clear all stored contexts. Used during shutdown.
	 */
	clearAllContexts(): void {
		this.contexts.clear();
		this.databaseAuthorizationContexts.revokeAll();
	}

	/** Revoke every MCP context issued for a parent session. */
	revokeContextsForParentSession(parentSessionId: string): number {
		let revoked = 0;
		for (const [contextId, context] of this.contexts) {
			if (context.parentSessionId === parentSessionId) {
				this.contexts.delete(contextId);
				this.databaseAuthorizationContexts.revoke(contextId);
				revoked++;
			}
		}
		return revoked;
	}

	/**
	 * Get the authorization header value for cyrus-tools MCP requests.
	 */
	getAuthorizationHeaderValue(): string {
		return `Bearer ${this.localBearer}`;
	}

	/**
	 * Validate an incoming authorization header against the expected value.
	 */
	isAuthorizationValid(rawAuthorizationHeader: unknown): boolean {
		if (typeof rawAuthorizationHeader !== "string") return false;
		const expectedDigest = createHash("sha256")
			.update(this.getAuthorizationHeaderValue())
			.digest();
		const receivedDigest = createHash("sha256")
			.update(rawAuthorizationHeader)
			.digest();
		return timingSafeEqual(receivedDigest, expectedDigest);
	}

	private pruneContexts(maxEntries: number): void {
		const now = this.now();
		for (const [contextId, context] of this.contexts) {
			if (context.expiresAt <= now) {
				this.contexts.delete(contextId);
				this.databaseAuthorizationContexts.revoke(contextId);
			}
		}
		if (this.contexts.size <= maxEntries) {
			return;
		}

		const entriesByAge = Array.from(this.contexts.entries()).sort(
			(a, b) => a[1].lastAccessAt - b[1].lastAccessAt,
		);

		const pruneCount = this.contexts.size - maxEntries;
		for (let i = 0; i < pruneCount; i++) {
			const entry = entriesByAge[i];
			if (!entry) {
				break;
			}
			const [contextId] = entry;
			this.contexts.delete(contextId);
			this.databaseAuthorizationContexts.revoke(contextId);
		}
	}
}
