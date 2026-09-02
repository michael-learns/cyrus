import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

function createEngineeringCallbacks() {
	return {
		repositoriesList: vi.fn(),
		createAndStart: vi.fn(),
		current: vi.fn(),
		status: vi.fn(),
		prompt: vi.fn(),
		stop: vi.fn(),
	};
}

async function connectEngineering(
	engineering: ReturnType<typeof createEngineeringCallbacks>,
) {
	const server = createCyrusToolsServer(undefined, { engineering });
	const client = new Client({
		name: "slack-engineering-tool-test",
		version: "1.0.0",
	});
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

describe("GitHub Issue orchestration tools", () => {
	it("registers GitHub tools without requiring a Linear client", () => {
		const githubIssues = {
			get: vi.fn(),
			start: vi.fn(),
			status: vi.fn(),
			prompt: vi.fn(),
			stop: vi.fn(),
		};
		const server = createCyrusToolsServer(undefined, { githubIssues });
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).toEqual([
			"github_issue_get",
			"github_issue_start",
			"github_issue_status",
			"github_issue_prompt",
			"github_issue_stop",
		]);
	});

	it("omits GitHub tools when the host did not wire GitHub callbacks", () => {
		const server = createCyrusToolsServer({} as never);
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).not.toContain("github_issue_start");
	});
});

describe("Slack engineering orchestration tools", () => {
	it("registers the six tools only when verified Slack engineering callbacks are supplied", () => {
		const engineering = createEngineeringCallbacks();
		const server = createCyrusToolsServer(undefined, { engineering });
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).toEqual([
			"engineering_repositories_list",
			"engineering_create_and_start",
			"engineering_current",
			"engineering_status",
			"engineering_prompt",
			"engineering_stop",
		]);
	});

	it("does not expose engineering tools to sessions without verified Slack callbacks", () => {
		const server = createCyrusToolsServer(undefined, {
			parentSessionId: "linear-parent",
		});
		const registeredTools = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);

		expect(registeredTools).not.toContain("engineering_create_and_start");
	});

	it("registers the exact duplicate-resolution input contract", async () => {
		const { client } = await connectEngineering(createEngineeringCallbacks());
		const tools = await client.listTools();
		const createAndStart = tools.tools.find(
			(tool) => tool.name === "engineering_create_and_start",
		);

		expect(createAndStart?.inputSchema).toEqual({
			type: "object",
			properties: {
				issueRepository: { type: "string", minLength: 1 },
				title: { type: "string", minLength: 1 },
				summary: { type: "string", minLength: 1 },
				targetRepositories: {
					type: "array",
					items: { type: "string", minLength: 1 },
				},
				duplicateResolution: {
					type: "object",
					properties: {
						action: {
							type: "string",
							enum: ["reuse_existing", "create_new"],
						},
						issueNumber: {
							type: "integer",
							exclusiveMinimum: 0,
							maximum: 9_007_199_254_740_991,
						},
					},
					required: ["action", "issueNumber"],
				},
			},
			required: ["issueRepository", "title", "summary"],
			$schema: "http://json-schema.org/draft-07/schema#",
		});
	});

	it("forwards a duplicate resolution and preserves the success envelope", async () => {
		const engineering = createEngineeringCallbacks();
		engineering.createAndStart.mockResolvedValue({
			status: "started",
			issueNumber: 42,
		});
		const { client } = await connectEngineering(engineering);
		const input = {
			issueRepository: "ceedaragents/cyrus",
			title: "Confirm likely duplicate",
			summary: "The Slack user directly chose to reuse issue 42.",
			duplicateResolution: {
				action: "reuse_existing" as const,
				issueNumber: 42,
			},
		};

		const response = await client.callTool({
			name: "engineering_create_and_start",
			arguments: input,
		});

		expect(engineering.createAndStart).toHaveBeenCalledWith(input);
		expect(JSON.parse((response.content[0] as { text: string }).text)).toEqual({
			success: true,
			result: { status: "started", issueNumber: 42 },
		});
	});
});
