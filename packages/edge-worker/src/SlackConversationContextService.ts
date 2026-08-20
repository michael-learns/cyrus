import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type {
	SlackBlock,
	SlackFile,
	SlackMessageAttachment,
	SlackThreadMessage,
} from "cyrus-slack-event-transport";
import { fileTypeFromBuffer } from "file-type";

const MAX_MESSAGES = 200;
const MAX_TEXT_CHARS = 100_000;
const MAX_IMAGES = 20;
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;
const MAX_DOWNLOAD_BYTES = 50 * 1024 * 1024;
const SUPPORTED_IMAGES = new Map([
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

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
	forwarded: Array<{ author: string; source?: string; text: string }>;
	files: SlackCapturedFile[];
}

export interface SlackConversationTruncation {
	kind:
		| "messages"
		| "text"
		| "images"
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
		messages: 200;
		textCharacters: 100000;
		images: 20;
		imageBytes: 10485760;
		totalDownloadBytes: 52428800;
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
}

interface CaptureLogger {
	warn?(message: string): void;
}

export interface SlackConversationContextServiceOptions {
	cyrusHome: string;
	fetch?: typeof fetch;
	logger?: CaptureLogger;
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
	return (
		url.protocol === "https:" &&
		(url.hostname === "slack.com" || url.hostname.endsWith(".slack.com"))
	);
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

export class SlackConversationContextService {
	private readonly cyrusHome: string;
	private readonly fetchImpl: typeof fetch;
	private readonly logger?: CaptureLogger;

	constructor(options: SlackConversationContextServiceOptions) {
		this.cyrusHome = options.cyrusHome;
		this.fetchImpl = options.fetch ?? fetch;
		this.logger = options.logger;
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
		normalized = this.applyTextLimit(normalized, truncations);

		const key = createHash("sha256")
			.update(
				`${input.teamId}\0${input.channelId}\0${input.threadTs}\0${input.kickoffTs}`,
			)
			.digest("hex")
			.slice(0, 24);
		const directory = join(this.cyrusHome, "slack-context", key);
		const imagesDirectory = join(directory, "images");
		await mkdir(imagesDirectory, { recursive: true, mode: 0o700 });

		let imageCount = 0;
		let downloadedBytes = 0;
		for (const message of normalized) {
			for (let index = 0; index < message.files.length; index++) {
				const original = selected.find((item) => item.ts === message.ts)
					?.files?.[index];
				if (!original) continue;
				const result = await this.captureFile(
					original,
					input.token,
					imagesDirectory,
					imageCount,
					downloadedBytes,
				);
				message.files[index] = result.file;
				if (
					original.mimetype &&
					SUPPORTED_IMAGES.has(original.mimetype) &&
					result.file.reason !== "image_limit" &&
					result.file.reason !== "file_too_large" &&
					result.file.reason !== "total_download_limit"
				) {
					imageCount++;
				}
				if (result.file.status === "downloaded") {
					downloadedBytes += result.bytes;
				} else if (result.file.reason === "image_limit") {
					truncations.push({
						kind: "images",
						omitted: 1,
						detail: "image omitted after 20-image limit",
					});
				} else if (result.file.reason === "file_too_large") {
					truncations.push({
						kind: "image_size",
						omitted: 1,
						detail: "image exceeded 10 MiB limit",
					});
				} else if (result.file.reason === "total_download_limit") {
					truncations.push({
						kind: "total_downloads",
						omitted: 1,
						detail: "image omitted after 50 MiB total-download limit",
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
				imageBytes: 10485760,
				totalDownloadBytes: 52428800,
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
		const length = (message: SlackConversationMessage) =>
			message.text.length +
			message.forwarded.reduce((sum, item) => sum + item.text.length, 0);
		if (
			messages.reduce((sum, message) => sum + length(message), 0) <=
			MAX_TEXT_CHARS
		)
			return messages;
		const root = structuredClone(messages[0]!);
		let remaining = MAX_TEXT_CHARS;
		if (length(root) > remaining) {
			root.text = root.text.slice(0, remaining);
			root.forwarded = [];
			truncations.push({
				kind: "text",
				detail: "text truncated at 100,000 characters; root preserved",
			});
			return [root];
		}
		remaining -= length(root);
		const newest: SlackConversationMessage[] = [];
		for (let index = messages.length - 1; index > 0 && remaining > 0; index--) {
			const message = structuredClone(messages[index]!);
			const messageLength = length(message);
			if (messageLength <= remaining) {
				newest.unshift(message);
				remaining -= messageLength;
			} else {
				message.text = message.text.slice(0, remaining);
				message.forwarded = [];
				newest.unshift(message);
				remaining = 0;
			}
		}
		truncations.push({
			kind: "text",
			detail:
				"text truncated at 100,000 characters; root and newest messages preserved",
		});
		return [root, ...newest];
	}

	private async captureFile(
		file: SlackFile,
		token: string,
		imagesDirectory: string,
		imageCount: number,
		downloadedBytes: number,
	): Promise<{ file: SlackCapturedFile; bytes: number }> {
		const result: SlackCapturedFile = {
			id: redact(file.id, token),
			name: redact(file.name || file.id, token),
			...(file.mimetype && { mimeType: redact(file.mimetype, token) }),
			...(typeof file.size === "number" && { size: file.size }),
			status: "skipped",
		};
		if (!file.mimetype || !SUPPORTED_IMAGES.has(file.mimetype))
			return { file: { ...result, reason: "unsupported_type" }, bytes: 0 };
		if (imageCount >= MAX_IMAGES)
			return { file: { ...result, reason: "image_limit" }, bytes: 0 };
		if (file.size && file.size > MAX_IMAGE_BYTES)
			return { file: { ...result, reason: "file_too_large" }, bytes: 0 };
		if (file.size && downloadedBytes + file.size > MAX_DOWNLOAD_BYTES)
			return { file: { ...result, reason: "total_download_limit" }, bytes: 0 };
		const privateUrl = file.url_private_download || file.url_private;
		if (!privateUrl)
			return { file: { ...result, reason: "missing_private_url" }, bytes: 0 };
		let url: URL;
		try {
			url = new URL(privateUrl);
		} catch {
			return { file: { ...result, reason: "unsafe_host" }, bytes: 0 };
		}
		if (!isSlackOwnedHost(url))
			return { file: { ...result, reason: "unsafe_host" }, bytes: 0 };

		try {
			let response: Response | undefined;
			for (let redirects = 0; redirects <= 5; redirects++) {
				response = await this.fetchImpl(url.toString(), {
					redirect: "manual",
					headers: { Authorization: `Bearer ${token}` },
				});
				if (![301, 302, 303, 307, 308].includes(response.status)) break;
				if (redirects === 5)
					return { file: { ...result, reason: "unsafe_redirect" }, bytes: 0 };
				const location = response.headers.get("location");
				if (!location)
					return { file: { ...result, reason: "unsafe_redirect" }, bytes: 0 };
				const next = new URL(location, url);
				if (!isSlackOwnedHost(next))
					return { file: { ...result, reason: "unsafe_redirect" }, bytes: 0 };
				url = next;
			}
			if (!response?.ok)
				return {
					file: { ...result, status: "failed", reason: "download_failed" },
					bytes: 0,
				};
			const contentLength = Number(response.headers.get("content-length") || 0);
			if (contentLength > MAX_IMAGE_BYTES)
				return { file: { ...result, reason: "file_too_large" }, bytes: 0 };
			if (downloadedBytes + contentLength > MAX_DOWNLOAD_BYTES)
				return {
					file: { ...result, reason: "total_download_limit" },
					bytes: 0,
				};
			const bytes = Buffer.from(await response.arrayBuffer());
			if (bytes.length > MAX_IMAGE_BYTES)
				return { file: { ...result, reason: "file_too_large" }, bytes: 0 };
			if (downloadedBytes + bytes.length > MAX_DOWNLOAD_BYTES)
				return {
					file: { ...result, reason: "total_download_limit" },
					bytes: 0,
				};
			const detected = await fileTypeFromBuffer(bytes);
			const headerMime = response.headers
				.get("content-type")
				?.split(";", 1)[0]
				?.trim()
				.toLowerCase();
			if (
				!detected ||
				detected.mime !== file.mimetype ||
				headerMime !== detected.mime ||
				!SUPPORTED_IMAGES.has(detected.mime)
			) {
				return { file: { ...result, reason: "mime_mismatch" }, bytes: 0 };
			}
			const localName = `image-${String(imageCount + 1).padStart(3, "0")}.${SUPPORTED_IMAGES.get(detected.mime)}`;
			await writeFile(join(imagesDirectory, localName), bytes, { mode: 0o600 });
			return {
				file: {
					...result,
					status: "downloaded",
					reason: undefined,
					localPath: `images/${localName}`,
				},
				bytes: bytes.length,
			};
		} catch (error) {
			this.logger?.warn?.(
				`Slack image capture failed for file ${redact(file.id, token)}: ${error instanceof Error ? redact(error.message, token) : "unknown error"}`,
			);
			return {
				file: { ...result, status: "failed", reason: "download_failed" },
				bytes: 0,
			};
		}
	}

	private renderTranscript(manifest: SlackConversationManifest): string {
		const lines = [`Slack thread: ${manifest.source.permalink}`, ""];
		for (const message of manifest.messages) {
			lines.push(`[${message.ts}] ${message.author}`, message.text);
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
