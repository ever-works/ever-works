import { DEFAULT_CLI_VERSION, GEMINI_NPM_PACKAGE } from '../types.js';

interface Logger {
	debug(message: string, ...args: unknown[]): void;
}

export interface GeminiCliCommand {
	readonly command: string;
	readonly args: string[];
}

function getPackageSpec(version: string): string {
	return version === 'latest' ? GEMINI_NPM_PACKAGE : `${GEMINI_NPM_PACKAGE}@${version}`;
}

/**
 * Resolve the Gemini CLI command invocation via npx.
 */
export function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): GeminiCliCommand {
	const packageSpec = getPackageSpec(version);
	logger?.debug(`Using Gemini CLI via npx (${packageSpec})`);
	return {
		command: 'npx',
		args: ['--yes', packageSpec]
	};
}
