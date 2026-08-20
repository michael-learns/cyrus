import { describe, expect, it, vi } from "vitest";
import { EdgeWorker } from "../src/EdgeWorker.js";

/**
 * Chat sessions are told to drive `gh pr ...`, but their workspace is not a git
 * checkout and they only inherit the parent environment. Under the documented
 * GitHub App setup there is no GITHUB_TOKEN and no `gh` login, so the runner has
 * to be handed a resolved token explicitly.
 */
describe("EdgeWorker chat runner credentials", () => {
	function buildWorker(token: string | undefined) {
		const worker: any = Object.create(EdgeWorker.prototype);
		worker.runnerSelectionService = {
			getDefaultRunner: vi.fn().mockReturnValue("codex"),
		};
		worker.getDefaultModelForRunner = vi.fn().mockReturnValue("model");
		worker.getDefaultFallbackModelForRunner = vi
			.fn()
			.mockReturnValue("fallback");
		worker.resolveGitHubTokenValue = vi.fn().mockResolvedValue(token);
		worker.createRunnerForType = vi.fn().mockReturnValue({ id: "runner" });
		return worker;
	}

	it("injects the resolved GitHub token into the chat runner environment", async () => {
		const worker = buildWorker("ghs_installation_token");

		await worker.createChatRunner({ workingDirectory: "/tmp/thread" });

		expect(worker.resolveGitHubTokenValue).toHaveBeenCalled();
		expect(worker.createRunnerForType).toHaveBeenCalledWith(
			"claude",
			expect.objectContaining({
				additionalEnv: {
					GH_TOKEN: "ghs_installation_token",
					GITHUB_TOKEN: "ghs_installation_token",
				},
			}),
		);
	});

	it("locks Slack parent sessions to Claude even when another runner is configured globally", async () => {
		const worker = buildWorker(undefined);

		await worker.createChatRunner({ workingDirectory: "/tmp/thread" });

		expect(
			worker.runnerSelectionService.getDefaultRunner,
		).not.toHaveBeenCalled();
		expect(worker.createRunnerForType).toHaveBeenCalledWith(
			"claude",
			expect.objectContaining({ model: "model", fallbackModel: "fallback" }),
		);
	});

	it("starts the session normally when no token can be resolved", async () => {
		const worker = buildWorker(undefined);

		const runner = await worker.createChatRunner({
			workingDirectory: "/tmp/thread",
		});

		expect(runner).toEqual({ id: "runner" });
		const passedConfig = worker.createRunnerForType.mock.calls[0]?.[1];
		expect(passedConfig.additionalEnv).toBeUndefined();
	});

	it("preserves environment variables the caller already set", async () => {
		const worker = buildWorker("ghs_installation_token");

		await worker.createChatRunner({
			workingDirectory: "/tmp/thread",
			additionalEnv: { EXISTING: "value" },
		});

		expect(worker.createRunnerForType).toHaveBeenCalledWith(
			"claude",
			expect.objectContaining({
				additionalEnv: expect.objectContaining({
					EXISTING: "value",
					GH_TOKEN: "ghs_installation_token",
				}),
			}),
		);
	});
});
