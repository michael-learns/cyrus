import { describe, expect, it } from "vitest";
import {
	normalizeSlackEngineeringFixture,
	type SlackEngineeringFixture,
} from "./slackEngineeringFixture.js";

describe("normalizeSlackEngineeringFixture", () => {
	it("turns fixture links and images into production-shaped Slack thread messages", () => {
		const fixture: SlackEngineeringFixture = {
			channel: "C_ENGINEERING",
			user: "U_REQUESTER",
			threadTs: "1755660000.000100",
			kickoffTs: "1755660002.000300",
			text: "Implement the dashboard fix",
			history: [
				{
					ts: "1755660000.000100",
					user: "U_REPORTER",
					text: "The chart is clipped",
					links: [{ label: "Design", url: "https://example.com/design" }],
					images: [
						{
							id: "F_SCREENSHOT",
							name: "chart.png",
							mimeType: "image/png",
							base64: "iVBORw0KGgo=",
						},
					],
				},
			],
		};

		const normalized = normalizeSlackEngineeringFixture(fixture);

		expect(normalized.event.payload).toEqual({
			type: "app_mention",
			user: "U_REQUESTER",
			text: "Implement the dashboard fix",
			ts: "1755660002.000300",
			channel: "C_ENGINEERING",
			thread_ts: "1755660000.000100",
			event_ts: "1755660002.000300",
		});
		expect(normalized.messages).toEqual([
			{
				user: "U_REPORTER",
				text: "The chart is clipped",
				ts: "1755660000.000100",
				blocks: [
					{
						type: "rich_text",
						elements: [
							{
								type: "rich_text_section",
								elements: [
									{
										type: "link",
										text: "Design",
										url: "https://example.com/design",
									},
								],
							},
						],
					},
				],
				files: [
					{
						id: "F_SCREENSHOT",
						name: "chart.png",
						mimetype: "image/png",
						size: 8,
						url_private_download: "https://files.slack.com/f1/F_SCREENSHOT",
					},
				],
			},
			{
				user: "U_REQUESTER",
				text: "Implement the dashboard fix",
				ts: "1755660002.000300",
			},
		]);
		expect(normalized.files.get("F_SCREENSHOT")).toEqual({
			bytes: Buffer.from("iVBORw0KGgo=", "base64"),
			mimeType: "image/png",
		});
	});

	it("rejects history after the kickoff so synthetic capture cannot invent future context", () => {
		expect(() =>
			normalizeSlackEngineeringFixture({
				channel: "C_ENGINEERING",
				user: "U_REQUESTER",
				threadTs: "1755660000.000100",
				kickoffTs: "1755660002.000300",
				text: "Implement it",
				history: [
					{
						ts: "1755660003.000400",
						user: "U_LATE",
						text: "future message",
					},
				],
			}),
		).toThrow("history message timestamp must not be after kickoffTs");
	});
});
