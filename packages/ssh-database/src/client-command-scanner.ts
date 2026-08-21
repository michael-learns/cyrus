import { queryRejected } from "./errors.js";

export type DatabaseEngine = "postgres" | "mysql";

export function assertNoClientCommands(
	engine: DatabaseEngine,
	sql: string,
): void {
	const visible = visibleSql(sql, engine);
	if (engine === "postgres") {
		if (/\\[A-Za-z!]|:\s*$/.test(visible)) throw queryRejected();
		return;
	}

	if (/\/\*[!+]/.test(sql)) throw queryRejected();
	for (const line of visible.split(/\r?\n/)) {
		if (/^\s*(?:system|source|tee|pager|delimiter|charset)\b/i.test(line)) {
			throw queryRejected();
		}
	}
}

export function visibleSql(sql: string, engine: DatabaseEngine): string {
	let result = "";
	for (let index = 0; index < sql.length; ) {
		const character = sql[index] as string;
		const next = sql[index + 1];
		if (character === "-" && next === "-") {
			index += 2;
			while (index < sql.length && sql[index] !== "\n") index++;
			result += "\n";
			continue;
		}
		if (character === "/" && next === "*") {
			const end = sql.indexOf("*/", index + 2);
			if (end < 0) throw queryRejected();
			result += " ".repeat(sql.slice(index, end + 2).length);
			index = end + 2;
			continue;
		}
		if (engine === "postgres" && character === "$") {
			const match = sql.slice(index).match(/^\$[A-Za-z_][A-Za-z0-9_]*\$|^\$\$/);
			if (match) {
				const delimiter = match[0];
				const end = sql.indexOf(delimiter, index + delimiter.length);
				if (end < 0) throw queryRejected();
				result += " ".repeat(end + delimiter.length - index);
				index = end + delimiter.length;
				continue;
			}
		}
		if (character === "'" || character === '"' || character === "`") {
			if (
				engine === "postgres" &&
				character !== "`" &&
				result.trimEnd().endsWith(":")
			) {
				throw queryRejected();
			}
			const quote = character;
			const start = index++;
			while (index < sql.length) {
				if (sql[index] === quote) {
					if (sql[index + 1] === quote) {
						index += 2;
						continue;
					}
					index++;
					break;
				}
				if (sql[index] === "\\" && engine === "mysql") index++;
				index++;
			}
			if (sql[index - 1] !== quote) throw queryRejected();
			result += " ".repeat(index - start);
			continue;
		}
		result += character;
		index++;
	}
	return result;
}
