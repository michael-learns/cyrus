interface McpToolClient {
	listTools(): Promise<{ tools: Array<{ name: string }> }>;
	callTool(input: {
		name: string;
		arguments?: Record<string, unknown>;
	}): Promise<unknown>;
}

interface EngineeringRepository {
	name: string;
	fullName: string;
	routingHints: string[];
}

export interface SyntheticModelDecision {
	kind:
		| "question"
		| "ambiguous"
		| "database"
		| "denied"
		| "created"
		| "prompted"
		| "status"
		| "stopped";
	result?: unknown;
	[key: string]: unknown;
}

const REQUIRED_ENGINEERING_TOOLS = [
	"engineering_repositories_list",
	"engineering_create_and_start",
	"engineering_current",
	"engineering_status",
	"engineering_prompt",
	"engineering_stop",
] as const;

const REQUIRED_DATABASE_TOOLS = [
	"database_connections_list",
	"database_query",
] as const;

interface DatabaseConnection {
	id: string;
	name: string;
	engine: "postgres" | "mysql";
}

function latestInstruction(prompt: string): string {
	return prompt
		.trim()
		.split("\n")
		.map((line) => line.trim())
		.filter(Boolean)
		.at(-1)!;
}

function isQuestion(text: string): boolean {
	return (
		text.endsWith("?") ||
		/^(what|why|how|when|where|who|could you explain|can you explain)\b/i.test(
			text,
		)
	);
}

function isImplementationRequest(text: string): boolean {
	return /\b(implement|fix|add|build|create|improve|change|update)\b/i.test(
		text,
	);
}

function issueTitle(text: string): string {
	return text
		.replace(/\s*\[(?:agent|model)=[^\]]+\]/gi, "")
		.trim()
		.slice(0, 120);
}

export class SyntheticSlackEngineeringModel {
	constructor(private readonly client: McpToolClient) {}

	async respond(prompt: string): Promise<SyntheticModelDecision> {
		const instruction = latestInstruction(prompt);
		const sql = instruction.match(/\bSQL:\s*([\s\S]+)$/i)?.[1]?.trim();
		let databaseEvidence:
			| ({ connectionName: string } & Record<string, unknown>)
			| undefined;
		if (sql) {
			try {
				await this.requireTools(REQUIRED_DATABASE_TOOLS, "database");
				const listed = (await this.call("database_connections_list")) as {
					connections: DatabaseConnection[];
				};
				const lowered = instruction.toLowerCase();
				const selected = listed.connections.filter(
					(connection) =>
						lowered.includes(connection.id.toLowerCase()) ||
						lowered.includes(connection.name.toLowerCase()) ||
						lowered.includes(connection.engine.toLowerCase()),
				);
				if (selected.length !== 1) {
					return {
						kind:
							selected.length === 0 && listed.connections.length === 0
								? "denied"
								: "ambiguous",
						connectionCount: listed.connections.length,
					};
				}
				const connection = selected[0]!;
				const query = (await this.call("database_query", {
					connectionId: connection.id,
					sql,
				})) as Record<string, unknown>;
				databaseEvidence = {
					...query,
					connectionName: String(query.connectionName ?? connection.name),
				};
			} catch (error) {
				const failure = error as Error & { code?: string };
				return { kind: "denied", errorCode: failure.code ?? "QUERY_FAILED" };
			}
			if (!isImplementationRequest(instruction)) {
				return { kind: "database", ...databaseEvidence };
			}
		}
		const stop = /\b(stop|cancel)\b/i.test(instruction);
		const status = /\b(status|progress)\b/i.test(instruction);
		if (isQuestion(instruction) && !status) return { kind: "question" };

		await this.requireTools(REQUIRED_ENGINEERING_TOOLS, "engineering");
		if (stop) {
			return {
				kind: "stopped",
				result: await this.call("engineering_stop"),
			};
		}
		if (status) {
			return {
				kind: "status",
				result: await this.call("engineering_status"),
			};
		}
		if (!isImplementationRequest(instruction)) {
			await this.call("engineering_current");
			return {
				kind: "prompted",
				result: await this.call("engineering_prompt", { message: instruction }),
			};
		}

		const repositories = (await this.call(
			"engineering_repositories_list",
		)) as EngineeringRepository[];
		const lowered = instruction.toLowerCase();
		const selected = repositories.filter((repository) => {
			const slug = repository.fullName.split("/").at(-1)!;
			return (
				lowered.includes(repository.fullName.toLowerCase()) ||
				lowered.includes(repository.name.toLowerCase()) ||
				lowered.includes(slug.toLowerCase())
			);
		});
		if (selected.length === 0 && repositories.length !== 1) {
			return { kind: "ambiguous", result: repositories };
		}
		const targets = selected.length > 0 ? selected : [repositories[0]!];
		const engineering = await this.call("engineering_create_and_start", {
			issueRepository: targets[0]!.fullName,
			title: issueTitle(instruction),
			summary: instruction,
			targetRepositories: targets.map((repository) => repository.fullName),
		});
		return {
			kind: "created",
			result: engineering,
			engineering,
			...(databaseEvidence && {
				databaseConnectionName: databaseEvidence.connectionName,
			}),
		};
	}

	private async requireTools(
		required: readonly string[],
		kind: "engineering" | "database",
	): Promise<void> {
		let tools: Array<{ name: string }>;
		try {
			tools = (await this.client.listTools()).tools;
		} catch {
			throw new Error("engineering MCP tools are unavailable or misregistered");
		}
		const available = new Set(tools.map((tool) => tool.name));
		if (required.some((tool) => !available.has(tool))) {
			throw new Error(`${kind} MCP tools are unavailable or misregistered`);
		}
	}

	private async call(
		name:
			| (typeof REQUIRED_ENGINEERING_TOOLS)[number]
			| (typeof REQUIRED_DATABASE_TOOLS)[number],
		args?: Record<string, unknown>,
	): Promise<unknown> {
		const response = (await this.client.callTool({
			name,
			arguments: args ?? {},
		})) as { content?: Array<{ type: string; text?: string }> };
		const text = response.content?.find((part) => part.type === "text")?.text;
		if (!text)
			throw new Error(`engineering MCP tool ${name} returned no result`);
		const payload = JSON.parse(text) as {
			success: boolean;
			result?: unknown;
			error?: string;
		};
		if (!payload.success) {
			const structured = payload.error as unknown as
				| { code?: string; message?: string }
				| string
				| undefined;
			const failure = new Error(
				typeof structured === "string"
					? structured
					: (structured?.message ?? `MCP tool ${name} failed`),
			) as Error & { code?: string };
			if (typeof structured === "object") failure.code = structured?.code;
			throw failure;
		}
		return payload.result;
	}
}
