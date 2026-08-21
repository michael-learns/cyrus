export type DatabaseAuthorizationContext = Readonly<{
	capabilityId: string;
	platform: "slack" | "slack-engineering";
	teamId: string;
	channelId: string;
	userId: string;
	parentSessionId: string;
	workItemId?: string;
	repositoryIds: readonly string[];
	issuedAt: number;
	expiresAt: number;
}>;

export type DatabaseAuthorizationContextInput =
	| {
			platform: "slack";
			teamId: string;
			channelId: string;
			userId: string;
			parentSessionId: string;
			repositoryIds: readonly string[];
	  }
	| {
			platform: "slack-engineering";
			teamId: string;
			channelId: string;
			userId: string;
			parentSessionId: string;
			workItemId: string;
			repositoryIds: readonly string[];
	  };

export interface DatabaseAuthorizationContextServiceOptions {
	now?: () => number;
	ttlMs?: number;
	maxContexts?: number;
}

const DEFAULT_TTL_MS = 24 * 60 * 60 * 1_000;
const DEFAULT_MAX_CONTEXTS = 500;

export class DatabaseAuthorizationContextService {
	private readonly contexts = new Map<string, DatabaseAuthorizationContext>();
	private readonly now: () => number;
	private readonly ttlMs: number;
	private readonly maxContexts: number;

	constructor(options: DatabaseAuthorizationContextServiceOptions = {}) {
		this.now = options.now ?? Date.now;
		this.ttlMs = options.ttlMs ?? DEFAULT_TTL_MS;
		this.maxContexts = options.maxContexts ?? DEFAULT_MAX_CONTEXTS;
		if (!Number.isSafeInteger(this.ttlMs) || this.ttlMs <= 0) {
			throw new Error("Database authorization TTL must be a positive integer");
		}
		if (!Number.isSafeInteger(this.maxContexts) || this.maxContexts <= 0) {
			throw new Error(
				"Database authorization capacity must be a positive integer",
			);
		}
	}

	issue(
		capabilityId: string,
		input: DatabaseAuthorizationContextInput,
	): DatabaseAuthorizationContext {
		this.assertInput(capabilityId, input);
		const issuedAt = this.now();
		const context = Object.freeze({
			...input,
			capabilityId,
			repositoryIds: Object.freeze([...new Set(input.repositoryIds)]),
			issuedAt,
			expiresAt: issuedAt + this.ttlMs,
		});
		this.contexts.set(capabilityId, context);
		this.prune();
		return context;
	}

	get(
		capabilityId: string,
		expectedParentSessionId?: string,
	): DatabaseAuthorizationContext | undefined {
		const context = this.contexts.get(capabilityId);
		if (!context) return undefined;
		if (context.expiresAt <= this.now()) {
			this.contexts.delete(capabilityId);
			return undefined;
		}
		if (
			expectedParentSessionId !== undefined &&
			context.parentSessionId !== expectedParentSessionId
		) {
			return undefined;
		}
		return context;
	}

	revoke(capabilityId: string): boolean {
		return this.contexts.delete(capabilityId);
	}

	revokeParentSession(parentSessionId: string): number {
		let revoked = 0;
		for (const [capabilityId, context] of this.contexts) {
			if (context.parentSessionId === parentSessionId) {
				this.contexts.delete(capabilityId);
				revoked++;
			}
		}
		return revoked;
	}

	revokeAll(): void {
		this.contexts.clear();
	}

	private assertInput(
		capabilityId: string,
		input: DatabaseAuthorizationContextInput,
	): void {
		if (!isNonEmpty(capabilityId))
			throw new Error("Missing database capability ID");
		if (input.platform !== "slack" && input.platform !== "slack-engineering") {
			throw new Error("Unsupported database authorization platform");
		}
		for (const value of [
			input.teamId,
			input.channelId,
			input.userId,
			input.parentSessionId,
		]) {
			if (!isNonEmpty(value))
				throw new Error("Incomplete Slack authorization context");
		}
		if (
			input.platform === "slack-engineering" &&
			!isNonEmpty(input.workItemId)
		) {
			throw new Error("Missing Slack engineering work item");
		}
		if (
			!Array.isArray(input.repositoryIds) ||
			input.repositoryIds.length === 0 ||
			input.repositoryIds.some((repositoryId) => !isNonEmpty(repositoryId))
		) {
			throw new Error("Missing database authorization repositories");
		}
	}

	private prune(): void {
		const now = this.now();
		for (const [capabilityId, context] of this.contexts) {
			if (context.expiresAt <= now) this.contexts.delete(capabilityId);
		}
		if (this.contexts.size <= this.maxContexts) return;
		const oldest = [...this.contexts.values()].sort(
			(left, right) => left.issuedAt - right.issuedAt,
		);
		for (const context of oldest.slice(
			0,
			this.contexts.size - this.maxContexts,
		)) {
			this.contexts.delete(context.capabilityId);
		}
	}
}

function isNonEmpty(value: unknown): value is string {
	return (
		typeof value === "string" && value.length > 0 && value.trim() === value
	);
}
