import { describe, expect, it, vi } from 'vitest';
import type { ConfigFileSystem } from './config-store';
import { createConfigWorkerSafetyGate, workerSafetyMarkerPath } from './worker-safety-store';

const CONFIG_PATH = 'C:/Users/worker/AppData/Roaming/ever-works-node/node-config.json';
const MARKER_PATH = `${CONFIG_PATH}.worker-session`;

function memoryFs() {
	const files = new Map<string, string>();
	const creates: string[] = [];
	const removes: string[] = [];
	const restrictions: string[] = [];
	let createFailure: 'none' | 'before' | 'partial' = 'none';

	const fs: ConfigFileSystem = {
		readFile: async (filePath) => files.get(filePath) ?? null,
		writeFile: async (filePath, content) => void files.set(filePath, content),
		createFileExclusive: async (filePath, content) => {
			creates.push(filePath);
			if (files.has(filePath)) throw Object.assign(new Error('already exists'), { code: 'EEXIST' });
			if (createFailure === 'before') throw Object.assign(new Error('disk unavailable'), { code: 'EIO' });
			if (createFailure === 'partial') {
				files.set(filePath, '');
				throw Object.assign(new Error('crash during marker write'), { code: 'EIO' });
			}
			files.set(filePath, content);
		},
		mkdir: async () => undefined,
		chmod: async () => undefined,
		restrict: async (filePath) => void restrictions.push(filePath),
		remove: async (filePath) => {
			removes.push(filePath);
			files.delete(filePath);
		},
		dirname: (filePath) => filePath.replace(/[\\/][^\\/]*$/, '')
	};

	return {
		fs,
		files,
		creates,
		removes,
		restrictions,
		failCreate: (failure: typeof createFailure) => (createFailure = failure)
	};
}

function gate(fs: ConfigFileSystem, sessionId: string) {
	return createConfigWorkerSafetyGate(fs, CONFIG_PATH, {
		platform: 'win32',
		now: () => Date.parse('2026-08-22T23:45:00.000Z'),
		createSessionId: () => sessionId
	});
}

describe('config-backed worker safety gate', () => {
	it('atomically arms an owner-only marker before work and blocks a reconstructed worker', async () => {
		const h = memoryFs();
		const first = gate(h.fs, 'session-first');

		await expect(first.acquire()).resolves.toEqual({ kind: 'acquired', sessionId: 'session-first' });
		expect(h.creates).toEqual([MARKER_PATH]);
		expect(h.restrictions).toEqual([MARKER_PATH]);
		expect(h.files.get(MARKER_PATH)).toContain('session-first');

		await expect(gate(h.fs, 'session-second').acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/previous worker session/i) }
		});
		expect(h.creates).toEqual([MARKER_PATH]);
	});

	it('treats corrupt and partially-written markers as durable quarantine', async () => {
		const corrupt = memoryFs();
		corrupt.files.set(MARKER_PATH, '{partial');
		await expect(gate(corrupt.fs, 'never-created').acquire()).resolves.toMatchObject({
			kind: 'blocked',
			state: { reason: expect.stringMatching(/unreadable|corrupt|incomplete/i) }
		});
		expect(corrupt.creates).toEqual([]);

		const partial = memoryFs();
		partial.failCreate('partial');
		await expect(gate(partial.fs, 'partial-session').acquire()).resolves.toMatchObject({
			kind: 'blocked'
		});
		expect(partial.files.has(MARKER_PATH)).toBe(true);
	});

	it('fails before leasing when exclusive durable marker creation cannot be proven', async () => {
		const h = memoryFs();
		h.failCreate('before');

		await expect(gate(h.fs, 'not-durable').acquire()).rejects.toThrow(/durably arm|safety prerequisite/i);
		expect(h.files.has(MARKER_PATH)).toBe(false);
	});

	it('releases only the exact owning session and supports explicit operator clearance', async () => {
		const h = memoryFs();
		const owner = gate(h.fs, 'owner-session');
		await owner.acquire();

		await expect(owner.release('different-session')).rejects.toThrow(/does not own/i);
		expect(h.files.has(MARKER_PATH)).toBe(true);
		await expect(owner.release('owner-session')).resolves.toBeUndefined();
		expect(h.files.has(MARKER_PATH)).toBe(false);

		h.files.set(MARKER_PATH, 'crash-partial');
		await expect(owner.clear()).resolves.toBeUndefined();
		expect(h.files.has(MARKER_PATH)).toBe(false);
		expect(h.removes).toEqual([MARKER_PATH, MARKER_PATH]);
	});

	it('leaves the marker fail-closed if owner-only restriction fails', async () => {
		const h = memoryFs();
		h.fs.restrict = vi.fn(async () => {
			throw new Error('ACL update failed');
		});

		await expect(gate(h.fs, 'acl-session').acquire()).rejects.toThrow(/owner-only|ACL update failed/i);
		expect(h.files.has(workerSafetyMarkerPath(CONFIG_PATH))).toBe(true);
		await expect(gate(h.fs, 'retry-session').acquire()).resolves.toMatchObject({ kind: 'blocked' });
	});
});
