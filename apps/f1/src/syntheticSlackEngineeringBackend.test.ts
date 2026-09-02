import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { EdgeWorker } from "cyrus-edge-worker";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { afterEach, describe, expect, it, vi } from "vitest";
import { SyntheticSlackEngineeringBackend } from "./syntheticSlackEngineeringBackend.js";

interface DuplicateCandidate {
	number: number;
	title: string;
	state: "open" | "closed";
	url: string;
	match: "exact_title" | "strong_similarity";
	score: number;
}

interface EngineeringResult {
	status: string;
	reason?: "closed_exact" | "similar";
	issueNumber?: number;
	issueReused?: boolean;
	candidates?: DuplicateCandidate[];
}

async function seedIssue(
	backend: SyntheticSlackEngineeringBackend,
	input: {
		title: string;
		body: string;
		state?: "open" | "closed";
	},
): Promise<number> {
	const created = await backend.fetch(
		"https://api.github.com/repos/f1-test/primary-repo/issues",
		{
			method: "POST",
			body: JSON.stringify({ title: input.title, body: input.body }),
		},
	);
	const payload = (await created.json()) as { number: number };
	if (input.state === "closed") {
		const closed = await backend.fetch(
			`https://api.github.com/repos/f1-test/primary-repo/issues/${payload.number}`,
			{ method: "PATCH", body: JSON.stringify({ state: "closed" }) },
		);
		expect(closed.status).toBe(200);
	}
	return payload.number;
}

