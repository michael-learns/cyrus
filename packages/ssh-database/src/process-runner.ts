import { spawn } from "node:child_process";
import { DatabaseAccessError, type DatabaseAccessErrorCode } from "./errors.js";

export interface ProcessInvocation {
	file: string;
	args: string[];
	env: Record<string, string>;
	stdin?: Uint8Array;
	shell: false;
	timeoutMs: number;
	maxStdoutBytes: number;
	maxStderrBytes: number;
	signal?: AbortSignal;
	timeoutCode?: DatabaseAccessErrorCode;
	spawnErrorCode?: DatabaseAccessErrorCode;
}

export interface ProcessResult {
	stdout: Buffer;
	stderr: Buffer;
	exitCode: number | null;
}

export type ProcessRunner = (
	invocation: ProcessInvocation,
) => Promise<ProcessResult>;

export const runBoundedProcess: ProcessRunner = (invocation) =>
	new Promise((resolve, reject) => {
		let settled = false;
		let stdoutBytes = 0;
		let stderrBytes = 0;
		const stdout: Buffer[] = [];
		const stderr: Buffer[] = [];
		const child = spawn(invocation.file, invocation.args, {
			env: invocation.env,
			stdio: ["pipe", "pipe", "pipe"],
			shell: false,
			detached: process.platform !== "win32",
		});

		const finishError = (error: DatabaseAccessError) => {
			if (settled) return;
			settled = true;
			cleanup();
			terminateProcessTree(child.pid);
			reject(error);
		};
		const onAbort = () =>
			finishError(
				new DatabaseAccessError(
					"REQUEST_CANCELLED",
					"The database request was cancelled",
				),
			);
		const timer = setTimeout(
			() =>
				finishError(
					new DatabaseAccessError(
						invocation.timeoutCode ?? "QUERY_TIMEOUT",
						"The database request timed out",
					),
				),
			invocation.timeoutMs,
		);
		const cleanup = () => {
			clearTimeout(timer);
			invocation.signal?.removeEventListener("abort", onAbort);
		};

		if (invocation.signal?.aborted) {
			onAbort();
			return;
		}
		invocation.signal?.addEventListener("abort", onAbort, { once: true });
		child.on("error", () =>
			finishError(
				new DatabaseAccessError(
					invocation.spawnErrorCode ?? "GATEWAY_UNAVAILABLE",
					"The required executable is unavailable",
				),
			),
		);
		child.stdout.on("data", (chunk: Buffer) => {
			stdoutBytes += chunk.byteLength;
			if (stdoutBytes > invocation.maxStdoutBytes) {
				finishError(
					new DatabaseAccessError(
						"OUTPUT_INVALID",
						"The process returned too much output",
					),
				);
				return;
			}
			stdout.push(Buffer.from(chunk));
		});
		child.stderr.on("data", (chunk: Buffer) => {
			if (stderrBytes >= invocation.maxStderrBytes) return;
			const retained = chunk.subarray(
				0,
				invocation.maxStderrBytes - stderrBytes,
			);
			stderr.push(Buffer.from(retained));
			stderrBytes += retained.byteLength;
		});
		child.on("close", (exitCode) => {
			if (settled) return;
			settled = true;
			cleanup();
			resolve({
				stdout: Buffer.concat(stdout),
				stderr: Buffer.concat(stderr),
				exitCode,
			});
		});
		if (invocation.stdin) child.stdin.end(invocation.stdin);
		else child.stdin.end();
	});

function terminateProcessTree(pid: number | undefined): void {
	if (!pid) return;
	const kill = (signal: NodeJS.Signals) => {
		if (process.platform === "win32") process.kill(pid, signal);
		else process.kill(-pid, signal);
	};
	try {
		kill("SIGTERM");
	} catch {
		// The process may already have exited.
	}
	const forceKill = setTimeout(() => {
		try {
			kill("SIGKILL");
		} catch {
			// The process exited after SIGTERM.
		}
	}, 250);
	forceKill.unref();
}
