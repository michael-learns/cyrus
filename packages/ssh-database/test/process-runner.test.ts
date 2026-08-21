import { describe, expect, it } from "vitest";
import { runBoundedProcess } from "../src/index.js";

function invocation(script: string) {
	return {
		file: process.execPath,
		args: ["--eval", script],
		env: {},
		shell: false as const,
		timeoutMs: 1_000,
		maxStdoutBytes: 64,
		maxStderrBytes: 8,
	};
}

describe("bounded process runner", () => {
	it("caps stdout and retains only a bounded stderr tail", async () => {
		await expect(
			runBoundedProcess({
				...invocation("process.stdout.write('x'.repeat(100))"),
				maxStdoutBytes: 10,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_INVALID" });

		await expect(
			runBoundedProcess(
				invocation("process.stderr.write('abcdefghijklmnop'); process.exit(2)"),
			),
		).resolves.toEqual({
			stdout: Buffer.alloc(0),
			stderr: Buffer.from("abcdefgh"),
			exitCode: 2,
		});
	});

	it("terminates on timeout and cancellation with stable errors", async () => {
		await expect(
			runBoundedProcess({
				...invocation("setInterval(() => {}, 1000)"),
				timeoutMs: 20,
			}),
		).rejects.toMatchObject({ code: "QUERY_TIMEOUT" });

		const controller = new AbortController();
		const running = runBoundedProcess({
			...invocation("setInterval(() => {}, 1000)"),
			signal: controller.signal,
		});
		controller.abort();
		await expect(running).rejects.toMatchObject({ code: "REQUEST_CANCELLED" });
	});
});
