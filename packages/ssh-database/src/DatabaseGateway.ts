import { GATEWAY_PROTOCOL_VERSION } from "./constants.js";
import { DatabaseAccessError } from "./errors.js";
import type { GatewayProfile } from "./gateway-profile.js";
import type { FramedDatabaseOutput } from "./output/types.js";
import { decodeGatewayRequest, encodeGatewayResponse } from "./protocol.js";
import { type ValidatedSql, validateAndBoundSql } from "./sql-policy.js";

export interface DatabaseGatewayExecutor {
	preflight(profile: GatewayProfile, signal?: AbortSignal): Promise<void>;
	query(
		profile: GatewayProfile,
		query: ValidatedSql & {
			queryTimeoutMs: number;
			maxRows: number;
			maxOutputBytes: number;
		},
		signal?: AbortSignal,
	): Promise<FramedDatabaseOutput>;
}

export class DatabaseGateway {
	constructor(
		private readonly profile: GatewayProfile,
		private readonly executor: DatabaseGatewayExecutor,
	) {}

	async handle(frame: Uint8Array, signal?: AbortSignal): Promise<Buffer> {
		try {
			const request = decodeGatewayRequest(frame, {
				expectedProfile: this.profile.id,
				expectedEngine: this.profile.engine,
			});
			const limits = {
				queryTimeoutMs: Math.min(
					request.limits.queryTimeoutMs,
					this.profile.limits.queryTimeoutMs,
				),
				maxSqlBytes: Math.min(
					request.limits.maxSqlBytes,
					this.profile.limits.maxSqlBytes,
				),
				maxRows: Math.min(request.limits.maxRows, this.profile.limits.maxRows),
				maxOutputBytes: Math.min(
					request.limits.maxOutputBytes,
					this.profile.limits.maxOutputBytes,
				),
			};
			const validated = validateAndBoundSql({
				engine: this.profile.engine,
				sql: request.sql,
				maxSqlBytes: limits.maxSqlBytes,
				maxRows: limits.maxRows,
			});
			await this.executor.preflight(this.profile, signal);
			const result = await this.executor.query(
				this.profile,
				{ ...validated, ...limits },
				signal,
			);
			return encodeGatewayResponse({
				version: GATEWAY_PROTOCOL_VERSION,
				success: true,
				format: this.profile.engine === "postgres" ? "csv" : "tsv",
				...result,
			});
		} catch (error) {
			const safe =
				error instanceof DatabaseAccessError
					? error
					: new DatabaseAccessError(
							"QUERY_FAILED",
							"The database query could not be completed",
						);
			return encodeGatewayResponse({
				version: GATEWAY_PROTOCOL_VERSION,
				success: false,
				error: { code: safe.code, message: safe.message },
			});
		}
	}
}
