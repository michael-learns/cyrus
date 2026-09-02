import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { AgentTurn } from "cyrus-core";
import {
	type ChatRepositoryProvider,
	ChatSessionHandler,
	EdgeWorker,
	SlackChatAdapter,
} from "cyrus-edge-worker";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
	normalizeSlackEngineeringFixture,
	type SlackEngineeringFixture,
} from "./slackEngineeringFixture.js";
import { SyntheticSlackEngineeringBackend } from "./syntheticSlackEngineeringBackend.js";

const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52,
]);

function workspaceFiles(directory: string): string[] {
	return readdirSync(directory, { recursive: true, withFileTypes: true })
		.filter((entry) => entry.isFile())
		.map((entry) => `${entry.parentPath}/${entry.name}`);
}

describe("F1 Slack chat thread context", () => {
	afterEach(() => vi.unstubAllGlobals());

	it("delivers an attachment-only issue card and its screenshot through the real chat boundary", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-f1-slack-chat-"));
		const backend = new SyntheticSlackEngineeringBackend();
		vi.stubGlobal("fetch", backend.fetch);
		const fixture: SlackEngineeringFixture = {
			channel: "C_BUG_REPORTS",
			user: "U_REQUESTER",
			threadTs: "1787249725.124729",
			kickoffTs: "1787271397.218729",
			text: "<@U_CYRUS> can you explain this issue simply?",
			history: [
				{
					ts: "1787249725.124729",
					user: "U_GITHUB_APP",
					text: "",
					attachments: [
						{
							footer: "GitHub",
							text: "Implement GitHub issue #451 end-to-end. The worker sends an unsupported field.",
							fallback: "Issue opened by Cyrus",
						},
					],
					images: [
						{
							id: "F_ISSUE_SCREENSHOT",
							name: "issue.png",
							mimeType: "image/png",
							base64: PNG.toString("base64"),
						},
					],
				},
			],
		};
		const normalized = normalizeSlackEngineeringFixture(fixture);
		backend.setThread(fixture.channel, fixture.threadTs, normalized.messages);
		for (const [id, file] of normalized.files)
			backend.setFile(id, file.bytes, file.mimeType);

		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => [],
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};
		const adapter = new SlackChatAdapter(provider, undefined, {
			cyrusHome,
			contextFetch: backend.fetch,
		});
		let encodedTurn: AgentTurn | undefined;
		let encodedImage: Buffer | undefined;
		const allowedDirectories = new Set<string>();
		const runner = {
			supportsStreamingInput: true,
			start: vi.fn(),
			startStreaming: vi.fn(),
			startStreamingTurn: vi.fn((turn: AgentTurn) => {
				encodedTurn = turn;
				const image = turn.find((part) => part.type === "local_image");
				if (!image || !allowedDirectories.has(dirname(image.path)))
					throw new Error("image was not authorized at the runner boundary");
				encodedImage = readFileSync(image.path);
				return Promise.resolve({ sessionId: "f1-slack-chat-session" });
			}),
			allowLocalImageDirectory: vi.fn((directory: string) => {
				allowedDirectories.add(directory);
				return { release: () => allowedDirectories.delete(directory) };
			}),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
		};
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: provider,
			runnerConfigBuilder: {
				buildChatConfig: (input: Record<string, unknown>) => input,
			} as never,
			createRunner: () => runner as never,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		try {
			await handler.handleEvent(normalized.event);
			const text = encodedTurn
				?.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const image = encodedTurn?.find((part) => part.type === "local_image");
			expect(text).toContain("Implement GitHub issue #451 end-to-end.");
			expect(text).toContain("can you explain this issue simply?");
			expect(encodedImage).toEqual(PNG);
			expect(image?.mediaType).toBe("image/png");
			expect(allowedDirectories).toEqual(new Set());
			if (!image) throw new Error("missing image input");
			await expect(access(image.path)).resolves.toBeUndefined();
			expect(backend.externalRequests).toEqual([]);
		} finally {
			await rm(cyrusHome, { recursive: true, force: true });
		}
	});

	it("delivers an image attached to the top-level mention through the real chat boundary", async () => {
		const cyrusHome = await mkdtemp(
			join(tmpdir(), "cyrus-f1-slack-root-image-"),
		);
		const backend = new SyntheticSlackEngineeringBackend();
		vi.stubGlobal("fetch", backend.fetch);
		const fixture: SlackEngineeringFixture = {
			channel: "C_BUG_REPORTS",
			user: "U_REQUESTER",
			kickoffTs: "1787300268.820919",
			text: "<@U_CYRUS> can you analyze this image for me? No need to do any coding.",
			history: [
				{
					ts: "1787300268.820919",
					user: "U_REQUESTER",
					text: "<@U_CYRUS> can you analyze this image for me? No need to do any coding.",
					images: [
						{
							id: "F_IMG_4421",
							name: "IMG_4421.png",
							mimeType: "image/png",
							base64: PNG.toString("base64"),
						},
					],
				},
			],
		};
		const normalized = normalizeSlackEngineeringFixture(fixture);
		backend.setThread(fixture.channel, fixture.kickoffTs, normalized.messages);
		for (const [id, file] of normalized.files)
			backend.setFile(id, file.bytes, file.mimeType);

		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => [],
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};
		const adapter = new SlackChatAdapter(provider, undefined, {
			cyrusHome,
			contextFetch: backend.fetch,
		});
		let encodedTurn: AgentTurn | undefined;
		let encodedImage: Buffer | undefined;
		const allowedDirectories = new Set<string>();
		const runner = {
			supportsStreamingInput: true,
			start: vi.fn(),
			startStreaming: vi.fn(),
			startStreamingTurn: vi.fn((turn: AgentTurn) => {
				encodedTurn = turn;
				const image = turn.find((part) => part.type === "local_image");
				if (!image || !allowedDirectories.has(dirname(image.path)))
					throw new Error("image was not authorized at the runner boundary");
				encodedImage = readFileSync(image.path);
				return Promise.resolve({ sessionId: "f1-slack-root-image-session" });
			}),
			allowLocalImageDirectory: vi.fn((directory: string) => {
				allowedDirectories.add(directory);
				return { release: () => allowedDirectories.delete(directory) };
			}),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
		};
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: provider,
			runnerConfigBuilder: {
				buildChatConfig: (input: Record<string, unknown>) => input,
			} as never,
			createRunner: () => runner as never,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});

		try {
			await handler.handleEvent(normalized.event);
			const text = encodedTurn
				?.filter((part) => part.type === "text")
				.map((part) => part.text)
				.join("\n");
			const image = encodedTurn?.find((part) => part.type === "local_image");
			expect(text).toContain("can you analyze this image for me?");
			expect(text).toContain("File: IMG_4421.png — image/png — downloaded");
			expect(encodedImage).toEqual(PNG);
			expect(image?.mediaType).toBe("image/png");
			expect(allowedDirectories).toEqual(new Set());
			if (!image) throw new Error("missing image input");
			await expect(access(image.path)).resolves.toBeUndefined();
			expect(backend.externalRequests).toEqual([]);
		} finally {
			await rm(cyrusHome, { recursive: true, force: true });
		}
	});

	it("reads exact PDF and CSV bytes then returns exact HTML, CSV, and PDF files to the originating thread", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-f1-slack-files-"));
		const backend = new SyntheticSlackEngineeringBackend();
		vi.stubGlobal("fetch", backend.fetch);
		const inputPdf = Buffer.from("%PDF-1.4\n% exact inbound f1 pdf\n%%EOF\n");
		const inputCsv = Buffer.from("employee,hours\nAda,8\nGrace,7.5\n", "utf8");
		const outputHtml = Buffer.from(
			"<!doctype html><title>F1 summary</title><p>15.5 hours</p>\n",
			"utf8",
		);
		const outputCsv = Buffer.from(
			"employee,hours\nAda,8\nGrace,7.5\nTotal,15.5\n",
		);
		const outputPdf = Buffer.from(
			"%PDF-1.4\n% exact outbound f1 pdf transport\n%%EOF\n",
		);
		const fixture: SlackEngineeringFixture = {
			channel: "C_FILE_REPORTS",
			user: "U_REQUESTER",
			threadTs: "1800000000.000100",
			kickoffTs: "1800000001.000200",
			text: "Read the attachments and return HTML, CSV, and PDF summaries.",
			history: [
				{
					ts: "1800000000.000100",
					user: "U_REQUESTER",
					text: "Source files",
					files: [
						{
							id: "F_INPUT_PDF",
							name: "brief.pdf",
							mimeType: "application/pdf",
							base64: inputPdf.toString("base64"),
						},
						{
							id: "F_INPUT_CSV",
							name: "hours.csv",
							mimeType: "text/csv",
							base64: inputCsv.toString("base64"),
						},
						{
							id: "F_REJECT_AUDIO",
							name: "meeting.mp3",
							mimeType: "audio/mpeg",
							base64: Buffer.from("ID3 audio").toString("base64"),
						},
						{
							id: "F_REJECT_VIDEO",
							name: "demo.mp4",
							mimeType: "video/mp4",
							base64: Buffer.from("video").toString("base64"),
						},
					],
					images: [
						{
							id: "F_INPUT_IMAGE",
							name: "chart.png",
							mimeType: "image/png",
							base64: PNG.toString("base64"),
						},
					],
				},
			],
		};
		const normalized = normalizeSlackEngineeringFixture(fixture);
		backend.setThread(fixture.channel, fixture.threadTs!, normalized.messages);
		for (const [id, file] of normalized.files)
			backend.setFile(id, file.bytes, file.mimeType);

		const provider: ChatRepositoryProvider = {
			getRepositoryPaths: () => [],
			getDefaultRepository: () => undefined,
			getDefaultLinearWorkspaceId: () => undefined,
		};
		const adapter = new SlackChatAdapter(provider, undefined, {
			cyrusHome,
			contextFetch: backend.fetch,
		});
		let workspacePath = "";
		let turnText = "";
		let toolText = "";
		let worker: EdgeWorker;
		const runner = {
			supportsStreamingInput: true,
			start: vi.fn(),
			startStreaming: vi.fn(),
			startStreamingTurn: vi.fn(async (turn: AgentTurn) => {
				turnText = turn
					.filter((part) => part.type === "text")
					.map((part) => part.text)
					.join("\n");
				const captured = workspaceFiles(workspacePath).map((path) => ({
					path,
					bytes: readFileSync(path),
				}));
				expect(captured.some(({ bytes }) => bytes.equals(inputPdf))).toBe(true);
				expect(captured.some(({ bytes }) => bytes.equals(inputCsv))).toBe(true);
				const imageRoot = join(
					workspacePath,
					"images",
					"f1-slack-C_FILE_REPORTS-1800000001-000200",
				);
				expect(turn.filter((part) => part.type === "local_image")).toEqual([
					{
						type: "local_image",
						path: join(imageRoot, "image-001.png"),
						mediaType: "image/png",
					},
				]);
				expect(readFileSync(join(imageRoot, "image-001.png"))).toEqual(PNG);
				expect(turnText).toContain("meeting.mp3 — skipped (media_type)");
				expect(turnText).toContain("demo.mp4 — skipped (media_type)");

				const htmlPath = join(workspacePath, "summary.html");
				const csvPath = join(workspacePath, "summary.csv");
				const pdfPath = join(workspacePath, "summary.pdf");
				writeFileSync(htmlPath, outputHtml);
				writeFileSync(csvPath, outputCsv);
				writeFileSync(pdfPath, outputPdf);
				const parentSessionId = `slack-${normalized.event.eventId}`;
				const options = (
					worker as never as {
						createCyrusToolsOptions: (
							sessionId: string,
						) => Parameters<typeof createCyrusToolsServer>[1];
					}
				).createCyrusToolsOptions(parentSessionId);
				expect(options?.slackFiles).toBeDefined();
				const server = createCyrusToolsServer(undefined, options);
				const client = new Client({ name: "f1-slack-files", version: "1.0" });
				const [clientTransport, serverTransport] =
					InMemoryTransport.createLinkedPair();
				await server.connect(serverTransport);
				await client.connect(clientTransport);
				const result = await client.callTool({
					name: "slack_file_upload",
					arguments: {
						files: [
							{ filePath: htmlPath, title: "HTML summary" },
							{ filePath: csvPath, title: "CSV summary" },
							{ filePath: pdfPath, title: "PDF summary" },
						],
						initialComment: "Requested summaries",
					},
				});
				toolText = (result.content[0] as { text: string }).text;
				await client.close();
				await server.close();
				return { sessionId: "f1-slack-file-session" };
			}),
			allowLocalImageDirectory: vi.fn(() => ({ release: vi.fn() })),
			stop: vi.fn(),
			isRunning: vi.fn().mockReturnValue(false),
			isStreaming: vi.fn().mockReturnValue(false),
			addStreamMessage: vi.fn(),
			getMessages: vi.fn().mockReturnValue([]),
		};
		const handler = new ChatSessionHandler(adapter, {
			cyrusHome,
			chatRepositoryProvider: provider,
			runnerConfigBuilder: {
				buildChatConfig: (input: Record<string, unknown>) => {
					workspacePath = String(input.workspacePath);
					return input;
				},
			} as never,
			createRunner: () => runner as never,
			onWebhookStart: vi.fn(),
			onWebhookEnd: vi.fn(),
			onStateChange: vi.fn().mockResolvedValue(undefined),
			onClaudeError: vi.fn(),
		});
		worker = new EdgeWorker({ cyrusHome, repositories: [] });
		(
			worker as never as { chatSessionHandler: typeof handler }
		).chatSessionHandler = handler;

		try {
			await handler.handleEvent(normalized.event);
			await runner.startStreamingTurn.mock.results[0]!.value;
			expect(toolText).toContain('"success":true');
			expect(backend.snapshot().fileDeliveries).toEqual([
				{
					channelId: fixture.channel,
					threadTs: fixture.threadTs,
					initialComment: "Requested summaries",
					files: [
						{
							id: "F_F1_UPLOAD_1",
							filename: "summary.html",
							title: "HTML summary",
							byteLength: outputHtml.byteLength,
						},
						{
							id: "F_F1_UPLOAD_2",
							filename: "summary.csv",
							title: "CSV summary",
							byteLength: outputCsv.byteLength,
						},
						{
							id: "F_F1_UPLOAD_3",
							filename: "summary.pdf",
							title: "PDF summary",
							byteLength: outputPdf.byteLength,
						},
					],
				},
			]);
			const delivered = backend.snapshot().fileDeliveries[0]!.files;
			expect(backend.getUploadedFile(delivered[0]!.id)?.bytes).toEqual(
				outputHtml,
			);
			expect(backend.getUploadedFile(delivered[1]!.id)?.bytes).toEqual(
				outputCsv,
			);
			expect(backend.getUploadedFile(delivered[2]!.id)?.bytes).toEqual(
				outputPdf,
			);
			expect(backend.activeUploadTicketCount).toBe(0);
			const publicEvidence = `${turnText}\n${toolText}\n${JSON.stringify(backend.snapshot())}`;
			expect(publicEvidence).not.toContain("xoxb-f1-synthetic");
			expect(publicEvidence).not.toContain("f1-one-time-");
			expect(backend.externalRequests).toEqual([]);
		} finally {
			await rm(cyrusHome, { recursive: true, force: true });
		}
	});
});
