import { describe, expect, it } from "vitest";
import { parseMysqlBatchOutput, parsePostgresCsvOutput } from "../src/index.js";

async function* chunks(...values: Array<string | Uint8Array>) {
	for (const value of values) {
		yield typeof value === "string" ? Buffer.from(value) : value;
	}
}

describe("native client output framing", () => {
	it("preserves complete multiline RFC 4180 records across chunks", async () => {
		const result = await parsePostgresCsvOutput(
			chunks('id,notes\r\n1,"hello', '\r\nworld"\r\n2,"a ""quote"""\r\n'),
			{ maxRows: 2, maxOutputBytes: 1024 },
		);
		expect(result).toEqual({
			output: 'id,notes\r\n1,"hello\r\nworld"\r\n2,"a ""quote"""\r\n',
			rowCount: 2,
			byteCount: 45,
			truncated: false,
		});
	});

	it("uses the extra complete PostgreSQL row only to mark truncation", async () => {
		const result = await parsePostgresCsvOutput(chunks("id\n1\n2\n3\n"), {
			maxRows: 2,
			maxOutputBytes: 1024,
		});
		expect(result).toEqual({
			output: "id\n1\n2\n",
			rowCount: 2,
			byteCount: 7,
			truncated: true,
		});
	});

	it("retains only complete PostgreSQL rows within the byte limit", async () => {
		const result = await parsePostgresCsvOutput(
			chunks("id,name\n1,Ada\n2,Grace Hopper\n"),
			{ maxRows: 10, maxOutputBytes: 17 },
		);
		expect(result).toEqual({
			output: "id,name\n1,Ada\n",
			rowCount: 1,
			byteCount: 14,
			truncated: true,
		});
	});

	it("preserves MySQL batch escapes and NULL across chunks", async () => {
		const result = await parseMysqlBatchOutput(
			chunks("id\tnote\n1\thello\\t", "world\n2\t\\N\n"),
			{ maxRows: 2, maxOutputBytes: 1024 },
		);
		expect(result).toEqual({
			output: "id\tnote\n1\thello\\tworld\n2\t\\N\n",
			rowCount: 2,
			byteCount: 28,
			truncated: false,
		});
	});

	it("bounds an in-progress record instead of buffering it indefinitely", async () => {
		await expect(
			parsePostgresCsvOutput(chunks(`id,note\n1,${"x".repeat(100)}`), {
				maxRows: 10,
				maxOutputBytes: 16,
			}),
		).resolves.toEqual({
			output: "id,note\n",
			rowCount: 0,
			byteCount: 8,
			truncated: true,
		});
	});

	it("rejects malformed CSV, incomplete headers, binary, and invalid UTF-8", async () => {
		await expect(
			parsePostgresCsvOutput(chunks('id,note\n1,"unterminated'), {
				maxRows: 10,
				maxOutputBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
		await expect(
			parsePostgresCsvOutput(chunks("x".repeat(20)), {
				maxRows: 10,
				maxOutputBytes: 8,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
		await expect(
			parseMysqlBatchOutput(chunks(new Uint8Array([0x69, 0x64, 0x0a, 0x00])), {
				maxRows: 10,
				maxOutputBytes: 1024,
			}),
		).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
		await expect(
			parseMysqlBatchOutput(
				chunks(new Uint8Array([0x69, 0x64, 0x0a, 0xc3, 0x28])),
				{
					maxRows: 10,
					maxOutputBytes: 1024,
				},
			),
		).rejects.toMatchObject({ code: "OUTPUT_INVALID" });
	});
});
