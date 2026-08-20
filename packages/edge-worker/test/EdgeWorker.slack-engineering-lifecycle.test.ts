import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("EdgeWorker Slack engineering lifecycle", () => {
	it("assembles the captured transcript before canonical capture-local images in message/file order", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cyrus-slack-turn-"));
		const transcriptPath = join(directory, "transcript.md");
		await writeFile(transcriptPath, "authoritative transcript");
		const worker: any = Object.create(EdgeWorker.prototype);

		const turn = await worker.buildSlackEngineeringContextTurn({
			directory,
			transcriptPath,
			manifest: {
				messages: [
					{
						files: [
							{
								status: "downloaded",
								localPath: "images/one.png",
								mimeType: "image/png",
							},
						],
					},
					{
						files: [
							{
								status: "failed",
								localPath: "images/skip.png",
								mimeType: "image/png",
							},
							{
								status: "downloaded",
								localPath: "images/two.jpg",
								mimeType: "image/jpeg",
							},
						],
					},
				],
			},
		});

		expect(turn).toEqual([
			{ type: "text", text: "authoritative transcript" },
			{
				type: "local_image",
				path: join(directory, "images/one.png"),
				mediaType: "image/png",
			},
			{
				type: "local_image",
				path: join(directory, "images/two.jpg"),
				mediaType: "image/jpeg",
			},
		]);
	});

	it("does not capture artifacts when create validation rejects", async () => {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.slackEngineeringOrchestrator = {
			validateCreateInput: vi.fn(() => {
				throw new Error("invalid repository");
			}),
		};
		worker.captureSlackEngineeringSource = vi.fn();
		worker.chatSessionHandler = { getLatestEventForSession: vi.fn() };
		worker.logger = { info: vi.fn() };

		await expect(
			worker.createAndStartSlackEngineering("parent", {
				issueRepository: "unknown/repository",
				title: "secret title",
				summary: "secret body",
			}),
		).rejects.toThrow("invalid repository");
		expect(worker.captureSlackEngineeringSource).not.toHaveBeenCalled();
		expect(JSON.stringify(worker.logger.info.mock.calls)).not.toContain(
			"secret",
		);
	});

	it("cleans captured create artifacts when strict receipt persistence rejects", async () => {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.slackEngineeringOrchestrator = {
			validateCreateInput: vi.fn(),
			createAndStart: vi.fn().mockRejectedValue(new Error("disk unavailable")),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			source: { parentSessionId: "parent" },
			manifest: { directory: "/context/new" },
		});
		worker.buildSlackEngineeringContextTurn = vi.fn().mockResolvedValue([]);
		worker.cleanupSlackContextDirectories = vi.fn();

		await expect(
			worker.createAndStartSlackEngineering("parent", {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
			}),
		).rejects.toThrow("disk unavailable");
		expect(worker.cleanupSlackContextDirectories).toHaveBeenCalledWith(
			undefined,
			["/context/new"],
		);
	});

	it("does not capture follow-up artifacts for a terminal receipt", async () => {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(false),
		};
		worker.captureSlackEngineeringSource = vi.fn();

		await expect(
			worker.promptSlackEngineering("parent", "change it"),
		).rejects.toThrow("No active engineering job");
		expect(worker.captureSlackEngineeringSource).not.toHaveBeenCalled();
	});

	it("cleans a newly captured follow-up directory if the receipt turns terminal", async () => {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			addContextDirectory: vi
				.fn()
				.mockRejectedValue(new Error("receipt is terminal")),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: { directory: "/context/new", manifest: { messages: [] } },
		});
		worker.cleanupSlackContextDirectories = vi.fn();

		await expect(
			worker.promptSlackEngineering("parent", "change it"),
		).rejects.toThrow("receipt is terminal");
		expect(worker.cleanupSlackContextDirectories).toHaveBeenCalledWith(
			undefined,
			["/context/new"],
		);
	});

	it("delivers ordered follow-up image parts to the active child runner", async () => {
		const addStreamTurn = vi.fn();
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			addContextDirectory: vi.fn(),
			current: vi.fn().mockReturnValue({ workItemId: "work" }),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: {
				directory: "/context/new",
				manifest: {
					messages: [
						{
							text: "authoritative follow-up",
							files: [
								{
									status: "downloaded",
									localPath: "/context/one.png",
									mimeType: "image/png",
								},
								{
									status: "downloaded",
									localPath: "/context/two.jpg",
									mimeType: "image/jpeg",
								},
							],
						},
					],
				},
			},
		});
		worker.getGitHubIssueWorkItemSession = vi
			.fn()
			.mockReturnValue({ sessionId: "child" });
		worker.agentSessionManager = {
			getSession: vi.fn().mockReturnValue({
				agentRunner: {
					isRunning: vi.fn().mockReturnValue(true),
					addStreamTurn,
				},
			}),
		};

		await worker.promptSlackEngineering("parent", "untrusted model summary");

		expect(addStreamTurn).toHaveBeenCalledWith([
			{ type: "text", text: "authoritative follow-up" },
			{ type: "local_image", path: "/context/one.png", mediaType: "image/png" },
			{
				type: "local_image",
				path: "/context/two.jpg",
				mediaType: "image/jpeg",
			},
		]);
	});

	it("keeps tampered restored paths outside the Slack context root", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-cleanup-"));
		const root = join(cyrusHome, "slack-context");
		const safe = join(root, "T", "C", "100");
		const outside = join(cyrusHome, "outside.txt");
		await mkdir(safe, { recursive: true });
		await writeFile(join(safe, "manifest.json"), "safe");
		await writeFile(outside, "must survive");
		const auditDecision = vi.fn();
		const clearContextDirectories = vi.fn();
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.cyrusHome = cyrusHome;
		worker.logger = { warn: vi.fn() };
		worker.slackEngineeringOrchestrator = {
			auditDecision,
			clearContextDirectories,
		};
		const receipt = {
			sourceKey: "source",
			workItemId: "work",
			contextDirectories: [safe, outside],
		};

		await worker.cleanupSlackContextDirectories(receipt);

		await expect(readFile(outside, "utf8")).resolves.toBe("must survive");
		await expect(
			readFile(join(safe, "manifest.json"), "utf8"),
		).rejects.toThrow();
		expect(auditDecision).toHaveBeenCalledWith("cleanup_rejected", receipt);
		expect(JSON.stringify(worker.logger.warn.mock.calls)).not.toContain(
			outside,
		);
		expect(clearContextDirectories).toHaveBeenCalledWith("work");
	});

	it("replays pending final delivery after restart and marks it delivered", async () => {
		const priorToken = process.env.SLACK_BOT_TOKEN;
		process.env.SLACK_BOT_TOKEN = "xoxb-runtime-secret";
		try {
			const receipt = {
				sourceKey: "source",
				workItemId: "work",
				parentSessionId: "parent",
				teamId: "T1",
				userId: "U1",
				channelId: "C1",
				threadTs: "100.0",
				kickoffTs: "101.0",
				deliveryStatus: "pending",
				deliveryMessage: "Finished safely",
			};
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.slackChatAdapter = { postDelegatedWorkMessage: vi.fn() };
			worker.slackEngineeringOrchestrator = {
				pendingDeliveries: vi.fn().mockReturnValue([receipt]),
				persistPendingDelivery: vi.fn(),
				markDeliveryDelivered: vi.fn(),
				auditDecision: vi.fn(),
			};
			worker.logger = { warn: vi.fn() };

			await worker.replayPendingSlackEngineeringDeliveries();

			expect(
				worker.slackChatAdapter.postDelegatedWorkMessage,
			).toHaveBeenCalledWith(
				expect.objectContaining({
					teamId: "T1",
					slackBotToken: "xoxb-runtime-secret",
					payload: expect.objectContaining({
						channel: "C1",
						thread_ts: "100.0",
					}),
				}),
				"Finished safely",
			);
			expect(
				worker.slackEngineeringOrchestrator.markDeliveryDelivered,
			).toHaveBeenCalledWith("work");
			expect(
				worker.slackEngineeringOrchestrator.auditDecision,
			).toHaveBeenCalledWith("delivery_replay", receipt);
			expect(
				worker.slackEngineeringOrchestrator.auditDecision,
			).toHaveBeenCalledWith("delivery_result", receipt);
		} finally {
			if (priorToken === undefined) delete process.env.SLACK_BOT_TOKEN;
			else process.env.SLACK_BOT_TOKEN = priorToken;
		}
	});

	it("replays a restored pending delivery when a verified proxy event supplies its runtime token", async () => {
		const priorToken = process.env.SLACK_BOT_TOKEN;
		delete process.env.SLACK_BOT_TOKEN;
		try {
			const receipt = {
				sourceKey: "source",
				workItemId: "work",
				parentSessionId: "parent",
				teamId: "T1",
				userId: "U1",
				channelId: "C1",
				threadTs: "100.0",
				kickoffTs: "101.0",
				deliveryStatus: "pending",
				deliveryMessage: "Finished through proxy",
			};
			let release!: () => void;
			const gate = new Promise<void>((resolve) => {
				release = resolve;
			});
			const postDelegatedWorkMessage = vi.fn(async () => gate);
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.slackChatAdapter = { postDelegatedWorkMessage };
			worker.slackEngineeringOrchestrator = {
				pendingDeliveries: vi.fn().mockReturnValue([receipt]),
				persistPendingDelivery: vi.fn(),
				markDeliveryDelivered: vi.fn(async () => {
					receipt.deliveryStatus = "delivered";
				}),
				auditDecision: vi.fn(),
			};
			worker.logger = { warn: vi.fn() };

			await worker.replayPendingSlackEngineeringDeliveries();
			expect(postDelegatedWorkMessage).not.toHaveBeenCalled();
			expect(
				worker.slackEngineeringOrchestrator.auditDecision,
			).toHaveBeenCalledWith("delivery_deferred", receipt);

			const event = {
				eventType: "message",
				eventId: "proxy-event",
				teamId: "T1",
				slackBotToken: "xoxb-proxy-runtime-secret",
				payload: {
					type: "message",
					user: "U2",
					text: "hello",
					ts: "200.0",
					event_ts: "200.0",
					channel: "C2",
				},
			};
			const first =
				worker.replayPendingSlackEngineeringDeliveriesForEvent(event);
			const second =
				worker.replayPendingSlackEngineeringDeliveriesForEvent(event);
			expect(first).toBe(second);
			await Promise.resolve();
			await Promise.resolve();
			expect(postDelegatedWorkMessage).toHaveBeenCalledOnce();
			release();
			await Promise.all([first, second]);

			expect(postDelegatedWorkMessage).toHaveBeenCalledWith(
				expect.objectContaining({
					teamId: "T1",
					slackBotToken: "xoxb-proxy-runtime-secret",
					payload: expect.objectContaining({
						channel: "C1",
						thread_ts: "100.0",
					}),
				}),
				"Finished through proxy",
			);
			expect(receipt.deliveryStatus).toBe("delivered");
			expect(JSON.stringify(receipt)).not.toContain(
				"xoxb-proxy-runtime-secret",
			);
			expect(
				worker.slackEngineeringOrchestrator.auditDecision,
			).toHaveBeenCalledWith("delivery_proxy_retry", receipt);
			expect(
				JSON.stringify(
					worker.slackEngineeringOrchestrator.auditDecision.mock.calls,
				),
			).not.toContain("xoxb-proxy-runtime-secret");
		} finally {
			if (priorToken === undefined) delete process.env.SLACK_BOT_TOKEN;
			else process.env.SLACK_BOT_TOKEN = priorToken;
		}
	});

	it("keeps a team retry scheduled when one pending receipt fails and a sibling succeeds", async () => {
		vi.useFakeTimers();
		try {
			const receiptA: any = {
				sourceKey: "source-a",
				workItemId: "work-a",
				parentSessionId: "parent-a",
				teamId: "T1",
				userId: "U1",
				channelId: "C1",
				threadTs: "100.0",
				kickoffTs: "101.0",
				deliveryStatus: "pending",
				deliveryMessage: "Finished A",
			};
			const receiptB: any = {
				...receiptA,
				sourceKey: "source-b",
				workItemId: "work-b",
				parentSessionId: "parent-b",
				threadTs: "200.0",
				kickoffTs: "201.0",
				deliveryMessage: "Finished B",
			};
			let aPersistenceAttempts = 0;
			const persistPendingDelivery = vi.fn(async (workItemId: string) => {
				if (workItemId === "work-a" && ++aPersistenceAttempts === 1)
					throw new Error("transient persistence failure");
			});
			const postDelegatedWorkMessage = vi.fn().mockResolvedValue(undefined);
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.slackChatAdapter = { postDelegatedWorkMessage };
			worker.slackEngineeringOrchestrator = {
				pendingDeliveries: vi.fn(() =>
					[receiptA, receiptB].filter(
						(receipt) => receipt.deliveryStatus === "pending",
					),
				),
				persistPendingDelivery,
				markDeliveryDelivered: vi.fn(async (workItemId: string) => {
					const receipt = workItemId === "work-a" ? receiptA : receiptB;
					receipt.deliveryStatus = "delivered";
				}),
				auditDecision: vi.fn(),
			};
			worker.logger = { warn: vi.fn() };
			worker.slackRuntimeTokens = new Map([["T1", "xoxb-runtime"]]);

			await worker.startSlackEngineeringDeliveryReplay("T1", "xoxb-runtime");

			expect(receiptA.deliveryStatus).toBe("pending");
			expect(receiptB.deliveryStatus).toBe("delivered");
			expect(postDelegatedWorkMessage).toHaveBeenCalledTimes(1);
			expect(postDelegatedWorkMessage.mock.calls[0]?.[1]).toBe("Finished B");
			expect(vi.getTimerCount()).toBe(1);

			await vi.runAllTimersAsync();

			expect(receiptA.deliveryStatus).toBe("delivered");
			expect(postDelegatedWorkMessage).toHaveBeenCalledTimes(2);
			expect(postDelegatedWorkMessage.mock.calls[1]?.[1]).toBe("Finished A");
			expect(
				postDelegatedWorkMessage.mock.calls.filter(
					([, message]) => message === "Finished B",
				),
			).toHaveLength(1);
		} finally {
			vi.useRealTimers();
		}
	});

	it("persists pending delivery strictly before posting on retry", async () => {
		vi.useFakeTimers();
		try {
			const receipt: any = {
				sourceKey: "source",
				workItemId: "work",
				parentSessionId: "parent",
				teamId: "T1",
				userId: "U1",
				channelId: "C1",
				threadTs: "100.0",
				kickoffTs: "101.0",
				deliveryStatus: "pending",
				deliveryMessage: "Finished safely",
			};
			const order: string[] = [];
			let persistenceAttempts = 0;
			const persistPendingDelivery = vi.fn(async () => {
				persistenceAttempts++;
				order.push(`persist:${persistenceAttempts}`);
				if (persistenceAttempts === 1) throw new Error("disk unavailable");
			});
			const postDelegatedWorkMessage = vi.fn(async () => {
				order.push("post");
			});
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.slackChatAdapter = { postDelegatedWorkMessage };
			worker.slackEngineeringOrchestrator = {
				pendingDeliveries: vi.fn(() =>
					receipt.deliveryStatus === "pending" ? [receipt] : [],
				),
				persistPendingDelivery,
				markDeliveryDelivered: vi.fn(async () => {
					receipt.deliveryStatus = "delivered";
				}),
				auditDecision: vi.fn(),
			};
			worker.logger = { warn: vi.fn() };
			worker.slackRuntimeTokens = new Map([["T1", "xoxb-runtime"]]);

			await worker.startSlackEngineeringDeliveryReplay("T1", "xoxb-runtime");

			expect(order).toEqual(["persist:1"]);
			expect(postDelegatedWorkMessage).not.toHaveBeenCalled();
			expect(receipt.deliveryStatus).toBe("pending");

			await vi.runAllTimersAsync();

			expect(order).toEqual(["persist:1", "persist:2", "post"]);
			expect(receipt.deliveryStatus).toBe("delivered");
		} finally {
			vi.useRealTimers();
		}
	});

	it("uses strict persistence so a failed receipt write blocks external work", async () => {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.repositories = new Map([
			[
				"repo",
				{
					name: "api",
					githubUrl: "https://github.com/acme/api",
					isActive: true,
				},
			],
		]);
		worker.configuredRepositoryFullName = vi.fn().mockReturnValue("acme/api");
		worker.serializeMappings = vi.fn().mockReturnValue({});
		worker.persistenceManager = {
			saveEdgeWorkerState: vi
				.fn()
				.mockRejectedValue(new Error("disk unavailable")),
		};
		worker.logger = { debug: vi.fn(), info: vi.fn() };
		worker.createSlackEngineeringIssue = vi.fn();
		worker.startGitHubIssueWorkItem = vi.fn();
		const orchestrator = worker.createSlackEngineeringOrchestrator();

		await expect(
			orchestrator.createAndStart(
				{
					parentSessionId: "parent",
					teamId: "T1",
					userId: "U1",
					channelId: "C1",
					threadTs: "100",
					kickoffTs: "101",
					permalink: "https://example.slack.com/thread",
				},
				{ issueRepository: "acme/api", title: "Fix", summary: "Fix" },
			),
		).rejects.toThrow("disk unavailable");
		expect(worker.createSlackEngineeringIssue).not.toHaveBeenCalled();
		expect(worker.startGitHubIssueWorkItem).not.toHaveBeenCalled();
	});

	it("round-trips pending delivery state through EdgeWorker persistence", () => {
		const receipt = {
			sourceKey: "source",
			deliveryStatus: "pending",
			deliveryMessage: "Finished after restart",
		};
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.agentSessionManager = {
			serializeState: vi.fn().mockReturnValue({ sessions: {}, entries: {} }),
		};
		worker.globalSessionRegistry = {
			serializeState: vi.fn().mockReturnValue({ childToParentMap: {} }),
		};
		worker.repositoryRouter = {
			getIssueRepositoryCache: vi.fn().mockReturnValue(new Map()),
		};
		worker.slackEngineeringOrchestrator = {
			allReceipts: vi.fn().mockReturnValue([receipt]),
		};
		const state = worker.serializeMappings();
		const restored: any = Object.create(EdgeWorker.prototype);
		restored.slackEngineeringOrchestrator = { restore: vi.fn() };
		restored.agentSessionManager = { restoreState: vi.fn() };
		restored.globalSessionRegistry = { restoreState: vi.fn() };
		restored.repositoryRouter = { restoreIssueRepositoryCache: vi.fn() };
		restored.logger = { debug: vi.fn() };

		restored.restoreMappings(state);

		expect(restored.slackEngineeringOrchestrator.restore).toHaveBeenCalledWith([
			receipt,
		]);
	});
});
