import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	SlackBlock,
	SlackFile,
	SlackMessageAttachment,
	SlackThreadMessage,
} from "cyrus-slack-event-transport";
import {
	classifySlackFile,
	hasSlackMediaSignal,
	MAX_EMBEDDED_IMAGE_BYTES,
	MAX_OTHER_FILE_BYTES,
	MAX_RECEIVED_DOWNLOAD_BYTES,
	MAX_SLACK_CAPTURE_FILES,
	SLACK_DOWNLOAD_TIMEOUT_MS,
	SUPPORTED_SLACK_IMAGES,
} from "./SlackFilePolicy.js";

const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGES = MAX_SLACK_CAPTURE_FILES;

export interface SlackConversationLink {
	label: string;
	url: string;
}

export interface SlackCapturedFile {
	id: string;
	name: string;
	mimeType?: string;
	size?: number;
	status: "downloaded" | "skipped" | "failed";
	reason?: string;
	localPath?: string;
}

export interface SlackConversationMessage {
	ts: string;
	author: string;
	text: string;
	links: SlackConversationLink[];
	attachments?: Array<{ author: string; source?: string; text: string }>;
	forwarded: Array<{ author: string; source?: string; text: string }>;
	files: SlackCapturedFile[];
}

export interface SlackConversationTruncation {
	kind:
		| "messages"
		| "text"
		| "images"
		| "files"
		| "image_size"
		| "total_downloads"
		| "unsupported_file";
	omitted?: number;
	detail: string;
}

export interface SlackConversationManifest {
	version: 1;
	source: {
		teamId: string;
		channelId: string;
		threadTs: string;
		kickoffTs: string;
		permalink: string;
	};
	limits: {
		messages: number;
		textCharacters: number;
		images: number;
		imageBytes: number;
		otherFileBytes: number;
		totalDownloadBytes: number;
	};
	messages: SlackConversationMessage[];
	truncations: SlackConversationTruncation[];
}

export interface SlackConversationCaptureInput {
	teamId: string;
	channelId: string;
	threadTs: string;
	kickoffTs: string;
	threadPermalink: string;
	token: string;
	messages: SlackThreadMessage[];
	captureRoot?: string;
	eventId?: string;
}

interface CaptureLogger {
	warn?(message: string): void;
}

export interface SlackConversationContextServiceOptions {
	cyrusHome: string;
	fetch?: typeof fetch;
	logger?: CaptureLogger;
	requestTimeoutMs?: number;
}

function isPrivateSlackFileUrl(value: string): boolean {
	try {
		const url = new URL(value);
		return (
			url.hostname === "files.slack.com" ||
			url.hostname.endsWith(".files.slack.com") ||
			url.hostname === "slack-files.com" ||
			url.hostname.endsWith(".slack-files.com")
		);
	} catch {
		return false;
	}
}

function isSlackOwnedHost(url: URL): boolean {
	return url.protocol === "https:" && url.host === "files.slack.com";
}

function messageTextFootprint(message: SlackConversationMessage): number {
	return (
		message.ts.length +
		message.author.length +
		message.text.length +
		message.links.reduce(
			(total, link) => total + link.label.length + link.url.length,
			0,
		) +
		(message.attachments ?? []).reduce(
			(total, item) =>
				total +
				item.author.length +
				(item.source?.length ?? 0) +
				item.text.length,
			0,
		) +
		message.forwarded.reduce(
			(total, item) =>
				total +
				item.author.length +
				(item.source?.length ?? 0) +
				item.text.length,
			0,
		) +
		message.files.reduce(
			(total, file) =>
				total +
				file.id.length +
				file.name.length +
				(file.mimeType?.length ?? 0) +
				file.status.length +
				(file.reason?.length ?? 0) +
				(file.localPath?.length ?? 0),
			0,
		)
	);
}

