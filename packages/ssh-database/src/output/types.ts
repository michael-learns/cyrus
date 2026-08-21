export interface OutputLimits {
	maxRows: number;
	maxOutputBytes: number;
}

export interface FramedDatabaseOutput {
	output: string;
	rowCount: number;
	byteCount: number;
	truncated: boolean;
}
