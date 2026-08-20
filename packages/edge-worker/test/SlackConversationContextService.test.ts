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
			result.manifest.messages.reduce(
				(n, message) => n + message.text.length,
				0,
			),
		).toBe(100_000);
		expect(result.manifest.truncations).toEqual(
			expect.arrayContaining([
				expect.objectContaining({ kind: "messages", omitted: 5 }),
				expect.objectContaining({ kind: "text" }),
			]),
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