function fitMessageToTextBudget(
	message: SlackConversationMessage,
	budget: number,
): SlackConversationMessage {
	let remaining = budget;
	const take = (value: string): string => {
		const result = value.slice(0, remaining);
		remaining -= result.length;
		return result;
	};
	const fitted: SlackConversationMessage = {
		ts: take(message.ts),
		text: take(message.text),
		author: take(message.author),
		links: [],
		attachments: [],
		forwarded: [],
		files: [],
	};
	for (const link of message.links) {
		if (remaining === 0) break;
		fitted.links.push({ label: take(link.label), url: take(link.url) });
	}
	for (const item of message.attachments ?? []) {
		if (remaining === 0) break;
		fitted.attachments!.push({
			author: take(item.author),
			...(item.source !== undefined && { source: take(item.source) }),
			text: take(item.text),
		});
	}
	for (const item of message.forwarded) {
		if (remaining === 0) break;
		fitted.forwarded.push({
			author: take(item.author),
			...(item.source !== undefined && { source: take(item.source) }),
			text: take(item.text),
		});
	}
	for (const file of message.files) {
		if (remaining < file.status.length) break;
		remaining -= file.status.length;
		fitted.files.push({
			id: take(file.id),
			name: take(file.name),
			...(file.mimeType !== undefined && { mimeType: take(file.mimeType) }),
			...(file.size !== undefined && { size: file.size }),
			status: file.status,
			...(file.reason !== undefined && { reason: take(file.reason) }),
			...(file.localPath !== undefined && { localPath: take(file.localPath) }),
		});
	}
	return fitted;
}

async function readBodyWithinLimit(
	body: ReadableStream<Uint8Array> | null,
	limit: number,
): Promise<{
	buffer: Buffer;
	bytesReceived: number;
	exceeded: boolean;
	error?: unknown;
}> {
	if (!body)
		return { buffer: Buffer.alloc(0), bytesReceived: 0, exceeded: false };
	const reader = body.getReader();
	const chunks: Buffer[] = [];
	let bytesReceived = 0;
	try {
		while (true) {
			const { done, value } = await reader.read();
			if (done) break;
			const chunk = Buffer.from(value);
			const available = limit - bytesReceived;
			if (chunk.length > available) {
				if (available > 0) chunks.push(chunk.subarray(0, available));
				bytesReceived += chunk.length;
				await reader.cancel().catch(() => undefined);
				return {
					buffer: Buffer.concat(chunks),
					bytesReceived,
					exceeded: true,
				};
			}
			chunks.push(chunk);
			bytesReceived += chunk.length;
		}
		return {
			buffer: Buffer.concat(chunks, bytesReceived),
			bytesReceived,
			exceeded: false,
		};
	} catch (error) {
		await reader.cancel().catch(() => undefined);
		return {
			buffer: Buffer.concat(chunks, bytesReceived),
			bytesReceived,
			exceeded: false,
			error,
		};
	}
}

function redact(value: string, token: string): string {
	let safe = token ? value.split(token).join("[REDACTED]") : value;
	safe = safe.replace(/xox[baprs]-[A-Za-z0-9-]+/g, "[REDACTED]");
	safe = safe.replace(/https:\/\/[^\s<>]+/g, (url) =>
		isPrivateSlackFileUrl(url) ? "[PRIVATE_SLACK_FILE_URL]" : url,
	);
	return safe;
}

function flattenBlocks(blocks: SlackBlock[] | undefined): string {
	const output: string[] = [];
	const visit = (node: {
		type?: string;
		text?: string;
		url?: string;
		user_id?: string;
		elements?: unknown[];
	}): void => {
		if (typeof node.text === "string") output.push(node.text);
		else if (node.type === "link" && node.url) output.push(node.url);
		else if (node.type === "user" && node.user_id)
			output.push(`<@${node.user_id}>`);
		if (Array.isArray(node.elements)) {
			for (const child of node.elements) visit(child as typeof node);
		}
	};
	for (const block of blocks ?? []) visit(block);
	return output.join("").trim();
}

