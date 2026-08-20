import { mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { PersistenceManager } from "../src/PersistenceManager.js";

describe("PersistenceManager atomic saves", () => {
	it("serializes concurrent snapshots in call order and continues after a rejected save", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cyrus-state-queue-"));
		const order: string[] = [];
		let releaseFirst!: () => void;
		const firstGate = new Promise<void>((resolve) => {
			releaseFirst = resolve;
		});
		let writes = 0;
		const manager = new PersistenceManager(directory);
		vi.spyOn(manager as any, "writeStateAtomically").mockImplementation(
			async (path: string, data: string) => {
				const value = JSON.parse(data).state.issueRepositoryCache.value[0];
				order.push(`start:${value}`);
				if (++writes === 1) await firstGate;
				if (value === "failed") throw new Error("interrupted");
				await writeFile(path, data, "utf8");
				order.push(`finish:${value}`);
			},
		);

		const older = manager.saveEdgeWorkerState({
			issueRepositoryCache: { value: ["older"] },
		});
		const failed = manager.saveEdgeWorkerState({
			issueRepositoryCache: { value: ["failed"] },
		});
		const newer = manager.saveEdgeWorkerState({
			issueRepositoryCache: { value: ["newer"] },
		});
		await vi.waitFor(() => expect(order).toEqual(["start:older"]));
		releaseFirst();

		await expect(older).resolves.toBeUndefined();
		await expect(failed).rejects.toThrow("interrupted");
		await expect(newer).resolves.toBeUndefined();
		expect(order).toEqual([
			"start:older",
			"finish:older",
			"start:failed",
			"start:newer",
			"finish:newer",
		]);
		const stored = JSON.parse(
			await readFile(join(directory, "edge-worker-state.json"), "utf8"),
		);
		expect(stored.state.issueRepositoryCache.value).toEqual(["newer"]);
	});

	it("preserves the old primary and removes the unique temp after an interrupted write", async () => {
		const directory = await mkdtemp(join(tmpdir(), "cyrus-state-atomic-"));
		const primary = join(directory, "edge-worker-state.json");
		await writeFile(primary, '{"version":"4.0","state":{"old":true}}');
		const manager = new PersistenceManager(directory);
		const write = vi
			.spyOn(manager as any, "writeTempFile")
			.mockImplementation(async (tempPath: string) => {
				await writeFile(tempPath, "partial", "utf8");
				throw new Error("disk disconnected");
			});

		await expect(manager.saveEdgeWorkerState({})).rejects.toThrow(
			"disk disconnected",
		);

		expect(await readFile(primary, "utf8")).toBe(
			'{"version":"4.0","state":{"old":true}}',
		);
		expect((await readdir(directory)).sort()).toEqual([
			"edge-worker-state.json",
		]);
		expect(write).toHaveBeenCalledOnce();
		expect(write.mock.calls[0]![0]).toMatch(
			/edge-worker-state\.json\..+\.tmp$/,
		);
	});
});
