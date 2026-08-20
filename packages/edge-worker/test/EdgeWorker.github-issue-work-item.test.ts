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
			getMessages: vi.fn().mockReturnValue([]),
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
			"ghs_token",
		);
		expect(worker.runGitHubIssueWorkItem).toHaveBeenCalledWith(
			expect.objectContaining({ workItemId: "work-item-17" }),
			runner,
			"issue prompt",
			"ghs_token",
		);
	});

	it("creates one coordinated workspace for multiple configured repositories", async () => {
		const hostRepository = {
			...repository,
			id: "repo-2",
			name: "cyrus-host",
			repositoryPath: "/repos/cyrus-host",
			githubUrl: "https://github.com/cyrusagents/cyrus-host",
		};
		worker.findRepositoryByGitHubUrl.mockImplementation((name: string) =>
			name === "cyrusagents/cyrus-host" ? hostRepository : repository,
		);

		await worker.startGitHubIssueWorkItem({
			workItemId: "work-item-multi",
			repositoryFullName: "cyrusagents/cyrus",
			issueNumber: 17,
			targetRepositoryFullNames: [
				"cyrusagents/cyrus",
				"cyrusagents/cyrus-host",
			],
			runnerType: "claude",
			requestId: "request-multi",
		});

		expect(worker.gitService.createGitWorktree).toHaveBeenCalledWith(
			expect.objectContaining({ identifier: "GH-cyrus-17" }),
			[repository, hostRepository],
		);
		expect(
			worker.agentSessionManager.createCyrusAgentSession.mock.calls[0]?.[5],
		).toEqual([
			expect.objectContaining({ repositoryId: "repo-1" }),
			expect.objectContaining({ repositoryId: "repo-2" }),
		]);
		expect(worker.createGitHubIssueRunner).toHaveBeenCalledWith(
			expect.objectContaining({
				repositories: [repository, hostRepository],
				targetRepositoryFullNames: [
					"cyrusagents/cyrus",
					"cyrusagents/cyrus-host",
				],
			}),
			githubIssue,
			"ghs_token",
		);
	});

	it("locks Slack-created work items to Claude and repository model without trusting issue selectors", async () => {
		const lockedWorker: any = Object.create(EdgeWorker.prototype);
		lockedWorker.agentSessionManager = {
			getSession: vi
				.fn()
				.mockReturnValue({ workspace: { path: "/work", repoPaths: {} } }),
		};
		lockedWorker.toolPermissionResolver = {
			buildGithubAllowedTools: vi.fn().mockReturnValue([]),
		};
		lockedWorker.buildDisallowedTools = vi.fn().mockReturnValue([]);
		lockedWorker.gitService = {
			getGitMetadataDirectoriesForWorkspace: vi.fn().mockReturnValue([]),
		};
		lockedWorker.buildGitHubIssueSystemPrompt = vi
			.fn()
			.mockReturnValue("system");
		lockedWorker.buildSkillSessionContext = vi.fn().mockReturnValue({});
		lockedWorker.buildAgentRunnerConfig = vi
			.fn()
			.mockResolvedValue({ config: {}, runnerType: "claude" });
		lockedWorker.createRunnerForType = vi.fn().mockReturnValue(runner);
		lockedWorker.updateSlackWorkItemActivity = vi.fn();
		lockedWorker.config = { claudeDefaultModel: "default-claude" };
		const modelRepository = { ...repository, model: "repo-claude" };

		await lockedWorker.createGitHubIssueRunner(
			{
				workItemId: "slack-source-key",
				sessionId: "github-issue-slack-source-key",
				repository: modelRepository,
				repositories: [modelRepository],
				repositoryFullName: "cyrusagents/cyrus",
				targetRepositoryFullNames: ["cyrusagents/cyrus"],
				issueNumber: 17,
				issueIdentifier: "GH-cyrus-17",
				branchName: "cyrus/fix",
				branchNames: { "repo-1": "cyrus/fix" },
				prUrls: [],
				slackSubscribers: [],
				runnerType: "claude",
				issue: { id: "42", identifier: "GH-cyrus-17", title: "Fix" },
				status: "starting",
			},
			{
				...githubIssue,
				body: "[agent=codex] [model=attacker-model]",
				labels: [{ name: "codex" }],
			},
			"token",
		);

		const args = lockedWorker.buildAgentRunnerConfig.mock.calls[0];
		expect(args[8]).toEqual([]);
		expect(args[9]).toBe("[agent=claude]");
		expect(lockedWorker.createRunnerForType).toHaveBeenCalledWith(
			"claude",
			expect.objectContaining({ model: "repo-claude" }),
		);
	});

	it("rejects a second target set while a session for the same issue is live", async () => {
		await worker.startGitHubIssueWorkItem(
			{
				workItemId: "work-item-17",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 17,
				runnerType: "codex",
				requestId: "request-17",
			},
			"forwarded-token",
		);
		worker.gitService.createGitWorktree.mockClear();

		// A different target set hashes to a different work item id, but the
		// worktree path and branch name are still derived from the source repo
		// and issue number alone — so the two sessions would collide.
		await expect(
			worker.startGitHubIssueWorkItem(
				{
					workItemId: "work-item-17-multi",
					repositoryFullName: "cyrusagents/cyrus",
					issueNumber: 17,
					targetRepositoryFullNames: ["cyrusagents/cyrus", "cyrusagents/other"],
					runnerType: "codex",
					requestId: "request-17-multi",
				},
				"forwarded-token",
			),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(worker.gitService.createGitWorktree).not.toHaveBeenCalled();
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

	it("rejects an overlapping work item with a different repository set", async () => {
		worker.gitHubIssueWorkItemSessions.set("existing-work-item", {
			workItemId: "existing-work-item",
			sessionId: "github-issue-existing",
			repository,
			repositories: [repository],
			repositoryFullName: "cyrusagents/cyrus",
			targetRepositoryFullNames: ["cyrusagents/cyrus"],
			issueNumber: 17,
			issueIdentifier: "GH-cyrus-17",
			branchName: "cyrus/gh-17-fix-webhook-retries",
			branchNames: { "repo-1": "cyrus/gh-17-fix-webhook-retries" },
			prUrls: [],
			slackSubscribers: [],
			runnerType: "claude",
			issue: { id: "42" },
			status: "in_progress",
		});

		await expect(
			worker.startGitHubIssueWorkItem({
				workItemId: "new-work-item",
				repositoryFullName: "cyrusagents/cyrus",
				issueNumber: 17,
				targetRepositoryFullNames: [
					"cyrusagents/cyrus",
					"cyrusagents/cyrus-host",
				],
				runnerType: "claude",
				requestId: "expand-request",
			}),
		).rejects.toMatchObject({ statusCode: 409 });
		expect(worker.gitService.createGitWorktree).not.toHaveBeenCalled();
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
			"ghs_token",
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

	it("posts pull requests to Slack and releases delegated status ownership", async () => {
		const event = { payload: { channel: "C1", ts: "1", user: "U1" } };
		const postDelegatedWorkMessage = vi.fn().mockResolvedValue(undefined);
		const clearActivityStatus = vi.fn().mockResolvedValue(undefined);
		const setDelegatedWorkActive = vi.fn();
		worker.slackChatAdapter = {
			postDelegatedWorkMessage,
			clearActivityStatus,
		};
		const hasDelegatedWork = vi.fn().mockReturnValue(false);
		worker.chatSessionHandler = { setDelegatedWorkActive, hasDelegatedWork };
		worker.slackWorkItemEvents = new Map([
			["work-item-17", new Map([["slack-session-1", event]])],
		]);
		const workItem = {
			workItemId: "work-item-17",
			issue: { title: "Fix webhook retries" },
			prUrls: [
				"https://github.com/cyrusagents/cyrus/pull/1",
				"https://github.com/cyrusagents/cyrus-host/pull/2",
			],
		};

		await worker.finishSlackWorkItem(workItem, "awaiting_review");

		expect(postDelegatedWorkMessage).toHaveBeenCalledWith(
			event,
			expect.stringContaining("cyrus-host/pull/2"),
		);
		expect(clearActivityStatus).toHaveBeenCalledWith(event);
		expect(setDelegatedWorkActive).toHaveBeenCalledWith(
			"slack-session-1",
			false,
			"work-item-17",
		);
		expect(worker.slackWorkItemEvents.has("work-item-17")).toBe(false);
	});

	it("keeps the thread status while a sibling delegated job is still running", async () => {
		const event = { payload: { channel: "C1", ts: "1", user: "U1" } };
		const postDelegatedWorkMessage = vi.fn().mockResolvedValue(undefined);
		const clearActivityStatus = vi.fn().mockResolvedValue(undefined);
		const setDelegatedWorkActive = vi.fn();
		// A second job delegated by the same chat session is still in flight.
		const hasDelegatedWork = vi.fn().mockReturnValue(true);
		worker.slackChatAdapter = {
			postDelegatedWorkMessage,
			clearActivityStatus,
		};
		worker.chatSessionHandler = { setDelegatedWorkActive, hasDelegatedWork };
		worker.slackWorkItemEvents = new Map([
			["work-item-17", new Map([["slack-session-1", event]])],
		]);

		await worker.finishSlackWorkItem(
			{
				workItemId: "work-item-17",
				issue: { title: "Fix webhook retries" },
				prUrls: ["https://github.com/cyrusagents/cyrus/pull/1"],
			},
			"awaiting_review",
		);

		expect(postDelegatedWorkMessage).toHaveBeenCalled();
		expect(clearActivityStatus).not.toHaveBeenCalled();
	});

	it("converts a delegated summary from Markdown to Slack mrkdwn", async () => {
		const event = { payload: { channel: "C1", ts: "1", user: "U1" } };
		const postDelegatedWorkMessage = vi.fn().mockResolvedValue(undefined);
		worker.slackChatAdapter = {
			postDelegatedWorkMessage,
			clearActivityStatus: vi.fn().mockResolvedValue(undefined),
		};
		worker.chatSessionHandler = {
			setDelegatedWorkActive: vi.fn(),
			hasDelegatedWork: vi.fn().mockReturnValue(false),
		};
		worker.slackWorkItemEvents = new Map([
			["work-item-17", new Map([["slack-session-1", event]])],
		]);
		worker.agentSessionManager.getSession = vi.fn().mockReturnValue({
			agentRunner: {
				getMessages: () => [
					{
						type: "result",
						result:
							"### Summary\nFixed **retries**. See [the PR](https://github.com/o/r/pull/1).",
					},
				],
			},
		});

		await worker.finishSlackWorkItem(
			{
				workItemId: "work-item-17",
				issue: { title: "Fix webhook retries" },
				prUrls: ["https://github.com/cyrusagents/cyrus/pull/1"],
			},
			"awaiting_review",
		);

		const text = postDelegatedWorkMessage.mock.calls[0]?.[1] as string;
		expect(text).toContain("*Summary*");
		expect(text).toContain("Fixed *retries*");
		expect(text).toContain("<https://github.com/o/r/pull/1|the PR>");
		expect(text).not.toContain("###");
		expect(text).not.toContain("**");
	});
});