function collectLinks(
	text: string,
	blocks: SlackBlock[] | undefined,
	attachments: SlackMessageAttachment[] | undefined,
	token: string,
): SlackConversationLink[] {
	const links: SlackConversationLink[] = [];
	for (const match of text.matchAll(/<(https?:\/\/[^>|]+)(?:\|([^>]+))?>/g)) {
		const url = match[1];
		if (url && !isPrivateSlackFileUrl(url)) {
			links.push({
				label: redact(match[2] || url, token),
				url: redact(url, token),
			});
		}
	}
	const visit = (node: {
		type?: string;
		text?: string;
		url?: string;
		elements?: unknown[];
	}): void => {
		if (node.type === "link" && node.url && !isPrivateSlackFileUrl(node.url)) {
			links.push({
				label: redact(node.text || node.url, token),
				url: redact(node.url, token),
			});
		}
		for (const child of node.elements ?? []) visit(child as typeof node);
	};
	for (const block of blocks ?? []) visit(block);
	for (const attachment of attachments ?? []) {
		const url = attachment.title_link || attachment.from_url;
		if (url && !isPrivateSlackFileUrl(url)) {
			links.push({
				label: redact(attachment.title || url, token),
				url: redact(url, token),
			});
		}
	}
	return [
		...new Map(
			links.map((link) => [`${link.label}\0${link.url}`, link]),
		).values(),
	];
}

function forwardedContent(
	attachments: SlackMessageAttachment[] | undefined,
	token: string,
) {
	return (attachments ?? [])
		.filter((attachment) => attachment.is_share || attachment.is_msg_unfurl)
		.map((attachment) => {
			const fromMessageBlocks = (attachment.message_blocks ?? [])
				.map((item) => flattenBlocks(item.message?.blocks))
				.filter(Boolean)
				.join("\n");
			return {
				author: redact(
					attachment.author_name ||
						attachment.author_subname ||
						attachment.author_id ||
						"unknown",
					token,
				),
				...((attachment.channel_name || attachment.footer) && {
					source: redact(
						attachment.channel_name
							? `#${attachment.channel_name}`
							: attachment.footer!,
						token,
					),
				}),
				text: redact(
					attachment.text ||
						flattenBlocks(attachment.blocks) ||
						fromMessageBlocks ||
						attachment.fallback ||
						"",
					token,
				),
			};
		})
		.filter((item) => item.text);
}

function ordinaryAttachmentContent(
	attachments: SlackMessageAttachment[] | undefined,
	token: string,
) {
	return (attachments ?? [])
		.filter((attachment) => !attachment.is_share && !attachment.is_msg_unfurl)
		.map((attachment) => {
			const rawAuthor =
				attachment.author_name ||
				attachment.author_subname ||
				attachment.author_id ||
				attachment.footer ||
				"unknown";
			const rawSource =
				attachment.channel_name ||
				(attachment.footer && attachment.footer !== rawAuthor
					? attachment.footer
					: undefined);
			const fromMessageBlocks = (attachment.message_blocks ?? [])
				.map((item) => flattenBlocks(item.message?.blocks))
				.filter(Boolean)
				.join("\n");
			return {
				author: redact(rawAuthor, token),
				...(rawSource && {
					source: redact(
						attachment.channel_name ? `#${rawSource}` : rawSource,
						token,
					),
				}),
				text: redact(
					attachment.text ||
						flattenBlocks(attachment.blocks) ||
						fromMessageBlocks ||
						attachment.fallback ||
						"",
					token,
				),
			};
		})
		.filter((item) => item.text);
}

export class SlackConversationContextService {
	private readonly cyrusHome: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger?: CaptureLogger;
	private readonly requestTimeoutMs: number;

