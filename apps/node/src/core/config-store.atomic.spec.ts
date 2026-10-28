import { describe, expect, it, vi } from 'vitest';
import { killableDisk, type DiskOp, type KillableDisk } from './__fixtures__/killable-disk';
import { clearConfig, configBackupPath, loadConfig, saveConfig } from './config-store';
import { createLogger, type LogEntry } from './logger';
import type { SecretStore } from './secret-store';
import { clampResourceLimits, DEFAULT_HEARTBEAT_INTERVAL_MS, type NodeConfig } from './types';

/**
 * 2026-10-28 incident: `saveConfig` rewrote `node-config.json` IN PLACE
 * (truncate, then write). A node force-stopped mid-write was left with a
 * 0-byte config, which reads as "not enrolled", so the node could not start;
 * with an inline credential the machine would have had to re-enroll.
 *
 * These specs drive the store over a disk that can be killed at any step
 * (see `killable-disk.ts`).
 */

const DIR = 'C:/Users/owner/AppData/Roaming/ever-works-node';
const CONFIG = `${DIR}/node-config.json`;
const BACKUP = `${CONFIG}.bak`;
const OLD_SECRET = 'b2xkLXNlY3JldC12YWx1ZS1mb3ItdW5pdC10ZXN0cw';
const NEW_SECRET = 'bmV3LXNlY3JldC12YWx1ZS1mb3ItdW5pdC10ZXN0cw';
const NOW = Date.parse('2026-10-28T11:06:58.000Z');

function config(overrides: Partial<NodeConfig> = {}): NodeConfig {
	return {
		apiUrl: 'https://api.ever.works',
		nodeId: '11111111-2222-4333-8444-555555555555',
		secret: OLD_SECRET,
		kind: 'node',
		capabilities: ['os:windows'],
		heartbeatIntervalMs: DEFAULT_HEARTBEAT_INTERVAL_MS,
		enrolledAt: '2026-10-01T10:00:00.000Z',
		paused: false,
		secretStorage: 'file',
		limits: clampResourceLimits(undefined),
		...overrides
	};
}

/** Exactly what `saveConfig` writes for an inline-secret config. */
function serialized(value: NodeConfig): string {
	return `${JSON.stringify({ ...value, secretStorage: 'file' }, null, '\t')}\n`;
}

function capturingLogger() {
	const entries: LogEntry[] = [];
	return { logger: createLogger({ sink: (entry) => entries.push(entry) }), entries };
}

/** "Restart": a fresh process over whatever the killed one left on disk. */
function restart(h: KillableDisk): KillableDisk {
	return killableDisk({}, { files: h.files, mtimes: h.mtimes, now: () => NOW });
}

/** Every op that put the credential into a file, with the path it landed in. */
function secretWrites(ops: DiskOp[], secret: string): Array<{ index: number; op: DiskOp }> {
	return ops.map((op, index) => ({ index, op })).filter(({ op }) => op.content?.includes(secret));
}

