import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { describe, expect, it, vi } from "vitest";
import { createCyrusToolsServer } from "../../../src/tools/cyrus-tools/index.js";

async function connect(
	upload: (input: {
		files: Array<{ filePath: string; title?: string }>;
		initialComment?: string;
	}) => Promise<unknown>,
) {
	const server = createCyrusToolsServer(undefined, { slackFiles: { upload } });
	const client = new Client({ name: "slack-files-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, server };
}

describe("Slack file upload MCP tool", () => {
	it("registers only the exact model-facing upload schema", async () => {
		const { client } = await connect(vi.fn());
		const tools = await client.listTools();
		const upload = tools.tools.find(
			(tool) => tool.name === "slack_file_upload",
		);

		expect(upload?.inputSchema).toEqual({
			type: "object",
			properties: {
				files: {
					type: "array",
					minItems: 1,
					maxItems: 20,
					items: {
						type: "object",
						properties: {
							filePath: { type: "string", minLength: 1 },
							title: { type: "string", minLength: 1 },
						},
						required: ["filePath"],
						additionalProperties: false,
					},
				},
				initialComment: { type: "string", minLength: 1 },
			},
			required: ["files"],
			additionalProperties: false,
			$schema: "http://json-schema.org/draft-07/schema#",
		});
	});

	it("is completely absent without a verified callback", () => {
		const server = createCyrusToolsServer(undefined);
		const names = Object.keys(
			(server as unknown as { _registeredTools: Record<string, unknown> })
				._registeredTools,
		);
		expect(names).not.toContain("slack_file_upload");
	});

	it("returns structured success and rejects forged destination fields", async () => {
		const upload = vi.fn().mockResolvedValue({
			files: [{ id: "F1", title: "Report" }],
		});
		const { client } = await connect(upload);
		const success = await client.callTool({
			name: "slack_file_upload",
			arguments: {
				files: [{ filePath: "/workspace/report.pdf", title: "Report" }],
				initialComment: "Requested report",
			},
		});
		expect(JSON.parse((success.content[0] as { text: string }).text)).toEqual({
			success: true,
			result: { files: [{ id: "F1", title: "Report" }] },
		});
		expect(upload).toHaveBeenCalledWith({
			files: [{ filePath: "/workspace/report.pdf", title: "Report" }],
			initialComment: "Requested report",
		});

		const rejected = await client.callTool({
			name: "slack_file_upload",
			arguments: {
				files: [{ filePath: "/workspace/report.pdf" }],
				token: "xoxb-forged",
				channelId: "C-FORGED",
				threadTs: "999.999",
				workspacePath: "/tmp/forged",
			},
		});
		expect(rejected.isError).toBe(true);
		expect(upload).toHaveBeenCalledTimes(1);
	});

	it("returns safe structured errors without callback secrets", async () => {
		const { client } = await connect(
			vi.fn().mockRejectedValue(new Error("xoxb-secret /private/report.pdf")),
		);
		const result = await client.callTool({
			name: "slack_file_upload",
			arguments: { files: [{ filePath: "/workspace/report.pdf" }] },
		});
		const text = (result.content[0] as { text: string }).text;
		expect(text).not.toContain("xoxb-secret");
		expect(text).not.toContain("/private/report.pdf");
		expect(JSON.parse(text)).toEqual({
			success: false,
			error: {
				code: "UPLOAD_FAILED",
				message: "The Slack file upload could not be completed",
			},
		});
	});

	it("preserves a safe validation stage without returning callback text", async () => {
		const { client } = await connect(
			vi.fn().mockRejectedValue({
				code: "FILE_VALIDATION_FAILED",
				message: "leaked /private/report.pdf",
			}),
		);
		const result = await client.callTool({
			name: "slack_file_upload",
			arguments: { files: [{ filePath: "/workspace/report.pdf" }] },
		});
		expect(JSON.parse((result.content[0] as { text: string }).text)).toEqual({
			success: false,
			error: {
				code: "FILE_VALIDATION_FAILED",
				message: "One or more files failed upload validation",
			},
		});
	});
});
