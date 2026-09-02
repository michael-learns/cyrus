import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { SyntheticSlackEngineeringBackend } from "./syntheticSlackEngineeringBackend.js";

describe("SyntheticSlackEngineeringBackend", () => {
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
