import { readFileSync } from "node:fs";
import { access, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { AgentTurn } from "cyrus-core";
import {
	type ChatRepositoryProvider,
	ChatSessionHandler,
	SlackChatAdapter,
} from "cyrus-edge-worker";
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
			await expect(access(image.path)).rejects.toThrow();
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
			expect(text).toContain("File: IMG_4421.png — downloaded");
			expect(encodedImage).toEqual(PNG);
			expect(image?.mediaType).toBe("image/png");
			expect(allowedDirectories).toEqual(new Set());
			if (!image) throw new Error("missing image input");
			await expect(access(image.path)).rejects.toThrow();
			expect(backend.externalRequests).toEqual([]);
		} finally {
			await rm(cyrusHome, { recursive: true, force: true });
		}
	});
});