describe('saveConfig writes atomically (2026-10-28: a kill mid-write left a 0-byte config)', () => {
	it('a kill after the temp file is written but before the rename leaves the old config intact', async () => {
		const old = serialized(config());
		const h = killableDisk({ [CONFIG]: old }, { now: () => NOW });
		h.killAt((op) => (op.op === 'rename' ? 'kill' : null));

		void saveConfig(h.fs, CONFIG, config({ secret: NEW_SECRET, paused: true }), { platform: 'win32' });
		await vi.waitFor(() => expect(h.killed).toBe(true), { timeout: 500 });

		expect(h.files.get(CONFIG)).toBe(old);
		// The new content was complete — only the swap was lost.
		expect(h.temps()).toHaveLength(1);
		expect(h.files.get(h.temps()[0])).toContain(NEW_SECRET);

		const reloaded = await loadConfig(restart(h).fs, CONFIG);
		expect(reloaded).toMatchObject({ secret: OLD_SECRET, paused: false });
	});

	it('a kill halfway through writing leaves the old config intact', async () => {
		const old = serialized(config());
		const h = killableDisk({ [CONFIG]: old }, { now: () => NOW });
		h.killAt((op) =>
			(op.op === 'write' || op.op === 'writeInPlace') && op.content?.includes(NEW_SECRET) ? 'partial' : null
		);

		void saveConfig(h.fs, CONFIG, config({ secret: NEW_SECRET, paused: true }), { platform: 'win32' });
		await vi.waitFor(() => expect(h.killed).toBe(true), { timeout: 500 });

		expect(h.files.get(CONFIG)).toBe(old);
		await expect(loadConfig(restart(h).fs, CONFIG)).resolves.toMatchObject({ secret: OLD_SECRET });
	});

	it('Windows: the owner-only ACL lands on the EMPTY temp file before the credential is written into it', async () => {
		const h = killableDisk({}, { now: () => NOW });

		await saveConfig(h.fs, CONFIG, config({ secret: NEW_SECRET }), { platform: 'win32' });

		const writes = secretWrites(h.ops, NEW_SECRET);
		// The config and its last-good copy — never the target path itself.
		expect(writes.map(({ op }) => op.path)).not.toContain(CONFIG);
		expect(writes.length).toBeGreaterThanOrEqual(2);
		for (const { index, op } of writes) {
			expect(op.op).toBe('write');
			const before = h.ops.slice(0, index);
			expect(before).toContainEqual({ op: 'create', path: op.path, content: '' });
			const restricted = before.findIndex((earlier) => earlier.op === 'restrict' && earlier.path === op.path);
			const created = before.findIndex((earlier) => earlier.op === 'create' && earlier.path === op.path);
			expect(restricted).toBeGreaterThan(created);
		}
		// The renamed files keep the ACL the temp was given.
		expect(h.acl.get(CONFIG)).toBe('owner-only');
		expect(h.acl.get(BACKUP)).toBe('owner-only');
		expect(h.temps()).toEqual([]);
	});

	it('POSIX: the temp file is created 0600 and chmod-ed before the credential reaches it; the renamed file keeps 0600', async () => {
		const path = '/home/owner/.config/ever-works-node/node-config.json';
		const h = killableDisk({}, { now: () => NOW });

		await saveConfig(h.fs, path, config({ secret: NEW_SECRET }), { platform: 'linux' });

		const writes = secretWrites(h.ops, NEW_SECRET);
		expect(writes.map(({ op }) => op.path)).not.toContain(path);
		for (const { index, op } of writes) {
			const before = h.ops.slice(0, index);
			expect(before).toContainEqual({ op: 'create', path: op.path, content: '' });
			expect(before).toContainEqual({ op: 'chmod', path: op.path, mode: 0o600 });
		}
		expect(h.modes.get(path)).toBe(0o600);
		expect(h.modes.get(`${path}.bak`)).toBe(0o600);
		// POSIX: the directory entry is flushed after the rename.
		expect(h.ops.filter((op) => op.op === 'syncDir').map((op) => op.path)).toContain(
			'/home/owner/.config/ever-works-node'
		);
	});

	it('retries the rename while Windows reports the old config busy', async () => {
		const h = killableDisk({ [CONFIG]: serialized(config()) }, { now: () => NOW });
		h.failRenames('EBUSY', 'EPERM');

		await saveConfig(h.fs, CONFIG, config({ secret: NEW_SECRET }), { platform: 'win32' });

		expect(h.ops.filter((op) => op.op === 'rename' && op.to === CONFIG)).toHaveLength(3);
		expect(h.files.get(CONFIG)).toContain(NEW_SECRET);
		expect(h.temps()).toEqual([]);
	});

	it('still falls back to the in-place write for a filesystem without the atomic primitives', async () => {
		const h = killableDisk({}, { legacy: true });

		await saveConfig(h.fs, CONFIG, config(), { platform: 'win32' });

		expect(h.ops.map((op) => op.op)).toEqual(['mkdir', 'writeInPlace', 'restrict']);
		await expect(loadConfig(h.fs, CONFIG)).resolves.toMatchObject({ secret: OLD_SECRET });
	});
});

describe('loadConfig and stray temp files', () => {
	const stale = NOW - 10 * 60_000;
	const fresh = NOW - 5_000;

	it('never reads a stray temp file as the config, and removes only the stale ones it owns', async () => {
		const strays = {
			staleConfigTemp: `${CONFIG}.4242.0123456789ab.tmp`,
			freshLifecycleTemp: `${CONFIG}.lifecycle.json.4243.0123456789ab.tmp`,
			staleBackupTemp: `${CONFIG}.bak.4244.0123456789ab.tmp`,
			notOurs: `${DIR}/helper-policy.json.6f1c0d6e-1111-4222-8333-944444444444.tmp`,
			unrelated: `${DIR}/notes.tmp`
		};
		const h = killableDisk(
			{
				[CONFIG]: serialized(config()),
				[strays.staleConfigTemp]: serialized(config({ secret: NEW_SECRET })),
				[strays.freshLifecycleTemp]: '{}',
				[strays.staleBackupTemp]: serialized(config({ secret: NEW_SECRET })),
				[strays.notOurs]: '{}',
				[strays.unrelated]: 'x'
			},
			{ now: () => NOW }
		);
		for (const path of Object.values(strays)) h.mtimes.set(path, stale);
		h.mtimes.set(strays.freshLifecycleTemp, fresh);

		const loaded = await loadConfig(h.fs, CONFIG, { now: () => NOW });

		expect(loaded?.secret).toBe(OLD_SECRET);
		expect(h.files.has(strays.staleConfigTemp)).toBe(false);
		expect(h.files.has(strays.staleBackupTemp)).toBe(false);
		// Possibly another process's write in flight.
		expect(h.files.has(strays.freshLifecycleTemp)).toBe(true);
		// Not this config's files.
		expect(h.files.has(strays.notOurs)).toBe(true);
		expect(h.files.has(strays.unrelated)).toBe(true);
	});

	it('a torn config with only a temp file beside it reads as not enrolled — a temp is never promoted', async () => {
		const h = killableDisk(
			{ [CONFIG]: '', [`${CONFIG}.4242.0123456789ab.tmp`]: serialized(config({ secret: NEW_SECRET })) },
			{ now: () => NOW }
		);

		await expect(loadConfig(h.fs, CONFIG, { now: () => NOW })).resolves.toBeNull();
	});
});

