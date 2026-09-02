import { lstat, readFile, realpath } from "node:fs/promises";
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

				const bytes = await readFile(canonicalPath);
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
