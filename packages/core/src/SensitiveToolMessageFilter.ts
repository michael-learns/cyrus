import type { SDKMessage } from "./agent-runner-types.js";

export const DATABASE_TOOL_PAYLOAD_REDACTION =
	"Sensitive database payload redacted by Cyrus";
export const DATABASE_TOOL_ACTIVITY_LABEL = "Database operation";

const DATABASE_TOOL_NAME_PATTERN =
	/(?:^|_+)database_(?:connections_list|query)$/i;

export function isSensitiveDatabaseToolName(name: unknown): boolean {
	return typeof name === "string" && DATABASE_TOOL_NAME_PATTERN.test(name);
}

/**
 * Redacts database MCP inputs/results plus all later generated content in that
 * turn before messages reach Cyrus-owned activities, status renderers,
 * telemetry, or other durable consumers. The provider runner retains its
 * original transcript for session continuity and direct Slack replies.
 */
export class SensitiveToolMessageFilter {
	private readonly sensitiveToolUseIds = new Map<string, Set<string>>();
	private readonly sensitiveTurns = new Set<string>();
	private readonly sensitiveSessions = new Set<string>();

	filter<T extends SDKMessage>(sessionId: string, message: T): T {
		if (message.type === "assistant") {
			return this.filterAssistant(sessionId, message) as T;
		}
		if (message.type === "user") {
			return this.filterUser(sessionId, message) as T;
		}
		if (message.type === "result") {
			return this.filterResult(sessionId, message) as T;
		}
		return message;
	}

	clearSession(sessionId: string): void {
		this.sensitiveToolUseIds.delete(sessionId);
		this.sensitiveTurns.delete(sessionId);
		this.sensitiveSessions.delete(sessionId);
	}

	clearAll(): void {
		this.sensitiveToolUseIds.clear();
		this.sensitiveTurns.clear();
		this.sensitiveSessions.clear();
	}

	hasSeenSensitiveData(sessionId: string): boolean {
		return this.sensitiveSessions.has(sessionId);
	}

	private filterAssistant(sessionId: string, message: SDKMessage): SDKMessage {
		const candidate = message as any;
		const content = candidate.message?.content;
		if (!Array.isArray(content)) return message;
		if (
			content.some(
				(block: any) =>
					block?.type === "tool_use" && isSensitiveDatabaseToolName(block.name),
			)
		) {
			this.sensitiveTurns.add(sessionId);
			this.sensitiveSessions.add(sessionId);
		}
		const redactTurn = this.sensitiveTurns.has(sessionId);
		let changed = false;
		const filtered = content.map((block: any) => {
			if (redactTurn && block?.type === "text") {
				changed = true;
				return { ...block, text: DATABASE_TOOL_PAYLOAD_REDACTION };
			}
			if (
				block?.type !== "tool_use" ||
				!isSensitiveDatabaseToolName(block.name)
			) {
				if (redactTurn && block?.type === "tool_use") {
					changed = true;
					return {
						...block,
						input: { redacted: DATABASE_TOOL_PAYLOAD_REDACTION },
					};
				}
				return block;
			}
			changed = true;
			if (typeof block.id === "string") {
				let ids = this.sensitiveToolUseIds.get(sessionId);
				if (!ids) {
					ids = new Set();
					this.sensitiveToolUseIds.set(sessionId, ids);
				}
				ids.add(block.id);
			}
			return {
				...block,
				input: { redacted: DATABASE_TOOL_PAYLOAD_REDACTION },
			};
		});
		if (!changed) return message;
		return {
			...candidate,
			message: { ...candidate.message, content: filtered },
		};
	}

	private filterUser(sessionId: string, message: SDKMessage): SDKMessage {
		const candidate = message as any;
		const content = candidate.message?.content;
		if (!Array.isArray(content)) return message;
		const ids = this.sensitiveToolUseIds.get(sessionId);
		const redactTurn = this.sensitiveTurns.has(sessionId);
		if ((!ids || ids.size === 0) && !redactTurn) return message;
		let changed = false;
		const filtered = content.map((block: any) => {
			if (
				block?.type !== "tool_result" ||
				(!redactTurn &&
					(typeof block.tool_use_id !== "string" ||
						!ids?.has(block.tool_use_id)))
			) {
				return block;
			}
			changed = true;
			if (typeof block.tool_use_id === "string") {
				ids?.delete(block.tool_use_id);
			}
			return {
				...block,
				content: DATABASE_TOOL_PAYLOAD_REDACTION,
			};
		});
		if (ids?.size === 0) this.sensitiveToolUseIds.delete(sessionId);
		if (!changed) return message;
		return {
			...candidate,
			message: { ...candidate.message, content: filtered },
			...(candidate.tool_use_result === undefined
				? {}
				: {
						tool_use_result: {
							redacted: DATABASE_TOOL_PAYLOAD_REDACTION,
						},
					}),
		};
	}

	private filterResult(sessionId: string, message: SDKMessage): SDKMessage {
		if (!this.sensitiveTurns.delete(sessionId)) return message;
		this.sensitiveToolUseIds.delete(sessionId);
		const candidate = message as any;
		return {
			...candidate,
			...(typeof candidate.result === "string"
				? { result: DATABASE_TOOL_PAYLOAD_REDACTION }
				: {}),
			...(Array.isArray(candidate.errors)
				? { errors: [DATABASE_TOOL_PAYLOAD_REDACTION] }
				: {}),
		};
	}
}