	constructor(options: SlackConversationContextServiceOptions) {
		this.cyrusHome = options.cyrusHome;
		this.fetchImpl = options.fetch ?? fetch;
		this.logger = options.logger;
		this.requestTimeoutMs =
			options.requestTimeoutMs ?? SLACK_DOWNLOAD_TIMEOUT_MS;
	}

	async capture(input: SlackConversationCaptureInput): Promise<{
		directory: string;
		manifestPath: string;
		transcriptPath: string;
		manifest: SlackConversationManifest;
	}> {
		const truncations: SlackConversationTruncation[] = [];
		const chronological = input.messages
			.filter((message) => message.ts <= input.kickoffTs)
			.sort((a, b) => a.ts.localeCompare(b.ts));
		let selected = chronological;
		if (selected.length > MAX_MESSAGES) {
			const omitted = selected.length - MAX_MESSAGES;
			selected = [selected[0]!, ...selected.slice(-(MAX_MESSAGES - 1))];
			truncations.push({
				kind: "messages",
				omitted,
				detail: `${omitted} older messages omitted; root and newest messages preserved`,
			});
		}

		let normalized = selected.map((message) =>
			this.normalizeMessage(message, input.token),
		);

		const key = createHash("sha256")
			.update(
				`${input.teamId}\0${input.channelId}\0${input.threadTs}\0${input.kickoffTs}`,
			)
			.digest("hex")
			.slice(0, 24);
		const directory =
			input.captureRoot ?? join(this.cyrusHome, "slack-context", key);
		const imagesDirectory = join(directory, "images");
		const safeEvent =
			redact(input.eventId ?? key, input.token)
				.replace(/[^a-zA-Z0-9_-]+/g, "-")
				.replace(/^-+|-+$/g, "") || "event";
		const attachmentsDirectory = join(directory, "attachments", safeEvent);
		await mkdir(imagesDirectory, { recursive: true, mode: 0o700 });
		await mkdir(attachmentsDirectory, { recursive: true, mode: 0o700 });

		let imageCount = 0;
		let receivedBytes = 0;
		let fileCount = 0;
		for (const message of normalized) {
			for (let index = 0; index < message.files.length; index++) {
				const original = selected.find((item) => item.ts === message.ts)
					?.files?.[index];
				if (!original) continue;
				const result =
					fileCount >= MAX_SLACK_CAPTURE_FILES
						? {
								file: { ...message.files[index]!, reason: "file_limit" },
								bytesReceived: 0,
							}
						: await this.captureFile(
								original,
								input.token,
								imagesDirectory,
								attachmentsDirectory,
								imageCount,
								receivedBytes,
								fileCount,
							);
				fileCount++;
				message.files[index] = result.file;
				if (
					original.mimetype &&
					SUPPORTED_SLACK_IMAGES.has(original.mimetype) &&
					result.file.reason !== "image_limit" &&
					result.file.reason !== "file_too_large" &&
					result.file.reason !== "total_download_limit"
				) {
					imageCount++;
				}
				receivedBytes += result.bytesReceived;
				if (result.file.reason === "image_limit") {
					truncations.push({
						kind: "images",
						omitted: 1,
						detail: "image omitted after 20-image limit",
					});
				} else if (result.file.reason === "file_limit") {
					truncations.push({
						kind: "files",
						omitted: 1,
						detail: "file omitted after 20-file limit",
					});
				} else if (result.file.reason === "file_too_large") {
					truncations.push({
						kind: "image_size",
						omitted: 1,
						detail: "file exceeded its download-size limit",
					});
				} else if (result.file.reason === "total_download_limit") {
					truncations.push({
						kind: "total_downloads",
						omitted: 1,
						detail: "file omitted after 100 MiB total-download limit",
					});
				} else if (result.file.reason === "unsupported_type") {
					truncations.push({
						kind: "unsupported_file",
						omitted: 1,
						detail: "unsupported non-image file retained as metadata only",
					});
				}
			}
		}
		normalized = this.applyTextLimit(normalized, truncations);

		const manifest: SlackConversationManifest = {
			version: 1,
			source: {
				teamId: redact(input.teamId, input.token),
				channelId: redact(input.channelId, input.token),
				threadTs: redact(input.threadTs, input.token),
				kickoffTs: redact(input.kickoffTs, input.token),
				permalink: redact(input.threadPermalink, input.token),
			},
			limits: {
				messages: 200,
				textCharacters: 100000,
				images: 20,
				imageBytes: MAX_EMBEDDED_IMAGE_BYTES,
				otherFileBytes: MAX_OTHER_FILE_BYTES,
				totalDownloadBytes: MAX_RECEIVED_DOWNLOAD_BYTES,
			},
			messages: normalized,
			truncations,
		};
		const manifestPath = join(directory, "manifest.json");
		const transcriptPath = join(directory, "transcript.md");
		await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, {
			mode: 0o600,
		});
		await writeFile(transcriptPath, this.renderTranscript(manifest), {
			mode: 0o600,
		});
		return { directory, manifestPath, transcriptPath, manifest };
	}

	private normalizeMessage(
		message: SlackThreadMessage,
		token: string,
	): SlackConversationMessage {
		return {
			ts: message.ts,
			author: redact(
				message.user_profile?.display_name ||
					message.user_profile?.real_name ||
					message.user_profile?.name ||
					message.bot_profile?.name ||
					message.username ||
					message.user ||
					message.bot_id ||
					"unknown",
				token,
			),
			text: redact(message.text || flattenBlocks(message.blocks), token),
			links: collectLinks(
				message.text || "",
				message.blocks,
				message.attachments,
				token,
			),
			attachments: ordinaryAttachmentContent(message.attachments, token),
			forwarded: forwardedContent(message.attachments, token),
			files: (message.files ?? []).map((file) => ({
				id: redact(file.id, token),
				name: redact(file.name || file.id, token),
				...(file.mimetype && { mimeType: redact(file.mimetype, token) }),
				...(typeof file.size === "number" && { size: file.size }),
				status: "skipped" as const,
				reason: "not_processed",
			})),
		};
	}

	private applyTextLimit(
		messages: SlackConversationMessage[],
		truncations: SlackConversationTruncation[],
	): SlackConversationMessage[] {
		const total = messages.reduce(
			(sum, message) => sum + messageTextFootprint(message),
			0,
		);
		if (total <= MAX_TEXT_CHARS) return messages;
		const root = messages[0]!;
		const newest = messages.at(-1)!;
		if (messages.length === 1) {
			truncations.push({
				kind: "text",
				detail:
					"persisted message text fields truncated at 100,000 characters; root preserved",
			});
			return [fitMessageToTextBudget(root, MAX_TEXT_CHARS)];
		}
		const newestReservation = Math.min(
			messageTextFootprint(newest),
			Math.floor(MAX_TEXT_CHARS / 2),
		);
		const fittedRoot = fitMessageToTextBudget(
			root,
			MAX_TEXT_CHARS - newestReservation,
		);
		let remaining = MAX_TEXT_CHARS - messageTextFootprint(fittedRoot);
		const fittedNewest = fitMessageToTextBudget(newest, remaining);
		remaining -= messageTextFootprint(fittedNewest);
		const middle: SlackConversationMessage[] = [];
		for (let index = messages.length - 2; index > 0 && remaining > 0; index--) {
			const message = messages[index]!;
			const footprint = messageTextFootprint(message);
			const fitted =
				footprint <= remaining
					? message
					: fitMessageToTextBudget(message, remaining);
			const fittedFootprint = messageTextFootprint(fitted);
			if (fittedFootprint > 0) middle.unshift(fitted);
			remaining -= fittedFootprint;
		}
		truncations.push({
			kind: "text",
			detail:
				"persisted message text fields truncated at 100,000 characters; root and newest messages preserved",
		});
		return [fittedRoot, ...middle, fittedNewest];
	}

	private async captureFile(
		file: SlackFile,
		token: string,
		imagesDirectory: string,
		attachmentsDirectory: string,
		imageCount: number,
		receivedBytes: number,
		fileCount: number,
	): Promise<{ file: SlackCapturedFile; bytesReceived: number }> {
		const result: SlackCapturedFile = {
			id: redact(file.id, token),
			name: redact(file.name || file.id, token),
			...(file.mimetype && { mimeType: redact(file.mimetype, token) }),
			...(typeof file.size === "number" && { size: file.size }),
			status: "skipped",
		};
		if (
			hasSlackMediaSignal({
				declaredMime: file.mimetype,
				name: file.name || file.id,
			})
		)
			return {
				file: { ...result, reason: "media_type" },
				bytesReceived: 0,
			};
		const declaredImage = Boolean(
			file.mimetype && SUPPORTED_SLACK_IMAGES.has(file.mimetype),
		);
		if (declaredImage && imageCount >= MAX_IMAGES)
			return { file: { ...result, reason: "image_limit" }, bytesReceived: 0 };
		const fileLimit = declaredImage
			? MAX_EMBEDDED_IMAGE_BYTES
			: MAX_OTHER_FILE_BYTES;
		if (file.size && file.size > fileLimit)
			return {
				file: { ...result, reason: "file_too_large" },
				bytesReceived: 0,
			};
		if (file.size && receivedBytes + file.size > MAX_RECEIVED_DOWNLOAD_BYTES)
			return {
				file: { ...result, reason: "total_download_limit" },
				bytesReceived: 0,
			};
		if (receivedBytes >= MAX_RECEIVED_DOWNLOAD_BYTES)
			return {
				file: { ...result, reason: "total_download_limit" },
				bytesReceived: 0,
			};
		const privateUrl = file.url_private_download || file.url_private;
		if (!privateUrl)
			return {
				file: { ...result, reason: "missing_private_url" },
				bytesReceived: 0,
			};
		let url: URL;
		let candidateBytesReceived = 0;
		try {
			url = new URL(privateUrl);
		} catch {
			return {
				file: { ...result, reason: "unsafe_host" },
				bytesReceived: 0,
			};
		}
		if (!isSlackOwnedHost(url))
			return {
				file: { ...result, reason: "unsafe_host" },
				bytesReceived: 0,
			};

		try {
			let response: Response | undefined;
			for (let redirects = 0; redirects <= 5; redirects++) {
				response = await this.fetchImpl(url.toString(), {
					redirect: "manual",
					headers: { Authorization: `Bearer ${token}` },
					signal: AbortSignal.timeout(this.requestTimeoutMs),
				});
				if (![301, 302, 303, 307, 308].includes(response.status)) break;
				await response.body?.cancel().catch(() => undefined);
				if (redirects === 5)
					return {
						file: { ...result, reason: "unsafe_redirect" },
						bytesReceived: 0,
					};
				const location = response.headers.get("location");
				if (!location)
					return {
						file: { ...result, reason: "unsafe_redirect" },
						bytesReceived: 0,
					};
				let next: URL;
				try {
					next = new URL(location, url);
				} catch {
					return {
						file: { ...result, reason: "unsafe_redirect" },
						bytesReceived: 0,
					};
				}
				if (!isSlackOwnedHost(next))
					return {
						file: { ...result, reason: "unsafe_redirect" },
						bytesReceived: 0,
					};
				url = next;
			}
			if (!response?.ok)
				return {
					file: { ...result, status: "failed", reason: "download_failed" },
					bytesReceived: 0,
				};
			const contentLength = Number(response.headers.get("content-length") || 0);
			if (contentLength > fileLimit) {
				await response.body?.cancel().catch(() => undefined);
				return {
					file: { ...result, reason: "file_too_large" },
					bytesReceived: 0,
				};
			}
			if (receivedBytes + contentLength > MAX_RECEIVED_DOWNLOAD_BYTES) {
				await response.body?.cancel().catch(() => undefined);
				return {
					file: { ...result, reason: "total_download_limit" },
					bytesReceived: 0,
				};
			}
			const remainingTotal = MAX_RECEIVED_DOWNLOAD_BYTES - receivedBytes;
			const streamLimit = Math.min(fileLimit, remainingTotal);
			const body = await readBodyWithinLimit(response.body, streamLimit);
			candidateBytesReceived = body.bytesReceived;
			if (body.error)
				return {
					file: { ...result, status: "failed", reason: "download_failed" },
					bytesReceived: body.bytesReceived,
				};
			if (body.exceeded) {
				const reason =
					remainingTotal < fileLimit
						? "total_download_limit"
						: "file_too_large";
				return {
					file: { ...result, reason },
					bytesReceived: body.bytesReceived,
				};
			}
			const bytes = body.buffer;
			const headerMime = response.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase();
			const classified = await classifySlackFile({
				declaredMime: file.mimetype,
				responseMime: headerMime,
				name: file.name || file.id,
				bytes,
			});
			if (!classified.allowed) {
				return {
					file: { ...result, reason: "media_type" },
					bytesReceived: body.bytesReceived,
				};
			}
			if (
				declaredImage &&
				(!classified.detectedMime ||
					classified.detectedMime !== file.mimetype ||
					headerMime !== classified.detectedMime ||
					!classified.isImage)
			) {
				return {
					file: { ...result, reason: "mime_mismatch" },
					bytesReceived: body.bytesReceived,
				};
			}
			const isImage = declaredImage && classified.isImage;
			const localName = isImage
				? `image-${String(imageCount + 1).padStart(3, "0")}.${SUPPORTED_SLACK_IMAGES.get(classified.detectedMime!)}`
				: `file-${String(fileCount + 1).padStart(3, "0")}.${classified.extension.replace(/[^a-z0-9]/gi, "") || "bin"}`;
			await writeFile(
				join(isImage ? imagesDirectory : attachmentsDirectory, localName),
				bytes,
				{ mode: 0o600 },
			);
			return {
				file: {
					...result,
					status: "downloaded",
					reason: undefined,
					localPath: isImage
						? `images/${localName}`
						: `attachments/${attachmentsDirectory.split("/").at(-1)}/${localName}`,
				},
				bytesReceived: body.bytesReceived,
			};
		} catch (error) {
			this.logger?.warn?.(
				`Slack image capture failed for file ${redact(file.id, token)}: ${error instanceof Error ? redact(error.message, token) : "unknown error"}`,
			);
			return {
				file: { ...result, status: "failed", reason: "download_failed" },
				bytesReceived: candidateBytesReceived,
			};
		}
	}

	private renderTranscript(manifest: SlackConversationManifest): string {
		const lines = [`Slack thread: ${manifest.source.permalink}`, ""];
		for (const message of manifest.messages) {
			lines.push(`[${message.ts}] ${message.author}`, message.text);
			for (const item of message.attachments ?? [])
				lines.push(
					`[Attachment from ${item.author}${item.source ? ` ${item.source}` : ""}]`,
					item.text,
				);
			for (const item of message.forwarded)
				lines.push(
					`[Forwarded from ${item.author}${item.source ? ` ${item.source}` : ""}]`,
					item.text,
				);
			for (const link of message.links)
				lines.push(`Link: ${link.label} — ${link.url}`);
			for (const file of message.files)
				lines.push(
					`File: ${file.name} — ${file.status}${file.reason ? ` (${file.reason})` : ""}${file.localPath ? ` — ${file.localPath}` : ""}`,
				);
			lines.push("");
		}
		for (const item of manifest.truncations)
			lines.push(`[TRUNCATED: ${item.detail}]`);
		return `${lines.join("\n")}\n`;
	}
}
