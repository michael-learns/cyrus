import { readFileSync, realpathSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { z } from "zod";
import { DatabaseAccessError } from "./errors.js";

const SafeId = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/);
const ProfileSchema = z.object({
	engine: z.enum(["postgres", "mysql"]),
	database: SafeId,
	host: z.string().min(1).max(253).optional(),
	port: z.number().int().min(1).max(65_535).optional(),
	user: z
		.string()
		.min(1)
		.max(128)
		.regex(/^[A-Za-z0-9_][A-Za-z0-9_.-]*$/),
	expectedRole: z.string().min(1).max(256),
	executable: z.string().refine(isAbsolute),
	credentialsFile: z.string().refine(isAbsolute),
	limits: z.object({
		queryTimeoutMs: z.number().int().min(1).max(60_000),
		maxSqlBytes: z.number().int().min(1).max(65_536),
		maxRows: z.number().int().min(1).max(1_000),
		maxOutputBytes: z.number().int().min(1).max(1_048_576),
	}),
});
const ProfileFileSchema = z.object({
	version: z.literal(1),
	profiles: z.record(SafeId, ProfileSchema),
});

export type GatewayProfile = z.infer<typeof ProfileSchema> & { id: string };

export interface GatewayProfileFileDependencies {
	realpath: (path: string) => string;
	stat: (path: string) => { isFile: () => boolean; uid: number; mode: number };
	readFile: (path: string) => string;
}

const defaultDependencies: GatewayProfileFileDependencies = {
	realpath: realpathSync,
	stat: statSync,
	readFile: (path) => readFileSync(path, "utf8"),
};

export function parseGatewayProfileFile(
	input: unknown,
	profileId: string,
): GatewayProfile {
	const parsed = ProfileFileSchema.safeParse(input);
	if (!parsed.success) invalidProfile();
	const profile = parsed.data.profiles[profileId];
	if (!profile) invalidProfile();
	return { id: profileId, ...profile };
}

export function loadGatewayProfile(
	path: string,
	profileId: string,
	dependencies: GatewayProfileFileDependencies = defaultDependencies,
): GatewayProfile {
	try {
		const canonicalPath = dependencies.realpath(path);
		const stat = dependencies.stat(canonicalPath);
		if (!stat.isFile() || stat.uid !== 0 || (stat.mode & 0o022) !== 0) {
			invalidProfile();
		}
		return parseGatewayProfileFile(
			JSON.parse(dependencies.readFile(canonicalPath)),
			profileId,
		);
	} catch (error) {
		if (error instanceof DatabaseAccessError) throw error;
		invalidProfile();
	}
}

function invalidProfile(): never {
	throw new DatabaseAccessError(
		"GATEWAY_UNAVAILABLE",
		"The database gateway profile is unavailable",
	);
}
