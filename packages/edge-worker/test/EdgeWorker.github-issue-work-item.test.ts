import { beforeEach, describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("EdgeWorker GitHub Issue work items", () => {
	let worker: any;
	let runner: any;
	let repository: any;
	let githubIssue: any;

	beforeEach(() => {
		runner = {
			isRunning: vi.fn().mockReturnValue(false),
			stop: vi.fn(),
		};
		repository = {
			id: "repo-1",
			name: "cyrus",
			repositoryPath: "/repos/cyrus",
			workspaceBaseDir: "/worktrees",
			baseBranch: "main",
			githubUrl: "https://github.com/cyrusagents/cyrus",
			isActive: true,
		};
		githubIssue = {
			id: 42,
			number: 17,
			title: "Fix webhook retries",
			body: "Retry failed webhook deliveries.",
			state: "open",
			html_url: "https://github.com/cyrusagents/cyrus/issues/17",
			url: "https://api.github.com/repos/cyrusagents/cyrus/issues/17",
			user: {
				login: "octocat",
				id: 1,
				avatar_url: "",
				html_url: "",
				type: "User",
			},
			labels: [{ id: 1, name: "bug", color: "d73a4a" }],
		};

		worker = Object.create(EdgeWorker.prototype);
		worker.gitHubIssueWorkItemSessions = new Map();
		worker.processedGitHubIssueCommentIds = new Set();
		worker.sessionRepositories = new Map();
		worker.resolveGitHubTokenValue = vi.fn().mockResolvedValue("ghs_token");
		worker.findRepositoryByGitHubUrl = vi.fn().mockReturnValue(repository);
		worker.fetchGitHubIssue = vi.fn().mockResolvedValue(githubIssue);
		worker.buildSyntheticGitHubIssue = vi
			.fn()
			.mockReturnValue({ id: "42", identifier: "GH-cyrus-17" });
		worker.gitService = {
			sanitizeBranchName: vi.fn((value: string) => value),
			createGitWorktree: vi.fn().mockResolvedValue({
				path: "/worktrees/GH-cyrus-17",
				isGitWorktree: true,
			}),
			deleteWorktree: vi.fn().mockResolvedValue(undefined),
		};
		worker.agentSessionManager = {
			getAllSessions: vi.fn().mockReturnValue([]),
			createCyrusAgentSession: vi.fn(),
			addAgentRunner: vi.fn(),
			setActivitySink: vi.fn(),
			getAgentRunner: vi.fn().mockReturnValue(runner),
			getSession: vi.fn().mockReturnValue({ agentRunner: runner }),
			requestSessionStop: vi.fn(),
			removeSession: vi.fn(),
		};
		worker.getActivitySinkForRepo = vi.fn().mockReturnValue(undefined);
		worker.createGitHubIssueRunner = vi.fn().mockResolvedValue(runner);
		worker.buildGitHubIssueTaskPrompt = vi.fn().mockReturnValue("issue prompt");
		worker.runGitHubIssueWorkItem = vi.fn().mockResolvedValue(undefined);
		worker.reportGitHubWorkItemStatus = vi.fn().mockResolvedValue(undefined);
		worker.savePersistedState = vi.fn().mockResolvedValue(undefined);
		worker.emit = vi.fn();
		worker.config = { handlers: {} };
	});

	it("creates an isolated session without auto-running from the webhook", async () => {
		const result = await worker.startGitHubIssueWorkItem(
			{
				workItemId: "work-item-17",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 17,
				runnerType: "codex",
				requestId: "request-17",
			},
			"forwarded-token",
		);

		expect(result).toEqual({
			sessionId: "github-issue-work-item-17",
			status: "starting",
		});
		expect(worker.gitService.createGitWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ identifier: "GH-cyrus-17" }),
			[repository],
		);
		expect(worker.createGitHubIssueRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				runnerType: "codex",
				branchName: "cyrus/gh-17-fix-webhook-retries",
			}),
			githubIssue,
		);
		expect(worker.runGitHubIssueWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ workItemId: "work-item-17" }),
			runner,
			"issue prompt",
			"ghs_token",
		);
	});

	it("rejects closed GitHub Issues before creating a worktree", async () => {
		githubIssue.state = "closed";

		await expect(
			worker.startGitHubIssueWorkItem({
				workItemId: "work-item-17",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 17,
				runnerType: "claude",
				requestId: "request-17",
			}),
		).rejects.toMatchObject({
			message: "GitHub Issue is not open",
			statusCode: 409,
		});
		expect(worker.gitService.createGitWorktree).not.toHaveBeenCalled();
	});

	it("stops the runner and removes its worktree when the source closes", async () => {
		worker.gitHubIssueWorkItemSessions.set("work-item-17", {
			workItemId: "work-item-17",
			sessionId: "github-issue-work-item-17",
			repository,
			repositoryFullName: "cyrusagents/cyrus",
			issueNumber: 17,
			issueIdentifier: "GH-cyrus-17",
			branchName: "cyrus/gh-17-fix-webhook-retries",
			runnerType: "codex",
			issue: { id: "42" },
			status: "in_progress",
		});

		await worker.stopGitHubIssueWorkItem("work-item-17", {
			requestId: "stop-17",
			reason: "source_closed",
		});

		expect(worker.agentSessionManager.requestSessionStop).toHaveBeenCalledWith(
			"github-issue-work-item-17",
		);
		expect(runner.stop).toHaveBeenCalled();
		expect(worker.gitService.deleteWorktree).toHaveBeenCalledWith(
			"GH-cyrus-17",
			{ repositories: [repository] },
		);
		expect(worker.gitHubIssueWorkItemSessions.has("work-item-17")).toBe(false);
		expect(worker.reportGitHubWorkItemStatus).toHaveBeenCalledWith(
			"work-item-17",
			expect.objectContaining({ status: "stopped" }),
		);
	});

	it("streams each human GitHub comment only once", async () => {
		runner.isRunning.mockReturnValue(true);
		runner.supportsStreamingInput = true;
		runner.addStreamMessage = vi.fn();
		worker.gitHubIssueWorkItemSessions.set("work-item-17", {
			workItemId: "work-item-17",
			sessionId: "github-issue-work-item-17",
			repository,
			repositoryFullName: "cyrusagents/cyrus",
			issueNumber: 17,
			issueIdentifier: "GH-cyrus-17",
			branchName: "cyrus/gh-17-fix-webhook-retries",
			runnerType: "codex",
			issue: { id: "42" },
			status: "in_progress",
		});
		const comment = {
			requestId: "comment-request-1",
			commentId: 99,
			author: "octocat",
			body: "Please add a regression test",
		};

		await worker.promptGitHubIssueWorkItem("work-item-17", comment);
		await worker.promptGitHubIssueWorkItem("work-item-17", comment);

		expect(runner.addStreamMessage).toHaveBeenCalledTimes(1);
		expect(runner.addStreamMessage).toHaveBeenCalledWith(
			expect.stringContaining("Please add a regression test"),
		);
	});

	it("retries a failed work item in its existing session", async () => {
		const failed = {
			workItemId: "work-item-17",
			sessionId: "github-issue-work-item-17",
			repository,
			repositoryFullName: "cyrusagents/cyrus",
			issueNumber: 17,
			issueIdentifier: "GH-cyrus-17",
			branchName: "cyrus/gh-17-fix-webhook-retries",
			runnerType: "codex",
			issue: { id: "42" },
			status: "failed",
		};
		worker.gitHubIssueWorkItemSessions.set("work-item-17", failed);
		worker.runnerResumeSessionId = vi.fn().mockReturnValue("codex-session-1");

		const result = await worker.startGitHubIssueWorkItem({
			workItemId: "work-item-17",
			repositoryFullName: "cyrusagents/cyrus",
			issueNumber: 17,
			runnerType: "codex",
			requestId: "retry-request-17",
		});

		expect(result).toEqual({
			sessionId: "github-issue-work-item-17",
			status: "starting",
		});
		expect(worker.createGitHubIssueRunner).toHaveBeenCalledWith(
			failed,
			githubIssue,
			"codex-session-1",
		);
		expect(worker.gitService.createGitWorktree).not.toHaveBeenCalled();
		expect(worker.runGitHubIssueWorkItem).toHaveBeenCalled();
	});

	it("recovers an awaiting-review work item from persisted session metadata", () => {
		worker.agentSessionManager.getAllSessions.mockReturnValue([
			{
				id: "github-issue-work-item-17",
				issue: {
					id: "42",
					identifier: "GH-cyrus-17",
					title: "Fix webhook retries",
					branchName: "cyrus/gh-17-fix-webhook-retries",
				},
				metadata: {
					githubWorkItem: {
						workItemId: "work-item-17",
						repositoryFullName: "cyrusagents/cyrus",
						issueNumber: 17,
						issueIdentifier: "GH-cyrus-17",
						branchName: "cyrus/gh-17-fix-webhook-retries",
						runnerType: "codex",
						status: "awaiting_review",
					},
				},
			},
		]);

		const recovered = worker.getGitHubIssueWorkItemSession("work-item-17");

		expect(recovered).toEqual(
			expect.objectContaining({
				workItemId: "work-item-17",
				sessionId: "github-issue-work-item-17",
				status: "awaiting_review",
				repository,
			}),
		);
	});
});
