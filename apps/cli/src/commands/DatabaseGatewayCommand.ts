import {
	DatabaseAccessError,
	DatabaseGateway,
	type DatabaseGatewayExecutor,
	encodeGatewayResponse,
	GATEWAY_PROTOCOL_VERSION,
	type GatewayProfile,
	loadGatewayProfile,
	MAX_GATEWAY_REQUEST_BYTES,
	NativeDatabaseExecutor,
} from "cyrus-ssh-database";

export interface DatabaseGatewayCommandOptions {
	configPath: string;
	profileId: string;
}

export interface DatabaseGatewayCommandDependencies {
	stdin: AsyncIterable<Uint8Array>;
	writeStdout: (chunk: Uint8Array) => void;
	loadProfile: (configPath: string, profileId: string) => GatewayProfile;
	createExecutor: () => DatabaseGatewayExecutor;
}

const defaultDependencies: DatabaseGatewayCommandDependencies = {
	stdin: process.stdin,
	writeStdout: (chunk) => {
		process.stdout.write(chunk);
	},
	loadProfile: loadGatewayProfile,
	createExecutor: () => new NativeDatabaseExecutor(),
};

export class DatabaseGatewayCommand {
	constructor(
		private readonly dependencies: DatabaseGatewayCommandDependencies = defaultDependencies,
	) {}

	async execute(options: DatabaseGatewayCommandOptions): Promise<number> {
		let response: Buffer;
		try {
			const frame = await readBoundedFrame(this.dependencies.stdin);
			const profile = this.dependencies.loadProfile(
				options.configPath,
				options.profileId,
			);
			response = await new DatabaseGateway(
				profile,
				this.dependencies.createExecutor(),
			).handle(frame);
		} catch (error) {
			const safe =
				error instanceof DatabaseAccessError
					? error
					: new DatabaseAccessError(
							"GATEWAY_UNAVAILABLE",
							"The database gateway is unavailable",
						);
			response = encodeGatewayResponse({
				version: GATEWAY_PROTOCOL_VERSION,
				success: false,
				error: { code: safe.code, message: safe.message },
			});
		}
		this.dependencies.writeStdout(response);
		return 0;
	}
}

async function readBoundedFrame(
	source: AsyncIterable<Uint8Array>,
): Promise<Buffer> {
	const chunks: Buffer[] = [];
	let bytes = 0;
	for await (const chunk of source) {
		bytes += chunk.byteLength;
		if (bytes > MAX_GATEWAY_REQUEST_BYTES) {
			throw new DatabaseAccessError(
				"QUERY_REJECTED",
				"Only a bounded read-only query is allowed",
			);
		}
		chunks.push(Buffer.from(chunk));
	}
	return Buffer.concat(chunks);
}
