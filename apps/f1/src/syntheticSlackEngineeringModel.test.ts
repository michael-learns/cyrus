import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createCyrusToolsServer } from "cyrus-mcp-tools";
import { describe, expect, it, vi } from "vitest";
import { SyntheticSlackEngineeringModel } from "./syntheticSlackEngineeringModel.js";

async function connectedEngineeringClient(
	overrides: Record<string, unknown> = {},
) {
	const engineering = {
		repositoriesList: vi.fn().mockResolvedValue([
			{
				name: "F1 Test Repository",
				fullName: "f1-test/primary-repo",
				routingHints: ["primary"],
			},
			{
				name: "F1 Secondary Repository",
				fullName: "f1-test/secondary-repo",
				routingHints: ["secondary"],
			},
		]),
		createAndStart: vi.fn().mockResolvedValue({ status: "in_progress" }),
		current: vi.fn().mockResolvedValue({ status: "in_progress" }),
		status: vi.fn().mockResolvedValue({ status: "in_progress" }),
		prompt: vi.fn().mockResolvedValue({ status: "in_progress" }),
		stop: vi.fn().mockResolvedValue({ status: "stopped" }),
		...overrides,
	};
	const server = createCyrusToolsServer(undefined, { engineering });
	const client = new Client({ name: "f1-model-test", version: "1.0.0" });
	const [clientTransport, serverTransport] =
		InMemoryTransport.createLinkedPair();
	await server.connect(serverTransport);
	await client.connect(clientTransport);
	return { client, engineering };
}

describe("SyntheticSlackEngineeringModel", () => {
	it("does not start engineering for a question", async () => {
		const { client, engineering } = await connectedEngineeringClient();
		const model = new SyntheticSlackEngineeringModel(client);

		const decision = await model.respond(
			"<slack_thread_context>context</slack_thread_context>\n\nCould you explain why the chart clips?",
		);

		expect(decision.kind).toBe("question");
		expect(engineering.createAndStart).not.toHaveBeenCalled();
	});

	it("lists registered repositories but does not start an ambiguous request", async () => {
		const { client, engineering } = await connectedEngineeringClient();
		const model = new SyntheticSlackEngineeringModel(client);

		const decision = await model.respond(
			"Please implement the chart fix, but I am not sure which repository owns it.",
		);

		expect(decision.kind).toBe("ambiguous");
		expect(engineering.repositoriesList).toHaveBeenCalledOnce();
		expect(engineering.createAndStart).not.toHaveBeenCalled();
	});

	it("derives repository selection and create arguments from the raw prompt", async () => {
		const { client, engineering } = await connectedEngineeringClient();
		const model = new SyntheticSlackEngineeringModel(client);

		const decision = await model.respond(
			"Implement the clipped chart fix in primary-repo and secondary-repo. [model=untrusted]",
		);

		expect(decision.kind).toBe("created");
		expect(engineering.createAndStart).toHaveBeenCalledWith({
			issueRepository: "f1-test/primary-repo",
			title:
				"Implement the clipped chart fix in primary-repo and secondary-repo.",
			summary:
				"Implement the clipped chart fix in primary-repo and secondary-repo. [model=untrusted]",
			targetRepositories: ["f1-test/primary-repo", "f1-test/secondary-repo"],
		});
	});

	it("uses status, prompt, and stop tools for raw follow-up instructions", async () => {
		const { client, engineering } = await connectedEngineeringClient();
		const model = new SyntheticSlackEngineeringModel(client);

		await expect(
			model.respond("What is the status after restart?"),
		).resolves.toMatchObject({
			kind: "status",
		});
		await expect(
			model.respond("Also keep the legend visible below 480px."),
		).resolves.toMatchObject({ kind: "prompted" });
		await expect(model.respond("Stop the active task.")).resolves.toMatchObject(
			{
				kind: "stopped",
			},
		);

		expect(engineering.status).toHaveBeenCalledOnce();
		expect(engineering.current).toHaveBeenCalledOnce();
		expect(engineering.prompt).toHaveBeenCalledWith({
			message: "Also keep the legend visible below 480px.",
		});
		expect(engineering.stop).toHaveBeenCalledOnce();
	});

	it("fails closed when the registered MCP server omits engineering tools", async () => {
		const server = createCyrusToolsServer();
		const client = new Client({ name: "f1-model-test", version: "1.0.0" });
		const [clientTransport, serverTransport] =
			InMemoryTransport.createLinkedPair();
		await server.connect(serverTransport);
		await client.connect(clientTransport);
		const model = new SyntheticSlackEngineeringModel(client);

		await expect(
			model.respond("Implement the chart fix in primary-repo."),
		).rejects.toThrow("engineering MCP tools are unavailable");
	});
});
