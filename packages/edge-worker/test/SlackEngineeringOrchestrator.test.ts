import { describe, expect, it, vi } from "vitest";
import {
	SlackEngineeringOrchestrator,
	type SlackEngineeringReceipt,
} from "../src/SlackEngineeringOrchestrator.js";

const source = {
	parentSessionId: "slack-session",
	teamId: "T123",
	userId: "U123",
	channelId: "C123",
	threadTs: "100.000",
	kickoffTs: "101.000",
	permalink: "https://example.slack.com/archives/C123/p100",
	contextDirectory: "/tmp/context",
	contextManifestPath: "/tmp/context/manifest.json",
	contextTranscriptPath: "/tmp/context/transcript.md",
};

const repositories = [
	{ name: "api", fullName: "acme/api", routingHints: ["backend"] },
	{ name: "web", fullName: "acme/web", routingHints: ["frontend"] },
];

function setup(initial: SlackEngineeringReceipt[] = []) {
	const saves: SlackEngineeringReceipt[][] = [];
	const createIssue = vi.fn().mockResolvedValue({
		number: 42,
		url: "https://github.com/acme/api/issues/42",
	});
	const findIssueByMarker = vi.fn().mockResolvedValue(undefined);
	const startWorkItem = vi.fn().mockResolvedValue({
		workItemId: "slack-source-work",
		sessionId: "github-issue-slack-source-work",
		status: "starting" as const,
	});
	const promptWorkItem = vi.fn();
	const stopWorkItem = vi.fn();
	const audit = vi.fn();
	const service = new SlackEngineeringOrchestrator(
		{
			repositories: () => repositories,
			persist: async (receipts) =>
				saves.push(receipts.map((item) => ({ ...item }))),
			createIssue,
			findIssueByMarker,
			startWorkItem,
			promptWorkItem,
			stopWorkItem,
			audit,
		},
		initial,
	);
	return {
		service,
		saves,
		createIssue,
		findIssueByMarker,
		startWorkItem,
		promptWorkItem,
		stopWorkItem,
		audit,
	};
}

