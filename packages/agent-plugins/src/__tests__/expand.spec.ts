import { describe, expect, it } from 'vitest';
import {
	classifyCwd,
	expandArgs,
	expandEnvValues,
	expandPlaceholders,
	isReservedEnvKey,
	RESERVED_ENV_KEYS
} from '../expand';

const ctx = { pluginRoot: '/plugins/devtools', pluginData: '/plugins/data/devtools' };

describe('expand — placeholder substitution (spec 9.2)', () => {
	it('replaces both placeholders', () => {
		expect(expandPlaceholders('${PLUGIN_ROOT}/config.json', ctx)).toBe('/plugins/devtools/config.json');
		expect(expandPlaceholders('${PLUGIN_DATA}/cache', ctx)).toBe('/plugins/data/devtools/cache');
	});

	it('replaces every occurrence, not just the first', () => {
		expect(expandPlaceholders('${PLUGIN_ROOT}:${PLUGIN_ROOT}', ctx)).toBe('/plugins/devtools:/plugins/devtools');
	});

	it('replaces both placeholders in one value', () => {
		expect(expandPlaceholders('${PLUGIN_ROOT}:${PLUGIN_DATA}', ctx)).toBe(
			'/plugins/devtools:/plugins/data/devtools'
		);
	});

	it('is a single pass: text introduced by a replacement is not rescanned', () => {
		// A data directory whose own path contains the literal text
		// `${PLUGIN_ROOT}` must survive verbatim. Anything else would be
		// recursive expansion, which spec 9.2 forbids outright.
		const tricky = { pluginRoot: '/root', pluginData: '/data/${PLUGIN_ROOT}/x' };
		expect(expandPlaceholders('${PLUGIN_DATA}/f', tricky)).toBe('/data/${PLUGIN_ROOT}/x/f');
	});

	it('leaves unrecognised placeholder-like text literal', () => {
		for (const value of [
			'${PLUGIN_HOME}/x',
			'${HOME}/x',
			'$PLUGIN_ROOT/x',
			'{PLUGIN_ROOT}/x',
			'${plugin_root}/x',
			'${PLUGIN_ROOT/x',
			'%PLUGIN_ROOT%/x'
		]) {
			expect(expandPlaceholders(value, ctx)).toBe(value);
		}
	});

	it('performs no environment-variable expansion of any other kind', () => {
		process.env['AGENT_PLUGINS_TEST_VAR'] = 'leaked';
		expect(expandPlaceholders('${AGENT_PLUGINS_TEST_VAR}', ctx)).toBe('${AGENT_PLUGINS_TEST_VAR}');
		delete process.env['AGENT_PLUGINS_TEST_VAR'];
	});

	it('leaves a value with no placeholders untouched', () => {
		expect(expandPlaceholders('plain text', ctx)).toBe('plain text');
		expect(expandPlaceholders('', ctx)).toBe('');
	});

	it('is repeatable — the shared pattern carries no state between calls', () => {
		// A module-level global regular expression that is not reset leaks
		// `lastIndex` across calls; `replace` avoids that, and this pins it.
		for (let i = 0; i < 5; i += 1) {
			expect(expandPlaceholders('${PLUGIN_ROOT}/a', ctx)).toBe('/plugins/devtools/a');
			expect(expandPlaceholders('${PLUGIN_DATA}/b', ctx)).toBe('/plugins/data/devtools/b');
		}
	});
});

describe('expand — where expansion applies (spec 9.2)', () => {
	it('expands every element of args', () => {
		expect(expandArgs(['--config', '${PLUGIN_ROOT}/c.json', '${PLUGIN_DATA}', 'plain'], ctx)).toEqual([
			'--config',
			'/plugins/devtools/c.json',
			'/plugins/data/devtools',
			'plain'
		]);
	});

	it('returns an empty list for absent args', () => {
		expect(expandArgs(undefined, ctx)).toEqual([]);
	});

	it('expands env values but never env keys', () => {
		const expanded = expandEnvValues({ DATA_DIR: '${PLUGIN_DATA}/db', '${PLUGIN_ROOT}': 'weird-key' }, ctx);
		expect(expanded['DATA_DIR']).toBe('/plugins/data/devtools/db');
		// The key stays literal: expansion "does not apply to `env` keys".
		expect(Object.keys(expanded)).toContain('${PLUGIN_ROOT}');
		expect(expanded['${PLUGIN_ROOT}']).toBe('weird-key');
	});

	it('returns an empty object for absent env', () => {
		expect(expandEnvValues(undefined, ctx)).toEqual({});
	});
});

describe('expand — reserved environment names (spec 9.2)', () => {
	it('names exactly the two the client owns', () => {
		expect(RESERVED_ENV_KEYS).toEqual(['PLUGIN_ROOT', 'PLUGIN_DATA']);
	});

	it.each([
		['PLUGIN_ROOT', true],
		['PLUGIN_DATA', true],
		['plugin_root', false],
		['PLUGIN_ROOTX', false],
		['MY_PLUGIN_ROOT', false],
		['PATH', false]
	])('isReservedEnvKey(%j) is %s', (key, expected) => {
		expect(isReservedEnvKey(key)).toBe(expected);
	});
});

describe('expand — cwd classification (spec 7.2.1)', () => {
	it.each([
		['./data', 'plugin-relative'],
		['./', 'plugin-relative'],
		['${PLUGIN_ROOT}', 'plugin-root'],
		['${PLUGIN_ROOT}/a/b', 'plugin-root'],
		['${PLUGIN_DATA}', 'plugin-data'],
		['${PLUGIN_DATA}/a', 'plugin-data']
	])('classifies %j as %s', (value, expected) => {
		expect(classifyCwd(value)).toBe(expected);
	});

	it.each([
		'data',
		'../data',
		'/absolute',
		'C:/absolute',
		'.',
		'..',
		'${PLUGIN_ROOTX}',
		'${PLUGIN_ROOT}x',
		'${PLUGIN_DATA}x',
		'x${PLUGIN_ROOT}',
		''
	])('refuses to classify %j', (value) => {
		expect(classifyCwd(value)).toBeUndefined();
	});

	it('distinguishes the two roots, because containment differs between them', () => {
		// A `${PLUGIN_DATA}`-rooted cwd is contained against the data
		// directory, not the package root (spec 7.2.1) — so the anchor has
		// to survive parsing.
		expect(classifyCwd('${PLUGIN_ROOT}/x')).not.toBe(classifyCwd('${PLUGIN_DATA}/x'));
	});
});
