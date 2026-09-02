import { constants } from "node:fs";
import { type FileHandle, lstat, open, realpath } from "node:fs/promises";
import { basename, isAbsolute, relative, resolve, sep } from "node:path";
import type {
	SlackMessageService,
	SlackUploadedFile,
} from "cyrus-slack-event-transport";
import { classifySlackFile, MAX_OTHER_FILE_BYTES } from "./SlackFilePolicy.js";

export interface SlackFileUploadInput {
	files: Array<{ filePath: string; title?: string }>;
	initialComment?: string;
}

export interface VerifiedSlackFileUploadDestination {
	token: string;
	channelId: string;
	threadTs: string;
	workspacePath: string;
}

export class SlackFileUploadError extends Error {
	constructor(
		public readonly code:
			| "INVALID_BATCH"
			| "FILE_VALIDATION_FAILED"
			| "UPLOAD_FAILED",
		message: string,
	) {
		super(message);
		this.name = "SlackFileUploadError";
	}
}

type SlackUploadTransport = Pick<SlackMessageService, "uploadFilesToThread">;

function contained(root: string, candidate: string): boolean {
	const pathFromRoot = relative(root, candidate);
	return (
		pathFromRoot === "" ||
		(!pathFromRoot.startsWith(`..${sep}`) &&
			pathFromRoot !== ".." &&
			!isAbsolute(pathFromRoot))
	);
}

function sameFile(
	left: { dev: number | bigint; ino: number | bigint },
	right: { dev: number | bigint; ino: number | bigint },
): boolean {
	return left.dev === right.dev && left.ino === right.ino;
}

async function readBounded(handle: FileHandle): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let total = 0;
	while (total <= MAX_OTHER_FILE_BYTES) {
		const buffer = Buffer.allocUnsafe(
			Math.min(64 * 1024, MAX_OTHER_FILE_BYTES + 1 - total),
		);
		const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
		if (bytesRead === 0) break;
		total += bytesRead;
		if (total > MAX_OTHER_FILE_BYTES) throw new Error("file grew too large");
		chunks.push(buffer.subarray(0, bytesRead));
	}
	return Buffer.concat(chunks, total);
}

/** Validates model-selected files before handing any bytes to Slack transport. */
export class SlackFileUploadService {
	constructor(private readonly transport: SlackUploadTransport) {}

	async upload(
		input: SlackFileUploadInput,
		destination: VerifiedSlackFileUploadDestination,
	): Promise<{ files: SlackUploadedFile[] }> {
		if (
			input.files.length < 1 ||
			input.files.length > 20 ||
			(input.initialComment !== undefined &&
				(typeof input.initialComment !== "string" ||
					input.initialComment.length === 0))
		) {
			throw new SlackFileUploadError(
				"INVALID_BATCH",
				"Upload between 1 and 20 files",
			);
		}

		const workspaceInput = resolve(destination.workspacePath);
		let workspace: string;
		try {
			const workspaceInfo = await lstat(workspaceInput);
			if (workspaceInfo.isSymbolicLink() || !workspaceInfo.isDirectory())
				throw new Error("invalid workspace");
			workspace = await realpath(workspaceInput);
		} catch {
			throw new SlackFileUploadError(
				"FILE_VALIDATION_FAILED",
				"The upload workspace is unavailable",
			);
		}

		const files = [];
		for (const requested of input.files) {
			if (
				typeof requested.filePath !== "string" ||
				requested.filePath.length === 0 ||
				(requested.title !== undefined &&
					(typeof requested.title !== "string" || requested.title.length === 0))
			) {
				throw new SlackFileUploadError(
					"FILE_VALIDATION_FAILED",
					"One or more files failed upload validation",
				);
			}

			const inputPath = resolve(workspaceInput, requested.filePath);
			const lexicalPath = contained(workspaceInput, inputPath)
				? resolve(workspace, relative(workspaceInput, inputPath))
				: inputPath;
			if (!contained(workspace, lexicalPath)) {
				throw new SlackFileUploadError(
					"FILE_VALIDATION_FAILED",
					"One or more files failed upload validation",
				);
			}

			try {
				const segments = relative(workspace, lexicalPath)
					.split(sep)
					.filter(Boolean);
				let current = workspace;
				for (const segment of segments) {
					current = resolve(current, segment);
					if ((await lstat(current)).isSymbolicLink())
						throw new Error("symlink");
				}
				const info = await lstat(lexicalPath);
				if (!info.isFile() || info.size > MAX_OTHER_FILE_BYTES)
					throw new Error("invalid file");

				const canonicalPath = await realpath(lexicalPath);
				if (!contained(workspace, canonicalPath)) throw new Error("outside");
				const canonicalInfo = await lstat(canonicalPath);
				if (!canonicalInfo.isFile() || !sameFile(info, canonicalInfo))
					throw new Error("file identity changed");

				// Node has no openat-style API. O_NOFOLLOW closes the leaf race; the
				// descriptor identity check below closes intermediate-component races.
				// Platforms without O_NOFOLLOW fail closed instead of reopening a path.
				if (
					!Number.isInteger(constants.O_NOFOLLOW) ||
					constants.O_NOFOLLOW <= 0
				)
					throw new Error("secure file open unavailable");
				let handle: FileHandle | undefined;
				let bytes: Buffer;
				try {
					handle = await open(
						canonicalPath,
						constants.O_RDONLY | constants.O_NOFOLLOW,
					);
					const openedInfo = await handle.stat();
					if (
						!openedInfo.isFile() ||
						openedInfo.size > MAX_OTHER_FILE_BYTES ||
						!sameFile(canonicalInfo, openedInfo)
					)
						throw new Error("opened file failed validation");
					bytes = await readBounded(handle);
				} finally {
					await handle?.close();
				}
				const filename = basename(canonicalPath);
				const classification = await classifySlackFile({
					name: filename,
					bytes,
				});
				if (!classification.allowed) throw new Error("media");
				files.push({
					bytes,
					filename,
					title: requested.title ?? filename,
				});
			} catch {
				throw new SlackFileUploadError(
					"FILE_VALIDATION_FAILED",
					"One or more files failed upload validation",
				);
			}
		}

		try {
			return {
				files: await this.transport.uploadFilesToThread({
					token: destination.token,
					channel_id: destination.channelId,
					thread_ts: destination.threadTs,
					files,
					...(input.initialComment !== undefined && {
						initialComment: input.initialComment,
					}),
				}),
			};
		} catch {
			throw new SlackFileUploadError(
				"UPLOAD_FAILED",
				"The Slack file upload could not be completed",
			);
		}
	}
}
