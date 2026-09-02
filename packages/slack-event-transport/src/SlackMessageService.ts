import type {
	SlackBlock,
	SlackFile,
	SlackMessageAttachment,
	SlackMessageAuthorProfile,
} from "./types.js";

/**
 * Service for posting messages to Slack channels.
 *
 * Uses the Slack Web API with a bot token to post messages,
 * typically used to reply to @mention webhooks in a thread.
 */

/**
 * A single message from a Slack thread (conversations.replies)
 */
export interface SlackThreadMessage {
	/** User ID who posted the message (absent for some bot messages) */
	user?: string;
	/** Message text */
	text: string;
	/** Message timestamp (unique ID) */
	ts: string;
	/** Bot ID if the message was posted by a bot */
	bot_id?: string;
	/** Message subtype (e.g., "bot_message") */
	subtype?: string;
	/** Display name supplied for legacy/app-authored messages. */
	username?: string;
	/** Rich blocks, including labeled links. */
	blocks?: SlackBlock[];
	/** Shared/unfurled content. */
	attachments?: SlackMessageAttachment[];
	/** File metadata used by secure artifact capture. */
	files?: SlackFile[];
	/** Resolved human profile when supplied by Slack. */
	user_profile?: SlackMessageAuthorProfile;
	/** Resolved bot profile when supplied by Slack. */
	bot_profile?: SlackMessageAuthorProfile;
}

export interface SlackFetchThreadThroughParams
	extends Omit<SlackFetchThreadParams, "limit" | "oldest"> {
	/** Include messages no later than this kickoff/trigger timestamp. */
	trigger_ts: string;
}

export interface SlackThreadSnapshot {
	messages: SlackThreadMessage[];
	permalink: string;
}

/**
 * Parameters for fetching thread messages from Slack
 */
export interface SlackFetchThreadParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID containing the thread */
	channel: string;
	/** Timestamp of the thread parent message */
	thread_ts: string;
	/** Maximum number of messages to fetch (default 100) */
	limit?: number;
	/**
	 * Only fetch messages after this timestamp. Must be server-side: pagination
	 * walks from the thread head, so a client-side filter would never reach
	 * recent messages in a thread longer than `limit`.
	 */
	oldest?: string;
}

/**
 * Parameters for posting a message to Slack
 */
export interface SlackPostMessageParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID to post the message in */
	channel: string;
	/** Message text */
	text: string;
	/** Thread timestamp to reply in a thread */
	thread_ts?: string;
}

/**
 * Parameters for setting the transient loading status shown in a Slack thread.
 */
export interface SlackSetAssistantThreadStatusParams {
	/** Slack Bot OAuth token */
	token: string;
	/** Channel ID containing the thread */
	channel_id: string;
	/** Timestamp of the thread parent message */
	thread_ts: string;
	/** Status text. An empty string clears the current status. */
	status: string;
}

/** A caller-authorized in-memory file to upload to a verified Slack thread. */
export interface SlackFileUploadRequest {
	bytes: Uint8Array;
	filename: string;
	title: string;
}

/** Parameters for uploading an already-authorized batch to one Slack thread. */
export interface SlackUploadFilesToThreadParams {
	/** Slack Bot OAuth token. */
	token: string;
	/** Verified Slack channel ID. */
	channel_id: string;
	/** Verified Slack thread timestamp. */
	thread_ts: string;
	/** In-memory files; this transport never reads paths. */
	files: SlackFileUploadRequest[];
	/** Optional caller-validated comment posted with the completed file batch. */
	initialComment?: string;
}

/** Safe metadata returned after Slack completes an upload. */
export interface SlackUploadedFile {
	id: string;
	title: string;
}

interface SlackApiResponse {
	ok: boolean;
	error?: string;
}

interface SlackUploadUrlResponse extends SlackApiResponse {
	file_id?: string;
	upload_url?: string;
}