describe("SlackEngineeringOrchestrator", () => {
	it("persists creating before posting the GitHub issue and starting before child startup", async () => {
		const { service, saves, createIssue, startWorkItem } = setup();
		const order: string[] = [];
		createIssue.mockImplementation(async () => {
			order.push(`post:${saves.at(-1)?.[0]?.status}`);
			return { number: 42, url: "https://github.com/acme/api/issues/42" };
		});
		startWorkItem.mockImplementation(async () => {
			order.push(`start:${saves.at(-1)?.[0]?.status}`);
			return {
				workItemId: "work-42",
				sessionId: "session-42",
				status: "starting",
			};
		});

		const result = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix checkout",
			summary: "Checkout fails for returning users.",
			targetRepositories: ["acme/api", "acme/web"],
		});

		expect(order).toEqual(["post:creating", "start:starting"]);
		expect(result.status).toBe("starting");
		expect(createIssue.mock.calls[0]?.[0].body).toMatch(
			/^Checkout fails for returning users\.\n\nRepositories:\n- acme\/api\n- acme\/web\n\nSlack thread: https:\/\/example\.slack\.com\/archives\/C123\/p100\n\n<!-- cyrus-slack-source:[a-f0-9]{64} -->$/,
		);
		expect(createIssue.mock.calls[0]?.[0].body).not.toContain("/tmp/context");
		expect(startWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ runnerType: "claude" }),
		);
	});

	it("persists and starts work from a selected existing issue without posting a new issue", async () => {
		const { service, saves, createIssue, startWorkItem } = setup();
		startWorkItem.mockImplementation(async () => {
			expect(saves.at(-1)?.[0]).toMatchObject({
				status: "starting",
				issueNumber: 17,
				issueUrl: "https://github.com/acme/api/issues/17",
				issueCreationState: "created",
				issueReused: true,
			});
			return {
				workItemId: "work-17",
				sessionId: "session-17",
				status: "starting",
			};
		});

		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix checkout",
			summary: "Checkout fails.",
			existingIssue: {
				number: 17,
				url: "https://github.com/acme/api/issues/17",
				wasClosed: false,
			},
		});

		expect(createIssue).not.toHaveBeenCalled();
		expect(startWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ issueNumber: 17 }),
		);
		expect(receipt).toMatchObject({
			issueNumber: 17,
			issueCreationState: "created",
			issueReused: true,
		});
	});

	it("retries a durably persisted existing issue without requiring it in the retry input", async () => {
		const first = setup();
		let writes = 0;
		(first.service as any).deps.persist = vi
			.fn()
			.mockImplementation(async (receipts: SlackEngineeringReceipt[]) => {
				first.saves.push(receipts.map((item) => ({ ...item })));
				writes++;
				if (writes === 2) throw new Error("starting write interrupted");
			});

		await expect(
			first.service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix checkout",
				summary: "Checkout fails.",
				existingIssue: {
					number: 17,
					url: "https://github.com/acme/api/issues/17",
					wasClosed: false,
				},
			}),
		).rejects.toThrow("starting write interrupted");
		const persisted = first.saves.at(-1)!;
		expect(persisted[0]).toMatchObject({
			issueNumber: 17,
			issueUrl: "https://github.com/acme/api/issues/17",
			issueCreationState: "created",
			issueReused: true,
		});

		const retry = setup(persisted);
		const receipt = await retry.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored retry title",
			summary: "ignored retry summary",
		});

		expect(retry.createIssue).not.toHaveBeenCalled();
		expect(retry.startWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ issueNumber: 17 }),
		);
		expect(receipt.issueReused).toBe(true);
	});

	it("durably marks a database-sensitive child exactly once", async () => {
		const { service, saves } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Inspect checkout",
			summary: "Use authorized database evidence.",
		});
		const savesBeforeMark = saves.length;

		await service.markDatabaseSensitive(receipt.workItemId!);
		await service.markDatabaseSensitive(receipt.workItemId!);

		expect(service.byWorkItem(receipt.workItemId!)?.databaseSensitive).toBe(
			true,
		);
		expect(saves).toHaveLength(savesBeforeMark + 1);
		expect(saves.at(-1)?.[0]?.databaseSensitive).toBe(true);
	});

	it("recovers an uncertain create by hidden marker without posting a duplicate", async () => {
		const first = setup();
		first.createIssue.mockRejectedValueOnce(new Error("connection reset"));
		await expect(
			first.service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix checkout",
				summary: "Checkout fails.",
			}),
		).rejects.toThrow("connection reset");
		const persisted = first.saves.at(-1)!;
		const retry = setup(persisted);
		retry.findIssueByMarker.mockResolvedValue({
			number: 42,
			url: "https://github.com/acme/api/issues/42",
		});

		const result = await retry.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored retry title",
			summary: "ignored retry summary",
		});

		expect(result.issueNumber).toBe(42);
		expect(retry.createIssue).not.toHaveBeenCalled();
		expect(retry.findIssueByMarker).toHaveBeenCalledWith(
			"acme/api",
			persisted[0]!.marker,
		);
		expect(retry.audit).toHaveBeenCalledWith("recovery", expect.any(Object));
	});

	it("fails closed after one uncertain POST until exact issue listing can see the marker", async () => {
		const first = setup();
		first.createIssue.mockRejectedValueOnce(
			new Error("socket closed after POST"),
		);
		await expect(
			first.service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix checkout",
				summary: "Checkout fails.",
			}),
		).rejects.toThrow("socket closed after POST");
		const uncertain = first.service.allReceipts();
		expect(uncertain[0]).toMatchObject({ issueCreationState: "uncertain" });

		const hidden = setup(uncertain);
		await expect(
			hidden.service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "ignored",
				summary: "ignored",
			}),
		).rejects.toThrow("visibility is uncertain");
		expect(hidden.findIssueByMarker).toHaveBeenCalledOnce();
		expect(hidden.createIssue).not.toHaveBeenCalled();

		const visible = setup(hidden.service.allReceipts());
		visible.findIssueByMarker.mockResolvedValue({
			number: 42,
			url: "https://github.com/acme/api/issues/42",
		});
		await visible.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored",
			summary: "ignored",
		});
		expect(visible.createIssue).not.toHaveBeenCalled();
		expect(first.createIssue).toHaveBeenCalledOnce();
	});

	it("durably keeps a stop requested during delayed issue creation and never starts a child", async () => {
		const { service, createIssue, startWorkItem, saves } = setup();
		let releaseCreate!: () => void;
		const createGate = new Promise<void>((resolve) => {
			releaseCreate = resolve;
		});
		createIssue.mockImplementation(async () => {
			await createGate;
			return { number: 42, url: "https://github.com/acme/api/issues/42" };
		});
		const creating = service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		await vi.waitFor(() => expect(createIssue).toHaveBeenCalledOnce());

		const stopped = await service.stop(source.parentSessionId);
		expect(stopped.status).toBe("stopped");
		expect(saves.at(-1)?.[0]?.status).toBe("stopped");
		releaseCreate();
		const result = await creating;

		expect(result.status).toBe("stopped");
		expect(service.current(source.parentSessionId)?.status).toBe("stopped");
		expect(startWorkItem).not.toHaveBeenCalled();
	});

	it("enforces one active job per thread and allows a later kickoff after terminal state", async () => {
		const { service, createIssue } = setup();
		const first = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "One",
			summary: "One",
		});
		const duplicate = await service.createAndStart(
			{ ...source, kickoffTs: "102.000" },
			{
				issueRepository: "acme/api",
				title: "Two",
				summary: "Two",
			},
		);
		expect(duplicate.sourceKey).toBe(first.sourceKey);
		expect(createIssue).toHaveBeenCalledTimes(1);

		await service.setStatus(first.workItemId!, "awaiting_review");
		const next = await service.createAndStart(
			{ ...source, kickoffTs: "102.000" },
			{
				issueRepository: "acme/api",
				title: "Two",
				summary: "Two",
			},
		);
		expect(next.sourceKey).not.toBe(first.sourceKey);
		expect(createIssue).toHaveBeenCalledTimes(2);
	});

	it("validates target repositories without exposing local paths", async () => {
		const { service } = setup();
		expect(service.listRepositories()).toEqual(repositories);
		await expect(
			service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
				targetRepositories: ["acme/web"],
			}),
		).rejects.toThrow("must contain the primary issue repository");
		await expect(
			service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
				targetRepositories: ["acme/api", "unknown/repo"],
			}),
		).rejects.toThrow("not an active configured GitHub repository");
	});

	it("propagates creating persistence failure before GitHub POST", async () => {
		const { service, createIssue, startWorkItem } = setup();
		(service as any).deps.persist = vi
			.fn()
			.mockRejectedValue(new Error("disk full"));

		await expect(
			service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
			}),
		).rejects.toThrow("disk full");
		expect(createIssue).not.toHaveBeenCalled();
		expect(startWorkItem).not.toHaveBeenCalled();
	});

	it("can post after restoring a receipt whose durable pre-POST attempt never began", async () => {
		const initial = setup();
		const neverAttempted: SlackEngineeringReceipt = {
			...source,
			sourceKey:
				"e30c15136e038aa126e57d878a36d9635772ab2b88bfdb07ba86043d1bedd982",
			marker:
				"<!-- cyrus-slack-source:e30c15136e038aa126e57d878a36d9635772ab2b88bfdb07ba86043d1bedd982 -->",
			status: "creating",
			issueCreationState: "not_attempted",
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
			targetRepositories: ["acme/api"],
		};
		initial.service.restore([neverAttempted]);

		await initial.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored",
			summary: "ignored",
		});

		expect(initial.findIssueByMarker).not.toHaveBeenCalled();
		expect(initial.createIssue).toHaveBeenCalledOnce();
	});

	it("propagates starting persistence failure before child startup", async () => {
		const { service, createIssue, startWorkItem } = setup();
		let writes = 0;
		(service as any).deps.persist = vi.fn().mockImplementation(async () => {
			writes++;
			if (writes === 3) throw new Error("starting write failed");
		});

		await expect(
			service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
			}),
		).rejects.toThrow("starting write failed");
		expect(createIssue).toHaveBeenCalledOnce();
		expect(startWorkItem).not.toHaveBeenCalled();
	});

	it("recovers a restored starting receipt by retrying the same child start", async () => {
		const initial = setup();
		await initial.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		const restored = initial.service
			.allReceipts()
			.map((receipt) => ({ ...receipt, status: "starting" as const }));
		const retry = setup(restored);

		const result = await retry.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored",
			summary: "ignored",
		});

		expect(retry.createIssue).not.toHaveBeenCalled();
		expect(retry.startWorkItem).toHaveBeenCalledOnce();
		expect(retry.startWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				workItemId: restored[0]!.workItemId,
				issueNumber: 42,
			}),
		);
		expect(result.sessionId).toBe("github-issue-slack-source-work");
	});

	it("durably marks failed startup and permits same-source recovery", async () => {
		const first = setup();
		first.startWorkItem.mockRejectedValueOnce(new Error("startup failed"));
		await expect(
			first.service.createAndStart(source, {
				issueRepository: "acme/api",
				title: "Fix",
				summary: "Fix",
			}),
		).rejects.toThrow("startup failed");
		expect(first.saves.at(-1)?.[0]).toMatchObject({
			status: "failed",
			error: "startup failed",
		});
		const retry = setup(first.saves.at(-1)!);

		await retry.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "ignored",
			summary: "ignored",
		});
		expect(retry.createIssue).not.toHaveBeenCalled();
		expect(retry.startWorkItem).toHaveBeenCalledOnce();
	});

	it("shares one in-flight create across truly concurrent calls", async () => {
		const { service, createIssue, startWorkItem } = setup();
		let release!: () => void;
		const gate = new Promise<void>((resolve) => {
			release = resolve;
		});
		createIssue.mockImplementation(async () => {
			await gate;
			return { number: 42, url: "https://github.com/acme/api/issues/42" };
		});
		const input = { issueRepository: "acme/api", title: "Fix", summary: "Fix" };

		const first = service.createAndStart(source, input);
		const second = service.createAndStart(source, input);
		release();
		const [a, b] = await Promise.all([first, second]);

		expect(a).toBe(b);
		expect(createIssue).toHaveBeenCalledOnce();
		expect(startWorkItem).toHaveBeenCalledOnce();
	});

	it("normalizes the primary repository first and removes duplicate targets", async () => {
		const { service, startWorkItem } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
			targetRepositories: ["acme/web", "api", "acme/web"],
		});
		expect(receipt.targetRepositories).toEqual(["acme/api", "acme/web"]);
		expect(startWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({
				targetRepositoryFullNames: ["acme/api", "acme/web"],
			}),
		);
	});

	it("scopes current, status actions, prompt, and stop to the parent thread", async () => {
		const { service, promptWorkItem, stopWorkItem } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		expect(service.current("other-session")).toBeUndefined();
		await expect(service.prompt("other-session", "change it")).rejects.toThrow(
			"No engineering job exists",
		);
		await service.prompt(source.parentSessionId, "change it");
		expect(promptWorkItem).toHaveBeenCalledWith(
			receipt.workItemId,
			"change it",
		);
		await expect(service.stop("other-session")).rejects.toThrow(
			"No engineering job exists",
		);
		await service.stop(source.parentSessionId);
		expect(stopWorkItem).toHaveBeenCalledWith(receipt.workItemId);
	});

	it("rejects new context artifacts for terminal receipts", async () => {
		const { service } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		await service.setStatus(receipt.workItemId!, "awaiting_review");
		await expect(
			service.addContextDirectory(source.parentSessionId, "/tmp/new-context"),
		).rejects.toThrow("No active engineering job");
	});

	it("persists pending terminal delivery before marking it delivered", async () => {
		const { service, saves } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		await service.markTerminalDeliveryPending(
			receipt.workItemId!,
			"awaiting_review",
			"Finished work",
		);
		expect(saves.at(-1)?.[0]).toMatchObject({
			status: "awaiting_review",
			deliveryStatus: "pending",
			deliveryMessage: "Finished work",
		});
		await service.markDeliveryDelivered(receipt.workItemId!);
		expect(saves.at(-1)?.[0]?.deliveryStatus).toBe("delivered");
	});

	it("keeps delivery pending in memory when the delivered write fails", async () => {
		const { service } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Fix",
			summary: "Fix",
		});
		await service.markTerminalDeliveryPending(
			receipt.workItemId!,
			"awaiting_review",
			"Finished work",
		);
		(service as any).deps.persist = vi
			.fn()
			.mockRejectedValue(new Error("disk unavailable"));

		await expect(
			service.markDeliveryDelivered(receipt.workItemId!),
		).rejects.toThrow("disk unavailable");
		expect(service.pendingDeliveries()).toHaveLength(1);
	});

	it("restore replaces all receipt and index state", async () => {
		const first = setup();
		await first.service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "Old",
			summary: "Old",
		});
		const replacement = {
			...first.service.allReceipts()[0]!,
			sourceKey: "replacement",
			parentSessionId: "new-parent",
			kickoffTs: "999.0",
		};
		first.service.restore([replacement]);
		expect(first.service.current(source.parentSessionId)).toBeUndefined();
		expect(first.service.current("new-parent")?.sourceKey).toBe("replacement");
	});

	it("emits body-free structured audit decisions", async () => {
		const { service, audit } = setup();
		const receipt = await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "secret title",
			summary: "secret body",
		});
		service.listRepositories();
		service.current(source.parentSessionId);
		service.status(source.parentSessionId);
		await service.setStatus(receipt.workItemId!, "in_progress");
		await service.createAndStart(source, {
			issueRepository: "acme/api",
			title: "secret title",
			summary: "secret body",
		});
		await service.prompt(source.parentSessionId, "secret follow-up");
		await service.stop(source.parentSessionId);
		await service.markTerminalDeliveryPending(
			receipt.workItemId!,
			"stopped",
			"secret delivery body",
		);
		await service.markDeliveryDelivered(receipt.workItemId!);
		await expect(
			service.createAndStart(
				{ ...source, kickoffTs: "999" },
				{
					issueRepository: "unknown/private-repository",
					title: "secret rejected title",
					summary: "secret rejected body",
				},
			),
		).rejects.toThrow();
		const decisions = audit.mock.calls.map(([decision]) => decision);
		expect(decisions).toEqual(
			expect.arrayContaining([
				"create_and_start",
				"repositories_list",
				"current",
				"status",
				"duplicate_return",
				"prompt",
				"stop",
				"delivery_pending",
				"delivery_delivered",
				"validation_rejected",
			]),
		);
		const serialized = JSON.stringify(audit.mock.calls);
		expect(serialized).not.toContain("secret title");
		expect(serialized).not.toContain("secret body");
		expect(serialized).not.toContain("secret follow-up");
		expect(serialized).not.toContain("secret delivery body");
		expect(serialized).not.toContain("unknown/private-repository");
		expect(serialized).not.toContain("example.slack.com");
		expect(serialized).not.toContain("/tmp/context");
	});
});
