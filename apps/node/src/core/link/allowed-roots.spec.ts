import { resolve } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isWithinAllowedRoots, resolveAllowedRoots } from './allowed-roots';

describe('allowed roots (CONTRACTS R-18, R-39, R-41; FL-14 ACC-FL14-14)', () => {
	const api = resolve('/srv/code/api');
	const pool = resolve('/srv/fleet-workspaces');

	it('is the ready checkouts plus the workspace root, de-duplicated, never home', () => {
		expect(resolveAllowedRoots({ checkouts: [api, api], workspaceRoot: pool })).toEqual([api, pool]);
	});

	it('includes log directories for logs only', () => {
		const logs = resolve('/var/log');
		expect(resolveAllowedRoots({ workspaceRoot: pool, logDirs: [logs] })).toEqual([pool]);
		expect(resolveAllowedRoots({ workspaceRoot: pool, logDirs: [logs], purpose: 'logs' })).toEqual([pool, logs]);
	});

	it('answers inside for a root and its descendants, outside for siblings and escapes', () => {
		const roots = [api];
		expect(isWithinAllowedRoots(api, roots)).toBe(true);
		expect(isWithinAllowedRoots(resolve('/srv/code/api/src/index.ts'), roots)).toBe(true);
		expect(isWithinAllowedRoots(resolve('/srv/code/api-other'), roots)).toBe(false);
		expect(isWithinAllowedRoots(resolve('/srv/code/api/../web'), roots)).toBe(false);
		expect(isWithinAllowedRoots('relative/path', roots)).toBe(false);
	});
});
