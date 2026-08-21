import { homedir } from "node:os";
import { join } from "node:path";
import type { EdgeWorkerConfig } from "cyrus-core";
import { describe, expect, it } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

describe("EdgeWorker database connection path normalization", () => {
	it("resolves configured identity and known-hosts paths without mutating input", () => {
		const input = {
			cyrusHome: "/tmp/cyrus-home",
			repositories: [],
			databaseConnections: [
				{
					id: "payroll",
					name: "Payroll",
					engine: "postgres",
					repositoryIds: ["repo"],
					slackDestinations: [{ teamId: "T1", channelId: "C1" }],
					ssh: {
						host: "db.internal",
						identityFile: "~/.cyrus/ssh/payroll",
						knownHostsFile: "~/.cyrus/ssh/known_hosts",
					},
					database: { name: "payroll", profile: "payroll" },
					allowModelDataRetention: true,
				},
			],
		} as EdgeWorkerConfig;

		const normalized = (EdgeWorker as any).normalizeConfigPaths(input);

		expect(normalized.databaseConnections[0].ssh).toEqual({
			host: "db.internal",
			identityFile: join(homedir(), ".cyrus/ssh/payroll"),
			knownHostsFile: join(homedir(), ".cyrus/ssh/known_hosts"),
		});
		expect(input.databaseConnections?.[0]?.ssh.identityFile).toBe(
			"~/.cyrus/ssh/payroll",
		);
	});
});
