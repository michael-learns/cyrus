import { readFile } from "node:fs/promises";
import type { EdgeWorkerConfig, ILogger } from "cyrus-core";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ConfigManager } from "../src/ConfigManager.js";

vi.mock("node:fs/promises");

const repository = {
	id: "payroll",
	name: "Payroll",
	repositoryPath: "/srv/payroll",
	baseBranch: "main",
	workspaceBaseDir: "/srv/worktrees",
};
const connection = {
	id: "payroll-production",
	name: "Payroll production",
	engine: "postgres" as const,
	repositoryIds: ["payroll"],
	slackDestinations: [{ teamId: "T1", channelId: "C1" }],
	ssh: {
		host: "db.internal",
		identityFile: "/keys/payroll",
		knownHostsFile: "/keys/known_hosts",
	},
	database: { name: "payroll", profile: "payroll-production" },
	allowModelDataRetention: true as const,
};

describe("ConfigManager databaseConnections hot reload", () => {
	let logger: ILogger;
	let baseConfig: EdgeWorkerConfig;

	beforeEach(() => {
		vi.clearAllMocks();
		logger = {
			info: vi.fn(),
			warn: vi.fn(),
			error: vi.fn(),
			debug: vi.fn(),
		} as unknown as ILogger;
		baseConfig = {
			cyrusHome: "/tmp/cyrus-home",
			repositories: [repository],
			databaseConnections: [connection],
		} as EdgeWorkerConfig;
	});

	function manager(config = baseConfig) {
		return new ConfigManager(
			config,
			logger,
			"/tmp/cyrus-home/config.json",
			new Map(config.repositories.map((item) => [item.id, item])),
		);
	}

	it("loads an explicit replacement and detects the global change", async () => {
		const replacement = { ...connection, name: "Replacement" };
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: [repository],
				databaseConnections: [replacement],
			}) as never,
		);

		const instance = manager();
		const loaded = await (instance as any).loadConfigSafely();
		expect(loaded.databaseConnections).toEqual([
			expect.objectContaining({
				...replacement,
				ssh: expect.objectContaining(replacement.ssh),
				limits: expect.objectContaining({ maxRows: 100 }),
			}),
		]);
		expect((instance as any).detectGlobalConfigChanges(loaded)).toBe(true);
	});

	it("treats an explicit empty list as immediate revocation", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: [repository],
				databaseConnections: [],
			}) as never,
		);

		const loaded = await (manager() as any).loadConfigSafely();
		expect(loaded.databaseConnections).toEqual([]);
	});

	it("treats an omitted field as immediate revocation", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({ repositories: [repository] }) as never,
		);

		const loaded = await (manager() as any).loadConfigSafely();
		expect(loaded.databaseConnections).toEqual([]);
	});

	it("rejects an invalid candidate without partially replacing state", async () => {
		vi.mocked(readFile).mockResolvedValue(
			JSON.stringify({
				repositories: [repository],
				databaseConnections: [
					{ ...connection, allowModelDataRetention: false },
				],
			}) as never,
		);

		await expect((manager() as any).loadConfigSafely()).resolves.toBeNull();
	});
});
