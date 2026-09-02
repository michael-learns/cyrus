import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackMessageService } from "../src/SlackMessageService.js";

// Mock global fetch
const mockFetch = vi.fn();
global.fetch = mockFetch;

describe("SlackMessageService", () => {
	let service: SlackMessageService;

	beforeEach(() => {
		mockFetch.mockReset();
		service = new SlackMessageService();
	});

	afterEach(() => {
		vi.restoreAllMocks();
	});

	describe("postMessage", () => {
		it("posts a message to a Slack channel with thread_ts", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello from Cyrus!",
				thread_ts: "1704110400.000100",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-test-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						channel: "C9876543210",
						text: "Hello from Cyrus!",
						thread_ts: "1704110400.000100",
					}),
				},
			);
		});

		it("posts a message without thread_ts", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello from Cyrus!",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/chat.postMessage",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-test-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						channel: "C9876543210",
						text: "Hello from Cyrus!",
					}),
				},
			);
		});

		it("throws on non-OK HTTP response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => '{"ok":false,"error":"invalid_auth"}',
			});

			await expect(
				service.postMessage({
					token: "xoxb-bad-token",
					channel: "C9876543210",
					text: "Hello",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Failed to post message: 401 Unauthorized",
			);
		});

		it("throws on Slack API error (HTTP 200 with ok: false)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "channel_not_found" }),
			});

			await expect(
				service.postMessage({
					token: "xoxb-test-token",
					channel: "C9876543210",
					text: "Hello",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Slack API error: channel_not_found",
			);
		});

		it("respects custom base URL", async () => {
			const customService = new SlackMessageService(
				"https://slack.example.com/api",
			);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await customService.postMessage({
				token: "xoxb-test-token",
				channel: "C9876543210",
				text: "Hello",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.example.com/api/chat.postMessage",
				expect.any(Object),
			);
		});
	});

	describe("setAssistantThreadStatus", () => {
		it("sets a task status on a Slack thread", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.setAssistantThreadStatus({
				token: "xoxb-test-token",
				channel_id: "C9876543210",
				thread_ts: "1704110400.000100",
				status: "is inspecting code…",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				"https://slack.com/api/assistant.threads.setStatus",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-test-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						channel_id: "C9876543210",
						thread_ts: "1704110400.000100",
						status: "is inspecting code…",
					}),
				},
			);
		});

		it("clears a task status with an empty status", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true }),
			});

			await service.setAssistantThreadStatus({
				token: "xoxb-test-token",
				channel_id: "C9876543210",
				thread_ts: "1704110400.000100",
				status: "",
			});

			expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
				channel_id: "C9876543210",
				thread_ts: "1704110400.000100",
				status: "",
			});
		});

		it("throws on a non-OK HTTP response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 429,
				statusText: "Too Many Requests",
				text: async () => "ratelimited",
			});

			await expect(
				service.setAssistantThreadStatus({
					token: "xoxb-test-token",
					channel_id: "C9876543210",
					thread_ts: "1704110400.000100",
					status: "is thinking…",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Failed to set assistant thread status: 429 Too Many Requests",
			);
		});

		it("throws when Slack rejects the status", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "missing_scope" }),
			});

			await expect(
				service.setAssistantThreadStatus({
					token: "xoxb-test-token",
					channel_id: "C9876543210",
					thread_ts: "1704110400.000100",
					status: "is thinking…",
				}),
			).rejects.toThrow("[SlackMessageService] Slack API error: missing_scope");
		});
	});

	describe("uploadFilesToThread", () => {
		const uploadParams = {
			token: "xoxb-secret-token",
			channel_id: "C123",
			thread_ts: "1704110400.000100",
			files: [
				{
					bytes: new Uint8Array([0, 1, 2, 255]),
					filename: "report.txt",
					title: "Run report",
				},
				{
					bytes: new Uint8Array([3, 4]),
					filename: "notes.csv",
					title: "Run notes",
				},
			],
		};

		it("requests URLs, transfers the exact bytes, and completes one verified thread batch", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						file_id: "F1",
						upload_url: "https://files.slack.com/upload/F1?ticket=private-one",
					}),
				})
				.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" })
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						file_id: "F2",
						upload_url: "https://files.slack.com/upload/F2?ticket=private-two",
					}),
				})
				.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" })
				.mockResolvedValueOnce({ ok: true, json: async () => ({ ok: true }) });

			await expect(service.uploadFilesToThread(uploadParams)).resolves.toEqual([
				{ id: "F1", title: "Run report" },
				{ id: "F2", title: "Run notes" },
			]);

			expect(mockFetch.mock.calls).toHaveLength(5);
			expect(mockFetch.mock.calls[0]).toEqual([
				"https://slack.com/api/files.getUploadURLExternal",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-secret-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({ filename: "report.txt", length: 4 }),
				},
			]);
			expect(mockFetch.mock.calls[1]).toEqual([
				"https://files.slack.com/upload/F1?ticket=private-one",
				{
					method: "POST",
					headers: {},
					body: new Uint8Array([0, 1, 2, 255]),
					redirect: "manual",
					signal: expect.any(AbortSignal),
				},
			]);
			expect(mockFetch.mock.calls[4]).toEqual([
				"https://slack.com/api/files.completeUploadExternal",
				{
					method: "POST",
					headers: {
						Authorization: "Bearer xoxb-secret-token",
						"Content-Type": "application/json",
					},
					body: JSON.stringify({
						files: [
							{ id: "F1", title: "Run report" },
							{ id: "F2", title: "Run notes" },
						],
						channel_id: "C123",
						thread_ts: "1704110400.000100",
					}),
				},
			]);
		});

		it.each([
			[
				"URL endpoint HTTP failure",
				{
					ok: false,
					status: 500,
					statusText: "Server Error",
					text: async () => "private failure",
				},
			],
			[
				"URL endpoint body failure",
				{ ok: true, json: async () => ({ ok: false, error: "invalid_auth" }) },
			],
		])("rejects a %s without exposing credentials", async (_name, response) => {
			mockFetch.mockResolvedValueOnce(response);

			const error = await service
				.uploadFilesToThread({
					...uploadParams,
					files: [uploadParams.files[0]],
				})
				.catch((caught: unknown) => String(caught));
			expect(error).toMatch(
				/file upload URL request failed|Slack API error during file upload URL request/,
			);
			expect(error).not.toMatch(/xoxb-secret-token|private failure/);
		});

		it.each([
			"http://files.slack.com/upload/private-ticket",
			"https://evil.example/upload/private-ticket",
			"https://files.slack.com:444/upload/private-ticket",
			"not a URL with private-ticket",
		])("rejects unsafe upload URLs without calling them", async (upload_url) => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true, file_id: "F1", upload_url }),
			});

			await expect(
				service.uploadFilesToThread({
					...uploadParams,
					files: [uploadParams.files[0]],
				}),
			).rejects.toThrow("[SlackMessageService] Unsafe Slack file upload URL");
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it.each([
			["redirect", { ok: false, status: 302, statusText: "Found" }],
			[
				"transfer failure",
				{ ok: false, status: 500, statusText: "Server Error" },
			],
		])("rejects raw upload %s without completing the batch", async (_name, rawResponse) => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						file_id: "F1",
						upload_url:
							"https://files.slack.com/upload/F1?ticket=private-ticket",
					}),
				})
				.mockResolvedValueOnce(rawResponse);

			await expect(
				service.uploadFilesToThread({
					...uploadParams,
					files: [uploadParams.files[0]],
				}),
			).rejects.toThrow(
				"[SlackMessageService] Slack file upload transfer failed",
			);
			expect(mockFetch).toHaveBeenCalledTimes(2);
		});

		it("rejects raw upload timeouts without leaking the one-time URL", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						file_id: "F1",
						upload_url:
							"https://files.slack.com/upload/F1?ticket=private-timeout",
					}),
				})
				.mockRejectedValueOnce(new DOMException("aborted", "AbortError"));

			const error = await service
				.uploadFilesToThread({
					...uploadParams,
					files: [uploadParams.files[0]],
				})
				.catch((caught: unknown) => String(caught));
			expect(error).toContain(
				"[SlackMessageService] Slack file upload transfer timed out",
			);
			expect(error).not.toMatch(/private-timeout|xoxb-secret-token/);
		});

		it.each([
			["HTTP failure", { ok: false, status: 500, statusText: "Server Error" }],
			[
				"body failure",
				{
					ok: true,
					json: async () => ({ ok: false, error: "channel_not_found" }),
				},
			],
		])("rejects completion %s after successful transfers", async (_name, completionResponse) => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						file_id: "F1",
						upload_url:
							"https://files.slack.com/upload/F1?ticket=private-ticket",
					}),
				})
				.mockResolvedValueOnce({ ok: true, status: 200, statusText: "OK" })
				.mockResolvedValueOnce(completionResponse);

			const error = await service
				.uploadFilesToThread({
					...uploadParams,
					files: [uploadParams.files[0]],
				})
				.catch((caught: unknown) => String(caught));
			expect(error).toMatch(
				/file upload completion failed|Slack API error during file upload completion: channel_not_found/,
			);
		});
	});

	describe("fetchThreadMessages", () => {
		it("fetches every root-to-trigger page in chronological order with structured content and a permalink", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{
								user: "U2",
								text: "second",
								ts: "2.000",
								blocks: [{ type: "section", elements: [] }],
								files: [
									{ id: "F1", name: "diagram.png", mimetype: "image/png" },
								],
							},
							{ user: "U1", text: "root", ts: "1.000", attachments: [] },
						],
						has_more: true,
						response_metadata: { next_cursor: "next-page" },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U3", text: "kickoff", ts: "3.000" },
							{ user: "U4", text: "too late", ts: "4.000" },
						],
						has_more: false,
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						permalink: "https://workspace.slack.com/archives/C1/p1000",
					}),
				});

			const result = await service.fetchThreadThrough({
				token: "xoxb-secret",
				channel: "C1",
				thread_ts: "1.000",
				trigger_ts: "3.000",
			});

			expect(result).toEqual({
				messages: [
					{ user: "U1", text: "root", ts: "1.000", attachments: [] },
					{
						user: "U2",
						text: "second",
						ts: "2.000",
						blocks: [{ type: "section", elements: [] }],
						files: [{ id: "F1", name: "diagram.png", mimetype: "image/png" }],
					},
					{ user: "U3", text: "kickoff", ts: "3.000" },
				],
				permalink: "https://workspace.slack.com/archives/C1/p1000",
			});
			const secondPage = new URL(mockFetch.mock.calls[1][0]);
			expect(secondPage.searchParams.get("cursor")).toBe("next-page");
			const permalinkCall = new URL(mockFetch.mock.calls[2][0]);
			expect(permalinkCall.pathname).toBe("/api/chat.getPermalink");
			expect(permalinkCall.searchParams.get("message_ts")).toBe("1.000");
		});

		it("rejects an incomplete paginated thread response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [{ user: "U1", text: "root", ts: "1.000" }],
					has_more: true,
					response_metadata: { next_cursor: "" },
				}),
			});

			await expect(
				service.fetchThreadThrough({
					token: "xoxb-secret",
					channel: "C1",
					thread_ts: "1.000",
					trigger_ts: "2.000",
				}),
			).rejects.toThrow("incomplete pagination");
			expect(mockFetch).toHaveBeenCalledTimes(1);
		});

		it("fetches thread messages with correct GET params and Bearer auth", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{ user: "U111", text: "Hello", ts: "1704110400.000100" },
						{ user: "U222", text: "World", ts: "1704110400.000200" },
					],
					has_more: false,
				}),
			});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(result).toEqual([
				{ user: "U111", text: "Hello", ts: "1704110400.000100" },
				{ user: "U222", text: "World", ts: "1704110400.000200" },
			]);

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining("https://slack.com/api/conversations.replies?"),
				{
					method: "GET",
					headers: {
						Authorization: "Bearer xoxb-test-token",
					},
				},
			);

			// Verify query params
			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("channel")).toBe("C9876543210");
			expect(calledUrl.searchParams.get("ts")).toBe("1704110400.000100");
			expect(calledUrl.searchParams.get("limit")).toBe("100");
		});

		it("handles cursor-based pagination across multiple pages", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U111", text: "Page 1", ts: "1704110400.000100" },
						],
						has_more: true,
						response_metadata: { next_cursor: "cursor_abc" },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U222", text: "Page 2", ts: "1704110400.000200" },
						],
						has_more: false,
					}),
				});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(result).toEqual([
				{ user: "U111", text: "Page 1", ts: "1704110400.000100" },
				{ user: "U222", text: "Page 2", ts: "1704110400.000200" },
			]);

			expect(mockFetch).toHaveBeenCalledTimes(2);

			// Verify second call includes cursor
			const secondCallUrl = new URL(mockFetch.mock.calls[1][0]);
			expect(secondCallUrl.searchParams.get("cursor")).toBe("cursor_abc");
		});

		it("enforces the limit parameter", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [
						{ user: "U111", text: "Msg 1", ts: "1704110400.000100" },
						{ user: "U222", text: "Msg 2", ts: "1704110400.000200" },
						{ user: "U333", text: "Msg 3", ts: "1704110400.000300" },
					],
					has_more: false,
				}),
			});

			const result = await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				limit: 2,
			});

			expect(result).toHaveLength(2);
			expect(result[0].text).toBe("Msg 1");
			expect(result[1].text).toBe("Msg 2");

			// Verify limit was passed in query params
			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("limit")).toBe("2");
		});

		it("passes oldest through so Slack filters server-side", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [{ user: "U111", text: "Newer", ts: "1704110400.000900" }],
					has_more: false,
				}),
			});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				limit: 50,
				oldest: "1704110400.000500",
			});

			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.get("oldest")).toBe("1704110400.000500");
			expect(calledUrl.searchParams.get("limit")).toBe("50");
		});

		it("omits oldest when it is not supplied", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: true, messages: [], has_more: false }),
			});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			const calledUrl = new URL(mockFetch.mock.calls[0][0]);
			expect(calledUrl.searchParams.has("oldest")).toBe(false);
		});

		it("keeps oldest on paginated follow-up requests", async () => {
			mockFetch
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U111", text: "Page 1", ts: "1704110400.000600" },
						],
						has_more: true,
						response_metadata: { next_cursor: "cursor_abc" },
					}),
				})
				.mockResolvedValueOnce({
					ok: true,
					json: async () => ({
						ok: true,
						messages: [
							{ user: "U222", text: "Page 2", ts: "1704110400.000700" },
						],
						has_more: false,
					}),
				});

			await service.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
				oldest: "1704110400.000500",
			});

			const secondCallUrl = new URL(mockFetch.mock.calls[1][0]);
			expect(secondCallUrl.searchParams.get("oldest")).toBe(
				"1704110400.000500",
			);
			expect(secondCallUrl.searchParams.get("cursor")).toBe("cursor_abc");
		});

		it("throws on non-OK HTTP response", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: false,
				status: 401,
				statusText: "Unauthorized",
				text: async () => '{"ok":false,"error":"invalid_auth"}',
			});

			await expect(
				service.fetchThreadMessages({
					token: "xoxb-bad-token",
					channel: "C9876543210",
					thread_ts: "1704110400.000100",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Failed to fetch thread messages: 401 Unauthorized",
			);
		});

		it("throws on Slack API error (HTTP 200 with ok: false)", async () => {
			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({ ok: false, error: "thread_not_found" }),
			});

			await expect(
				service.fetchThreadMessages({
					token: "xoxb-test-token",
					channel: "C9876543210",
					thread_ts: "1704110400.000100",
				}),
			).rejects.toThrow(
				"[SlackMessageService] Slack API error: thread_not_found",
			);
		});

		it("respects custom base URL", async () => {
			const customService = new SlackMessageService(
				"https://slack.example.com/api",
			);

			mockFetch.mockResolvedValueOnce({
				ok: true,
				json: async () => ({
					ok: true,
					messages: [],
					has_more: false,
				}),
			});

			await customService.fetchThreadMessages({
				token: "xoxb-test-token",
				channel: "C9876543210",
				thread_ts: "1704110400.000100",
			});

			expect(mockFetch).toHaveBeenCalledWith(
				expect.stringContaining(
					"https://slack.example.com/api/conversations.replies?",
				),
				expect.any(Object),
			);
		});
	});
});
