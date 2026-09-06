import { describe, expect, it } from 'vitest';

import {
	FLEET_RUN_ENV_FILE_MAX_COUNT,
	FLEET_RUN_ENV_FILE_REFS_MAX_COUNT,
	FLEET_RUN_ENV_GRANT_MAX_COUNT,
	FleetRunEnvFileError,
	isGrantableFleetRunEnvName,
	isValidFleetRunEnvFilePath,
	normalizeFleetRunEnvFileRefs,
	normalizeFleetRunEnvGrants
} from '../fleet-run-secrets.types.js';
import * as runSecrets from '../fleet-run-secrets.types.js';

/**
 * Run secrets (self-build slice Y, EW-781).
 *
 * The load-bearing assertion of this file is the FIRST one: no shape this
 * module declares can carry a secret value except the fetch-response entry.
 * Everything else pins the refusals a partial environment would otherwise
 * slip through.
 */
describe('fleet run secrets — the by-reference invariant', () => {
	it('never lets a normalized reference carry content', () => {
		const [ref] = normalizeFleetRunEnvFileRefs([
			{ repoConnectionId: 'row-1', paths: ['apps/api/.env'], content: 'SENTINEL', envFiles: { a: 'b' } }
		]);
		expect(Object.keys(ref).sort()).toEqual(['paths', 'repoConnectionId']);
		expect(JSON.stringify(ref)).not.toContain('SENTINEL');
	});

	it('exposes no runtime symbol whose name suggests it holds a value', () => {
		// A future field named `content`/`value`/`secret` on the SPEC side is
		// the regression this module exists to prevent; the one legitimate
		// carrier (`FleetRunEnvFileContent`) is a type, so it is invisible here.
		for (const name of Object.keys(runSecrets)) {
			expect(name).not.toMatch(/^(FLEET_RUN_ENV_FILE_CONTENTS?|.*_SECRET_VALUE)$/);
		}
	});
});

describe('isValidFleetRunEnvFilePath', () => {
	it.each(['.env', 'apps/api/.env', 'packages/agent/.env.local', 'a/b/c/.env-test'])('accepts %s', (path) => {
		expect(isValidFleetRunEnvFilePath(path)).toBe(true);
	});

	it.each([
		['absolute posix', '/etc/passwd'],
		['absolute windows', 'C:/Windows/x'],
		['backslash', 'apps\\api\\.env'],
		['parent traversal', '../.env'],
		['embedded traversal', 'apps/../../.env'],
		['dot segment', 'apps/./.env'],
		['option-shaped segment', '--upload-pack/.env'],
		['empty', ''],
		['nul byte', 'apps/\0/.env'],
		['not a string', 42]
	])('refuses %s', (_label, path) => {
		expect(isValidFleetRunEnvFilePath(path)).toBe(false);
	});

	it('refuses a path longer than 200 characters', () => {
		expect(isValidFleetRunEnvFilePath(`${'a/'.repeat(120)}.env`)).toBe(false);
	});
});

