import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	SlackConversationContextService,
	type SlackConversationManifest,
} from "../src/SlackConversationContextService.js";

const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52,
]);

function persistedTextFootprint(value: unknown): number {
	if (typeof value === "string") return value.length;
	if (Array.isArray(value))
		return value.reduce(
			(total, item) => total + persistedTextFootprint(item),
			0,
		);
	if (value && typeof value === "object")
		return Object.values(value).reduce(
			(total, item) => total + persistedTextFootprint(item),
			0,
		);
	return 0;
}

describe("SlackConversationContextService", () => {
	let cyrusHome: string;
	let fetchMock: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-context-"));
		fetchMock = vi.fn();
	});

	afterEach(async () => {
		await rm(cyrusHome, { recursive: true, force: true });
	});

	function service() {
		return new SlackConversationContextService({
			cyrusHome,
			fetch: fetchMock as typeof fetch,
		});
	}

	it("normalizes ordered authors, labeled links, and forwarded content through the kickoff", async () => {
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1.000",
			kickoffTs: "3.000",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-never-persist-this",
			messages: [
				{ user: "U3", text: "after", ts: "4.000" },
				{
					user: "U2",
					user_profile: { display_name: "Mina" },
					text: "See <https://example.com/spec|the spec>",
					ts: "3.000",
					attachments: [
						{
							is_share: true,
							author_name: "Ari",
							channel_name: "eng",
							text: "Forwarded decision",
							title: "Incident",
							title_link: "https://example.com/incident",
						},
					],
				},
				{
					user: "U1",
					text: "root",
					ts: "1.000",
					blocks: [
						{
							type: "rich_text",
							elements: [
								{
									type: "link",
									url: "https://example.com/runbook",
									text: "runbook",
								},
							],
						},
					],
				},
			],
		});

		expect(result.manifest.messages).toEqual([
			expect.objectContaining({ ts: "1.000", author: "U1", text: "root" }),
			expect.objectContaining({
				ts: "3.000",
				author: "Mina",
				links: [
					{ label: "the spec", url: "https://example.com/spec" },
					{ label: "Incident", url: "https://example.com/incident" },
				],
				forwarded: [
					{ author: "Ari", source: "#eng", text: "Forwarded decision" },
				],
			}),
		]);
		expect(result.manifest.messages[0].links).toEqual([
			{ label: "runbook", url: "https://example.com/runbook" },
		]);
		const transcript = await readFile(result.transcriptPath, "utf8");
		expect(transcript).toContain("Forwarded decision");
		expect(transcript).not.toContain("after");
		expect(result.directory.startsWith(cyrusHome)).toBe(true);
	});

	it("preserves the root and newest 199 messages and explicitly records message and text truncation", async () => {
		const messages = Array.from({ length: 205 }, (_, index) => ({
			user: `U${index}`,
			text: index === 204 ? "n".repeat(100_500) : `message-${index}`,
			ts: `${String(index + 1).padStart(3, "0")}.000`,
		}));
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "001.000",
			kickoffTs: "205.000",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages,
		});

		expect(result.manifest.messages).toHaveLength(2);
		expect(result.manifest.messages[0].ts).toBe("001.000");
		expect(result.manifest.messages[1].ts).toBe("205.000");
		expect(
			persistedTextFootprint(result.manifest.messages),
		).toBeLessThanOrEqual(100_000);
		expect(result.manifest.truncations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "messages", omitted: 5 }),
				expect.objectContaining({ kind: "text" }),
			]),
		);
	});

	it("budgets every persisted message string while preserving distinct root and kickoff records", async () => {
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1.000",
			kickoffTs: "2.000",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user_profile: { display_name: "root-author".repeat(2_000) },
					text: "r".repeat(40_000),
					ts: "1.000",
					blocks: [
						{
							type: "rich_text",
							elements: [
								{
									type: "link",
									text: "label".repeat(2_000),
									url: `https://example.com/${"u".repeat(20_000)}`,
								},
							],
						},
					],
					attachments: [
						{
							is_share: true,
							author_name: "forward-author".repeat(1_000),
							text: "forwarded".repeat(4_000),
						},
					],
					files: [
						{
							id: "file-id".repeat(1_000),
							name: "file-name".repeat(1_000),
							mimetype: "application/pdf",
						},
					],
				},
				{
					user_profile: { display_name: "kickoff-author".repeat(10_000) },
					text: "implement this now",
					ts: "2.000",
				},
			],
		});

		expect(result.manifest.messages.map((message) => message.ts)).toEqual([
			"1.000",
			"2.000",
		]);
		expect(result.manifest.messages[1].text).toContain("implement this now");
		expect(
			persistedTextFootprint(result.manifest.messages),
		).toBeLessThanOrEqual(100_000);
		expect(result.manifest.truncations).toContainEqual(
			expect.objectContaining({ kind: "text" }),
		);
	});

	it("allows exactly 100,000 persisted message characters and truncates the next character", async () => {
		const capture = (textLength: number, kickoffTs: string) =>
			service().capture({
				teamId: "T1",
				channelId: "C1",
				threadTs: kickoffTs,
				kickoffTs,
				threadPermalink: "https://workspace.slack.com/archives/C1/p1",
				token: "xoxb-secret",
				messages: [{ user: "U", text: "x".repeat(textLength), ts: "1" }],
			});
		const exact = await capture(99_998, "1");
		const over = await capture(99_999, "2");

		expect(persistedTextFootprint(exact.manifest.messages)).toBe(100_000);
		expect(exact.manifest.truncations.some(({ kind }) => kind === "text")).toBe(
			false,
		);
		expect(persistedTextFootprint(over.manifest.messages)).toBe(100_000);
		expect(over.manifest.truncations).toContainEqual(
			expect.objectContaining({ kind: "text" }),
		);
	});

	it("downloads a valid Slack PNG with auth and gives an unsafe source name a safe local name", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(PNG, {
				status: 200,
				headers: {
					"content-type": "image/png",
					"content-length": String(PNG.length),
				},
			}),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1.000",
			kickoffTs: "1.000",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "image",
					ts: "1.000",
					files: [
						{
							id: "F/../1",
							name: "../../token-xoxb-secret.png",
							mimetype: "image/png",
							size: PNG.length,
							url_private_download:
								"https://files.slack.com/files-pri/T1-F1/download/image.png",
						},
					],
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledWith(
			"https://files.slack.com/files-pri/T1-F1/download/image.png",
			expect.objectContaining({
				redirect: "manual",
				headers: { Authorization: "Bearer xoxb-secret" },
			}),
		);
		const file = result.manifest.messages[0].files[0];
		expect(file).toEqual(
			expect.objectContaining({
				status: "downloaded",
				localPath: "images/image-001.png",
			}),
		);
		expect(file.localPath).not.toContain("..");
		expect(await readFile(join(result.directory, file.localPath!))).toEqual(
			PNG,
		);
	});

	it("rejects non-Slack hosts and non-Slack redirects without leaking authorization", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, {
				status: 302,
				headers: { location: "https://evil.example/steal" },
			}),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "files",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://evil.example/one.png",
						},
						{
							id: "F2",
							name: "two.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/two.png",
						},
					],
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(
			fetchMock.mock.calls.some(([url]) =>
				String(url).includes("evil.example"),
			),
		).toBe(false);
		expect(
			result.manifest.messages[0].files.map((file) => file.reason),
		).toEqual(["unsafe_host", "unsafe_redirect"]);
	});

	it("aborts each Slack media request at its configured timeout", async () => {
		let observedSignal: AbortSignal | undefined;
		fetchMock.mockImplementation(async (_url, init) => {
			observedSignal = init?.signal ?? undefined;
			if (!observedSignal) throw new Error("missing abort signal");
			await new Promise((_, reject) => {
				observedSignal!.addEventListener("abort", () =>
					reject(observedSignal!.reason),
				);
			});
			throw new Error("unreachable");
		});
		const timedService = new SlackConversationContextService({
			cyrusHome,
			fetch: fetchMock as typeof fetch,
			requestTimeoutMs: 5,
		});

		const result = await timedService.capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/one.png",
						},
					],
				},
			],
		});

		expect(observedSignal?.aborted).toBe(true);
		expect(result.manifest.messages[0].files[0]).toEqual(
			expect.objectContaining({ status: "failed", reason: "download_failed" }),
		);
	});

	it("cancels a redirect response body before following it", async () => {
		let redirectCancelled = false;
		fetchMock
			.mockResolvedValueOnce({
				status: 302,
				headers: new Headers({ location: "https://files.slack.com/two.png" }),
				body: new ReadableStream({
					cancel() {
						redirectCancelled = true;
					},
				}),
			} as Response)
			.mockResolvedValueOnce(
				new Response(PNG, { headers: { "content-type": "image/png" } }),
			);

		await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/one.png",
						},
					],
				},
			],
		});

		expect(redirectCancelled).toBe(true);
	});

	it.each([
		"https://slack.com/file.png",
		"https://api.slack.com/file.png",
		"https://files.slack.com.evil.example/file.png",
		"https://notfiles.slack.com/file.png",
		"http://files.slack.com/file.png",
		"https://files.slack.com:444/file.png",
	])("never sends authorization to a non-private-file host: %s", async (url) => {
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: url,
						},
					],
				},
			],
		});

		expect(fetchMock).not.toHaveBeenCalled();
		expect(result.manifest.messages[0].files[0]).toEqual(
			expect.objectContaining({ status: "skipped", reason: "unsafe_host" }),
		);
	});

	it.each([
		"https://slack.com/file.png",
		"https://api.slack.com/file.png",
		"https://files.slack.com.evil.example/file.png",
		"https://notfiles.slack.com/file.png",
		"http://files.slack.com/file.png",
		"https://files.slack.com:444/file.png",
	])("never follows an authenticated redirect to: %s", async (location) => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location } }),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/one.png",
						},
					],
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(fetchMock.mock.calls[0][0]).toBe("https://files.slack.com/one.png");
		expect(result.manifest.messages[0].files[0]).toEqual(
			expect.objectContaining({ status: "skipped", reason: "unsafe_redirect" }),
		);
	});

	it("classifies a malformed redirect location as unsafe without a second request", async () => {
		fetchMock.mockResolvedValueOnce(
			new Response(null, { status: 302, headers: { location: "http://[" } }),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/one.png",
						},
					],
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledTimes(1);
		expect(result.manifest.messages[0].files[0]).toEqual(
			expect.objectContaining({ status: "skipped", reason: "unsafe_redirect" }),
		);
	});

	it("streams an oversized image without content-length and stops at 10 MiB", async () => {
		let cancelled = false;
		const chunks = [
			Buffer.alloc(6 * 1024 * 1024),
			Buffer.alloc(6 * 1024 * 1024),
			Buffer.alloc(6 * 1024 * 1024),
		];
		PNG.copy(chunks[0]);
		fetchMock.mockResolvedValueOnce({
			ok: true,
			status: 200,
			headers: new Headers({ "content-type": "image/png" }),
			body: new ReadableStream({
				pull(controller) {
					const chunk = chunks.shift();
					if (chunk) controller.enqueue(chunk);
					else controller.close();
				},
				cancel() {
					cancelled = true;
				},
			}),
		} as Response);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "file",
					ts: "1",
					files: [
						{
							id: "F1",
							name: "one.png",
							mimetype: "image/png",
							url_private: "https://files.slack.com/one.png",
						},
					],
				},
			],
		});

		expect(cancelled).toBe(true);
		expect(result.manifest.messages[0].files[0]).toEqual(
			expect.objectContaining({ status: "skipped", reason: "file_too_large" }),
		);
	});

	it("charges repeated signature-invalid images against the 50 MiB receive budget", async () => {
		const invalidTenMiB = Buffer.alloc(10 * 1024 * 1024);
		fetchMock.mockImplementation(
			async () =>
				new Response(invalidTenMiB, {
					status: 200,
					headers: { "content-type": "image/png" },
				}),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "files",
					ts: "1",
					files: Array.from({ length: 6 }, (_, index) => ({
						id: `F${index}`,
						name: `${index}.png`,
						mimetype: "image/png",
						url_private: `https://files.slack.com/${index}.png`,
					})),
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(
			result.manifest.messages[0].files
				.slice(0, 5)
				.every((file) => file.reason === "mime_mismatch"),
		).toBe(true);
		expect(result.manifest.messages[0].files[5]).toEqual(
			expect.objectContaining({
				status: "skipped",
				reason: "total_download_limit",
			}),
		);
	});

	it("charges partial failed streams against the 50 MiB receive budget", async () => {
		fetchMock.mockImplementation(async () => {
			let reads = 0;
			return {
				ok: true,
				status: 200,
				headers: new Headers({ "content-type": "image/png" }),
				body: {
					getReader: () => ({
						read: async () => {
							if (reads++ === 0)
								return { done: false, value: Buffer.alloc(10 * 1024 * 1024) };
							throw new Error("connection reset");
						},
						cancel: async () => undefined,
					}),
				},
			} as Response;
		});
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "files",
					ts: "1",
					files: Array.from({ length: 6 }, (_, index) => ({
						id: `F${index}`,
						name: `${index}.png`,
						mimetype: "image/png",
						url_private: `https://files.slack.com/${index}.png`,
					})),
				},
			],
		});

		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(
			result.manifest.messages[0].files
				.slice(0, 5)
				.every((file) => file.reason === "download_failed"),
		).toBe(true);
		expect(result.manifest.messages[0].files[5]).toEqual(
			expect.objectContaining({
				status: "skipped",
				reason: "total_download_limit",
			}),
		);
	});

	it("degrades unsupported, oversized, MIME-mismatched, and over-limit images honestly", async () => {
		fetchMock.mockImplementation(
			async () =>
				new Response(PNG, {
					status: 200,
					headers: { "content-type": "image/jpeg" },
				}),
		);
		const files = [
			{
				id: "PDF",
				name: "doc.pdf",
				mimetype: "application/pdf",
				url_private: "https://files.slack.com/doc.pdf",
			},
			{
				id: "BIG",
				name: "big.png",
				mimetype: "image/png",
				size: 10 * 1024 * 1024 + 1,
				url_private: "https://files.slack.com/big.png",
			},
			...Array.from({ length: 21 }, (_, i) => ({
				id: `F${i}`,
				name: `${i}.jpeg`,
				mimetype: "image/jpeg",
				url_private: `https://files.slack.com/${i}.jpeg`,
			})),
		];
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [{ user: "U1", text: "files", ts: "1", files }],
		});

		const captured = result.manifest.messages[0].files;
		expect(captured[0]).toEqual(
			expect.objectContaining({
				status: "skipped",
				reason: "unsupported_type",
			}),
		);
		expect(captured[1]).toEqual(
			expect.objectContaining({ status: "skipped", reason: "file_too_large" }),
		);
		expect(
			captured.filter((file) => file.reason === "mime_mismatch"),
		).toHaveLength(20);
		expect(captured.at(-1)).toEqual(
			expect.objectContaining({ status: "skipped", reason: "image_limit" }),
		);
		expect(result.manifest.truncations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "unsupported_file" }),
				expect.objectContaining({ kind: "image_size" }),
				expect.objectContaining({ kind: "images" }),
			]),
		);
	});

	it("stops before the 50 MiB total download boundary", async () => {
		const tenMiBPng = Buffer.alloc(10 * 1024 * 1024);
		PNG.copy(tenMiBPng);
		fetchMock.mockImplementation(
			async () =>
				new Response(tenMiBPng, {
					status: 200,
					headers: {
						"content-type": "image/png",
						"content-length": String(tenMiBPng.length),
					},
				}),
		);
		const result = await service().capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-secret",
			messages: [
				{
					user: "U1",
					text: "files",
					ts: "1",
					files: Array.from({ length: 6 }, (_, index) => ({
						id: `F${index}`,
						name: `${index}.png`,
						mimetype: "image/png",
						size: tenMiBPng.length,
						url_private: `https://files.slack.com/${index}.png`,
					})),
				},
			],
		});

		expect(
			result.manifest.messages[0].files
				.slice(0, 5)
				.every((file) => file.status === "downloaded"),
		).toBe(true);
		expect(result.manifest.messages[0].files[5]).toEqual(
			expect.objectContaining({
				status: "skipped",
				reason: "total_download_limit",
			}),
		);
		expect(fetchMock).toHaveBeenCalledTimes(5);
		expect(result.manifest.truncations).toContainEqual(
			expect.objectContaining({ kind: "total_downloads" }),
		);
	});

	it("redacts tokens and private file URLs from the persisted manifest, transcript, and logs", async () => {
		const warnings: string[] = [];
		const secretUrl = "https://files.slack.com/files-pri/T1-F1/private.png";
		fetchMock.mockRejectedValueOnce(
			new Error(`failed ${secretUrl} with xoxb-top-secret`),
		);
		const capture = new SlackConversationContextService({
			cyrusHome,
			fetch: fetchMock as typeof fetch,
			logger: { warn: (message: string) => warnings.push(message) },
		});
		const result = await capture.capture({
			teamId: "T1",
			channelId: "C1",
			threadTs: "1",
			kickoffTs: "1",
			threadPermalink: "https://workspace.slack.com/archives/C1/p1",
			token: "xoxb-top-secret",
			messages: [
				{
					user: "U1",
					text: `token xoxb-top-secret ${secretUrl} <https://example.com/?auth=xoxb-top-secret|secret>`,
					ts: "1",
					files: [
						{
							id: "F1",
							name: secretUrl,
							mimetype: "image/png",
							url_private: secretUrl,
						},
					],
				},
			],
		});

		const manifest = await readFile(result.manifestPath, "utf8");
		const transcript = await readFile(result.transcriptPath, "utf8");
		for (const output of [manifest, transcript, warnings.join("\n")]) {
			expect(output).not.toContain("xoxb-top-secret");
			expect(output).not.toContain(secretUrl);
		}
		expect(JSON.parse(manifest) as SlackConversationManifest).toEqual(
			result.manifest,
		);
	});
});
