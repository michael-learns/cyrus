import { describe, expect, it } from "vitest";
import { EdgeConfigSchema } from "../src/config-schemas.js";

const repository = {
	id: "payroll",
	name: "Payroll",
	repositoryPath: "/srv/payroll",
	baseBranch: "main",
	workspaceBaseDir: "/srv/worktrees",
};

function connection(overrides: Record<string, unknown> = {}) {
	return {
		id: "payroll-production",
		name: "Payroll production (read-only)",
		engine: "postgres",
		repositoryIds: ["payroll"],
		slackDestinations: [{ teamId: "T0123456789", channelId: "C0123456789" }],
		ssh: {
			host: "payroll-db.internal",
			identityFile: "~/.cyrus/ssh/payroll_ed25519",
			knownHostsFile: "~/.cyrus/ssh/known_hosts",
		},
		database: { name: "payroll", profile: "payroll-production" },
		allowModelDataRetention: true,
		...overrides,
	};
}

describe("SSH database connection configuration", () => {
	it.each([
		"postgres",
		"mysql",
	] as const)("parses a valid %s connection with safe defaults", (engine) => {
		const parsed = EdgeConfigSchema.parse({
			repositories: [repository],
			databaseConnections: [connection({ engine })],
		});

		expect(parsed.databaseConnections).toEqual([
			expect.objectContaining({
				engine,
				ssh: expect.objectContaining({ port: 22 }),
				limits: {
					connectTimeoutMs: 10_000,
					queryTimeoutMs: 15_000,
					maxSqlBytes: 16_384,
					maxRows: 100,
					maxOutputBytes: 32_768,
				},
			}),
		]);
	});

	it("accepts an omitted connection list without changing existing configs", () => {
		expect(
			EdgeConfigSchema.parse({ repositories: [repository] }),
		).not.toHaveProperty("databaseConnections");
	});

	it("requires an explicit model-retention acknowledgement", () => {
		const value = connection();
		delete (value as { allowModelDataRetention?: boolean })
			.allowModelDataRetention;

		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [value],
			}),
		).toThrow();
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [connection({ allowModelDataRetention: false })],
			}),
		).toThrow();
	});

	it("rejects duplicate connection IDs", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [connection(), connection({ name: "Duplicate" })],
			}),
		).toThrow(/duplicate/i);
	});

	it.each([
		{ id: "-profile" },
		{ id: "unsafe id" },
		{ database: { name: "-payroll", profile: "payroll-production" } },
		{ database: { name: "payroll", profile: "../../shell" } },
		{ ssh: { ...connection().ssh, host: "-oProxyCommand=bad" } },
		{ ssh: { ...connection().ssh, user: "bad user" } },
	])("rejects unsafe operator-controlled tokens: $id", (override) => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [connection(override)],
			}),
		).toThrow();
	});

	it.each([
		{ ssh: { ...connection().ssh, port: 0 } },
		{ ssh: { ...connection().ssh, port: 65_536 } },
		{ limits: { connectTimeoutMs: 60_001 } },
		{ limits: { queryTimeoutMs: 60_001 } },
		{ limits: { maxSqlBytes: 65_537 } },
		{ limits: { maxRows: 1_001 } },
		{ limits: { maxOutputBytes: 1_048_577 } },
	])("rejects invalid ports and limits", (override) => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [connection(override)],
			}),
		).toThrow();
	});

	it("requires repository IDs and complete Slack destination pairs", () => {
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [connection({ repositoryIds: [] })],
			}),
		).toThrow();
		expect(() =>
			EdgeConfigSchema.parse({
				repositories: [repository],
				databaseConnections: [
					connection({ slackDestinations: [{ channelId: "C0123456789" }] }),
				],
			}),
		).toThrow();
	});
});
