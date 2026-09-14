import { beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => ({
	edgeWorkerConfigs: [] as Array<Record<string, unknown>>,
	setConfigPath: vi.fn(),
	on: vi.fn(),
	start: vi.fn().mockResolvedValue(undefined),
}));

vi.mock("cyrus-edge-worker", () => ({
	EdgeWorker: class {
		constructor(config: Record<string, unknown>) {
			mocks.edgeWorkerConfigs.push(config);
		}

		setConfigPath = mocks.setConfigPath;
		on = mocks.on;
		start = mocks.start;
	},
}));

vi.mock("cyrus-cloudflare-tunnel-client", () => ({
	getCyrusAppUrl: vi.fn(),
}));

vi.mock("cyrus-slack-event-transport", () => ({
	SlackEventTransport: class {},
}));

import { WorkerService } from "./WorkerService.js";

describe("WorkerService", () => {
	beforeEach(() => {
		vi.clearAllMocks();
		mocks.edgeWorkerConfigs.length = 0;
	});

	it("passes configured database connections into a newly started EdgeWorker", async () => {
		const databaseConnection = {
			id: "yto-staging-db4",
			name: "YTO staging database 4",
			engine: "postgres" as const,
			repositoryIds: ["github-yahshua-abba-yto"],
			slackDestinations: [{ teamId: "T1", channelId: "C1" }],
			ssh: {
				host: "db.example.test",
				port: 22,
				identityFile: "~/.cyrus/ssh/yto-staging-db4",
				knownHostsFile: "~/.cyrus/ssh/yto_known_hosts",
			},
			database: { name: "staging_db4", profile: "yto-staging-db4" },
			limits: {
				connectTimeoutMs: 10_000,
				queryTimeoutMs: 15_000,
				maxSqlBytes: 16_384,
				maxRows: 100,
				maxOutputBytes: 32_768,
			},
			allowModelDataRetention: true as const,
		};
		const configService = {
			load: vi.fn().mockReturnValue({
				databaseConnections: [databaseConnection],
			}),
			getConfigPath: vi.fn().mockReturnValue("/tmp/cyrus/config.json"),
		};
		const logger = {
			info: vi.fn(),
			error: vi.fn(),
			warn: vi.fn(),
			success: vi.fn(),
			raw: vi.fn(),
			divider: vi.fn(),
		};
		const service = new WorkerService(
			configService as never,
			{} as never,
			"/tmp/cyrus",
			logger as never,
			"0.2.68",
		);

		await service.startEdgeWorker({ repositories: [] });

		expect(mocks.edgeWorkerConfigs).toHaveLength(1);
		expect(mocks.edgeWorkerConfigs[0]?.databaseConnections).toEqual([
			databaseConnection,
		]);
	});
});
