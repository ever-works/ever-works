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
		// Security: `--ignore-scripts` disables npm lifecycle scripts (pre/postinstall, prepare)
		// of the fetched package so a compromised/yanked upstream version cannot execute arbitrary
		// code on the worker during install. The `version` flows from tenant-writable plugin
		// settings, so the install must never run package-controlled scripts. This only affects
		// npm lifecycle scripts — the resolved Gemini CLI `bin` entrypoint still runs normally.
		args: ['--yes', '--ignore-scripts', packageSpec]
	};
}
