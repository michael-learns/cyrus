import { fileTypeFromBuffer } from "file-type";

export const MAX_SLACK_CAPTURE_FILES = 20;
export const MAX_EMBEDDED_IMAGE_BYTES = 10 * 1024 * 1024;
export const MAX_OTHER_FILE_BYTES = 25 * 1024 * 1024;
export const MAX_RECEIVED_DOWNLOAD_BYTES = 100 * 1024 * 1024;
export const SLACK_DOWNLOAD_TIMEOUT_MS = 15_000;

export const SUPPORTED_SLACK_IMAGES = new Map([
	["image/jpeg", "jpg"],
	["image/png", "png"],
	["image/gif", "gif"],
	["image/webp", "webp"],
]);

const MEDIA_EXTENSIONS = new Set([
	"aac",
	"avi",
	"flac",
	"m4a",
	"mkv",
	"mov",
	"mp3",
	"mp4",
	"mpeg",
	"mpg",
	"ogg",
	"oga",
	"ogv",
	"opus",
	"wav",
	"webm",
	"wmv",
]);

function mediaMime(value: string | undefined): boolean {
	const mime = value?.split(";", 1)[0]?.trim().toLowerCase();
	return (
		mime?.startsWith("audio/") === true || mime?.startsWith("video/") === true
	);
}

function extension(name: string): string | undefined {
	const value = name
		.trim()
		.toLowerCase()
		.match(/\.([a-z0-9]{1,16})$/)?.[1];
	return value;
}

function mediaMagic(bytes: Buffer): boolean {
	return (
		bytes.subarray(0, 3).equals(Buffer.from("ID3")) ||
		(bytes[0] === 0xff && ((bytes[1] ?? 0) & 0xe0) === 0xe0) ||
		(bytes.subarray(0, 4).equals(Buffer.from("RIFF")) &&
			bytes.subarray(8, 12).equals(Buffer.from("WAVE"))) ||
		bytes.subarray(0, 4).equals(Buffer.from("OggS")) ||
		bytes.subarray(4, 8).equals(Buffer.from("ftyp"))
	);
}

export function hasSlackMediaSignal(input: {
	declaredMime?: string;
	responseMime?: string;
	name: string;
	detectedMime?: string;
	bytes?: Buffer;
}): boolean {
	return (
		mediaMime(input.declaredMime) ||
		mediaMime(input.responseMime) ||
		mediaMime(input.detectedMime) ||
		MEDIA_EXTENSIONS.has(extension(input.name) ?? "") ||
		(input.bytes !== undefined && mediaMagic(input.bytes))
	);
}

export async function classifySlackFile(input: {
	declaredMime?: string;
	responseMime?: string;
	name: string;
	bytes: Buffer;
}): Promise<{
	allowed: boolean;
	reason?: "media_type";
	isImage: boolean;
	extension: string;
	detectedMime?: string;
}> {
	const detected = await fileTypeFromBuffer(input.bytes);
	const detectedMime = detected?.mime;
	if (hasSlackMediaSignal({ ...input, detectedMime }))
		return {
			allowed: false,
			reason: "media_type",
			isImage: false,
			extension: extension(input.name) ?? detected?.ext ?? "bin",
			...(detectedMime && { detectedMime }),
		};
	const imageMime = detectedMime ?? input.declaredMime?.toLowerCase();
	const imageExtension = imageMime && SUPPORTED_SLACK_IMAGES.get(imageMime);
	return {
		allowed: true,
		isImage: Boolean(imageExtension),
		extension:
			imageExtension ?? extension(input.name) ?? detected?.ext ?? "bin",
		...(detectedMime && { detectedMime }),
	};
}