const SLACK_UPLOAD_TIMEOUT_MS = 15_000;
const SLACK_POST_CONNECT_RETRY_DELAYS_MS = [250, 1_000] as const;

function isSlackConnectTimeout(error: unknown): boolean {
	// This Undici error happens before a socket is established, so retrying
	// cannot duplicate a message. Do not broaden this to ambiguous failures.
	let current = error;
	for (let depth = 0; depth < 3; depth += 1) {
		if (typeof current !== "object" || current === null) return false;
		const candidate = current as { cause?: unknown; code?: unknown };
		if (candidate.code === "UND_ERR_CONNECT_TIMEOUT") return true;
		current = candidate.cause;
	}
	return false;
}

export class SlackMessageService {
	private apiBaseUrl: string;

	constructor(apiBaseUrl?: string) {
		this.apiBaseUrl = apiBaseUrl ?? "https://slack.com/api";
	}

	/**
	 * Upload already-authorized in-memory files to one verified Slack thread.
	 * The upload URL is a one-time capability and is never included in errors.
	 */
	async uploadFilesToThread(
		params: SlackUploadFilesToThreadParams,
	): Promise<SlackUploadedFile[]> {
		const uploadedFiles: SlackUploadedFile[] = [];

		for (const file of params.files) {
			const ticket = await this.callSlackApi<SlackUploadUrlResponse>(
				params.token,
				"files.getUploadURLExternal",
				new URLSearchParams({
					filename: file.filename,
					length: String(file.bytes.byteLength),
				}),
				"file upload URL request",
			);
			if (!ticket.file_id || !ticket.upload_url) {
				throw new Error(
					"[SlackMessageService] Slack file upload URL request returned an invalid response",
				);
			}

			await this.transferSlackUpload(ticket.upload_url, file.bytes);
			uploadedFiles.push({ id: ticket.file_id, title: file.title });
		}

		await this.callSlackApi<SlackApiResponse>(
			params.token,
			"files.completeUploadExternal",
			new URLSearchParams({
				files: JSON.stringify(uploadedFiles),
				channel_id: params.channel_id,
				thread_ts: params.thread_ts,
				...(params.initialComment !== undefined && {
					initial_comment: params.initialComment,
				}),
			}),
			"file upload completion",
		);

		return uploadedFiles;
	}

	private async callSlackApi<T extends SlackApiResponse>(
		token: string,
		method: string,
		body: URLSearchParams,
		stage: string,
	): Promise<T> {
		let response: Response;
		try {
			response = await fetch(`${this.apiBaseUrl}/${method}`, {
				method: "POST",
				headers: {
					Authorization: `Bearer ${token}`,
					"Content-Type": "application/x-www-form-urlencoded; charset=utf-8",
				},
				body: body.toString(),
			});
		} catch {
			throw new Error(`[SlackMessageService] ${stage} failed`);
		}

		if (!response.ok) {
			throw new Error(`[SlackMessageService] ${stage} failed`);
		}

		let responseBody: T;
		try {
			responseBody = (await response.json()) as T;
		} catch {
			throw new Error(
				`[SlackMessageService] ${stage} returned an invalid response`,
			);
		}
		if (!responseBody.ok) {
			throw new Error(`[SlackMessageService] Slack API error during ${stage}`);
		}
		return responseBody;
	}

	private async transferSlackUpload(
		uploadUrl: string,
		bytes: Uint8Array,
	): Promise<void> {
		if (!isSlackUploadUrl(uploadUrl)) {
			throw new Error("[SlackMessageService] Unsafe Slack file upload URL");
		}

		try {
			const response = await fetch(uploadUrl, {
				method: "POST",
				headers: { "Content-Type": "application/octet-stream" },
				body: bytes,
				redirect: "manual",
				signal: AbortSignal.timeout(SLACK_UPLOAD_TIMEOUT_MS),
			});
			if (!response.ok || (response.status >= 300 && response.status < 400)) {
				throw new Error("transfer failed");
			}
		} catch (error) {
			if (error instanceof Error && error.name === "AbortError") {
				throw new Error(
					"[SlackMessageService] Slack file upload transfer timed out",
				);
			}
			throw new Error(
				"[SlackMessageService] Slack file upload transfer failed",
			);
		}
	}

