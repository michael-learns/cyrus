import type {
	SlackMessageAttachment,
	SlackThreadMessage,
	SlackWebhookEvent,
} from "cyrus-slack-event-transport";

export interface SlackEngineeringFixtureLink {
	label: string;
	url: string;
}

export interface SlackEngineeringFixtureFile {
	id: string;
	name: string;
	mimeType: string;
	base64: string;
}

export interface SlackEngineeringFixtureImage
	extends SlackEngineeringFixtureFile {
	mimeType: "image/jpeg" | "image/png" | "image/gif" | "image/webp";
}

export interface SlackEngineeringFixtureMessage {
	ts: string;
	user: string;
	text: string;
	links?: SlackEngineeringFixtureLink[];
	files?: SlackEngineeringFixtureFile[];
	images?: SlackEngineeringFixtureImage[];
	attachments?: SlackMessageAttachment[];
}

export interface SlackEngineeringFixture {
	channel: string;
	user: string;
	threadTs?: string;
	kickoffTs: string;
	text: string;
	history?: SlackEngineeringFixtureMessage[];
	teamId?: string;
}

export interface NormalizedSlackEngineeringFixture {
	event: SlackWebhookEvent;
	messages: SlackThreadMessage[];
	files: Map<string, { bytes: Buffer; mimeType: string }>;
}

/**
 * Convert a readable F1 fixture into the same raw shapes returned by Slack.
 * Production SlackMessageService and SlackConversationContextService consume
 * the result; this helper deliberately performs no transcript normalization.
 */
export function normalizeSlackEngineeringFixture(
	fixture: SlackEngineeringFixture,
): NormalizedSlackEngineeringFixture {
	const files = new Map<string, { bytes: Buffer; mimeType: string }>();
	const messages = (fixture.history ?? []).map((message) => {
		if (message.ts > fixture.kickoffTs) {
			throw new Error("history message timestamp must not be after kickoffTs");
		}
		const links = message.links ?? [];
		const fixtureFiles = [...(message.files ?? []), ...(message.images ?? [])];
		const attachments = message.attachments ?? [];
		for (const file of fixtureFiles) {
			files.set(file.id, {
				bytes: Buffer.from(file.base64, "base64"),
				mimeType: file.mimeType,
			});
		}
		return {
			user: message.user,
			text: message.text,
			ts: message.ts,
			...(links.length > 0 && {
				blocks: [
					{
						type: "rich_text",
						elements: [
							{
								type: "rich_text_section",
								elements: links.map((link) => ({
									type: "link",
									text: link.label,
									url: link.url,
								})),
							},
						],
					},
				],
			}),
			...(fixtureFiles.length > 0 && {
				files: fixtureFiles.map((file) => ({
					id: file.id,
					name: file.name,
					mimetype: file.mimeType,
					size: files.get(file.id)!.bytes.byteLength,
					url_private_download: `https://files.slack.com/f1/${encodeURIComponent(file.id)}`,
				})),
			}),
			...(attachments.length > 0 && { attachments }),
		} satisfies SlackThreadMessage;
	});

	if (!messages.some((message) => message.ts === fixture.kickoffTs)) {
		messages.push({
			user: fixture.user,
			text: fixture.text,
			ts: fixture.kickoffTs,
		});
	}
	messages.sort((left, right) => left.ts.localeCompare(right.ts));
	const kickoffMessage = messages.find(
		(message) => message.ts === fixture.kickoffTs,
	);

	return {
		event: {
			eventType: "app_mention",
			eventId: `f1-slack-${fixture.channel}-${fixture.kickoffTs}`,
			teamId: fixture.teamId ?? "f1-test-team",
			slackBotToken: "xoxb-f1-synthetic",
			payload: {
				type: "app_mention",
				user: fixture.user,
				text: fixture.text,
				ts: fixture.kickoffTs,
				channel: fixture.channel,
				...(fixture.threadTs ? { thread_ts: fixture.threadTs } : {}),
				event_ts: fixture.kickoffTs,
				...(kickoffMessage?.blocks && { blocks: kickoffMessage.blocks }),
				...(kickoffMessage?.attachments && {
					attachments: kickoffMessage.attachments,
				}),
				...(kickoffMessage?.files && { files: kickoffMessage.files }),
			},
		},
		messages,
		files,
	};
}
