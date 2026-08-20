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
	const service = new SlackEngineeringOrchestrator(
		{
			repositories: () => repositories,
			persist: async (receipts) =>
				saves.push(receipts.map((item) => ({ ...item }))),
			createIssue,
			findIssueByMarker,
			startWorkItem,
			promptWorkItem: vi.fn(),
			stopWorkItem: vi.fn(),
		},
		initial,
	);
	return { service, saves, createIssue, findIssueByMarker, startWorkItem };
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
});
