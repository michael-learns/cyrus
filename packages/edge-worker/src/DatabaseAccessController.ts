import type { RepositoryConfig, SshDatabaseConnection } from "cyrus-core";
import {
	DatabaseAccessError,
	type SshDatabaseQueryResult,
} from "cyrus-ssh-database";
import type { DatabaseAuthorizationContext } from "./DatabaseAuthorizationContextService.js";

export interface DatabaseAccessControllerDependencies {
	getConnections: () => readonly SshDatabaseConnection[];
	getRepositories: () => readonly RepositoryConfig[];
	resolveAuthorizationContext: (
		capabilityId: string,
		parentSessionId: string,
	) => DatabaseAuthorizationContext | undefined;
	queryService: {
		query: (
			connection: SshDatabaseConnection,
			sql: string,
			signal?: AbortSignal,
		) => Promise<SshDatabaseQueryResult>;
	};
	audit?: (event: string, fields: Record<string, unknown>) => void;
	now?: () => number;
}

export interface DatabaseConnectionListResult {
	connections: Array<{
		id: string;
		name: string;
		engine: "postgres" | "mysql";
		repositories: Array<{ id: string; name: string }>;
	}>;
}

export type AuthorizedDatabaseQueryResult = SshDatabaseQueryResult & {
	connectionName: string;
	untrusted: true;
};

export class DatabaseAccessController {
	private readonly now: () => number;

	constructor(private readonly deps: DatabaseAccessControllerDependencies) {
		this.now = deps.now ?? Date.now;
	}

	async connectionsList(
		capabilityId: string,
		parentSessionId: string,
	): Promise<DatabaseConnectionListResult> {
		const context = this.requireContext(capabilityId, parentSessionId);
		const { connections, activeRepositories } =
			this.authorizedConnections(context);
		this.audit("database_connections_list", context, {
			success: true,
			connectionCount: connections.length,
		});
		return {
			connections: connections.map((connection) => ({
				id: connection.id,
				name: connection.name,
				engine: connection.engine,
				repositories: connection.repositoryIds.flatMap((repositoryId) => {
					const repository = activeRepositories.get(repositoryId);
					return repository
						? [{ id: repository.id, name: repository.name }]
						: [];
				}),
			})),
		};
	}

	async query(
		capabilityId: string,
		parentSessionId: string,
		input: { connectionId: string; sql: string },
		signal?: AbortSignal,
	): Promise<AuthorizedDatabaseQueryResult> {
		const startedAt = this.now();
		let context: DatabaseAuthorizationContext | undefined;
		let connection: SshDatabaseConnection | undefined;
		try {
			context = this.requireContext(capabilityId, parentSessionId);
			connection = this.authorizedConnections(context).connections.find(
				(candidate) => candidate.id === input.connectionId,
			);
			if (!connection) throw unavailable();
			const result = await this.deps.queryService.query(
				connection,
				input.sql,
				signal,
			);
			this.audit("database_query", context, {
				connectionId: connection.id,
				engine: connection.engine,
				durationMs: Math.max(0, this.now() - startedAt),
				rowCount: result.rowCount,
				byteCount: result.byteCount,
				truncated: result.truncated,
				success: true,
			});
			return {
				...result,
				connectionName: connection.name,
				untrusted: true,
			};
		} catch (error) {
			if (context) {
				this.audit("database_query", context, {
					...(connection
						? { connectionId: connection.id, engine: connection.engine }
						: {}),
					durationMs: Math.max(0, this.now() - startedAt),
					success: false,
					errorCode:
						error instanceof DatabaseAccessError ? error.code : "QUERY_FAILED",
				});
			}
			throw error instanceof DatabaseAccessError
				? error
				: new DatabaseAccessError(
						"QUERY_FAILED",
						"The database request could not be completed",
					);
		}
	}

	private requireContext(
		capabilityId: string,
		parentSessionId: string,
	): DatabaseAuthorizationContext {
		const context = this.deps.resolveAuthorizationContext(
			capabilityId,
			parentSessionId,
		);
		if (!context) throw unavailable();
		return context;
	}

	private authorizedConnections(context: DatabaseAuthorizationContext): {
		connections: SshDatabaseConnection[];
		activeRepositories: Map<string, RepositoryConfig>;
	} {
		const activeRepositories = new Map(
			this.deps
				.getRepositories()
				.filter((repository) => repository.isActive !== false)
				.map((repository) => [repository.id, repository]),
		);
		const authorizedRepositoryIds = new Set(
			context.repositoryIds.filter((repositoryId) =>
				activeRepositories.has(repositoryId),
			),
		);
		const connections = this.deps
			.getConnections()
			.filter(
				(connection) =>
					connection.slackDestinations.some(
						(destination) =>
							destination.teamId === context.teamId &&
							destination.channelId === context.channelId,
					) &&
					connection.repositoryIds.some((repositoryId) =>
						authorizedRepositoryIds.has(repositoryId),
					),
			);
		return { connections, activeRepositories };
	}

	private audit(
		event: string,
		context: DatabaseAuthorizationContext,
		fields: Record<string, unknown>,
	): void {
		this.deps.audit?.(event, {
			teamId: context.teamId,
			channelId: context.channelId,
			userId: context.userId,
			repositoryIds: [...context.repositoryIds],
			parentSessionId: context.parentSessionId,
			...(context.workItemId ? { workItemId: context.workItemId } : {}),
			...fields,
		});
	}
}

function unavailable(): DatabaseAccessError {
	return new DatabaseAccessError(
		"CONNECTION_NOT_ALLOWED",
		"The database connection is unavailable",
	);
}
