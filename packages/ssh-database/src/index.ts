export {
	assertNoClientCommands,
	type DatabaseEngine,
} from "./client-command-scanner.js";
export {
	GATEWAY_PROTOCOL_VERSION,
	MAX_GATEWAY_REQUEST_BYTES,
	MAX_GATEWAY_RESPONSE_BYTES,
	MAX_SQL_AST_DEPTH,
	MAX_SQL_CTES,
	MAX_SQL_PROJECTED_COLUMNS,
	MAX_SQL_TOKENS,
} from "./constants.js";
export {
	DATABASE_ACCESS_ERROR_CODES,
	DatabaseAccessError,
	type DatabaseAccessErrorCode,
} from "./errors.js";
export {
	buildNativeClientInvocation,
	type NativeClientInput,
	type NativeClientInvocation,
} from "./native-client.js";
export { parseMysqlBatchOutput } from "./output/mysql-batch.js";
export { parsePostgresCsvOutput } from "./output/postgres-csv.js";
export type {
	FramedDatabaseOutput,
	OutputLimits,
} from "./output/types.js";
export {
	assertMysqlPrivilegePreflight,
	assertPostgresPrivilegePreflight,
	type MysqlPrivilegePreflight,
	POSTGRES_PRIVILEGE_PREFLIGHT_SQL,
	type PostgresPrivilegePreflight,
} from "./privilege-preflight.js";
export {
	type DecodedGatewayResult,
	decodeGatewayRequest,
	decodeGatewayResponse,
	encodeGatewayResponse,
	type GatewayFailure,
	type GatewayRequest,
	type GatewayResponse,
	type GatewaySuccess,
} from "./protocol.js";
export {
	type ValidatedSql,
	type ValidateSqlInput,
	validateAndBoundSql,
} from "./sql-policy.js";
