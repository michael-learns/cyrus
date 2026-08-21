export const DATABASE_ACCESS_ERROR_CODES = [
	"CONNECTION_NOT_ALLOWED",
	"CONNECTION_NOT_FOUND",
	"QUERY_REJECTED",
	"SSH_UNAVAILABLE",
	"HOST_KEY_FAILED",
	"AUTHENTICATION_FAILED",
	"CONNECTION_TIMEOUT",
	"QUERY_TIMEOUT",
	"GATEWAY_UNAVAILABLE",
	"GATEWAY_VERSION_UNSUPPORTED",
	"PRIVILEGE_CHECK_FAILED",
	"REMOTE_CLIENT_MISSING",
	"OUTPUT_INVALID",
	"REQUEST_CANCELLED",
	"QUERY_FAILED",
] as const;

export type DatabaseAccessErrorCode =
	(typeof DATABASE_ACCESS_ERROR_CODES)[number];

export class DatabaseAccessError extends Error {
	readonly code: DatabaseAccessErrorCode;

	constructor(code: DatabaseAccessErrorCode, message: string) {
		super(message);
		this.name = "DatabaseAccessError";
		this.code = code;
	}
}

export function queryRejected(): DatabaseAccessError {
	return new DatabaseAccessError(
		"QUERY_REJECTED",
		"Only a bounded read-only query is allowed",
	);
}

export function outputInvalid(): DatabaseAccessError {
	return new DatabaseAccessError(
		"OUTPUT_INVALID",
		"The database gateway returned invalid output",
	);
}
