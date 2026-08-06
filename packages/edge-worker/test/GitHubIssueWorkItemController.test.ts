import { createLogger } from "cyrus-core";
import Fastify from "fastify";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
	GitHubIssueWorkItemController,
	type GitHubIssueWorkItemHandlers,
} from "../src/GitHubIssueWorkItemController.js";

describe("GitHubIssueWorkItemController", () => {
	const apiKey = "test-api-key";
	let app: ReturnType<typeof Fastify>;
	let handlers: GitHubIssueWorkItemHandlers;

	beforeEach(() => {
		app = Fastify();
		handlers = {
			start: vi.fn().mockResolvedValue({
				sessionId: "github-issue-work-item-1",
				status: "starting",
			}),
			prompt: vi.fn().mockResolvedValue(undefined),
			stop: vi.fn().mockResolvedValue(undefined),
		};
		new GitHubIssueWorkItemController({
			fastifyServer: app,
			apiKey: () => apiKey,
			handlers,
			logger: createLogger({ component: "test" }),
		}).register();
	});

	afterEach(async () => {
		await app.close();
	});

	it("authenticates and starts a selected runner", async () => {
		const response = await app.inject({
			method: "POST",
			url: "/api/work-items/start",
			headers: {
				authorization: `Bearer ${apiKey}`,
				"x-github-installation-token": "ghs_installation",
			},
			payload: {
				workItemId: "work-item-1",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 42,
				runnerType: "codex",
				requestId: "request-1",
			},
		});

		expect(response.statusCode).toBe(202);
		expect(response.json()).toEqual({
			sessionId: "github-issue-work-item-1",
			status: "starting",
		});
		expect(handlers.start).toHaveBeenCalledWith(
			expect.objectContaining({ runnerType: "codex", issueNumber: 42 }),
			"ghs_installation",
		);
	});

	it("deduplicates repeated start request IDs", async () => {
		const request = {
			method: "POST" as const,
			url: "/api/work-items/start",
			headers: { authorization: `Bearer ${apiKey}` },
			payload: {
				workItemId: "work-item-1",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 42,
				runnerType: "claude",
				requestId: "same-request",
			},
		};

		const first = await app.inject(request);
		const second = await app.inject(request);

		expect(first.statusCode).toBe(202);
		expect(second.statusCode).toBe(202);
		expect(handlers.start).toHaveBeenCalledTimes(1);
	});

	it("rejects invalid auth and malformed runner selections", async () => {
		const unauthorized = await app.inject({
			method: "POST",
			url: "/api/work-items/start",
			payload: {},
		});
		expect(unauthorized.statusCode).toBe(401);

		const malformed = await app.inject({
			method: "POST",
			url: "/api/work-items/start",
			headers: { authorization: `Bearer ${apiKey}` },
			payload: {
				workItemId: "work-item-1",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 42,
				runnerType: "unknown",
				requestId: "request-1",
			},
		});
		expect(malformed.statusCode).toBe(400);
		expect(handlers.start).not.toHaveBeenCalled();
	});

	it("forwards human prompts and source-close stops", async () => {
		const prompt = await app.inject({
			method: "POST",
			url: "/api/work-items/work-item-1/prompt",
			headers: { authorization: `Bearer ${apiKey}` },
			payload: {
				requestId: "comment-request-1",
				commentId: 99,
				author: "octocat",
				body: "Please include a regression test",
			},
		});
		const stop = await app.inject({
			method: "POST",
			url: "/api/work-items/work-item-1/stop",
			headers: { authorization: `Bearer ${apiKey}` },
			payload: { requestId: "stop-1", reason: "source_closed" },
		});

		expect(prompt.statusCode).toBe(202);
		expect(stop.statusCode).toBe(202);
		expect(handlers.prompt).toHaveBeenCalledWith(
			"work-item-1",
			expect.objectContaining({ commentId: 99, author: "octocat" }),
			undefined,
		);
		expect(handlers.stop).toHaveBeenCalledWith(
			"work-item-1",
			expect.objectContaining({ reason: "source_closed" }),
		);
	});
});
