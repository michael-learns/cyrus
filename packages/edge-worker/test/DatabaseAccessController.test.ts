import type { RepositoryConfig, SshDatabaseConnection } from "cyrus-core";
import { DatabaseAccessError } from "cyrus-ssh-database";
import { describe, expect, it, vi } from "vitest";
import { DatabaseAccessController } from "../src/DatabaseAccessController.js";
import type { DatabaseAuthorizationContext } from "../src/DatabaseAuthorizationContextService.js";

const payrollConnection: SshDatabaseConnection = {
	id: "payroll-production",
	name: "Payroll production",
	engine: "postgres",
	repositoryIds: ["payroll"],
	slackDestinations: [{ teamId: "T1", channelId: "C1" }],
	ssh: {
		host: "db.internal",
		port: 22,
		identityFile: "/keys/payroll",
		knownHostsFile: "/keys/known_hosts",
	},
	database: { name: "payroll", profile: "payroll-production" },
	limits: {
		connectTimeoutMs: 10_000,
		queryTimeoutMs: 15_000,
		maxSqlBytes: 16_384,
		maxRows: 100,
		maxOutputBytes: 32_768,
	},
	allowModelDataRetention: true,
};

const repositories: RepositoryConfig[] = [
	{
		id: "payroll",
		name: "Y1 Payroll",
		repositoryPath: "/repos/payroll",
		workspaceBaseDir: "/worktrees/payroll",
		baseBranch: "main",
		isActive: true,
	},
	{
		id: "inactive",
		name: "Inactive",
		repositoryPath: "/repos/inactive",
		workspaceBaseDir: "/worktrees/inactive",
		baseBranch: "main",
		isActive: false,
	},
];

function context(
	overrides: Partial<DatabaseAuthorizationContext> = {},
): DatabaseAuthorizationContext {
	return Object.freeze({
		capabilityId: "cap-1",
		platform: "slack",
		teamId: "T1",
		channelId: "C1",
		userId: "U1",
		parentSessionId: "slack-session",
		repositoryIds: Object.freeze(["payroll"]),
		issuedAt: 1,
		expiresAt: Number.MAX_SAFE_INTEGER,
		...overrides,
	});
}

function createController(input?: {
	connections?: () => readonly SshDatabaseConnection[];
	authorization?: DatabaseAuthorizationContext;
}) {
	const authorization = input?.authorization ?? context();
	const query = vi.fn().mockResolvedValue({
		connectionId: "payroll-production",
		engine: "postgres",
		format: "csv",
		output: "id,name\n1,Ada\n",
		truncated: false,
		rowCount: 1,
		byteCount: 14,
	});
	const audit = vi.fn();
	const controller = new DatabaseAccessController({
		getConnections: input?.connections ?? (() => [payrollConnection]),
		getRepositories: () => repositories,
		resolveAuthorizationContext: (capabilityId, parentSessionId) =>
			capabilityId === authorization.capabilityId &&
			parentSessionId === authorization.parentSessionId
				? authorization
				: undefined,
		queryService: { query },
		audit,
		now: () => 100,
	});
	return { controller, query, audit };
}

describe("DatabaseAccessController", () => {
	it("lists only exact-channel connections backed by an active repository", async () => {
		const hidden = {
			...payrollConnection,
			id: "finance-hidden",
			slackDestinations: [{ teamId: "T1", channelId: "C2" }],
		};
		const inactive = {
			...payrollConnection,
			id: "inactive-db",
			repositoryIds: ["inactive"],
		};
		const { controller } = createController({
			connections: () => [payrollConnection, hidden, inactive],
		});

		await expect(
			controller.connectionsList("cap-1", "slack-session"),
		).resolves.toEqual({
			connections: [
				{
					id: "payroll-production",
					name: "Payroll production",
					engine: "postgres",
					repositories: [{ id: "payroll", name: "Y1 Payroll" }],
				},
			],
		});
	});

	it("queries only an authorized live connection and audits metadata only", async () => {
		const { controller, query, audit } = createController();
		const result = await controller.query("cap-1", "slack-session", {
			connectionId: "payroll-production",
			sql: "SELECT id, name FROM employees",
		});

		expect(query).toHaveBeenCalledWith(
			payrollConnection,
			"SELECT id, name FROM employees",
			undefined,
		);
		expect(result).toMatchObject({
			connectionId: "payroll-production",
			connectionName: "Payroll production",
			output: "id,name\n1,Ada\n",
			untrusted: true,
		});
		expect(JSON.stringify(audit.mock.calls)).not.toContain("SELECT");
		expect(JSON.stringify(audit.mock.calls)).not.toContain("Ada");
		expect(audit).toHaveBeenCalledWith(
			"database_query",
			expect.objectContaining({
				connectionId: "payroll-production",
				teamId: "T1",
				channelId: "C1",
				userId: "U1",
				repositoryIds: ["payroll"],
				rowCount: 1,
				byteCount: 14,
				success: true,
			}),
		);
	});

	it("uses one non-enumerating error for hidden, missing, deleted, and stale access", async () => {
		let connections: readonly SshDatabaseConnection[] = [payrollConnection];
		const { controller, query } = createController({
			connections: () => connections,
		});
		const call = (connectionId: string, capabilityId = "cap-1") =>
			controller.query(capabilityId, "slack-session", {
				connectionId,
				sql: "SELECT 1",
			});

		const hidden = await call("unknown").catch((error) => error);
		connections = [];
		const deleted = await call("payroll-production").catch((error) => error);
		const stale = await call("payroll-production", "forged").catch(
			(error) => error,
		);

		for (const error of [hidden, deleted, stale]) {
			expect(error).toBeInstanceOf(DatabaseAccessError);
			expect(error).toMatchObject({
				code: "CONNECTION_NOT_ALLOWED",
				message: "The database connection is unavailable",
			});
		}
		expect(query).not.toHaveBeenCalled();
	});

	it("requires repository overlap for Slack engineering contexts", async () => {
		const { controller } = createController({
			authorization: context({
				platform: "slack-engineering",
				workItemId: "work-1",
				repositoryIds: ["different-repo"],
			}),
		});

		await expect(
			controller.connectionsList("cap-1", "slack-session"),
		).resolves.toEqual({ connections: [] });
	});
});
