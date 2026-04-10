export interface ExecuteOptions {
	readonly prompt: string;
	readonly systemPrompt: string;
	readonly cwd: string;
	readonly env: Record<string, string>;
	readonly maxTurns: number;
	readonly model?: string;
	readonly signal?: AbortSignal;
}

export interface ExecuteResult {
	readonly stdout: string;
	readonly stderr: string;
	readonly exitCode: number | null;
	readonly killed: boolean;
	readonly duration: number;
}

export function executeCodex(_options: ExecuteOptions): {
	promise: Promise<ExecuteResult>;
	kill: () => void;
} {
	let killed = false;
	return {
		promise: Promise.resolve({
			stdout: '',
			stderr: 'Codex runner not implemented yet',
			exitCode: 1,
			killed,
			duration: 0
		}),
		kill: () => {
			killed = true;
		}
	};
}
