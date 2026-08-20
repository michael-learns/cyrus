import { describe, expect, it } from "vitest";
import type { AgentTurn, IAgentRunner } from "../src/agent-runner-types";
import { StreamingPrompt } from "../src/StreamingPrompt";

describe("structured agent turns", () => {
	it("keeps legacy runner methods optional while exposing the ordered turn type", async () => {
		const legacyRunner = {
			supportsStreamingInput: false,
			start: async () => ({
				sessionId: null,
				startedAt: new Date(),
				isRunning: false,
			}),
			stop: () => undefined,
			isRunning: () => false,
			getMessages: () => [],
			getFormatter: () => ({}) as any,
		} satisfies IAgentRunner;
		const turn: AgentTurn = [
			{ type: "text", text: "before" },
			{
				type: "local_image",
				path: "/tmp/image.gif",
				mediaType: "image/gif",
			},
			{ type: "text", text: "after" },
		];

		expect(legacyRunner.supportsStreamingInput).toBe(false);
		expect(turn.map((part) => part.type)).toEqual([
			"text",
			"local_image",
			"text",
		]);
	});

	it("queues SDK content arrays without changing their order", async () => {
		const prompt = new StreamingPrompt(null);
		prompt.addMessage([
			{ type: "text", text: "before" },
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/jpeg",
					data: "YWJj",
				},
			},
			{ type: "text", text: "after" },
		]);
		prompt.complete();

		const messages = [];
		for await (const message of prompt) messages.push(message);
		expect(messages[0]?.message.content).toEqual([
			{ type: "text", text: "before" },
			{
				type: "image",
				source: {
					type: "base64",
					media_type: "image/jpeg",
					data: "YWJj",
				},
			},
			{ type: "text", text: "after" },
		]);
	});
});
