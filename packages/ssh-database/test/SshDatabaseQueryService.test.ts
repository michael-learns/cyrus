import { describe, expect, it, vi } from "vitest";
import {
	decodeGatewayRequest,
	encodeGatewayResponse,
	GATEWAY_PROTOCOL_VERSION,
	SshDatabaseQueryService,
} from "../src/index.js";

const connection = {
	id: "payroll-production",
	name: "Payroll production",
	engine: "postgres" as const,
	repositoryIds: ["payroll"],
	slackDestinations: [{ teamId: "T1", channelId: "C1" }],
	ssh: {
		host: "gateway.internal",
		user: "cyrus-db",
		port: 2222,
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
	allowModelDataRetention: true as const,
};

describe("SshDatabaseQueryService", () => {
	it("validates locally and invokes OpenSSH with an exact hardened argv", async () => {
		const run = vi.fn().mockResolvedValue({
			stdout: encodeGatewayResponse({
				version: GATEWAY_PROTOCOL_VERSION,
				success: true,
				format: "csv",
				output: "id\n1\n",
				truncated: false,
				rowCount: 1,
				byteCount: 5,
			}),
			stderr: Buffer.alloc(0),
			exitCode: 0,
		});
		const service = new SshDatabaseQueryService({
			run,
			inspectFile: (path) => ({
				canonicalPath: path,
				isFile: true,
				uid: process.getuid?.() ?? 0,
				mode: path.includes("known_hosts") ? 0o100644 : 0o100600,
				parentsSafe: true,
			}),
		});

		await expect(
			service.query(connection, "SELECT id FROM employees"),
		).resolves.toEqual({
			connectionId: connection.id,
			engine: "postgres",
			format: "csv",
			output: "id\n1\n",
			truncated: false,
			rowCount: 1,
			byteCount: 5,
		});

		const invocation = run.mock.calls[0]?.[0];
		expect(invocation).toEqual(
			expect.objectContaining({
				file: "/usr/bin/ssh",
				args: [
					"-F",
					"none",
					"-i",
					"/keys/payroll",
					"-p",
					"2222",
					"-o",
					"BatchMode=yes",
					"-o",
					"StrictHostKeyChecking=yes",
					"-o",
					"UserKnownHostsFile=/keys/known_hosts",
					"-o",
					"GlobalKnownHostsFile=/dev/null",
					"-o",
					"IdentitiesOnly=yes",
					"-o",
					"IdentityAgent=none",
					"-o",
					"PasswordAuthentication=no",
					"-o",
					"KbdInteractiveAuthentication=no",
					"-o",
					"PreferredAuthentications=publickey",
					"-o",
					"ProxyCommand=none",
					"-o",
					"ProxyJump=none",
					"-o",
					"ControlMaster=no",
					"-o",
					"ControlPath=none",
					"-o",
					"KnownHostsCommand=none",
					"-o",
					"ClearAllForwardings=yes",
					"-o",
					"PermitLocalCommand=no",
					"-o",
					"RequestTTY=no",
					"-o",
					"ConnectTimeout=10",
					"cyrus-db@gateway.internal",
				],
				env: { LANG: "C.UTF-8", LC_ALL: "C.UTF-8" },
				shell: false,
				maxStdoutBytes: 1_572_864,
				maxStderrBytes: 4_096,
			}),
		);
		expect(
			decodeGatewayRequest(invocation.stdin, {
				expectedProfile: connection.database.profile,
				expectedEngine: connection.engine,
			}),
		).toEqual(expect.objectContaining({ sql: "SELECT id FROM employees" }));
	});

	it("fails before SSH when key or known-hosts permissions are unsafe", async () => {
		const run = vi.fn();
		for (const mode of [0o100644, 0o100666]) {
			const service = new SshDatabaseQueryService({
				run,
				inspectFile: (path) => ({
					canonicalPath: path,
					isFile: true,
					uid: process.getuid?.() ?? 0,
					mode,
					parentsSafe: true,
				}),
			});
			await expect(service.query(connection, "SELECT 1")).rejects.toMatchObject(
				{
					code: "GATEWAY_UNAVAILABLE",
				},
			);
		}
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		["an attacker-owned known-hosts file", false, true],
		["an unsafe parent directory", true, false],
	] as const)("rejects %s before SSH", async (_caseName, safeOwner, parentsSafe) => {
		const run = vi.fn();
		const currentUid = process.getuid?.() ?? 501;
		const service = new SshDatabaseQueryService({
			run,
			inspectFile: (path) => ({
				canonicalPath: path,
				isFile: true,
				uid:
					path.includes("known_hosts") && !safeOwner
						? currentUid + 1
						: currentUid,
				mode: path.includes("known_hosts") ? 0o100644 : 0o100600,
				parentsSafe,
			}),
		});

		await expect(service.query(connection, "SELECT 1")).rejects.toMatchObject({
			code: "GATEWAY_UNAVAILABLE",
		});
		expect(run).not.toHaveBeenCalled();
	});

	it.each([
		["Host key verification failed", "HOST_KEY_FAILED"],
		["Permission denied (publickey)", "AUTHENTICATION_FAILED"],
		["Connection timed out", "CONNECTION_TIMEOUT"],
	] as const)("classifies safe SSH failure: %s", async (stderr, code) => {
		const service = new SshDatabaseQueryService({
			run: vi.fn().mockResolvedValue({
				stdout: Buffer.alloc(0),
				stderr: Buffer.from(stderr),
				exitCode: 255,
			}),
			inspectFile: (path) => ({
				canonicalPath: path,
				isFile: true,
				uid: process.getuid?.() ?? 0,
				mode: path.includes("known_hosts") ? 0o100644 : 0o100600,
				parentsSafe: true,
			}),
		});
		await expect(service.query(connection, "SELECT 1")).rejects.toMatchObject({
			code,
		});
	});

	it("forwards cancellation and isolates concurrent requests", async () => {
		const signals: Array<AbortSignal | undefined> = [];
		const run = vi.fn().mockImplementation(async (input) => {
			signals.push(input.signal);
			return {
				stdout: encodeGatewayResponse({
					version: 1,
					success: true,
					format: "csv",
					output: "value\n1\n",
					truncated: false,
					rowCount: 1,
					byteCount: 8,
				}),
				stderr: Buffer.alloc(0),
				exitCode: 0,
			};
		});
		const service = new SshDatabaseQueryService({
			run,
			inspectFile: (path) => ({
				canonicalPath: path,
				isFile: true,
				uid: process.getuid?.() ?? 0,
				mode: path.includes("known_hosts") ? 0o100644 : 0o100600,
				parentsSafe: true,
			}),
		});
		const first = new AbortController();
		const second = new AbortController();
		await Promise.all([
			service.query(connection, "SELECT 1", first.signal),
			service.query(connection, "SELECT 2", second.signal),
		]);
		expect(signals).toEqual([first.signal, second.signal]);
		expect(run.mock.calls[0]?.[0].stdin).not.toEqual(
			run.mock.calls[1]?.[0].stdin,
		);
	});
});