async function createEngineeringHarness(
	backend: SyntheticSlackEngineeringBackend,
): Promise<{
	call: (input: Record<string, unknown>) => Promise<EngineeringResult>;
	cleanup: () => Promise<void>;
}> {
	const directory = mkdtempSync(join(tmpdir(), "cyrus-f1-deduplication-"));
	const repositoryPath = join(directory, "repository");
	mkdirSync(repositoryPath, { recursive: true });
	vi.stubGlobal("fetch", backend.fetch);
	vi.stubEnv("GITHUB_TOKEN", "ghs-f1-synthetic");
	const worker = new EdgeWorker({
		cyrusHome: join(directory, "cyrus-home"),
		repositories: [
			{
				id: "f1-primary",
				name: "F1 Primary",
				repositoryPath,
				workspaceBaseDir: join(directory, "worktrees"),
				baseBranch: "main",
				githubUrl: "https://github.com/f1-test/primary-repo.git",
				isActive: true,
			},
		],
	});
	const internal = worker as never as {
		chatSessionHandler: {
			getLatestEventForSession: (sessionId: string) => unknown;
			getAllChatSessions: () => unknown[];
		};
		captureSlackEngineeringSource: (sessionId: string) => Promise<unknown>;
		buildSlackEngineeringContextTurn: () => Promise<unknown[]>;
		startGitHubIssueWorkItem: () => Promise<Record<string, unknown>>;
		attachSlackSubscriber: () => Promise<void>;
		createCyrusToolsOptions: (
			sessionId: string,
		) => Parameters<typeof createCyrusToolsServer>[1];
	};
	internal.chatSessionHandler = {
		getLatestEventForSession: () => ({
			eventId: "f1-deduplication-event",
			teamId: "T_F1",
			slackBotToken: "xoxb-f1-synthetic",
			payload: {
				type: "app_mention",
				user: "U_F1",
				channel: "C_F1",
				thread_ts: "1800000000.000100",
				ts: "1800000001.000200",
				event_ts: "1800000001.000200",
			},
		}),
		getAllChatSessions: () => [],
	};
	internal.captureSlackEngineeringSource = async () => ({
		source: {
			parentSessionId: "f1-parent",
			teamId: "T_F1",
			userId: "U_F1",
			channelId: "C_F1",
			threadTs: "1800000000.000100",
			kickoffTs: "1800000001.000200",
			permalink: "https://f1-test.slack.com/archives/C_F1/p1800000000000100",
		},
		manifest: { directory },
	});
	internal.buildSlackEngineeringContextTurn = async () => [];
	internal.startGitHubIssueWorkItem = async () => ({
		sessionId: "f1-child",
		status: "in_progress",
	});
	internal.attachSlackSubscriber = async () => undefined;

	const server = createCyrusToolsServer(
		undefined,
		internal.createCyrusToolsOptions("f1-parent"),
	);
	const client = new Client({ name: "cyrus-f1-deduplication", version: "1.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);

	return {
		call: async (input) => {
			const response = await client.callTool({
				name: "engineering_create_and_start",
				arguments: input,
			});
			const text = response.content.find((part) => part.type === "text")?.text;
			if (!text) throw new Error("missing engineering MCP result");
			const envelope = JSON.parse(text) as {
				success: boolean;
				result: EngineeringResult;
				error?: unknown;
			};
			if (!envelope.success)
				throw new Error(
					`engineering MCP failure: ${JSON.stringify(envelope.error)}`,
				);
			return envelope.result;
		},
		cleanup: async () => {
			await client.close();
			await server.close();
			rmSync(directory, { recursive: true, force: true });
		},
	};
}

describe("SyntheticSlackEngineeringBackend", () => {
	afterEach(() => {
		vi.unstubAllGlobals();
		vi.unstubAllEnvs();
	});

	it("serves fixture Slack and GitHub network boundaries without creating external resources", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		backend.setThread("C1", "100.1", [
			{ user: "U1", text: "root", ts: "100.1" },
		]);
		backend.setFile("F1", Buffer.from("png"), "image/png");

		const replies = await backend.fetch(
			"https://slack.com/api/conversations.replies?channel=C1&ts=100.1",
			{ headers: { Authorization: "Bearer xoxb-f1-synthetic" } },
		);
		expect(await replies.json()).toEqual({
			ok: true,
			messages: [{ user: "U1", text: "root", ts: "100.1" }],
			has_more: false,
			response_metadata: { next_cursor: "" },
		});

		const image = await backend.fetch("https://files.slack.com/f1/F1", {
			headers: { Authorization: "Bearer xoxb-f1-synthetic" },
		});
		expect(Buffer.from(await image.arrayBuffer()).toString("utf8")).toBe("png");
		expect(image.headers.get("content-type")).toBe("image/png");

		const issueResponse = await backend.fetch(
			"https://api.github.com/repos/acme/app/issues",
			{
				method: "POST",
				body: JSON.stringify({
					title: "Fix chart",
					body: "details\n<!-- cyrus-slack-source:key -->",
				}),
			},
		);
		expect(await issueResponse.json()).toMatchObject({
			number: 1,
			html_url: "https://github.com/acme/app/issues/1",
		});
		expect(backend.snapshot().issues).toHaveLength(1);
		expect(backend.snapshot().externalRequests).toEqual([]);
	});

	it("records Slack delivery failures and successful retry attempts", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		backend.failSlackDelivery = true;
		const failed = await backend.fetch(
			"https://slack.com/api/chat.postMessage",
			{
				method: "POST",
				body: JSON.stringify({ channel: "C1", text: "done", thread_ts: "1" }),
			},
		);
		expect(await failed.json()).toEqual({
			ok: false,
			error: "f1_delivery_failure",
		});

		backend.failSlackDelivery = false;
		const delivered = await backend.fetch(
			"https://slack.com/api/chat.postMessage",
			{
				method: "POST",
				body: JSON.stringify({ channel: "C1", text: "done", thread_ts: "1" }),
			},
		);
		expect(await delivered.json()).toEqual({ ok: true });
		expect(backend.snapshot().deliveries).toEqual([
			{ channel: "C1", text: "done", thread_ts: "1", ok: false },
			{ channel: "C1", text: "done", thread_ts: "1", ok: true },
		]);
	});

	it("emulates authenticated private downloads and one-use external upload tickets", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		backend.setFile("F_INPUT", Buffer.from("exact input"), "text/plain");

		const denied = await backend.fetch("https://files.slack.com/f1/F_INPUT");
		expect(denied.status).toBe(401);
		const downloaded = await backend.fetch(
			"https://files.slack.com/f1/F_INPUT",
			{ headers: { Authorization: "Bearer xoxb-f1-synthetic" } },
		);
		expect(Buffer.from(await downloaded.arrayBuffer())).toEqual(
			Buffer.from("exact input"),
		);

		for (const authorization of [undefined, "Bearer xoxb-wrong"]) {
			const response = await backend.fetch(
				"https://slack.com/api/files.getUploadURLExternal",
				{
					method: "POST",
					headers: {
						...(authorization && { Authorization: authorization }),
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ filename: "forbidden.csv", length: 7 }),
				},
			);
			expect(response.status).toBe(401);
			expect(await response.json()).toEqual({
				ok: false,
				error: "not_authed",
			});
		}

		const ticketResponse = await backend.fetch(
			"https://slack.com/api/files.getUploadURLExternal",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer xoxb-f1-synthetic",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({ filename: "result.csv", length: 7 }),
			},
		);
		const ticket = (await ticketResponse.json()) as {
			file_id: string;
			upload_url: string;
		};
		const bytes = Buffer.from("a,b\n1,2");
		const credentialLeak = await backend.fetch(ticket.upload_url, {
			method: "POST",
			headers: { Authorization: "Bearer xoxb-f1-synthetic" },
			body: bytes,
			redirect: "manual",
		});
		expect(credentialLeak.status).toBe(400);
		expect(backend.activeUploadTicketCount).toBe(1);
		const redirectingClient = await backend.fetch(ticket.upload_url, {
			method: "POST",
			headers: {},
			body: bytes,
		});
		expect(redirectingClient.status).toBe(400);
		expect(backend.activeUploadTicketCount).toBe(1);
		const uploaded = await backend.fetch(ticket.upload_url, {
			method: "POST",
			headers: {},
			body: bytes,
			redirect: "manual",
		});
		expect(uploaded.status).toBe(200);
		expect(
			await backend.fetch(ticket.upload_url, {
				method: "POST",
				headers: {},
				body: bytes,
				redirect: "manual",
			}),
		).toMatchObject({ status: 410 });

		const completion = await backend.fetch(
			"https://slack.com/api/files.completeUploadExternal",
			{
				method: "POST",
				headers: {
					Authorization: "Bearer xoxb-f1-synthetic",
					"Content-Type": "application/json",
				},
				body: JSON.stringify({
					files: [{ id: ticket.file_id, title: "Result" }],
					channel_id: "C_ORIGINAL",
					thread_ts: "100.1",
				}),
			},
		);
		expect(await completion.json()).toEqual({ ok: true });
		expect(backend.getUploadedFile(ticket.file_id)).toEqual({
			filename: "result.csv",
			bytes,
		});
		expect(backend.snapshot().fileDeliveries).toEqual([
			{
				channelId: "C_ORIGINAL",
				threadTs: "100.1",
				files: [
					{
						id: ticket.file_id,
						filename: "result.csv",
						title: "Result",
						byteLength: 7,
					},
				],
			},
		]);
		expect(backend.activeUploadTicketCount).toBe(0);
		expect(JSON.stringify(backend.snapshot())).not.toContain("upload_url");
		expect(JSON.stringify(backend.snapshot())).not.toContain("xoxb-");
	});

	it.each([
		{
			name: "marker only",
			query: "is:issue in:body cyrus-slack-source:abc123",
			expectedNumbers: [],
		},
		{
			name: "repository only",
			query: "repo:acme/app is:issue in:body",
			expectedNumbers: [],
		},
		{
			name: "wrong repository and exact marker",
			query: "repo:other/app is:issue in:body cyrus-slack-source:abc123",
			expectedNumbers: [],
		},
		{
			name: "exact repository and marker pair",
			query: "repo:acme/app is:issue in:body cyrus-slack-source:abc123",
			expectedNumbers: [1],
		},
	])("requires $name for source recovery", async ({
		query,
		expectedNumbers,
	}) => {
		const backend = new SyntheticSlackEngineeringBackend();
		await backend.fetch("https://api.github.com/repos/acme/app/issues", {
			method: "POST",
			body: JSON.stringify({
				title: "Fix chart",
				body: "details\n<!-- cyrus-slack-source:abc123 -->",
			}),
		});

		const response = await backend.fetch(
			`https://api.github.com/search/issues?q=${encodeURIComponent(query)}`,
		);

		const payload = (await response.json()) as {
			items: Array<{ number: number }>;
		};
		expect(payload.items.map((item) => item.number)).toEqual(expectedNumbers);
	});

	it("constrains production marker recovery to the queried repository", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		for (const repository of ["acme/app", "other/app"]) {
			await backend.fetch(`https://api.github.com/repos/${repository}/issues`, {
				method: "POST",
				body: JSON.stringify({
					title: repository,
					body: "details\n<!-- cyrus-slack-source:shared123 -->",
				}),
			});
		}

		const response = await backend.fetch(
			"https://api.github.com/search/issues?q=repo%3Aother%2Fapp%20is%3Aissue%20in%3Abody%20cyrus-slack-source%3Ashared123",
		);

		expect(await response.json()).toMatchObject({
			items: [{ number: 2, body: expect.stringContaining("shared123") }],
		});
	});

	it("lists issues only from the requested repository for exact marker recovery", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		for (const repository of ["acme/app", "other/app"]) {
			await backend.fetch(`https://api.github.com/repos/${repository}/issues`, {
				method: "POST",
				body: JSON.stringify({
					title: repository,
					body: "details\n<!-- cyrus-slack-source:shared123 -->",
				}),
			});
		}

		const response = await backend.fetch(
			"https://api.github.com/repos/other/app/issues?state=all&per_page=100&page=1",
		);

		expect(await response.json()).toEqual([
			expect.objectContaining({
				number: 2,
				body: expect.stringContaining("shared123"),
			}),
		]);
		expect(backend.snapshot().externalRequests).toEqual([]);
	});

	it("paginates all issue states with production-shaped GitHub list responses", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		for (let index = 1; index <= 101; index++) {
			await seedIssue(backend, {
				title: `Issue ${index}`,
				body: `Body ${index}`,
				state: index === 101 ? "closed" : "open",
			});
		}

		const first = await backend.fetch(
			"https://api.github.com/repos/f1-test/primary-repo/issues?state=all&per_page=100",
		);
		const secondUrl = first.headers
			.get("link")
			?.match(/<([^>]+)>; rel="next"/)?.[1];
		expect(secondUrl).toBe(
			"https://api.github.com/repos/f1-test/primary-repo/issues?state=all&per_page=100&page=2",
		);
		expect((await first.json()) as unknown[]).toHaveLength(100);
		const second = await backend.fetch(secondUrl!);
		expect(await second.json()).toEqual([
			expect.objectContaining({
				number: 101,
				title: "Issue 101",
				body: "Body 101",
				state: "closed",
				html_url: "https://github.com/f1-test/primary-repo/issues/101",
			}),
		]);
	});

	it("reuses an exact open issue through EdgeWorker MCP without increasing issue count", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		const number = await seedIssue(backend, {
			title: "Fix payroll export",
			body: "Existing report",
		});
		const harness = await createEngineeringHarness(backend);
		try {
			const before = backend.snapshot().issues.length;
			const result = await harness.call({
				issueRepository: "f1-test/primary-repo",
				title: "fix PAYROLL export!",
				summary: "Payroll exports fail for overtime records.",
				targetRepositories: ["f1-test/primary-repo"],
			});

			expect(result).toMatchObject({
				status: "in_progress",
				issueNumber: number,
				issueReused: true,
			});
			expect(backend.snapshot().issues).toHaveLength(before);
			expect(backend.snapshot().externalRequests).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("confirms then reopens an exact closed issue through EdgeWorker MCP without creating", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		const number = await seedIssue(backend, {
			title: "Fix checkout timeout",
			body: "Existing closed report",
			state: "closed",
		});
		const harness = await createEngineeringHarness(backend);
		try {
			const input = {
				issueRepository: "f1-test/primary-repo",
				title: "Fix checkout timeout",
				summary: "Checkout times out during payment.",
				targetRepositories: ["f1-test/primary-repo"],
			};
			const before = backend.snapshot().issues.length;
			const confirmation = await harness.call(input);

			expect(confirmation).toEqual({
				status: "confirmation_required",
				reason: "closed_exact",
				issueRepository: "f1-test/primary-repo",
				candidates: [
					{
						number,
						title: "Fix checkout timeout",
						state: "closed",
						url: `https://github.com/f1-test/primary-repo/issues/${number}`,
						match: "exact_title",
						score: 1,
					},
				],
			});
			const reused = await harness.call({
				...input,
				duplicateResolution: {
					action: "reuse_existing",
					issueNumber: number,
				},
			});

			expect(reused).toMatchObject({
				status: "in_progress",
				issueNumber: number,
				issueReused: true,
			});
			expect(backend.snapshot().issues).toHaveLength(before);
			expect(backend.snapshot().issues).toEqual([
				expect.objectContaining({ number, state: "open" }),
			]);
		} finally {
			await harness.cleanup();
		}
	});

	it("confirms a similar issue then creates exactly one through EdgeWorker MCP", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		const number = await seedIssue(backend, {
			title: "Fix payroll export failure",
			body: "Payroll export fails for overtime records.",
		});
		const harness = await createEngineeringHarness(backend);
		try {
			const input = {
				issueRepository: "f1-test/primary-repo",
				title: "Fix payroll export failures",
				summary: "Payroll export fails for overtime records.",
				targetRepositories: ["f1-test/primary-repo"],
			};
			const before = backend.snapshot().issues.length;
			const confirmation = await harness.call(input);
			expect(confirmation).toEqual({
				status: "confirmation_required",
				reason: "similar",
				issueRepository: "f1-test/primary-repo",
				candidates: [
					{
						number,
						title: "Fix payroll export failure",
						state: "open",
						url: `https://github.com/f1-test/primary-repo/issues/${number}`,
						match: "strong_similarity",
						score: 0.8,
					},
				],
			});

			const created = await harness.call({
				...input,
				duplicateResolution: {
					action: "create_new",
					issueNumber: number,
				},
			});
			expect(created).toMatchObject({
				status: "in_progress",
				issueNumber: number + 1,
			});
			expect(created.issueReused).not.toBe(true);
			expect(backend.snapshot().issues).toHaveLength(before + 1);
		} finally {
			await harness.cleanup();
		}
	});

	it("creates exactly one issue for no match through EdgeWorker MCP", async () => {
		const backend = new SyntheticSlackEngineeringBackend();
		await seedIssue(backend, {
			title: "Document deployment",
			body: "Unrelated report",
		});
		const harness = await createEngineeringHarness(backend);
		try {
			const before = backend.snapshot().issues.length;
			const created = await harness.call({
				issueRepository: "f1-test/primary-repo",
				title: "Fix checkout timeout",
				summary: "Checkout times out during payment.",
				targetRepositories: ["f1-test/primary-repo"],
			});
			expect(created).toMatchObject({
				status: "in_progress",
				issueNumber: 2,
			});
			expect(backend.snapshot().issues).toHaveLength(before + 1);
			expect(backend.snapshot().externalRequests).toEqual([]);
		} finally {
			await harness.cleanup();
		}
	});

	it("restores synthetic issues across an F1 server restart", async () => {
		const directory = mkdtempSync(join(tmpdir(), "cyrus-f1-backend-"));
		const statePath = join(directory, "backend.json");
		try {
			const first = new SyntheticSlackEngineeringBackend(statePath);
			await first.fetch("https://api.github.com/repos/acme/app/issues", {
				method: "POST",
				body: JSON.stringify({ title: "First", body: "first" }),
			});

			const restored = new SyntheticSlackEngineeringBackend(statePath);
			const second = await restored.fetch(
				"https://api.github.com/repos/acme/app/issues",
				{
					method: "POST",
					body: JSON.stringify({ title: "Second", body: "second" }),
				},
			);

			expect(await second.json()).toMatchObject({ number: 2 });
			expect(restored.snapshot().issues.map((issue) => issue.title)).toEqual([
				"First",
				"Second",
			]);
		} finally {
			rmSync(directory, { recursive: true, force: true });
		}
	});
});
