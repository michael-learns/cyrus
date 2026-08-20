import type { AgentTurn, ILogger, RunnerType } from "cyrus-core";
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";

export interface GitHubIssueStartRequest {
	workItemId: string;
	/** Repository that owns the source issue. */
	repositoryFullName: string;
	issueNumber: number;
	/** Configured repositories whose worktrees participate in the fix. */
	targetRepositoryFullNames?: string[];
	runnerType: RunnerType;
	requestId: string;
}

/** Server-internal extension. HTTP controllers only emit GitHubIssueStartRequest. */
export interface TrustedGitHubIssueStartRequest
	extends GitHubIssueStartRequest {
	initialTurn?: AgentTurn;
}

export interface GitHubIssuePromptRequest {
	requestId: string;
	commentId: number;
	author: string;
	body: string;
	url?: string;
}

export interface GitHubIssueStopRequest {
	requestId: string;
	reason: "source_closed" | "user_requested";
}

export interface GitHubIssueStartResult {
	sessionId: string;
	status: "starting" | "in_progress" | "awaiting_review";
}

export interface GitHubIssueWorkItemHandlers {
	start(
		request: GitHubIssueStartRequest,
		installationToken?: string,
	): Promise<GitHubIssueStartResult>;
	prompt(
		workItemId: string,
		request: GitHubIssuePromptRequest,
		installationToken?: string,
	): Promise<void>;
	stop(workItemId: string, request: GitHubIssueStopRequest): Promise<void>;
}

interface ControllerConfig {
	fastifyServer: FastifyInstance;
	apiKey: () => string | undefined;
	handlers: GitHubIssueWorkItemHandlers;
	logger: ILogger;
}

const RUNNER_TYPES: RunnerType[] = ["claude", "gemini", "codex", "cursor"];

/**
 * Authenticated control-plane routes for manually starting and controlling a
 * GitHub Issue session. The hosted app owns inbox persistence; this controller
 * deliberately keeps only short-lived idempotency state.
 */
export class GitHubIssueWorkItemController {
	private readonly completedRequests = new Map<
		string,
		GitHubIssueStartResult
	>();
	private readonly pendingRequests = new Map<
		string,
		Promise<GitHubIssueStartResult>
	>();

	constructor(private readonly config: ControllerConfig) {}

