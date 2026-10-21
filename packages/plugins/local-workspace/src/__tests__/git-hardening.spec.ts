import { describe, expect, it } from 'vitest';
import {
	checkoutHardeningEntries,
	checkoutHardeningEnv,
	finalizeHardeningEntries,
	gitConfigEnvOverlay,
	parseFilterDriverConfig
} from '../git-hardening.js';

/**
 * works-security finding 3 (fleet node 0.2.7) — the pure half of the
 * checkout / finalize hardening. The real-Git half (a planted hook and filter
 * driver that must NOT run) is in `local-workspace.hardening.spec.ts`.
 */

const PROBE = [
	'system\tfilter.lfs.clean git-lfs clean -- %f',
	'system\tfilter.lfs.smudge git-lfs smudge -- %f',
	'system\tfilter.lfs.process git-lfs filter-process',
	'system\tfilter.lfs.required true',
	'local\tfilter.lfs.process sh ./evil.sh',
	'local\tfilter.evil.smudge sh -c "touch pwned"; cat',
	'local\tfilter.evil.required',
	'global\tfilter.dotted.name.clean cat',
	'local\tfilter.ignored.textconv nope',
	'garbage line without a tab'
].join('\n');

describe('parseFilterDriverConfig', () => {
	it('reads scope, driver (dots included), key and value; skips what Git would not use', () => {
		const entries = parseFilterDriverConfig(PROBE);
		expect(entries).toContainEqual({
			scope: 'local',
			driver: 'evil',
			key: 'smudge',
			value: 'sh -c "touch pwned"; cat'
		});
		expect(entries).toContainEqual({ scope: 'local', driver: 'evil', key: 'required', value: '' });
		expect(entries).toContainEqual({ scope: 'global', driver: 'dotted.name', key: 'clean', value: 'cat' });
		expect(entries.some((entry) => entry.key === 'textconv')).toBe(false);
		expect(entries).toHaveLength(8);
	});
});

describe('checkoutHardeningEntries', () => {
	it('empties every driver it saw — and lfs even when it saw none — and switches off hooks, fsmonitor, ext and submodule recursion', () => {
		const entries = new Map(checkoutHardeningEntries('C:\\tmp\\no-hooks', parseFilterDriverConfig(PROBE)));
		expect(entries.get('core.hooksPath')).toBe('C:/tmp/no-hooks');
		expect(entries.get('core.fsmonitor')).toBe('false');
		expect(entries.get('protocol.ext.allow')).toBe('never');
		expect(entries.get('submodule.recurse')).toBe('false');
		for (const driver of ['lfs', 'evil', 'dotted.name']) {
			expect(entries.get(`filter.${driver}.smudge`)).toBe('');
			expect(entries.get(`filter.${driver}.clean`)).toBe('');
			expect(entries.get(`filter.${driver}.process`)).toBe('');
			expect(entries.get(`filter.${driver}.required`)).toBe('false');
		}
		const bare = new Map(checkoutHardeningEntries('/tmp/h', []));
		expect(bare.get('filter.lfs.process')).toBe('');
		expect(bare.has('core.symlinks')).toBe(false);
	});

	it('also tells git-lfs to skip the smudge', () => {
		expect(checkoutHardeningEnv('/tmp/h', [], {}).GIT_LFS_SKIP_SMUDGE).toBe('1');
	});
});

describe('finalizeHardeningEntries', () => {
	it("pins a driver a repository-writable scope touched back to the operator's definition", () => {
		const entries = new Map(finalizeHardeningEntries('/tmp/h', parseFilterDriverConfig(PROBE)));
		// lfs: the pool config overrode `process`; every key goes back to the system values.
		expect(entries.get('filter.lfs.process')).toBe('git-lfs filter-process');
		expect(entries.get('filter.lfs.clean')).toBe('git-lfs clean -- %f');
		expect(entries.get('filter.lfs.required')).toBe('true');
		// evil: defined only in the pool config — emptied, not required.
		expect(entries.get('filter.evil.smudge')).toBe('');
		expect(entries.get('filter.evil.clean')).toBe('');
		expect(entries.get('filter.evil.process')).toBe('');
		expect(entries.get('filter.evil.required')).toBe('false');
		// dotted.name: only the operator defined it — left exactly as it is.
		expect(entries.has('filter.dotted.name.clean')).toBe(false);
		expect(entries.get('core.hooksPath')).toBe('/tmp/h');
		expect(entries.get('core.fsmonitor')).toBe('false');
	});

	it('adds nothing for a repository whose drivers all come from the operator', () => {
		const trusted = parseFilterDriverConfig('system\tfilter.lfs.process git-lfs filter-process');
		expect(finalizeHardeningEntries('/tmp/h', trusted)).toHaveLength(2);
	});
});

describe('gitConfigEnvOverlay', () => {
	it('appends after an inherited GIT_CONFIG_COUNT so an operator pin survives and ours win', () => {
		expect(gitConfigEnvOverlay([['core.fsmonitor', 'false']], { GIT_CONFIG_COUNT: '2' })).toEqual({
			GIT_CONFIG_COUNT: '3',
			GIT_CONFIG_KEY_2: 'core.fsmonitor',
			GIT_CONFIG_VALUE_2: 'false'
		});
		expect(gitConfigEnvOverlay([['a.b', 'c']], { GIT_CONFIG_COUNT: 'junk' }).GIT_CONFIG_KEY_0).toBe('a.b');
	});
});
