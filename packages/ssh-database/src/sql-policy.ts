import parserPackage from "node-sql-parser";
import {
	assertNoClientCommands,
	type DatabaseEngine,
	visibleSql,
} from "./client-command-scanner.js";
import {
	MAX_SQL_AST_DEPTH,
	MAX_SQL_CTES,
	MAX_SQL_PROJECTED_COLUMNS,
	MAX_SQL_TOKENS,
} from "./constants.js";
import { queryRejected } from "./errors.js";

const { Parser } = parserPackage;
const parser = new Parser();

const ALLOWED_FUNCTIONS: Record<DatabaseEngine, ReadonlySet<string>> = {
	postgres: new Set([
		"abs",
		"array_agg",
		"avg",
		"ceil",
		"ceiling",
		"char_length",
		"coalesce",
		"count",
		"current_database",
		"current_schema",
		"current_user",
		"date_trunc",
		"extract",
		"floor",
		"json_agg",
		"jsonb_agg",
		"length",
		"lower",
		"max",
		"min",
		"now",
		"nullif",
		"pg_typeof",
		"round",
		"string_agg",
		"sum",
		"to_char",
		"upper",
	]),
	mysql: new Set([
		"abs",
		"avg",
		"ceil",
		"ceiling",
		"char_length",
		"coalesce",
		"count",
		"current_user",
		"database",
		"floor",
		"ifnull",
		"json_arrayagg",
		"length",
		"lower",
		"max",
		"min",
		"nullif",
		"round",
		"schema",
		"sum",
		"upper",
	]),
};

export interface ValidateSqlInput {
	engine: DatabaseEngine;
	sql: string;
	maxSqlBytes: number;
	maxRows: number;
}

export interface ValidatedSql {
	normalizedSql: string;
	boundedSql: string;
}

export function validateAndBoundSql(input: ValidateSqlInput): ValidatedSql {
	if (
		Buffer.byteLength(input.sql, "utf8") > input.maxSqlBytes ||
		input.maxRows < 1 ||
		input.maxRows > 1_000
	) {
		throw queryRejected();
	}
	assertNoClientCommands(input.engine, input.sql);
	const visible = visibleSql(input.sql, input.engine);
	const tokens =
		visible.match(
			/[A-Za-z_][A-Za-z0-9_$]*|\d+(?:\.\d+)?|<>|!=|<=|>=|::|[-+*/%=<>(){},.;]/g,
		) ?? [];
	if (tokens.length > MAX_SQL_TOKENS) throw queryRejected();

	let ast: unknown;
	try {
		ast = parser.astify(input.sql, {
			database: input.engine === "postgres" ? "Postgresql" : "MySQL",
		});
	} catch {
		throw queryRejected();
	}
	if (Array.isArray(ast) || !isRecord(ast) || ast.type !== "select") {
		throw queryRejected();
	}

	const counters = { ctes: 0 };
	inspectNode(ast, input.engine, 1, counters);
	if (counters.ctes > MAX_SQL_CTES) throw queryRejected();

	const normalizedSql = input.sql.trim().replace(/;\s*$/, "");
	return {
		normalizedSql,
		boundedSql: `SELECT * FROM (${normalizedSql}) AS cyrus_bounded LIMIT ${input.maxRows + 1}`,
	};
}

function inspectNode(
	node: unknown,
	engine: DatabaseEngine,
	depth: number,
	counters: { ctes: number },
): void {
	if (depth > MAX_SQL_AST_DEPTH) throw queryRejected();
	if (Array.isArray(node)) {
		for (const value of node) inspectNode(value, engine, depth + 1, counters);
		return;
	}
	if (!isRecord(node)) return;

	if (typeof node.type === "string") {
		const type = node.type.toLowerCase();
		if (
			[
				"insert",
				"update",
				"delete",
				"replace",
				"create",
				"drop",
				"alter",
				"truncate",
				"grant",
				"revoke",
				"transaction",
				"call",
				"procedure",
			].includes(type)
		) {
			throw queryRejected();
		}
		if (type === "select") inspectSelect(node);
		if (type === "function" || type === "aggr_func") {
			const functionName = readFunctionName(node);
			if (!functionName || !ALLOWED_FUNCTIONS[engine].has(functionName)) {
				throw queryRejected();
			}
		}
	}

	if (Array.isArray(node.with)) counters.ctes += node.with.length;
	for (const value of Object.values(node)) {
		inspectNode(value, engine, depth + 1, counters);
	}
}

function inspectSelect(node: Record<string, unknown>): void {
	const columns = node.columns;
	if (Array.isArray(columns) && columns.length > MAX_SQL_PROJECTED_COLUMNS) {
		throw queryRejected();
	}
	const into = node.into;
	if (isRecord(into) && into.position != null) throw queryRejected();
	if (
		node.locking_read != null ||
		node.for_update != null ||
		node.lock != null
	) {
		throw queryRejected();
	}
}

function readFunctionName(node: Record<string, unknown>): string | undefined {
	if (typeof node.name === "string") return node.name.toLowerCase();
	if (!isRecord(node.name) || !Array.isArray(node.name.name)) return undefined;
	const parts = node.name.name
		.map((part) =>
			isRecord(part) && typeof part.value === "string" ? part.value : undefined,
		)
		.filter((part): part is string => Boolean(part));
	return parts.length > 0 ? parts.join(".").toLowerCase() : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null;
}
