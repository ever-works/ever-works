import type { RuntimeEnvironmentData } from '@ever-works/plugin';
import { normalizeRuntimePackageList, isValidAllowedHost } from '@ever-works/plugin';

/**
 * Environments — how a platform-resolved runtime Environment
 * (`execContext.runtimeEnvironment`) maps onto Anthropic Managed Agents
 * concepts:
 *
 *  - networking → the CMA environment's `config.networking` block
 *    (`{type:'unrestricted'}` or
 *    `{type:'limited', allowed_hosts, allow_package_managers}`);
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
 * Networking config union for `environments.create`. `allowlist` is the
 * H-25 env-var fallback shape the plugin has always sent; `limited` is
 * the Environments-driven shape.
 */
export type ManagedAgentsNetworkingConfig =
	| { type: 'unrestricted' }
	| { type: 'limited'; allowed_hosts: string[]; allow_package_managers: boolean }
	| { type: 'allowlist'; hosts: string[] };

/**
 * Map a resolved Environment's networking posture onto the CMA config
 * block. Returns `undefined` when no Environment is present, which tells
 * the client to keep its historical env-var fallback path byte-for-byte.
 */
export function resolveEnvironmentNetworking(
	runtimeEnvironment: RuntimeEnvironmentData | undefined
): ManagedAgentsNetworkingConfig | undefined {
	if (!runtimeEnvironment) {
		return undefined;
	}

	if (runtimeEnvironment.networkingMode === 'limited') {
		const hosts = (runtimeEnvironment.allowedHosts ?? []).filter((host) => isValidAllowedHost(host));
		return {
			type: 'limited',
			allowed_hosts: hosts,
			allow_package_managers: runtimeEnvironment.allowPackageManagers !== false
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
export function buildPackageBootstrapPrompt(
	runtimeEnvironment: RuntimeEnvironmentData | undefined
): string | null {
	if (!runtimeEnvironment) {
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
