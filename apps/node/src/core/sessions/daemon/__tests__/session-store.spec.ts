import * as fsp from 'node:fs/promises';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { nodeSessionStoreFs, parseStoredSession, SessionStore, type StoredSession } from '../session-store';

/**
 * What the daemon remembers on disk (spec FR-8, FR-9, U15; ACC-FL04-13).
 */

const record = (overrides: Partial<StoredSession> = {}): StoredSession => ({
	version: 1,
	id: 's1',
	kind: 'owner',
	provider: 'shell',
	cwd: '/home/dana',
	title: '~',
	startedAt: '2026-10-18T09:41:00.000Z',
	startedBy: 'user:u1',
	cols: 120,
	rows: 32,
	endedAt: null,
	exitCode: null,
	endReason: null,
	...overrides
});

describe('SessionStore', () => {
	let dir: string;

	beforeEach(async () => {
		dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'ewn-store-'));
	});

	afterEach(async () => {
		await fsp.rm(dir, { recursive: true, force: true });
	});

	it('round-trips records and screens, and a rename survives a reload (FR-19)', async () => {
		const store = new SessionStore(dir);
		expect(await store.save(record())).toBe(true);
		expect(await store.saveScreen('s1', 'line 1\nline 2')).toBe(true);
		expect(await store.save(record({ title: 'api tests' }))).toBe(true);
		const loaded = await new SessionStore(dir).load();
		expect(loaded).toEqual([{ record: record({ title: 'api tests' }), screen: 'line 1\nline 2' }]);
		expect(store.storage).toBe('ok');
	});

	it('writes atomically: a crash between write and rename leaves the previous record', async () => {
		const store = new SessionStore(dir);
		await store.save(record({ title: 'first' }));
		let renames = 0;
		const crashing = new SessionStore(dir, {
			...nodeSessionStoreFs,
			rename: async (from, to) => {
				renames += 1;
				throw Object.assign(new Error('crash'), { from, to });
			}
		});
		expect(await crashing.save(record({ title: 'second' }))).toBe(false);
		expect(renames).toBe(1);
		const [loaded] = await new SessionStore(dir).load();
		expect(loaded.record.title).toBe('first');
		// The temp file was cleaned up; nothing half-written remains.
		const names = await fsp.readdir(path.join(dir, 'records'));
		expect(names.filter((name) => name.endsWith('.tmp'))).toEqual([]);
	});

	it('reports a full disk and keeps working when space returns (U15)', async () => {
		let full = true;
		const store = new SessionStore(dir, {
			...nodeSessionStoreFs,
			writeFile: async (file, content) => {
				if (full) throw Object.assign(new Error('ENOSPC: no space left on device'), { code: 'ENOSPC' });
				await nodeSessionStoreFs.writeFile(file, content);
			}
		});
		expect(await store.save(record())).toBe(false);
		expect(store.storage).toBe('failing');
		full = false;
		expect(await store.save(record())).toBe(true);
		expect(store.storage).toBe('ok');
	});

	it('forgets an acknowledged session, files and all', async () => {
		const store = new SessionStore(dir);
		await store.save(record());
		await store.saveScreen('s1', 'x');
		await store.forget('s1');
		expect(await store.load()).toEqual([]);
		expect(await fsp.readdir(path.join(dir, 'records'))).toEqual([]);
	});

	it('skips corrupted and foreign files', async () => {
		const store = new SessionStore(dir);
		await store.save(record());
		await fsp.writeFile(path.join(dir, 'records', 'broken.json'), '{ nope');
		await fsp.writeFile(path.join(dir, 'records', 'other.json'), JSON.stringify({ version: 2 }));
		await fsp.writeFile(path.join(dir, 'records', '..evil.json'), JSON.stringify(record({ id: '..evil' })));
		const loaded = await store.load();
		expect(loaded.map((entry) => entry.record.id)).toEqual(['s1']);
	});

	it('parses only valid records', () => {
		expect(parseStoredSession(JSON.stringify(record()))).toEqual(record());
		expect(parseStoredSession(JSON.stringify({ ...record(), kind: 'root' }))).toBeNull();
		expect(parseStoredSession(JSON.stringify({ ...record(), startedBy: 'nobody' }))).toBeNull();
		expect(parseStoredSession(null)).toBeNull();
	});
});
