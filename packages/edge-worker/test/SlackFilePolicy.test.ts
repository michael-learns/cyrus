import { describe, expect, it } from "vitest";
import {
	classifySlackFile,
	MAX_EMBEDDED_IMAGE_BYTES,
	MAX_OTHER_FILE_BYTES,
	MAX_RECEIVED_DOWNLOAD_BYTES,
	MAX_SLACK_CAPTURE_FILES,
	SLACK_DOWNLOAD_TIMEOUT_MS,
} from "../src/SlackFilePolicy.js";

const PNG = Buffer.from([
	0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49,
	0x48, 0x44, 0x52,
]);
const MP3 = Buffer.from([0x49, 0x44, 0x33, 0x04, 0x00, 0x00, 0x00, 0x00]);

describe("SlackFilePolicy", () => {
	it("rejects media signalled only by each independent policy input", async () => {
		const cases = [
			{
				label: "declared MIME",
				declaredMime: "audio/mpeg",
				responseMime: "application/pdf",
				name: "report.pdf",
				bytes: Buffer.from("%PDF-1.7"),
				expected: "media_type",
			},
			{
				label: "response MIME",
				declaredMime: "application/pdf",
				responseMime: "video/mp4",
				name: "report.pdf",
				bytes: Buffer.from("%PDF-1.7"),
				expected: "media_type",
			},
			{
				label: "known extension",
				declaredMime: "application/octet-stream",
				responseMime: "application/octet-stream",
				name: "voice.ogg",
				bytes: Buffer.from("data"),
				expected: "media_type",
			},
			{
				label: "detected bytes",
				declaredMime: "application/octet-stream",
				responseMime: "application/octet-stream",
				name: "payload.bin",
				bytes: MP3,
				expected: "media_type",
			},
		] as const;
		for (const testCase of cases) {
			const result = await classifySlackFile(testCase);
			expect(result, testCase.label).toMatchObject({
				allowed: false,
				reason: testCase.expected,
			});
		}
	});

	it("does not reject ordinary documents or unknown binaries as media", async () => {
		for (const testCase of [
			{
				declaredMime: "application/pdf",
				responseMime: "application/pdf",
				name: "report.pdf",
				bytes: Buffer.from("%PDF-1.7"),
			},
			{
				declaredMime: "text/plain",
				responseMime: "text/plain",
				name: "notes.txt",
				bytes: Buffer.from("hello"),
			},
			{
				declaredMime: "application/octet-stream",
				responseMime: "application/octet-stream",
				name: "payload.bin",
				bytes: Buffer.from([0xde, 0xad, 0xbe, 0xef]),
			},
		]) {
			expect(await classifySlackFile(testCase)).toMatchObject({
				allowed: true,
				isImage: false,
			});
		}
	});

	it("identifies a supported image from its actual bytes", async () => {
		expect(
			await classifySlackFile({
				declaredMime: "image/png",
				responseMime: "image/png",
				name: "diagram.png",
				bytes: PNG,
			}),
		).toEqual({
			allowed: true,
			isImage: true,
			extension: "png",
			detectedMime: "image/png",
		});
	});

	it("publishes the hand-derived capture limits shared by capture and upload", () => {
		expect({
			MAX_SLACK_CAPTURE_FILES,
			MAX_EMBEDDED_IMAGE_BYTES,
			MAX_OTHER_FILE_BYTES,
			MAX_RECEIVED_DOWNLOAD_BYTES,
			SLACK_DOWNLOAD_TIMEOUT_MS,
		}).toEqual({
			MAX_SLACK_CAPTURE_FILES: 20,
			MAX_EMBEDDED_IMAGE_BYTES: 10 * 1024 * 1024,
			MAX_OTHER_FILE_BYTES: 25 * 1024 * 1024,
			MAX_RECEIVED_DOWNLOAD_BYTES: 100 * 1024 * 1024,
			SLACK_DOWNLOAD_TIMEOUT_MS: 15_000,
		});
	});
});