	/**
	 * Post a message to a Slack channel.
	 *
	 * @see https://api.slack.com/methods/chat.postMessage
	 */
	async postMessage(params: SlackPostMessageParams): Promise<void> {
		const { token, channel, text, thread_ts } = params;

		const url = `${this.apiBaseUrl}/chat.postMessage`;

		const body: Record<string, string> = { channel, text };
		if (thread_ts) {
			body.thread_ts = thread_ts;
		}

		let response: Response;
		for (let attempt = 0; ; attempt += 1) {
			try {
				response = await fetch(url, {
					method: "POST",
					headers: {
						Authorization: `Bearer ${token}`,
						"Content-Type": "application/json",
					},
					body: JSON.stringify(body),
				});
				break;
			} catch (error) {
				const delayMs = SLACK_POST_CONNECT_RETRY_DELAYS_MS[attempt];
				if (delayMs === undefined || !isSlackConnectTimeout(error)) throw error;
				await new Promise((resolve) => setTimeout(resolve, delayMs));
			}
		}

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackMessageService] Failed to post message: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		// Slack API returns HTTP 200 even for errors — check the response body
		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
		};
		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
	}

	/**
	 * Set or clear the loading status displayed in a Slack thread.
	 *
	 * @see https://docs.slack.dev/reference/methods/assistant.threads.setStatus/
	 */
	async setAssistantThreadStatus(
		params: SlackSetAssistantThreadStatusParams,
	): Promise<void> {
		const { token, channel_id, thread_ts, status } = params;
		const url = `${this.apiBaseUrl}/assistant.threads.setStatus`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify({ channel_id, thread_ts, status }),
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackMessageService] Failed to set assistant thread status: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
		};
		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}
	}

	/**
	 * Get the bot's own identity (bot_id, user_id) via auth.test.
	 *
	 * @see https://api.slack.com/methods/auth.test
	 */
	async getIdentity(
		token: string,
	): Promise<{ bot_id?: string; user_id: string }> {
		const url = `${this.apiBaseUrl}/auth.test`;

		const response = await fetch(url, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${token}`,
				"Content-Type": "application/json",
			},
		});

		if (!response.ok) {
			const errorBody = await response.text();
			throw new Error(
				`[SlackMessageService] Failed to get identity: ${response.status} ${response.statusText} - ${errorBody}`,
			);
		}

		const responseBody = (await response.json()) as {
			ok: boolean;
			error?: string;
			bot_id?: string;
			user_id: string;
		};

		if (!responseBody.ok) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
			);
		}

		return { bot_id: responseBody.bot_id, user_id: responseBody.user_id };
	}

	/**
	 * Fetch all messages in a Slack thread using cursor-based pagination.
	 *
	 * @see https://api.slack.com/methods/conversations.replies
	 */
	async fetchThreadMessages(
		params: SlackFetchThreadParams,
	): Promise<SlackThreadMessage[]> {
		const { token, channel, thread_ts, limit = 100, oldest } = params;
		const messages: SlackThreadMessage[] = [];
		let cursor: string | undefined;

		while (messages.length < limit) {
			const queryParams = new URLSearchParams({
				channel,
				ts: thread_ts,
				limit: String(Math.min(limit - messages.length, 200)),
			});
			if (oldest) {
				queryParams.set("oldest", oldest);
			}
			if (cursor) {
				queryParams.set("cursor", cursor);
			}

			const url = `${this.apiBaseUrl}/conversations.replies?${queryParams.toString()}`;

			const response = await fetch(url, {
				method: "GET",
				headers: {
					Authorization: `Bearer ${token}`,
				},
			});

			if (!response.ok) {
				const errorBody = await response.text();
				throw new Error(
					`[SlackMessageService] Failed to fetch thread messages: ${response.status} ${response.statusText} - ${errorBody}`,
				);
			}

			const responseBody = (await response.json()) as {
				ok: boolean;
				error?: string;
				messages?: SlackThreadMessage[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			};

			if (!responseBody.ok) {
				throw new Error(
					`[SlackMessageService] Slack API error: ${responseBody.error ?? "unknown"}`,
				);
			}

			if (responseBody.messages) {
				messages.push(...responseBody.messages);
			}

			// Continue pagination if there are more messages
			const nextCursor = responseBody.response_metadata?.next_cursor;
			if (!responseBody.has_more || !nextCursor) {
				break;
			}
			cursor = nextCursor;
		}

		// Enforce limit
		return messages.slice(0, limit);
	}

	/** Fetch the complete thread through a trigger and its stable Slack permalink. */
	async fetchThreadThrough(
		params: SlackFetchThreadThroughParams,
	): Promise<SlackThreadSnapshot> {
		const { token, channel, thread_ts, trigger_ts } = params;
		const messages: SlackThreadMessage[] = [];
		let cursor: string | undefined;

		do {
			const query = new URLSearchParams({
				channel,
				ts: thread_ts,
				latest: trigger_ts,
				inclusive: "true",
				limit: "200",
			});
			if (cursor) query.set("cursor", cursor);
			const response = await fetch(
				`${this.apiBaseUrl}/conversations.replies?${query.toString()}`,
				{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
			);
			if (!response.ok) {
				throw new Error(
					`[SlackMessageService] Failed to fetch thread messages: ${response.status} ${response.statusText}`,
				);
			}
			const body = (await response.json()) as {
				ok: boolean;
				error?: string;
				messages?: SlackThreadMessage[];
				has_more?: boolean;
				response_metadata?: { next_cursor?: string };
			};
			if (!body.ok) {
				throw new Error(
					`[SlackMessageService] Slack API error: ${body.error ?? "unknown"}`,
				);
			}
			messages.push(...(body.messages ?? []));
			if (body.has_more) {
				const nextCursor = body.response_metadata?.next_cursor?.trim();
				if (!nextCursor) {
					throw new Error(
						"[SlackMessageService] Slack API returned incomplete pagination: has_more without next_cursor",
					);
				}
				cursor = nextCursor;
			} else {
				cursor = undefined;
			}
		} while (cursor);

		const permalinkQuery = new URLSearchParams({
			channel,
			message_ts: thread_ts,
		});
		const permalinkResponse = await fetch(
			`${this.apiBaseUrl}/chat.getPermalink?${permalinkQuery.toString()}`,
			{ method: "GET", headers: { Authorization: `Bearer ${token}` } },
		);
		if (!permalinkResponse.ok) {
			throw new Error(
				`[SlackMessageService] Failed to fetch thread permalink: ${permalinkResponse.status} ${permalinkResponse.statusText}`,
			);
		}
		const permalinkBody = (await permalinkResponse.json()) as {
			ok: boolean;
			error?: string;
			permalink?: string;
		};
		if (!permalinkBody.ok || !permalinkBody.permalink) {
			throw new Error(
				`[SlackMessageService] Slack API error: ${permalinkBody.error ?? "missing_permalink"}`,
			);
		}

		return {
			messages: messages
				.filter((message) => message.ts <= trigger_ts)
				.sort((a, b) => a.ts.localeCompare(b.ts)),
			permalink: permalinkBody.permalink,
		};
	}
}

function isSlackUploadUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.protocol === "https:" &&
			url.hostname === "files.slack.com" &&
			url.port === "" &&
			url.username === "" &&
			url.password === ""
		);
	} catch {
		return false;
	}
}
