import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import {
	CheckoutRegistryStore,
	emptyCheckoutRegistry,
	mergeDiscovery,
	parseCheckoutRegistry
} from './checkout-registry';

describe('checkout registry (FL-14 T-06)', () => {
	it('keeps entries discovery did not find this time, so a removed folder reads missing (spec S10)', () => {
		const first = mergeDiscovery(emptyCheckoutRegistry(), ['/code/api', '/code/web'], false, 't1');
		const second = mergeDiscovery(first, ['/code/web', '/code/cli'], false, 't2');
		expect(second.entries.map((entry) => entry.path)).toEqual(['/code/api', '/code/web', '/code/cli']);
		expect(second.scannedAt).toBe('t2');
		expect(second.entries.every((entry) => entry.kind === 'discovered' && entry.origin === 'discovery')).toBe(
			true
		);
	});

	it('never registers one path twice (spec U13)', () => {
		const state = mergeDiscovery(emptyCheckoutRegistry(), ['/code/api', '/code/api'], false, 't');
		expect(state.entries).toHaveLength(1);
	});

	it('reads a corrupted file as unreadable, never as a crash', () => {
		expect(parseCheckoutRegistry('{not json')).toBeNull();
		expect(parseCheckoutRegistry(JSON.stringify({ version: 2, entries: [] }))).toBeNull();
		const parsed = parseCheckoutRegistry(
			JSON.stringify({
				version: 1,
				scannedAt: null,
				entries: [
					{ path: '/code/api', kind: 'discovered', origin: 'discovery' },
					{ path: 'relative/path', kind: 'discovered', origin: 'discovery' },
					{ path: '/code/web', kind: 'bogus', origin: 'discovery' }
				]
			})
		);
		expect(parsed?.entries.map((entry) => entry.path)).toEqual(['/code/api']);
	});

	it('loads an empty registry, with a warning, from a file it cannot parse; saves and reloads', async () => {
		const dir = await mkdtemp(join(tmpdir(), 'fl14-registry-'));
		try {
			const file = join(dir, 'checkouts.json');
			await writeFile(file, 'garbage');
			const warnings: string[] = [];
			const store = new CheckoutRegistryStore(file, (message) => warnings.push(message));
			expect((await store.load()).entries).toEqual([]);
			expect(warnings).toHaveLength(1);
			const state = mergeDiscovery(emptyCheckoutRegistry(), ['/code/api'], true, '2026-10-21T00:00:00.000Z');
			await store.save(state);
			expect(JSON.parse(await readFile(file, 'utf8')).truncated).toBe(true);
			expect((await store.load()).entries[0]?.path).toBe('/code/api');
		} finally {
			await rm(dir, { recursive: true, force: true });
		}
	});
});