	register(): void {
		const app = this.config.fastifyServer;

		app.post(
			"/api/work-items/start",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!this.authorize(request, reply)) return;
				const body = this.parseStartRequest(request.body);
				if (!body) {
					reply
						.code(400)
						.send({ error: "Invalid GitHub work-item start request" });
					return;
				}

				try {
					const result = await this.startOnce(
						body,
						this.installationToken(request),
					);
					reply.code(202).send(result);
				} catch (error) {
					this.sendHandlerError(reply, error);
				}
			},
		);

		app.post(
			"/api/work-items/:workItemId/prompt",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!this.authorize(request, reply)) return;
				const workItemId = this.workItemId(request);
				const body = this.parsePromptRequest(request.body);
				if (!workItemId || !body) {
					reply
						.code(400)
						.send({ error: "Invalid GitHub work-item prompt request" });
					return;
				}

				try {
					await this.config.handlers.prompt(
						workItemId,
						body,
						this.installationToken(request),
					);
					reply.code(202).send({ success: true });
				} catch (error) {
					this.sendHandlerError(reply, error);
				}
			},
		);

		app.post(
			"/api/work-items/:workItemId/stop",
			async (request: FastifyRequest, reply: FastifyReply) => {
				if (!this.authorize(request, reply)) return;
				const workItemId = this.workItemId(request);
				const body = this.parseStopRequest(request.body);
				if (!workItemId || !body) {
					reply
						.code(400)
						.send({ error: "Invalid GitHub work-item stop request" });
					return;
				}

				try {
					await this.config.handlers.stop(workItemId, body);
					reply.code(202).send({ success: true });
				} catch (error) {
					this.sendHandlerError(reply, error);
				}
			},
		);
	}

	private authorize(request: FastifyRequest, reply: FastifyReply): boolean {
		const apiKey = this.config.apiKey();
		if (!apiKey) {
			reply.code(503).send({ error: "Cyrus worker is not paired" });
			return false;
		}
		if (request.headers.authorization !== `Bearer ${apiKey}`) {
			reply.code(401).send({ error: "Invalid authorization token" });
			return false;
		}
		return true;
	}

	private async startOnce(
		request: GitHubIssueStartRequest,
		installationToken?: string,
	): Promise<GitHubIssueStartResult> {
		const completed = this.completedRequests.get(request.requestId);
		if (completed) return completed;

		const pending = this.pendingRequests.get(request.requestId);
		if (pending) return pending;

		const start = this.config.handlers.start(request, installationToken);
		this.pendingRequests.set(request.requestId, start);
		try {
			const result = await start;
			this.completedRequests.set(request.requestId, result);
			if (this.completedRequests.size > 1_000) {
				const oldestRequestId = this.completedRequests.keys().next().value;
				if (oldestRequestId) this.completedRequests.delete(oldestRequestId);
			}
			return result;
		} finally {
			this.pendingRequests.delete(request.requestId);
		}
	}

	private parseStartRequest(value: unknown): GitHubIssueStartRequest | null {
		if (!value || typeof value !== "object") return null;
		const body = value as Record<string, unknown>;
		if (
			!this.nonEmptyString(body.workItemId) ||
			!this.nonEmptyString(body.repositoryFullName) ||
			!Number.isInteger(body.issueNumber) ||
			(body.issueNumber as number) <= 0 ||
			!RUNNER_TYPES.includes(body.runnerType as RunnerType) ||
			(body.targetRepositoryFullNames !== undefined &&
				(!Array.isArray(body.targetRepositoryFullNames) ||
					body.targetRepositoryFullNames.length === 0 ||
					body.targetRepositoryFullNames.some(
						(value) => !this.nonEmptyString(value),
					))) ||
			!this.nonEmptyString(body.requestId)
		) {
			return null;
		}
		return {
			workItemId: body.workItemId as string,
			repositoryFullName: body.repositoryFullName as string,
			issueNumber: body.issueNumber as number,
			...(body.targetRepositoryFullNames
				? {
						targetRepositoryFullNames:
							body.targetRepositoryFullNames as string[],
					}
				: {}),
			runnerType: body.runnerType as RunnerType,
			requestId: body.requestId as string,
		};
	}

	private parsePromptRequest(value: unknown): GitHubIssuePromptRequest | null {
		if (!value || typeof value !== "object") return null;
		const body = value as Record<string, unknown>;
		if (
			!this.nonEmptyString(body.requestId) ||
			!Number.isInteger(body.commentId) ||
			!this.nonEmptyString(body.author) ||
			!this.nonEmptyString(body.body) ||
			(body.url !== undefined && typeof body.url !== "string")
		) {
			return null;
		}
		return body as unknown as GitHubIssuePromptRequest;
	}

	private parseStopRequest(value: unknown): GitHubIssueStopRequest | null {
		if (!value || typeof value !== "object") return null;
		const body = value as Record<string, unknown>;
		if (
			!this.nonEmptyString(body.requestId) ||
			(body.reason !== "source_closed" && body.reason !== "user_requested")
		) {
			return null;
		}
		return body as unknown as GitHubIssueStopRequest;
	}

	private workItemId(request: FastifyRequest): string | undefined {
		const params = request.params as { workItemId?: unknown };
		return this.nonEmptyString(params?.workItemId)
			? (params.workItemId as string)
			: undefined;
	}

	private installationToken(request: FastifyRequest): string | undefined {
		const token = request.headers["x-github-installation-token"];
		return typeof token === "string" && token.length > 0 ? token : undefined;
	}

	private nonEmptyString(value: unknown): value is string {
		return typeof value === "string" && value.trim().length > 0;
	}

	private sendHandlerError(reply: FastifyReply, error: unknown): void {
		const err = error instanceof Error ? error : new Error(String(error));
		this.config.logger.warn("GitHub work-item request failed", err);
		const statusCode =
			"statusCode" in err && typeof err.statusCode === "number"
				? err.statusCode
				: 500;
		reply.code(statusCode).send({ error: err.message });
	}
}
