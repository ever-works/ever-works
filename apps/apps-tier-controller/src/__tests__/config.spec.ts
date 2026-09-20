/**
 * The startup contract, asserted as behaviour: every refusal fires, and the one path that yields a
 * configuration yields the right one.
 *
 * These are not "the constant exists" checks. Each case is a way an operator can misconfigure a
 * zone, and the assertion is that the controller declines rather than guesses.
 */
import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

import {
	APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR,
	APPS_TIER_CONTROL_KUBECONFIG_ENV_VAR,
	APPS_TIER_CONTROL_NAMESPACE_DEFAULT,
	APPS_TIER_MANAGED_ENABLED_ENV_VAR,
	APPS_TIER_TENANT_NAMESPACE_PREFIX
} from '@ever-works/contracts';

import {
	CONTROL_NAMESPACE_ENV_VAR,
	CONTROLLER_VERSION,
	loadControllerConfig,
	satisfiesMinimumVersion,
	ZONE_ID_ENV_VAR
} from '../config.js';

/** The minimum env that yields a configuration; each test removes or corrupts one thing. */
function validEnv(): NodeJS.ProcessEnv {
	return {
		[APPS_TIER_MANAGED_ENABLED_ENV_VAR]: '1',
		[ZONE_ID_ENV_VAR]: 'eu-hel-1'
	};
}

/** The refusal codes a result carries, for a readable assertion. */
function codes(result: ReturnType<typeof loadControllerConfig>): readonly string[] {
	return result.ok ? [] : result.refusals.map((refusal) => refusal.code);
}

describe('loadControllerConfig', () => {
	it('accepts the minimum env and defaults the control namespace', () => {
		const result = loadControllerConfig(validEnv());

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.config.zoneId).toBe('eu-hel-1');
		expect(result.config.controlNamespace).toBe(APPS_TIER_CONTROL_NAMESPACE_DEFAULT);
		expect(result.config.tenantNamespacePrefix).toBe(APPS_TIER_TENANT_NAMESPACE_PREFIX);
		expect(result.config.apiVersion).toBe('hosting.ever.works/v1alpha1');
		expect(result.config.credentials).toEqual({ kind: 'in-cluster' });
	});

	it('refuses when the managed tier is not explicitly enabled', () => {
		const env = validEnv();
		delete env[APPS_TIER_MANAGED_ENABLED_ENV_VAR];

		expect(codes(loadControllerConfig(env))).toContain('MANAGED_TIER_NOT_ENABLED');
	});

	it.each(['0', 'true', 'yes', 'TRUE', ' 1', ''])('refuses the enable flag value %o — only "1" opts in', (value) => {
		expect(codes(loadControllerConfig({ ...validEnv(), [APPS_TIER_MANAGED_ENABLED_ENV_VAR]: value }))).toContain(
			'MANAGED_TIER_NOT_ENABLED'
		);
	});

	it('refuses a missing zone id rather than inventing one', () => {
		const env = validEnv();
		delete env[ZONE_ID_ENV_VAR];

		expect(codes(loadControllerConfig(env))).toContain('ZONE_ID_MISSING');
	});

	it.each(['Eu-Hel-1', 'eu_hel_1', '-eu', 'eu-', 'eu hel', 'a'.repeat(33)])(
		'refuses the malformed zone id %o',
		(zoneId) => {
			expect(codes(loadControllerConfig({ ...validEnv(), [ZONE_ID_ENV_VAR]: zoneId }))).toContain(
				'ZONE_ID_MALFORMED'
			);
		}
	);

	it('refuses a malformed control namespace', () => {
		expect(
			codes(loadControllerConfig({ ...validEnv(), [CONTROL_NAMESPACE_ENV_VAR]: 'Not A Namespace' }))
		).toContain('CONTROL_NAMESPACE_MALFORMED');
	});

	it('honours a control-namespace override', () => {
		const result = loadControllerConfig({
			...validEnv(),
			[CONTROL_NAMESPACE_ENV_VAR]: 'ever-works-apps-control-canary'
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.config.controlNamespace).toBe('ever-works-apps-control-canary');
	});

	it('reads a kubeconfig path when one is given, for the local kind lane', () => {
		const result = loadControllerConfig({
			...validEnv(),
			[APPS_TIER_CONTROL_KUBECONFIG_ENV_VAR]: '/tmp/kind.kubeconfig'
		});

		expect(result.ok).toBe(true);
		if (!result.ok) throw new Error('unreachable');
		expect(result.config.credentials).toEqual({ kind: 'kubeconfig', path: '/tmp/kind.kubeconfig' });
	});

	it('refuses to run below the version floor the platform set', () => {
		expect(
			codes(loadControllerConfig({ ...validEnv(), [APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR]: '9.0.0' }))
		).toContain('CONTROLLER_VERSION_BELOW_PLATFORM_MINIMUM');
	});

	it('runs when it meets the floor exactly', () => {
		expect(
			loadControllerConfig({ ...validEnv(), [APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR]: CONTROLLER_VERSION }).ok
		).toBe(true);
	});

	it('reports every refusal at once, not just the first', () => {
		const result = loadControllerConfig({ [APPS_TIER_CONTROLLER_MIN_VERSION_ENV_VAR]: '9.0.0' });

		expect(codes(result)).toEqual(
			expect.arrayContaining([
				'MANAGED_TIER_NOT_ENABLED',
				'ZONE_ID_MISSING',
				'CONTROLLER_VERSION_BELOW_PLATFORM_MINIMUM'
			])
		);
	});
});

describe('satisfiesMinimumVersion', () => {
	it.each([
		['1.0.0', '1.0.0', true],
		['1.2.3', '1.2.2', true],
		['1.3.0', '1.2.9', true],
		['2.0.0', '1.9.9', true],
		['1.0.0', '1.0.1', false],
		['1.0.0', '1.1.0', false],
		['0.9.9', '1.0.0', false]
	] as const)('%s vs minimum %s → %s', (version, minimum, expected) => {
		expect(satisfiesMinimumVersion(version, minimum)).toBe(expected);
	});

	it.each(['', '1', '1.0', '1.0.0.0', 'v1.0.0', 'latest', '1.0.x'])(
		'treats the unparseable version %o as NOT satisfied',
		(value) => {
			// Failing closed matters here: a zone whose version cannot be read must not be trusted
			// just because the comparison could not be made.
			expect(satisfiesMinimumVersion(value, '1.0.0')).toBe(false);
			expect(satisfiesMinimumVersion('1.0.0', value)).toBe(false);
		}
	);
});

describe('CONTROLLER_VERSION', () => {
	it('equals the version in package.json', () => {
		// The platform gates a zone on this string. If the constant and the artefact disagree, an
		// old controller can claim to be a new one and the minimum-version gate becomes decorative.
		const manifest = JSON.parse(readFileSync(new URL('../../package.json', import.meta.url), 'utf8')) as {
			version: string;
		};

		expect(CONTROLLER_VERSION).toBe(manifest.version);
	});
});
