import { outputInvalid } from "../errors.js";
import type { FramedDatabaseOutput, OutputLimits } from "./types.js";

export async function parsePostgresCsvOutput(
	source: AsyncIterable<Uint8Array>,
	limits: OutputLimits,
): Promise<FramedDatabaseOutput> {
	const records: Buffer[] = [];
	let current: number[] = [];
	let inQuotes = false;
	let afterQuote = false;
	let atFieldStart = true;
	let rowCount = 0;
	let retainedBytes = 0;
	let sawHeader = false;
	let truncated = false;

	const retainRecord = (record: Buffer): boolean => {
		assertUtf8(record);
		if (!sawHeader) {
			if (record.byteLength > limits.maxOutputBytes) throw outputInvalid();
			records.push(record);
			retainedBytes += record.byteLength;
			sawHeader = true;
			return true;
		}
		if (
			rowCount >= limits.maxRows ||
			retainedBytes + record.byteLength > limits.maxOutputBytes
		) {
			truncated = true;
			return false;
		}
		records.push(record);
		retainedBytes += record.byteLength;
		rowCount++;
		return true;
	};

	for await (const chunk of source) {
		for (const byte of chunk) {
			if (byte === 0) throw outputInvalid();
			current.push(byte);
			if (current.length > limits.maxOutputBytes) {
				if (!sawHeader) throw outputInvalid();
				truncated = true;
				return finish();
			}

			if (inQuotes) {
				if (afterQuote) {
					if (byte === 0x22) {
						afterQuote = false;
						continue;
					}
					inQuotes = false;
					afterQuote = false;
					if (byte === 0x2c) {
						atFieldStart = true;
						continue;
					}
					if (byte !== 0x0a && byte !== 0x0d) throw outputInvalid();
				} else if (byte === 0x22) {
					afterQuote = true;
					continue;
				} else {
					continue;
				}
			}

			if (!inQuotes && byte === 0x22) {
				if (!atFieldStart) throw outputInvalid();
				inQuotes = true;
				atFieldStart = false;
				continue;
			}
			if (!inQuotes && byte === 0x2c) {
				atFieldStart = true;
				continue;
			}
			if (!inQuotes && byte === 0x0a) {
				if (!retainRecord(Buffer.from(current))) return finish();
				current = [];
				atFieldStart = true;
				continue;
			}
			if (!inQuotes && byte !== 0x0d) atFieldStart = false;
		}
	}

	if (inQuotes && !afterQuote) throw outputInvalid();
	if (current.length > 0 || !sawHeader) throw outputInvalid();
	return finish();

	function finish(): FramedDatabaseOutput {
		const outputBytes = Buffer.concat(records);
		return {
			output: assertUtf8(outputBytes),
			rowCount,
			byteCount: outputBytes.byteLength,
			truncated,
		};
	}
}

function assertUtf8(bytes: Uint8Array): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw outputInvalid();
	}
}