describe('the last-good copy (node-config.json.bak)', () => {
	it('is refreshed on every save, through the same owner-only path', async () => {
		const h = killableDisk({}, { now: () => NOW });

		await saveConfig(h.fs, CONFIG, config({ paused: true }), { platform: 'win32' });

		expect(configBackupPath(CONFIG)).toBe(BACKUP);
		expect(h.files.get(BACKUP)).toBe(h.files.get(CONFIG));
		expect(h.acl.get(BACKUP)).toBe('owner-only');
		// Written after the config itself: a kill between the two leaves an
		// up-to-date config and an older copy, never the reverse.
		const renames = h.ops.filter((op) => op.op === 'rename').map((op) => op.to);
		expect(renames).toEqual([CONFIG, BACKUP]);
	});

	it('recovers an EMPTY config (the incident) from the copy and says so', async () => {
		const h = killableDisk({ [CONFIG]: '', [BACKUP]: serialized(config({ paused: true })) }, { now: () => NOW });
		const { logger, entries } = capturingLogger();

		const loaded = await loadConfig(h.fs, CONFIG, { logger, now: () => NOW });

		expect(loaded).toMatchObject({ secret: OLD_SECRET, paused: true });
		const warning = entries.find((entry) => entry.level === 'warn' && entry.message.includes(BACKUP));
		expect(warning?.message).toMatch(/is empty/);
		expect(warning?.message).toMatch(/last good copy/i);
		// Reading never writes: the next save rewrites the config.
		expect(h.files.get(CONFIG)).toBe('');
	});

	it('recovers a truncated config (invalid JSON) too, and a keychain-backed one fetches its credential', async () => {
		const keychainStored = `${JSON.stringify({ ...config(), secret: '', secretStorage: 'keychain' }, null, '\t')}\n`;
		const h = killableDisk({ [CONFIG]: keychainStored.slice(0, 40), [BACKUP]: keychainStored }, { now: () => NOW });
		const secrets: SecretStore = {
			label: 'test keychain',
			get: async () => OLD_SECRET,
			set: async () => undefined,
			delete: async () => undefined
		};

		await expect(loadConfig(h.fs, CONFIG, { secrets, now: () => NOW })).resolves.toMatchObject({
			secret: OLD_SECRET,
			secretStorage: 'keychain'
		});
	});

	it('never resurrects a config that is MISSING or deliberately cleared', async () => {
		const missing = killableDisk({ [BACKUP]: serialized(config()) }, { now: () => NOW });
		await expect(loadConfig(missing.fs, CONFIG, { now: () => NOW })).resolves.toBeNull();

		const cleared = killableDisk({ [CONFIG]: '{}\n', [BACKUP]: serialized(config()) }, { now: () => NOW });
		await expect(loadConfig(cleared.fs, CONFIG, { now: () => NOW })).resolves.toBeNull();
	});

	it('is not written — and a stale one is removed — when an inline credential could not be made owner-only', async () => {
		const h = killableDisk({ [BACKUP]: serialized(config()) }, { now: () => NOW });
		h.failRestrict(new Error('icacls exited 5: Access is denied.'));
		const { logger, entries } = capturingLogger();

		await saveConfig(h.fs, CONFIG, config({ secret: NEW_SECRET }), { platform: 'win32', logger });

		expect(h.files.get(CONFIG)).toContain(NEW_SECRET);
		expect(h.files.has(BACKUP)).toBe(false);
		expect(h.ops.some((op) => op.content?.includes(NEW_SECRET) && op.path.startsWith(`${BACKUP}.`))).toBe(false);
		expect(entries.some((entry) => entry.level === 'warn' && entry.message.includes(CONFIG))).toBe(true);
	});

	it('is erased by unenroll before the config, along with any stray temp that may hold the credential', async () => {
		const temp = `${CONFIG}.4242.0123456789ab.tmp`;
		const h = killableDisk(
			{
				[CONFIG]: serialized(config()),
				[BACKUP]: serialized(config()),
				[temp]: serialized(config({ secret: NEW_SECRET }))
			},
			{ now: () => NOW }
		);
		h.mtimes.set(temp, NOW - 1_000);

		await clearConfig(h.fs, CONFIG, config());

		expect([...h.files.keys()]).toEqual([]);
		const removed = h.ops.filter((op) => op.op === 'remove').map((op) => op.path);
		expect(removed.indexOf(BACKUP)).toBeLessThan(removed.indexOf(CONFIG));
	});
});
