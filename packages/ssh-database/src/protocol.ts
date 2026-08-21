import { z } from "zod";
import {
	GATEWAY_PROTOCOL_VERSION,
	MAX_GATEWAY_REQUEST_BYTES,
	MAX_GATEWAY_RESPONSE_BYTES,
} from "./constants.js";
import {
	DATABASE_ACCESS_ERROR_CODES,
	DatabaseAccessError,
	outputInvalid,
	queryRejected,
} from "./errors.js";

const EngineSchema = z.enum(["postgres", "mysql"]);
const GatewayLimitsSchema = z.object({
	queryTimeoutMs: z.number().int().min(1).max(60_000),
	maxSqlBytes: z.number().int().min(1).max(65_536),
	maxRows: z.number().int().min(1).max(1_000),
	maxOutputBytes: z.number().int().min(1).max(1_048_576),
});
const RequestSchema = z.object({
	version: z.literal(GATEWAY_PROTOCOL_VERSION),
	profile: z.string().min(1).max(128),
	engine: EngineSchema,
	sql: z.string().min(1),
	limits: GatewayLimitsSchema,
});
const FailureSchema = z.object({
	version: z.literal(GATEWAY_PROTOCOL_VERSION),
	success: z.literal(false),
	error: z.object({
		code: z.enum(DATABASE_ACCESS_ERROR_CODES),
		message: z.string().min(1).max(256),
	}),
});
const SuccessWireSchema = z.object({
	version: z.literal(GATEWAY_PROTOCOL_VERSION),
	success: z.literal(true),
	format: z.enum(["csv", "tsv"]),
	outputBase64: z.string(),
	truncated: z.boolean(),
	rowCount: z.number().int().min(0),
	byteCount: z.number().int().min(0),
});

export type GatewayRequest = z.infer<typeof RequestSchema>;
export type GatewaySuccess = {
	version: typeof GATEWAY_PROTOCOL_VERSION;
	success: true;
	format: "csv" | "tsv";
	output: string;
	truncated: boolean;
	rowCount: number;
	byteCount: number;
};
export type GatewayFailure = z.infer<typeof FailureSchema>;
export type GatewayResponse = GatewaySuccess | GatewayFailure;
export type DecodedGatewayResult = Omit<GatewaySuccess, "version" | "success">;

export function encodeGatewayRequest(request: GatewayRequest): Buffer {
	const parsed = RequestSchema.safeParse(request);
	if (
		!parsed.success ||
		Buffer.byteLength(parsed.data.sql, "utf8") > parsed.data.limits.maxSqlBytes
	) {
		throw queryRejected();
	}
	const frame = Buffer.from(JSON.stringify(parsed.data), "utf8");
	if (frame.byteLength > MAX_GATEWAY_REQUEST_BYTES) throw queryRejected();
	return frame;
}

export function decodeGatewayRequest(
	frame: Uint8Array,
	expected: { expectedProfile: string; expectedEngine: "postgres" | "mysql" },
): GatewayRequest {
	if (frame.byteLength > MAX_GATEWAY_REQUEST_BYTES) throw queryRejected();
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
	} catch {
		throw queryRejected();
	}
	const parsed = RequestSchema.safeParse(value);
	if (!parsed.success) {
		const rawVersion = (value as { version?: unknown } | null)?.version;
		if (rawVersion !== GATEWAY_PROTOCOL_VERSION) {
			throw new DatabaseAccessError(
				"GATEWAY_VERSION_UNSUPPORTED",
				"The database gateway protocol version is unsupported",
			);
		}
		throw queryRejected();
	}
	if (
		parsed.data.profile !== expected.expectedProfile ||
		parsed.data.engine !== expected.expectedEngine
	) {
		throw new DatabaseAccessError(
			"CONNECTION_NOT_ALLOWED",
			"The requested database connection is unavailable",
		);
	}
	if (
		Buffer.byteLength(parsed.data.sql, "utf8") > parsed.data.limits.maxSqlBytes
	) {
		throw queryRejected();
	}
	return parsed.data;
}

export function encodeGatewayResponse(response: GatewayResponse): Buffer {
	const wire = response.success
		? {
				version: response.version,
				success: true as const,
				format: response.format,
				outputBase64: Buffer.from(response.output, "utf8").toString("base64"),
				truncated: response.truncated,
				rowCount: response.rowCount,
				byteCount: response.byteCount,
			}
		: response;
	return Buffer.from(JSON.stringify(wire), "utf8");
}

export function decodeGatewayResponse(
	frame: Uint8Array,
	maxOutputBytes: number,
): DecodedGatewayResult {
	const framedLimit = Math.min(
		MAX_GATEWAY_RESPONSE_BYTES,
		Math.ceil((maxOutputBytes * 4) / 3) + 4_096,
	);
	if (frame.byteLength > framedLimit) throw outputInvalid();
	let value: unknown;
	try {
		value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(frame));
	} catch {
		throw outputInvalid();
	}
	const failure = FailureSchema.safeParse(value);
	if (failure.success) {
		throw new DatabaseAccessError(
			failure.data.error.code,
			failure.data.error.message,
		);
	}
	const success = SuccessWireSchema.safeParse(value);
	if (!success.success || !isCanonicalBase64(success.data.outputBase64)) {
		throw outputInvalid();
	}
	const bytes = Buffer.from(success.data.outputBase64, "base64");
	if (
		bytes.byteLength > maxOutputBytes ||
		bytes.byteLength !== success.data.byteCount
	) {
		throw outputInvalid();
	}
	let output: string;
	try {
		output = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
	} catch {
		throw outputInvalid();
	}
	return {
		format: success.data.format,
		output,
		truncated: success.data.truncated,
		rowCount: success.data.rowCount,
		byteCount: success.data.byteCount,
	};
}

function isCanonicalBase64(value: string): boolean {
	if (
		!/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(
			value,
		)
	) {
		return false;
	}
	return Buffer.from(value, "base64").toString("base64") === value;
}
