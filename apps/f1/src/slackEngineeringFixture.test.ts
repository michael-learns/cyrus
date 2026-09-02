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

	it("turns generic files into production-shaped metadata without changing image fixtures", () => {
		const pdf = Buffer.from("%PDF-1.4\n% F1 exact PDF bytes\n%%EOF\n");
		const csv = Buffer.from("name,value\nalpha,7\n", "utf8");
		const normalized = normalizeSlackEngineeringFixture({
			channel: "C_FILES",
			user: "U_REQUESTER",
			kickoffTs: "1755660002.000300",
			text: "Read these files",
			history: [
				{
					ts: "1755660002.000300",
					user: "U_REQUESTER",
					text: "Read these files",
					files: [
						{
							id: "F_PDF",
							name: "requirements.pdf",
							mimeType: "application/pdf",
							base64: pdf.toString("base64"),
						},
						{
							id: "F_CSV",
							name: "records.csv",
							mimeType: "text/csv",
							base64: csv.toString("base64"),
						},
					],
				},
			],
		});

		expect(normalized.event.payload.files).toEqual([
			{
				id: "F_PDF",
				name: "requirements.pdf",
				mimetype: "application/pdf",
				size: pdf.byteLength,
				url_private_download: "https://files.slack.com/f1/F_PDF",
			},
			{
				id: "F_CSV",
				name: "records.csv",
				mimetype: "text/csv",
				size: csv.byteLength,
				url_private_download: "https://files.slack.com/f1/F_CSV",
			},
		]);
		expect(normalized.files.get("F_PDF")?.bytes).toEqual(pdf);
		expect(normalized.files.get("F_CSV")?.bytes).toEqual(csv);
	});
});
