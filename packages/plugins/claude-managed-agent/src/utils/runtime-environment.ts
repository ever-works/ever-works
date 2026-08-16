import type { RuntimeEnvironmentData } from '@ever-works/plugin';
import { normalizeRuntimePackageList, isValidAllowedHost } from '@ever-works/plugin';

import type { ManagedEnvironmentNetworking } from '../types.js';

/**
 * Environments — how a platform-resolved runtime Environment
 * (`execContext.runtimeEnvironment`) maps onto Anthropic Managed Agents
 * concepts:
 *
 *  - networking → the CMA environment's `config.networking` block
 *    (`{type:'unrestricted'}` or
 *    `{type:'limited', allowed_hosts, allow_package_managers, allow_mcp_servers}`);
 *  - pip/npm package lists → an initial session bootstrap message that
 *    installs them BEFORE the workspace seed / main prompts.
 *
 * Every value is re-validated here with the same shared allow-list
 * validators the platform applied (defense in depth — these strings are
 * composed into install commands inside the managed session). Anything
 * that fails validation is silently dropped rather than erroring the
 * run: the platform layers already rejected invalid input, so a failure
 * here means a tampered/legacy carrier, and a missing package is the
 * safe degradation.
 */

/**
 * Map a resolved Environment's networking posture onto the CMA config
 * block ({@link ManagedEnvironmentNetworking} — the shape the pinned SDK
 * documents for `environments.create` / `environments.update`). Returns
 * `undefined` when no Environment is present, which tells the client to
 * keep its historical env-var fallback path byte-for-byte.
 *
 * `allow_mcp_servers` is pinned to `false`: an Environment models egress
 * for the sandbox itself, and the platform has no UI for authorising MCP
 * servers inside a managed session, so the restrictive value is the only
 * one an Environment can honestly claim.
 */
export function resolveEnvironmentNetworking(
	runtimeEnvironment: RuntimeEnvironmentData | undefined
): ManagedEnvironmentNetworking | undefined {
	if (!runtimeEnvironment) {
		return undefined;
	}

	if (runtimeEnvironment.networkingMode === 'limited') {
		const hosts = (runtimeEnvironment.allowedHosts ?? []).filter((host) => isValidAllowedHost(host));
		return {
			type: 'limited',
			allowed_hosts: hosts,
			allow_package_managers: runtimeEnvironment.allowPackageManagers !== false,
			allow_mcp_servers: false
		};
	}

	return { type: 'unrestricted' };
}

/**
 * Compose the session bootstrap message that installs the Environment's
 * packages before any other work. Returns `null` when there is nothing
 * to install (callers then skip the bootstrap round-trip entirely).
 *
 * Command composition is deliberately dumb: validated specs, each
 * wrapped in single quotes, joined with single spaces after the fixed
 * `pip install` / `npm install -g` prefixes. The allow-list validators
 * guarantee no quote characters survive into a spec (so the quoting can
 * never be broken out of), and the quoting in turn neutralises the
 * comparison operators (`>=`, `<`) that are legitimate version syntax
 * but would read as shell redirects unquoted.
 */
export function buildPackageBootstrapPrompt(runtimeEnvironment: RuntimeEnvironmentData | undefined): string | null {
	if (!runtimeEnvironment) {
		return null;
	}

	// Limited networking with package managers switched off makes the
	// registries unreachable, so an install prompt could only ever burn a
	// session turn and fail. Skip the bootstrap entirely rather than ask
	// the agent to run commands the environment forbids.
	if (runtimeEnvironment.networkingMode === 'limited' && runtimeEnvironment.allowPackageManagers === false) {
		return null;
	}

	const pip = normalizeRuntimePackageList(runtimeEnvironment.pipPackages, 'pip').valid;
	const npm = normalizeRuntimePackageList(runtimeEnvironment.npmPackages, 'npm').valid;

	if (pip.length === 0 && npm.length === 0) {
		return null;
	}

	const quote = (spec: string): string => `'${spec}'`;
	const commands: string[] = [];
	if (pip.length > 0) {
		commands.push(`pip install ${pip.map(quote).join(' ')}`);
	}
	if (npm.length > 0) {
		commands.push(`npm install -g ${npm.map(quote).join(' ')}`);
	}

	return [
		`Before doing anything else, prepare the runtime environment "${runtimeEnvironment.name}" by running the following command(s) exactly as written, one at a time:`,
		'',
		...commands.map((command) => `- \`${command}\``),
		'',
		'If a command fails, retry it once; if it still fails, note the failure and continue. Reply with a short confirmation once the installs have finished. Do not start any other work in this turn.'
	].join('\n');
}
