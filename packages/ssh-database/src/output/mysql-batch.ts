import { outputInvalid } from "../errors.js";
import type { FramedDatabaseOutput, OutputLimits } from "./types.js";

export async function parseMysqlBatchOutput(
	source: AsyncIterable<Uint8Array>,
	limits: OutputLimits,
): Promise<FramedDatabaseOutput> {
	const lines: Buffer[] = [];
	let current: number[] = [];
	let sawHeader = false;
	let rowCount = 0;
	let retainedBytes = 0;
	let truncated = false;

	for await (const chunk of source) {
		for (const byte of chunk) {
			if (byte === 0) throw outputInvalid();
			current.push(byte);
			if (current.length > limits.maxOutputBytes) {
				if (!sawHeader) throw outputInvalid();
				truncated = true;
				return finish();
			}
			if (byte !== 0x0a) continue;
			const line = Buffer.from(current);
			assertMysqlLine(line);
			if (!sawHeader) {
				if (line.byteLength > limits.maxOutputBytes) throw outputInvalid();
				lines.push(line);
				retainedBytes += line.byteLength;
				sawHeader = true;
			} else if (
				rowCount >= limits.maxRows ||
				retainedBytes + line.byteLength > limits.maxOutputBytes
			) {
				truncated = true;
				return finish();
			} else {
				lines.push(line);
				retainedBytes += line.byteLength;
				rowCount++;
			}
			current = [];
		}
	}

	if (current.length > 0 || !sawHeader) throw outputInvalid();
	return finish();

	function finish(): FramedDatabaseOutput {
		const bytes = Buffer.concat(lines);
		return {
			output: decodeUtf8(bytes),
			rowCount,
			byteCount: bytes.byteLength,
			truncated,
		};
	}
}

function assertMysqlLine(line: Buffer): void {
	const text = decodeUtf8(line);
	for (let index = 0; index < text.length; index++) {
		if (text[index] !== "\\") continue;
		const escaped = text[++index];
		if (!escaped || !["0", "N", "Z", "n", "r", "t", "\\"].includes(escaped)) {
			throw outputInvalid();
		}
	}
}

function decodeUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw outputInvalid();
	}
}
