import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ClaudeRunner } from "cyrus-claude-runner";
import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("EdgeWorker Slack engineering lifecycle", () => {
	it("recovers by paginated repository issue listing and an exact hidden marker line", async () => {
		const priorFetch = globalThis.fetch;
		const marker = "<!-- cyrus-slack-source:exact-source -->";
		const fetchMock = vi
			.fn()
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							number: 1,
							html_url: "https://github.com/acme/api/issues/1",
							body: `${marker}-lookalike`,
						},
					]),
					{
						status: 200,
						headers: {
							link: '<https://api.github.com/repositories/1/issues?page=2>; rel="next"',
						},
					},
				),
			)
			.mockResolvedValueOnce(
				new Response(
					JSON.stringify([
						{
							number: 42,
							html_url: "https://github.com/acme/api/issues/42",
							body: `body\n\n${marker}`,
						},
					]),
					{ status: 200 },
				),
			);
		globalThis.fetch = fetchMock;
		try {
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.resolveGitHubTokenValue = vi.fn().mockResolvedValue("token");

			await expect(
				worker.findSlackEngineeringIssueByMarker("acme/api", marker),
			).resolves.toEqual({
				number: 42,
				url: "https://github.com/acme/api/issues/42",
			});
			expect(fetchMock.mock.calls[0]![0]).toContain(
				"/repos/acme/api/issues?state=all&per_page=100&page=1",
			);
			expect(fetchMock.mock.calls[1]![0]).toContain("page=2");
			expect(JSON.stringify(fetchMock.mock.calls)).not.toContain(
				"/search/issues",
			);
		} finally {
			globalThis.fetch = priorFetch;
		}
	});

	it("follows GitHub pagination until there is no next page", async () => {
		const priorFetch = globalThis.fetch;
		const marker = "<!-- cyrus-slack-source:deep-source -->";
		const fetchMock = vi.fn(async (input: string | URL | Request) => {
			const page = Number(new URL(String(input)).searchParams.get("page"));
			if (page === 11) {
				return new Response(
					JSON.stringify([
						{
							number: 84,
							html_url: "https://github.com/acme/api/issues/84",
							body: `body\n\n${marker}`,
						},
					]),
					{ status: 200 },
				);
			}
			return new Response(JSON.stringify([]), {
				status: 200,
				headers: {
					link: `<https://api.github.com/repositories/1/issues?page=${page + 1}>; rel="next"`,
				},
			});
		});
		globalThis.fetch = fetchMock;
		try {
			const worker: any = Object.create(EdgeWorker.prototype);
			worker.resolveGitHubTokenValue = vi.fn().mockResolvedValue("token");

			await expect(
				worker.findSlackEngineeringIssueByMarker("acme/api", marker),
			).resolves.toEqual({
				number: 84,
				url: "https://github.com/acme/api/issues/84",
			});
			expect(fetchMock).toHaveBeenCalledTimes(11);
			expect(fetchMock.mock.calls[10]![0]).toContain("page=11");
		} finally {
			globalThis.fetch = priorFetch;
		}
	});

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

	it("authorizes the capture only long enough for ClaudeRunner to read ordered follow-up images", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-followup-"));
		const initialContext = join(cyrusHome, "slack-context", "initial");
		const followupContext = join(cyrusHome, "slack-context", "followup");
		await mkdir(initialContext, { recursive: true });
		await mkdir(join(followupContext, "images"), { recursive: true });
		await writeFile(join(initialContext, "sentinel"), "unchanged");
		await writeFile(join(followupContext, "images", "one.png"), "one");
		await writeFile(join(followupContext, "images", "two.jpg"), "two");
		const initialEntries = await readdir(initialContext);
		const addMessage = vi.fn();
		const runner = new ClaudeRunner({
			cyrusHome,
			workingDirectory: cyrusHome,
			allowedDirectories: [initialContext],
		});
		(runner as any).sessionInfo = {
			sessionId: "claude-child",
			startedAt: new Date(),
			isRunning: true,
		};
		(runner as any).streamingPrompt = {
			completed: false,
			addMessage,
		};
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.cyrusHome = cyrusHome;
		const receipt = {
			workItemId: "work",
			contextDirectory: initialContext,
			contextDirectories: [initialContext],
		};
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			current: vi.fn().mockReturnValue(receipt),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: {
				directory: followupContext,
				manifest: {
					messages: [
						{
							text: "authoritative follow-up",
							files: [
								{
									status: "downloaded",
									localPath: "images/one.png",
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
			},
		});
		worker.getGitHubIssueWorkItemSession = vi
			.fn()
			.mockReturnValue({ sessionId: "child" });
		worker.agentSessionManager = {
			getSession: vi.fn().mockReturnValue({ agentRunner: runner }),
		};

		await worker.promptSlackEngineering("parent", "untrusted model summary");

		const content = addMessage.mock.calls[0]?.[0];
		expect(content?.map((part: { type: string }) => part.type)).toEqual([
			"text",
			"image",
			"image",
		]);
		expect(content?.[0]).toEqual({
			type: "text",
			text: "authoritative follow-up",
		});
		expect(content?.[1].source.data).toBe(
			Buffer.from("one").toString("base64"),
		);
		expect(content?.[2].source.data).toBe(
			Buffer.from("two").toString("base64"),
		);
		await expect(readFile(followupContext, "utf8")).rejects.toThrow();
		expect(await readdir(initialContext)).toEqual(initialEntries);
		expect(receipt.contextDirectories).toEqual([initialContext]);
		expect(receipt).not.toHaveProperty("contextDirectories.1", followupContext);
		expect(() =>
			runner.addStreamTurn([
				{
					type: "local_image",
					path: join(followupContext, "images", "one.png"),
					mediaType: "image/png",
				},
			]),
		).toThrow("Unable to load local image");
	});

	it("resumes an inactive Claude runner with exact ordered image bytes before capture cleanup", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-resume-"));
		const followupContext = join(cyrusHome, "slack-context", "followup");
		await mkdir(join(followupContext, "images"), { recursive: true });
		await writeFile(join(followupContext, "images", "one.png"), "one");
		await writeFile(join(followupContext, "images", "two.jpg"), "two");
		const runner = new ClaudeRunner({
			cyrusHome,
			workingDirectory: cyrusHome,
		});
		let finishRunner!: () => void;
		const runnerGate = new Promise<void>((resolve) => {
			finishRunner = resolve;
		});
		const startWithPrompt = vi
			.spyOn(runner as any, "startWithPrompt")
			.mockImplementation(async () => {
				await runnerGate;
				return {
					sessionId: "resumed",
					startedAt: new Date(),
					isRunning: false,
				};
			});
		const workItem = {
			workItemId: "work",
			sessionId: "child",
			runnerType: "claude",
			repositoryFullName: "acme/api",
			issueNumber: 42,
			issue: { title: "Fix" },
		};
		const receipt = { workItemId: "work" };
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.cyrusHome = cyrusHome;
		worker.logger = { warn: vi.fn() };
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			current: vi.fn().mockReturnValue(receipt),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: {
				directory: followupContext,
				manifest: {
					messages: [
						{
							text: "resume with screenshots",
							files: [
								{
									status: "downloaded",
									localPath: "images/one.png",
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
			},
		});
		worker.getGitHubIssueWorkItemSession = vi.fn().mockReturnValue(workItem);
		worker.agentSessionManager = {
			getSession: vi.fn().mockReturnValue({ agentRunner: undefined }),
			addAgentRunner: vi.fn(),
		};
		worker.resolveGitHubTokenValue = vi.fn().mockResolvedValue("token");
		worker.fetchGitHubIssue = vi.fn().mockResolvedValue({
			id: 42,
			title: "Fix",
			body: "Fix",
		});
		worker.runnerResumeSessionId = vi.fn().mockReturnValue("claude-old");
		worker.createGitHubIssueRunner = vi.fn().mockResolvedValue(runner);
		worker.runGitHubIssueWorkItem = vi.fn();

		await worker.promptSlackEngineering("parent", "untrusted summary");

		const content = startWithPrompt.mock.calls[0]?.[2];
		expect(content?.map((part: { type: string }) => part.type)).toEqual([
			"text",
			"image",
			"image",
		]);
		expect(content?.[0]).toEqual({
			type: "text",
			text: "resume with screenshots",
		});
		expect(content?.[1].source.data).toBe(
			Buffer.from("one").toString("base64"),
		);
		expect(content?.[2].source.data).toBe(
			Buffer.from("two").toString("base64"),
		);
		await expect(readFile(followupContext, "utf8")).rejects.toThrow();
		expect(worker.runGitHubIssueWorkItem).toHaveBeenCalledWith(
			workItem,
			runner,
			"",
			"token",
			undefined,
			expect.any(Promise),
		);
		finishRunner();
	});

	it("never authorizes a capture that canonicalizes outside Slack context", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-outside-"));
		await mkdir(join(cyrusHome, "slack-context"));
		const outside = await mkdtemp(
			join(tmpdir(), "cyrus-slack-outside-capture-"),
		);
		await mkdir(join(outside, "images"));
		await writeFile(join(outside, "images", "escape.png"), "safe");
		const runner = new ClaudeRunner({ cyrusHome, workingDirectory: cyrusHome });
		(runner as any).sessionInfo = {
			sessionId: "claude-child",
			startedAt: new Date(),
			isRunning: true,
		};
		(runner as any).streamingPrompt = {
			completed: false,
			addMessage: vi.fn(),
		};
		const authorize = vi.spyOn(runner, "allowLocalImageDirectory");
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.cyrusHome = cyrusHome;
		worker.logger = { warn: vi.fn() };
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			auditDecision: vi.fn(),
			current: vi.fn().mockReturnValue({
				workItemId: "work",
			}),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: {
				directory: outside,
				manifest: {
					messages: [
						{
							text: "unsafe follow-up",
							files: [
								{
									status: "downloaded",
									localPath: "images/escape.png",
									mimeType: "image/png",
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
			getSession: vi.fn().mockReturnValue({ agentRunner: runner }),
		};

		await expect(
			worker.promptSlackEngineering("parent", "untrusted"),
		).rejects.toThrow("Slack context");
		expect(authorize).not.toHaveBeenCalled();
		await expect(
			readFile(join(outside, "images", "escape.png"), "utf8"),
		).resolves.toBe("safe");
	});

	it("revokes access and removes the capture when ClaudeRunner rejects the turn", async () => {
		const cyrusHome = await mkdtemp(join(tmpdir(), "cyrus-slack-partial-"));
		const initialContext = join(cyrusHome, "slack-context", "initial");
		const followupContext = join(cyrusHome, "slack-context", "capture");
		await mkdir(initialContext, { recursive: true });
		await mkdir(join(followupContext, "images"), { recursive: true });
		await writeFile(join(initialContext, "sentinel"), "unchanged");
		await writeFile(join(followupContext, "images", "partial.png"), "partial");
		const runner = new ClaudeRunner({
			cyrusHome,
			workingDirectory: cyrusHome,
			allowedDirectories: [initialContext],
		});
		(runner as any).sessionInfo = {
			sessionId: "claude-child",
			startedAt: new Date(),
			isRunning: true,
		};
		(runner as any).streamingPrompt = {
			completed: false,
			addMessage: vi.fn(() => {
				throw new Error("stream rejected");
			}),
		};
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.cyrusHome = cyrusHome;
		worker.logger = { info: vi.fn(), warn: vi.fn() };
		worker.slackEngineeringOrchestrator = {
			isActive: vi.fn().mockReturnValue(true),
			current: vi.fn().mockReturnValue({
				workItemId: "work",
				contextDirectory: initialContext,
			}),
		};
		worker.captureSlackEngineeringSource = vi.fn().mockResolvedValue({
			manifest: {
				directory: followupContext,
				manifest: {
					messages: [
						{
							text: "rejected follow-up",
							files: [
								{
									status: "downloaded",
									localPath: "images/partial.png",
									mimeType: "image/png",
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
			getSession: vi.fn().mockReturnValue({ agentRunner: runner }),
		};

		await expect(
			worker.promptSlackEngineering("parent", "untrusted"),
		).rejects.toThrow("stream rejected");

		await expect(readFile(followupContext, "utf8")).rejects.toThrow();
		expect(await readdir(initialContext)).toEqual(["sentinel"]);
		expect(() =>
			(runner as any).loadLocalImage({
				type: "local_image",
				path: join(followupContext, "images", "partial.png"),
				mediaType: "image/png",
			}),
		).toThrow("Unable to load local image");
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

	it("resolves restored engineering tools by the verified Slack thread when the parent session id changes", async () => {
		const restoredReceipt = {
			parentSessionId: "parent-before-restart",
			teamId: "T1",
			channelId: "C1",
			threadTs: "100.0",
			kickoffTs: "101.0",
			status: "awaiting_review",
		};
		const status = vi.fn((parentSessionId: string) =>
			parentSessionId === restoredReceipt.parentSessionId
				? restoredReceipt
				: undefined,
		);
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.chatSessionHandler = {
			getLatestEventForSession: vi.fn().mockReturnValue({
				teamId: "T1",
				payload: { channel: "C1", thread_ts: "100.0", ts: "102.0" },
			}),
		};
		worker.slackEngineeringOrchestrator = {
			current: vi.fn().mockReturnValue(undefined),
			allReceipts: vi.fn().mockReturnValue([restoredReceipt]),
			status,
		};
		worker.getFailureModesClient = vi.fn().mockReturnValue(null);

		const options = worker.createCyrusToolsOptions("parent-after-restart");

		await expect(options.engineering.status()).resolves.toBe(restoredReceipt);
		expect(status).toHaveBeenCalledWith("parent-before-restart");
	});
});
