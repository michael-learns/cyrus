import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

function verifiedEvent() {
	return {
		eventType: "message",
		eventId: "Ev-upload",
		teamId: "T-VERIFIED",
		slackBotToken: "xoxb-verified",
		payload: {
			type: "message",
			user: "U1",
			text: "send the report",
			ts: "101.200",
			thread_ts: "100.100",
			event_ts: "101.200",
			channel: "C-VERIFIED",
		},
	};
}

function workerWithSlackSession() {
	const upload = vi.fn().mockResolvedValue({
		files: [{ id: "F1", title: "Report" }],
	});
	const worker: any = Object.create(EdgeWorker.prototype);
	worker.getFailureModesClient = vi.fn().mockReturnValue(null);
	worker.slackFileUploadService = { upload };
	worker.chatSessionHandler = {
		getLatestEventForSession: (sessionId: string) =>
			sessionId === "slack-parent" ? verifiedEvent() : undefined,
		getAllChatSessions: () => [
			{
				id: "slack-parent",
				workspace: { path: "/cyrus/chat-workspaces/thread-a" },
			},
			{
				id: "slack-other",
				workspace: { path: "/cyrus/chat-workspaces/thread-b" },
			},
		],
	};
	worker.slackEngineeringOrchestrator = {
		listRepositories: vi.fn(),
		current: vi.fn(),
		status: vi.fn(),
		stop: vi.fn(),
	};
	return { worker, upload };
}

describe("EdgeWorker Slack file upload authorization wiring", () => {
	it("derives token, channel, thread, and exact workspace from the verified parent session", async () => {
		const { worker, upload } = workerWithSlackSession();
		const options = worker.createCyrusToolsOptions("slack-parent");

		await expect(
			options.slackFiles.upload({
				files: [{ filePath: "/cyrus/chat-workspaces/thread-a/report.pdf" }],
				initialComment: "Requested report",
			}),
		).resolves.toEqual({ files: [{ id: "F1", title: "Report" }] });
		expect(upload).toHaveBeenCalledWith(
			{
				files: [{ filePath: "/cyrus/chat-workspaces/thread-a/report.pdf" }],
				initialComment: "Requested report",
			},
			{
				token: "xoxb-verified",
				channelId: "C-VERIFIED",
				threadTs: "100.100",
				workspacePath: "/cyrus/chat-workspaces/thread-a",
			},
		);
	});

	it("does not expose upload without a verified event, token, or matching chat session", () => {
		const { worker } = workerWithSlackSession();
		expect(
			worker.createCyrusToolsOptions("not-slack").slackFiles,
		).toBeUndefined();

		worker.chatSessionHandler.getLatestEventForSession = () => ({
			...verifiedEvent(),
			slackBotToken: undefined,
		});
		expect(
			worker.createCyrusToolsOptions("slack-parent").slackFiles,
		).toBeUndefined();

		worker.chatSessionHandler.getLatestEventForSession = () => verifiedEvent();
		worker.chatSessionHandler.getAllChatSessions = () => [];
		expect(
			worker.createCyrusToolsOptions("slack-parent").slackFiles,
		).toBeUndefined();
	});

	it("cannot be redirected by forged model destination fields", async () => {
		const { worker, upload } = workerWithSlackSession();
		const options = worker.createCyrusToolsOptions("slack-parent");
		await options.slackFiles.upload({
			files: [{ filePath: "/cyrus/chat-workspaces/thread-a/report.pdf" }],
			token: "xoxb-forged",
			channelId: "C-FORGED",
			threadTs: "999.999",
			workspacePath: "/cyrus/chat-workspaces/thread-b",
		});

		expect(upload.mock.calls[0]?.[1]).toEqual({
			token: "xoxb-verified",
			channelId: "C-VERIFIED",
			threadTs: "100.100",
			workspacePath: "/cyrus/chat-workspaces/thread-a",
		});
	});
});
