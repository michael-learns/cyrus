import {
	mkdir,
	mkdtemp,
	rm,
	symlink,
	truncate,
	writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { SlackFileUploadService } from "../src/SlackFileUploadService.js";

describe("SlackFileUploadService", () => {
	let root: string;
	let workspace: string;
	let otherWorkspace: string;
	let uploadFilesToThread: ReturnType<typeof vi.fn>;

	beforeEach(async () => {
		root = await mkdtemp(join(tmpdir(), "cyrus-slack-upload-"));
		workspace = join(root, "thread-a");
		otherWorkspace = join(root, "thread-b");
		await Promise.all([mkdir(workspace), mkdir(otherWorkspace)]);
		uploadFilesToThread = vi.fn().mockResolvedValue([
			{ id: "F1", title: "First report" },
			{ id: "F2", title: "second.txt" },
		]);
	});

	afterEach(async () => {
		await rm(root, { recursive: true, force: true });
	});

	function service() {
		return new SlackFileUploadService({ uploadFilesToThread });
	}

	const destination = () => ({
		token: "xoxb-verified",
		channelId: "C-VERIFIED",
		threadTs: "100.200",
		workspacePath: workspace,
	});

	it("reads a complete valid batch before sending it to the verified thread", async () => {
		const first = join(workspace, "first.txt");
		const second = join(workspace, "second.txt");
		await writeFile(first, "first bytes");
		await writeFile(second, "second bytes");

		await expect(
			service().upload(
				{
					files: [
						{ filePath: first, title: "First report" },
						{ filePath: second },
					],
					initialComment: "Requested files",
				},
				destination(),
			),
		).resolves.toEqual({
			files: [
				{ id: "F1", title: "First report" },
				{ id: "F2", title: "second.txt" },
			],
		});
		expect(uploadFilesToThread).toHaveBeenCalledWith({
			token: "xoxb-verified",
			channel_id: "C-VERIFIED",
			thread_ts: "100.200",
			initialComment: "Requested files",
			files: [
				{
					bytes: Buffer.from("first bytes"),
					filename: "first.txt",
					title: "First report",
				},
				{
					bytes: Buffer.from("second bytes"),
					filename: "second.txt",
					title: "second.txt",
				},
			],
		});
	});

	it.each([
		["empty", () => []],
		[
			"over 20",
			() =>
				Array.from({ length: 21 }, (_, index) => ({
					filePath: join(workspace, `file-${index}.txt`),
				})),
		],
	])("rejects an %s batch before transport", async (_label, files) => {
		await expect(
			service().upload({ files: files() }, destination()),
		).rejects.toMatchObject({
			code: "INVALID_BATCH",
		});
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects an empty initial comment before transport", async () => {
		const filePath = join(workspace, "report.txt");
		await writeFile(filePath, "report");
		await expect(
			service().upload(
				{ files: [{ filePath }], initialComment: "" },
				destination(),
			),
		).rejects.toMatchObject({ code: "INVALID_BATCH" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it.each([
		["outside path", () => join(root, "outside.txt")],
		["traversal path", () => join(workspace, "..", "outside.txt")],
		["cross-thread path", () => join(otherWorkspace, "secret.txt")],
	])("rejects an %s before transport", async (_label, path) => {
		await writeFile(path(), "private");
		await expect(
			service().upload({ files: [{ filePath: path() }] }, destination()),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects a symlink even when its target is inside the workspace", async () => {
		const target = join(workspace, "target.txt");
		const link = join(workspace, "link.txt");
		await writeFile(target, "inside");
		await symlink(target, link);

		await expect(
			service().upload({ files: [{ filePath: link }] }, destination()),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects a directory before transport", async () => {
		await expect(
			service().upload({ files: [{ filePath: workspace }] }, destination()),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects a missing file before transport", async () => {
		await expect(
			service().upload(
				{ files: [{ filePath: join(workspace, "missing.txt") }] },
				destination(),
			),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects a path through an in-workspace symlinked directory", async () => {
		const realDirectory = join(workspace, "real");
		const linkedDirectory = join(workspace, "linked");
		await mkdir(realDirectory);
		await writeFile(join(realDirectory, "report.txt"), "inside");
		await symlink(realDirectory, linkedDirectory);

		await expect(
			service().upload(
				{ files: [{ filePath: join(linkedDirectory, "report.txt") }] },
				destination(),
			),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("rejects a file larger than 25 MiB before reading or transport", async () => {
		const oversized = join(workspace, "oversized.bin");
		await writeFile(oversized, "");
		await truncate(oversized, 25 * 1024 * 1024 + 1);

		await expect(
			service().upload({ files: [{ filePath: oversized }] }, destination()),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it.each([
		["extension", "recording.mp3", Buffer.from("plain")],
		["magic bytes", "recording.bin", Buffer.from("ID3audio")],
		[
			"detected MIME",
			"recording.bin",
			Buffer.concat([
				Buffer.from("RIFF"),
				Buffer.alloc(4),
				Buffer.from("AVI "),
				Buffer.alloc(20),
			]),
		],
	])("rejects audio/video signaled by %s before transport", async (_label, name, bytes) => {
		const path = join(workspace, name);
		await writeFile(path, bytes);

		await expect(
			service().upload({ files: [{ filePath: path }] }, destination()),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});

	it("validates every file before making any Slack request", async () => {
		const valid = join(workspace, "valid.txt");
		const invalid = join(otherWorkspace, "invalid.txt");
		await writeFile(valid, "valid");
		await writeFile(invalid, "invalid");

		await expect(
			service().upload(
				{ files: [{ filePath: valid }, { filePath: invalid }] },
				destination(),
			),
		).rejects.toMatchObject({ code: "FILE_VALIDATION_FAILED" });
		expect(uploadFilesToThread).not.toHaveBeenCalled();
	});
});
