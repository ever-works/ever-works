import type { RuntimeEnvironmentData } from '@ever-works/plugin';
import { normalizeRuntimePackageList, isValidAllowedHost } from '@ever-works/plugin';

import type { ManagedEnvironmentNetworking } from '../types.js';
import { resolveEnvVarNetworking } from './managed-agents-client.js';

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
 * Fails closed (Ever Works #109). The carrier crosses an RPC boundary in some
 * deployments, so it is read as untrusted input rather than as the type says:
 *
 *  - `networkingMode` other than exactly `'limited'` / `'unrestricted'` (a
 *    tampered or legacy carrier, or a mode this build does not know) does NOT
 *    widen to `unrestricted`: it falls back to the operator's env-var policy
 *    ({@link resolveEnvVarNetworking}), the same policy a run with no
 *    Environment gets.
 *  - `allow_package_managers` is granted only by an explicit
 *    `allowPackageManagers: true`; a missing or non-boolean value denies.
 *  - `allow_mcp_servers` is carried from the Environment's
 *    `allowMcpServers`, again only on an explicit `true`. The platform writes
 *    no such field today (the Environments UI has no MCP-server control), so
 *    every managed session keeps MCP servers off until one does.
 */
export function resolveEnvironmentNetworking(
	runtimeEnvironment: RuntimeEnvironmentData | undefined
): ManagedEnvironmentNetworking | undefined {
	if (!runtimeEnvironment) {
		return undefined;
	}

	// Compared as an unknown value: the declared union is what the platform
	// writes, not a guarantee about what arrived.
	const mode: unknown = runtimeEnvironment.networkingMode;

	if (mode === 'limited') {
		const hosts = (runtimeEnvironment.allowedHosts ?? []).filter((host) => isValidAllowedHost(host));
		return {
			type: 'limited',
			allowed_hosts: hosts,
			allow_package_managers: runtimeEnvironment.allowPackageManagers === true,
			allow_mcp_servers: runtimeEnvironment.allowMcpServers === true
		};
	}

	if (mode === 'unrestricted') {
		return { type: 'unrestricted' };
	}

	return resolveEnvVarNetworking();
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
	// Decided from the policy the session actually gets, so the two cannot
	// disagree: a missing flag or an unrecognised mode that resolves to a
	// limited policy without package managers skips the bootstrap too.
	const networking = resolveEnvironmentNetworking(runtimeEnvironment);
	if (networking?.type === 'limited' && !networking.allow_package_managers) {
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