describe('normalizeFleetRunEnvFileRefs', () => {
	it('treats undefined, null and [] as "no env files"', () => {
		expect(normalizeFleetRunEnvFileRefs(undefined)).toEqual([]);
		expect(normalizeFleetRunEnvFileRefs(null)).toEqual([]);
		expect(normalizeFleetRunEnvFileRefs([])).toEqual([]);
	});

	it('keeps the mount target when one is named', () => {
		expect(normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', mountDir: 'api', paths: ['.env'] }])).toEqual(
			[{ repoConnectionId: 'row-1', mountDir: 'api', paths: ['.env'] }]
		);
	});

	it('refuses a second reference for the same checkout', () => {
		expect(() =>
			normalizeFleetRunEnvFileRefs([
				{ repoConnectionId: 'row-1', paths: ['.env'] },
				{ repoConnectionId: 'row-2', paths: ['.env.local'] }
			])
		).toThrow(FleetRunEnvFileError);
	});

	it('refuses a reserved mount directory', () => {
		expect(() =>
			normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', mountDir: '.git', paths: ['.env'] }])
		).toThrow(/mountDir/);
	});

	it('refuses an empty path list rather than silently delivering nothing', () => {
		expect(() => normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', paths: [] }])).toThrow(/non-empty/);
	});

	it('refuses a traversing path naming the entry', () => {
		expect(() => normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', paths: ['../../.env'] }])).toThrow(
			/envFilesRef\[0\]\.paths/
		);
	});

	it('refuses the same path twice in one reference', () => {
		expect(() => normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', paths: ['.env', '.ENV'] }])).toThrow(
			/twice/
		);
	});

	it('caps the paths per reference and the references per run', () => {
		const tooManyPaths = Array.from({ length: FLEET_RUN_ENV_FILE_MAX_COUNT + 1 }, (_, i) => `.env${i}`);
		expect(() => normalizeFleetRunEnvFileRefs([{ repoConnectionId: 'row-1', paths: tooManyPaths }])).toThrow(
			/the limit is/
		);
		const tooManyRefs = Array.from({ length: FLEET_RUN_ENV_FILE_REFS_MAX_COUNT + 1 }, (_, i) => ({
			repoConnectionId: `row-${i}`,
			mountDir: `m${i}`,
			paths: ['.env']
		}));
		expect(() => normalizeFleetRunEnvFileRefs(tooManyRefs)).toThrow(/the limit is/);
	});

	it('refuses a repoConnectionId that is not a row id', () => {
		expect(() => normalizeFleetRunEnvFileRefs([{ repoConnectionId: '../../etc', paths: ['.env'] }])).toThrow(
			/repoConnectionId/
		);
	});
});

describe('isGrantableFleetRunEnvName', () => {
	it.each(['DATABASE_URL', 'GH_TOKEN', 'AWS_ACCESS_KEY_ID', 'REDIS_URL', 'STRIPE_SECRET_KEY'])(
		'admits the platform-owned name %s, which is exactly the point',
		(name) => {
			expect(isGrantableFleetRunEnvName(name)).toBe(true);
		}
	);

	it.each([
		'FLEET_NODE_SECRET',
		'EVER_WORKS_NODE_TOKEN',
		'PLUGIN_SECRET_ENCRYPTION_KEY',
		'AUTH_SECRET',
		'BETTER_AUTH_SECRET',
		'PLATFORM_API_KEY'
	])('never admits the un-grantable core name %s', (name) => {
		expect(isGrantableFleetRunEnvName(name)).toBe(false);
	});

	it.each(['*', 'DATABASE_*', 'DATABASE URL', '1DATABASE', '', 'a'.repeat(200)])(
		'refuses the malformed or wildcard name %s',
		(name) => {
			expect(isGrantableFleetRunEnvName(name)).toBe(false);
		}
	);
});

describe('normalizeFleetRunEnvGrants', () => {
	it('drops what it cannot accept instead of failing a run', () => {
		expect(normalizeFleetRunEnvGrants(['DATABASE_URL', 'FLEET_NODE_SECRET', '*', 42, 'GH_TOKEN'])).toEqual([
			'DATABASE_URL',
			'GH_TOKEN'
		]);
	});

	it('de-duplicates case-insensitively, keeping the first spelling', () => {
		expect(normalizeFleetRunEnvGrants(['DATABASE_URL', 'database_url'])).toEqual(['DATABASE_URL']);
	});

	it('caps the list', () => {
		const many = Array.from({ length: FLEET_RUN_ENV_GRANT_MAX_COUNT + 5 }, (_, i) => `VAR_${i}`);
		expect(normalizeFleetRunEnvGrants(many)).toHaveLength(FLEET_RUN_ENV_GRANT_MAX_COUNT);
	});

	it('treats a non-array as no grants', () => {
		expect(normalizeFleetRunEnvGrants(undefined)).toEqual([]);
		expect(normalizeFleetRunEnvGrants('DATABASE_URL')).toEqual([]);
	});
});
