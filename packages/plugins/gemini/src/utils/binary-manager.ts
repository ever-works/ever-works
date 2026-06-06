import { DEFAULT_CLI_VERSION, GEMINI_NPM_PACKAGE } from '../types.js';

interface Logger {
	debug(message: string, ...args: unknown[]): void;
}

export interface GeminiCliCommand {
	readonly command: string;
	readonly args: string[];
}

// Security: the Gemini CLI `version` is operator/tenant-supplied plugin settings
// (settings.version) and is interpolated into the npm package spec passed to
// `npx --yes` (`@google/gemini-cli@${version}`), which is then fetched and executed.
// Without validation an attacker-controlled value could turn the spec into an arbitrary
// install source — e.g. a malicious dist-tag, or a git/URL/file/alias spec
// (`@google/gemini-cli@github:evil/pkg`, `@google/gemini-cli@file:../evil`) — causing
// npx to install and run a different package. Restrict it to an exact semver-like token
// (optional leading `v`, optional pre-release/build suffix), mirroring the
// OpenCode/Codex binary managers, while still allowing the sentinel `latest`.
const VERSION_PATTERN = /^v?\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/u;

function getPackageSpec(version: string): string {
	return version === 'latest' ? GEMINI_NPM_PACKAGE : `${GEMINI_NPM_PACKAGE}@${version}`;
}

/**
 * Resolve the Gemini CLI command invocation via npx.
 */
export function ensureBinary(version: string = DEFAULT_CLI_VERSION, logger?: Logger): GeminiCliCommand {
	// Security: reject any version that is neither the `latest` sentinel nor a strict
	// semver token before it is interpolated into the npx package spec (see VERSION_PATTERN).
	if (version !== 'latest' && !VERSION_PATTERN.test(version)) {
		throw new Error(`Invalid Gemini CLI version: ${version}`);
	}

	const packageSpec = getPackageSpec(version);
	logger?.debug(`Using Gemini CLI via npx (${packageSpec})`);
	return {
		command: 'npx',
		args: ['--yes', packageSpec]
	};
}
