import { describe, expect, it } from "vitest";
import {
	McpConfigService,
	type McpConfigServiceDeps,
} from "../src/McpConfigService.js";

function createService(options?: {
	now?: () => number;
	contextTtlMs?: number;
	maxContexts?: number;
	resolveDatabaseAuthorizationContext?: McpConfigServiceDeps["resolveDatabaseAuthorizationContext"];
}) {
	return new McpConfigService(
		{
			getLinearTokenForWorkspace: () => null,
			getIssueTracker: () => undefined,
			getCyrusToolsMcpUrl: () => "http://127.0.0.1:3456/mcp",
			createCyrusToolsOptions: () => ({}),
			resolveDatabaseAuthorizationContext:
				options?.resolveDatabaseAuthorizationContext,
		},
		{
			now: options?.now,
			contextTtlMs: options?.contextTtlMs,
			maxContexts: options?.maxContexts,
		},
	);
}

function cyrusHeaders(config: ReturnType<McpConfigService["buildMcpConfig"]>) {
	return config["cyrus-tools"]?.headers as Record<string, string>;
}

describe("McpConfigService capabilities", () => {
	it("uses unique opaque context IDs and a process-local bearer without CYRUS_API_KEY", () => {
		const previous = process.env.CYRUS_API_KEY;
		delete process.env.CYRUS_API_KEY;
		try {
			const service = createService();
			const first = cyrusHeaders(
				service.buildMcpConfig("repo-payroll", "", "slack-parent-1"),
			);
			const second = cyrusHeaders(
				service.buildMcpConfig("repo-payroll", "", "slack-parent-1"),
			);

			expect(first["x-cyrus-mcp-context-id"]).toMatch(
				/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
			);
			expect(second["x-cyrus-mcp-context-id"]).not.toBe(
				first["x-cyrus-mcp-context-id"],
			);
			expect(first["x-cyrus-mcp-context-id"]).not.toContain("repo-payroll");
			expect(first["x-cyrus-mcp-context-id"]).not.toContain("slack-parent-1");
			expect(first.Authorization).toMatch(/^Bearer [A-Za-z0-9_-]{43}$/);
			expect(second.Authorization).toBe(first.Authorization);
			expect(service.isAuthorizationValid(first.Authorization)).toBe(true);
			expect(service.isAuthorizationValid(`${first.Authorization}x`)).toBe(
				false,
			);
			expect(service.isAuthorizationValid(undefined)).toBe(false);
			expect(service.isAuthorizationValid([first.Authorization])).toBe(false);
		} finally {
			if (previous === undefined) delete process.env.CYRUS_API_KEY;
			else process.env.CYRUS_API_KEY = previous;
		}
	});

	it("expires inactive contexts and refreshes active ones", () => {
		let now = 1_000;
		const service = createService({ now: () => now, contextTtlMs: 100 });
		const headers = cyrusHeaders(
			service.buildMcpConfig("repo", "", "parent-session"),
		);
		const contextId = headers["x-cyrus-mcp-context-id"]!;

		now = 1_099;
		expect(service.getContext(contextId)).toBeDefined();
		now = 1_198;
		expect(service.getContext(contextId)).toBeDefined();
		now = 1_299;
		expect(service.getContext(contextId)).toBeUndefined();
	});

	it("prunes oldest contexts and supports lifecycle/config revocation", () => {
		let now = 1;
		const service = createService({ now: () => now++, maxContexts: 2 });
		const first = cyrusHeaders(service.buildMcpConfig("r1", "", "parent-1"))[
			"x-cyrus-mcp-context-id"
		]!;
		const second = cyrusHeaders(service.buildMcpConfig("r2", "", "parent-2"))[
			"x-cyrus-mcp-context-id"
		]!;
		const third = cyrusHeaders(service.buildMcpConfig("r3", "", "parent-2"))[
			"x-cyrus-mcp-context-id"
		]!;

		expect(service.getContext(first)).toBeUndefined();
		expect(service.getContext(second)).toBeDefined();
		expect(service.getContext(third)).toBeDefined();
		expect(service.revokeContextsForParentSession("parent-2")).toBe(2);
		expect(service.getContext(second)).toBeUndefined();
		expect(service.getContext(third)).toBeUndefined();

		const after = cyrusHeaders(service.buildMcpConfig("r4", "", "parent-4"))[
			"x-cyrus-mcp-context-id"
		]!;
		service.clearAllContexts();
		expect(service.getContext(after)).toBeUndefined();
	});

	it("stores an immutable database authorization context beside the server", () => {
		const service = createService({
			resolveDatabaseAuthorizationContext: ({ parentSessionId }) => ({
				platform: "slack",
				teamId: "T1",
				channelId: "C1",
				userId: "U1",
				parentSessionId: parentSessionId!,
				repositoryIds: ["payroll"],
			}),
		});
		const headers = cyrusHeaders(
			service.buildMcpConfig("payroll", "", "slack-session"),
		);
		const context = service.getContext(headers["x-cyrus-mcp-context-id"]!);

		expect(context?.databaseAuthorizationContext).toMatchObject({
			capabilityId: headers["x-cyrus-mcp-context-id"],
			platform: "slack",
			parentSessionId: "slack-session",
		});
		expect(Object.isFrozen(context?.databaseAuthorizationContext)).toBe(true);
	});
});
