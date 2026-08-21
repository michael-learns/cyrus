import { DatabaseAccessError } from "./errors.js";

export const POSTGRES_PRIVILEGE_PREFLIGHT_SQL = `
WITH RECURSIVE memberships(roleid) AS (
  SELECT roleid FROM pg_auth_members WHERE member = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  UNION
  SELECT member.roleid FROM pg_auth_members member JOIN memberships parent ON member.member = parent.roleid
), owned_objects AS (
  SELECT datdba AS owner FROM pg_database WHERE datdba = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  UNION ALL SELECT nspowner FROM pg_namespace WHERE nspowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  UNION ALL SELECT relowner FROM pg_class WHERE relowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
  UNION ALL SELECT proowner FROM pg_proc WHERE proowner = (SELECT oid FROM pg_roles WHERE rolname = current_user)
), user_routines AS (
  SELECT p.oid FROM pg_proc p JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname NOT IN ('pg_catalog', 'information_schema')
    AND has_function_privilege(current_user, p.oid, 'EXECUTE')
)
SELECT current_user AS "currentRole", r.rolsuper AS "isSuperuser",
  r.rolcreatedb AS "canCreateDb", r.rolcreaterole AS "canCreateRole",
  r.rolreplication AS "isReplication", r.rolbypassrls AS "canBypassRls",
  (SELECT count(*) FROM memberships) AS "membershipCount",
  (SELECT count(*) FROM owned_objects) AS "ownedObjectCount",
  has_database_privilege(current_user, current_database(), 'CREATE') AS "hasDatabaseCreate",
  has_database_privilege(current_user, current_database(), 'TEMP') AS "hasDatabaseTemp",
  EXISTS (SELECT 1 FROM pg_namespace n WHERE has_schema_privilege(current_user, n.oid, 'CREATE')) AS "hasSchemaCreate",
  EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind IN ('r','p','v','m','f') AND
    (has_table_privilege(current_user, c.oid, 'INSERT') OR has_table_privilege(current_user, c.oid, 'UPDATE') OR
     has_table_privilege(current_user, c.oid, 'DELETE') OR has_table_privilege(current_user, c.oid, 'TRUNCATE') OR
     has_table_privilege(current_user, c.oid, 'REFERENCES') OR has_table_privilege(current_user, c.oid, 'TRIGGER'))) AS "hasTableWrite",
  EXISTS (SELECT 1 FROM pg_class c WHERE c.relkind = 'S' AND
    (has_sequence_privilege(current_user, c.oid, 'USAGE') OR has_sequence_privilege(current_user, c.oid, 'UPDATE'))) AS "hasSequenceMutation",
  EXISTS (SELECT 1 FROM user_routines) AS "hasUserRoutineExecute",
  current_setting('statement_timeout', true) IS NOT NULL AS "deadlineSupported"
FROM pg_roles r WHERE r.rolname = current_user`;

export interface PostgresPrivilegePreflight {
	currentRole: string;
	isSuperuser: boolean;
	canCreateDb: boolean;
	canCreateRole: boolean;
	isReplication: boolean;
	canBypassRls: boolean;
	membershipCount: number;
	ownedObjectCount: number;
	hasDatabaseCreate: boolean;
	hasDatabaseTemp: boolean;
	hasSchemaCreate: boolean;
	hasTableWrite: boolean;
	hasSequenceMutation: boolean;
	hasUserRoutineExecute: boolean;
	deadlineSupported: boolean;
}

export function assertPostgresPrivilegePreflight(
	result: PostgresPrivilegePreflight,
	expectedRole: string,
): void {
	const safe =
		result.currentRole === expectedRole &&
		result.isSuperuser === false &&
		result.canCreateDb === false &&
		result.canCreateRole === false &&
		result.isReplication === false &&
		result.canBypassRls === false &&
		result.membershipCount === 0 &&
		result.ownedObjectCount === 0 &&
		result.hasDatabaseCreate === false &&
		result.hasDatabaseTemp === false &&
		result.hasSchemaCreate === false &&
		result.hasTableWrite === false &&
		result.hasSequenceMutation === false &&
		result.hasUserRoutineExecute === false &&
		result.deadlineSupported === true;
	if (!safe) privilegeCheckFailed();
}

export interface MysqlPrivilegePreflight {
	currentAccount: string;
	deadlineSupported: boolean;
	grants: string[];
}

export function assertMysqlPrivilegePreflight(
	result: MysqlPrivilegePreflight,
	expectedAccount: string,
): void {
	if (
		result.currentAccount !== expectedAccount ||
		result.deadlineSupported !== true ||
		!result.grants.every(isSafeMysqlGrant)
	) {
		privilegeCheckFailed();
	}
}

function isSafeMysqlGrant(grant: string): boolean {
	const normalized = grant.trim().replace(/\s+/g, " ").toUpperCase();
	if (/^GRANT USAGE ON \*\.\* TO /.test(normalized)) {
		return !normalized.includes(" WITH GRANT OPTION");
	}
	const match = normalized.match(/^GRANT (.+) ON (.+) TO /);
	if (
		!match ||
		match[2] === "*.*" ||
		normalized.includes(" WITH GRANT OPTION")
	) {
		return false;
	}
	const privilegesText = match[1];
	if (!privilegesText) return false;
	const privileges = privilegesText
		.split(",")
		.map((value) => value.trim())
		.filter(Boolean);
	return (
		privileges.length > 0 &&
		privileges.every(
			(privilege) => privilege === "SELECT" || privilege === "SHOW VIEW",
		)
	);
}

function privilegeCheckFailed(): never {
	throw new DatabaseAccessError(
		"PRIVILEGE_CHECK_FAILED",
		"The configured database role is not strictly read-only",
	);
}
