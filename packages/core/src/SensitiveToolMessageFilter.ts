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
 * Redacts database MCP inputs and results before messages reach Cyrus-owned
 * activities, status renderers, telemetry, or other durable consumers. The
 * provider runner retains its original transcript for session continuity.
 */
export class SensitiveToolMessageFilter {
	private readonly sensitiveToolUseIds = new Map<string, Set<string>>();

	filter<T extends SDKMessage>(sessionId: string, message: T): T {
		if (message.type === "assistant") {
			return this.filterAssistant(sessionId, message) as T;
		}
		if (message.type === "user") {
			return this.filterUser(sessionId, message) as T;
		}
		return message;
	}

	clearSession(sessionId: string): void {
		this.sensitiveToolUseIds.delete(sessionId);
	}

	clearAll(): void {
		this.sensitiveToolUseIds.clear();
	}

	private filterAssistant(sessionId: string, message: SDKMessage): SDKMessage {
		const candidate = message as any;
		const content = candidate.message?.content;
		if (!Array.isArray(content)) return message;
		let changed = false;
		const filtered = content.map((block: any) => {
			if (
				block?.type !== "tool_use" ||
				!isSensitiveDatabaseToolName(block.name)
			) {
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
		if (!ids || ids.size === 0) return message;
		let changed = false;
		const filtered = content.map((block: any) => {
			if (
				block?.type !== "tool_result" ||
				typeof block.tool_use_id !== "string" ||
				!ids.has(block.tool_use_id)
			) {
				return block;
			}
			changed = true;
			ids.delete(block.tool_use_id);
			return {
				...block,
				content: DATABASE_TOOL_PAYLOAD_REDACTION,
			};
		});
		if (ids.size === 0) this.sensitiveToolUseIds.delete(sessionId);
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
}
