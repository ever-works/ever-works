import { describe, expect, it } from 'vitest';
import { join } from 'path';
import {
	AGENT_PROFILE_KEY_FILE,
	AGENT_PROFILE_ROOT_ENV,
	AgentProfileAccessError,
	AgentProfileKeyError,
	AgentProfileManager,
	agentProfileDirName,
	createAgentProfileManager,
	defaultAgentProfileRoot,
	type AgentProfileFs
} from './agent-profile';

const NODE = '11111111-2222-4333-8444-555555555555';
const AGENT_A = 'aaaaaaaa-2222-4333-8444-555555555555';
const AGENT_B = 'bbbbbbbb-2222-4333-8444-555555555555';
const KEY_1 = 'a'.repeat(32);
const KEY_2 = 'b'.repeat(32);
const ROOT = join('/', 'profiles');

/** An in-memory tree: directories as a set, files as a map. */
function memoryFs(): AgentProfileFs & { dirs: Set<string>; files: Map<string, string>; removed: string[] } {
	const dirs = new Set<string>();
	const files = new Map<string, string>();
	const removed: string[] = [];
	const under = (path: string, root: string) =>
		path === root || path.startsWith(`${root}/`) || path.startsWith(`${root}\\`);
	return {
		dirs,
		files,
		removed,
		mkdir: async (path) => {
			dirs.add(path);
		},
		rm: async (path) => {
			removed.push(path);
			for (const dir of [...dirs]) if (under(dir, path)) dirs.delete(dir);
			for (const file of [...files.keys()]) if (under(file, path)) files.delete(file);
		},
		readTextFile: async (path) => files.get(path) ?? null,
		writeTextFile: async (path, content) => {
			files.set(path, content);
		},
		exists: async (path) => dirs.has(path) || files.has(path),
		directorySize: async (path) =>
			[...files.entries()]
				.filter(([file]) => under(file, path))
				.reduce((sum, [, content]) => sum + content.length, 0)
	};
}

describe('agent profile directories', () => {
	it('uses the env override, else a folder under the home directory', () => {
		expect(defaultAgentProfileRoot({ [AGENT_PROFILE_ROOT_ENV]: '/data/profiles' }, '/home/ops')).toBe(
			'/data/profiles'
		);
		expect(defaultAgentProfileRoot({}, '/home/ops')).toBe(join('/home/ops', '.ever-works', 'agent-profiles'));
	});

	it('names one directory per (node, Agent) pair, never shared between Agents', () => {
		expect(agentProfileDirName(NODE, AGENT_A)).toMatch(/^[0-9a-f]{32}$/);
		expect(agentProfileDirName(NODE, AGENT_A)).toBe(agentProfileDirName(NODE, AGENT_A));
		expect(agentProfileDirName(NODE, AGENT_A)).not.toBe(agentProfileDirName(NODE, AGENT_B));
	});

	it('creates the profile lazily with its own browser and file roots, restricted to the owner', async () => {
		const fs = memoryFs();
		const restricted: string[] = [];
		const manager = new AgentProfileManager({
			root: ROOT,
			fs,
			restrictToOwner: (path) => void restricted.push(path)
		});

		const first = await manager.ensure(NODE, AGENT_A, KEY_1);
		expect(first.created).toBe(true);
		expect(first.browserDir).toBe(join(first.dir, 'browser'));
		expect(first.filesDir).toBe(join(first.dir, 'files'));
		expect(fs.files.get(join(first.dir, AGENT_PROFILE_KEY_FILE))).toBe(KEY_1);
		expect(restricted).toEqual([first.dir]);

		const again = await manager.ensure(NODE, AGENT_A, KEY_1);
		expect(again).toMatchObject({ dir: first.dir, created: false, reset: false });
		expect(fs.removed).toEqual([]);
	});

	it('replaces exactly one directory when the platform rotated that Agent’s key, leaving a sibling untouched', async () => {
		const fs = memoryFs();
		const manager = new AgentProfileManager({ root: ROOT, fs });
		const a = await manager.ensure(NODE, AGENT_A, KEY_1);
		const b = await manager.ensure(NODE, AGENT_B, KEY_1);
		fs.files.set(join(a.browserDir, 'Cookies'), 'signed-in');
		fs.files.set(join(b.browserDir, 'Cookies'), 'signed-in');

		const reset = await manager.ensure(NODE, AGENT_A, KEY_2);

		expect(reset).toMatchObject({ created: true, reset: true });
		expect(fs.removed).toEqual([a.dir]);
		expect(fs.files.has(join(a.browserDir, 'Cookies'))).toBe(false);
		expect(fs.files.get(join(b.browserDir, 'Cookies'))).toBe('signed-in');
		expect(fs.files.get(join(b.dir, AGENT_PROFILE_KEY_FILE))).toBe(KEY_1);
	});

	it('refuses a missing or malformed key instead of guessing a directory', async () => {
		const manager = new AgentProfileManager({ root: ROOT, fs: memoryFs() });
		await expect(manager.ensure(NODE, AGENT_A, '')).rejects.toBeInstanceOf(AgentProfileKeyError);
		await expect(manager.ensure(NODE, AGENT_A, '../../etc')).rejects.toBeInstanceOf(AgentProfileKeyError);
	});

	it('still creates the profile when owner-only hardening is unavailable', async () => {
		const manager = new AgentProfileManager({
			root: ROOT,
			fs: memoryFs(),
			restrictToOwner: () => {
				throw new Error('icacls missing');
			}
		});
		await expect(manager.ensure(NODE, AGENT_A, KEY_1)).resolves.toMatchObject({ created: true });
	});

	it('fails closed where owner-only access is required: no hook, or a failing hook, leaves nothing behind', async () => {
		const noHookFs = memoryFs();
		const noHook = new AgentProfileManager({ root: ROOT, fs: noHookFs, requireOwnerOnly: true });
		await expect(noHook.ensure(NODE, AGENT_A, KEY_1)).rejects.toBeInstanceOf(AgentProfileAccessError);
		expect(noHookFs.dirs.size).toBe(0);
		expect(noHookFs.files.size).toBe(0);

		const failingFs = memoryFs();
		const failing = new AgentProfileManager({
			root: ROOT,
			fs: failingFs,
			requireOwnerOnly: true,
			restrictToOwner: async () => {
				throw new Error('icacls failed');
			}
		});
		await expect(failing.ensure(NODE, AGENT_A, KEY_1)).rejects.toThrow(/icacls failed/);
		expect(failingFs.dirs.size).toBe(0);
		expect(failingFs.files.size).toBe(0);
	});

	it('requires owner-only access on Windows and keeps it best-effort elsewhere', async () => {
		const windows = createAgentProfileManager({ root: ROOT, fs: memoryFs(), platform: 'win32' });
		await expect(windows.ensure(NODE, AGENT_A, KEY_1)).rejects.toBeInstanceOf(AgentProfileAccessError);

		const restricted: string[] = [];
		const windowsWithAcl = createAgentProfileManager({
			root: ROOT,
			fs: memoryFs(),
			platform: 'win32',
			restrictToOwner: (path) => void restricted.push(path)
		});
		const profile = await windowsWithAcl.ensure(NODE, AGENT_A, KEY_1);
		expect(restricted).toEqual([profile.dir]);

		const linux = createAgentProfileManager({ root: ROOT, fs: memoryFs(), platform: 'linux' });
		await expect(linux.ensure(NODE, AGENT_A, KEY_1)).resolves.toMatchObject({ created: true });
	});

	it('serializes opens of one profile: a stale-key open cannot resume after a reset and write its key back', async () => {
		const fs = memoryFs();
		const manager = new AgentProfileManager({ root: ROOT, fs });
		const first = await manager.ensure(NODE, AGENT_A, KEY_1);

		// Hold the old-key open inside its critical section (between reading the
		// stored key and publishing its own) while the rotated-key open arrives.
		let releaseOld: () => void = () => undefined;
		const oldHeld = new Promise<void>((resolve) => {
			releaseOld = resolve;
		});
		const realRead = fs.readTextFile;
		let reads = 0;
		fs.readTextFile = async (path) => {
			reads += 1;
			const value = await realRead(path);
			if (reads === 1) await oldHeld;
			return value;
		};

		const stale = manager.ensure(NODE, AGENT_A, KEY_1);
		const rotated = manager.ensure(NODE, AGENT_A, KEY_2);
		await new Promise((resolve) => setTimeout(resolve, 10));
		// The rotated open is queued behind the held one, not interleaved with it.
		expect(reads).toBe(1);
		releaseOld();

		await expect(stale).resolves.toMatchObject({ created: false, reset: false });
		await expect(rotated).resolves.toMatchObject({ created: true, reset: true });
		expect(fs.files.get(join(first.dir, AGENT_PROFILE_KEY_FILE))).toBe(KEY_2);

		// The next open with the current key keeps the fresh profile.
		fs.files.set(join(first.browserDir, 'Cookies'), 'signed-in');
		await expect(manager.ensure(NODE, AGENT_A, KEY_2)).resolves.toMatchObject({ created: false, reset: false });
		expect(fs.files.get(join(first.browserDir, 'Cookies'))).toBe('signed-in');
	});

	it('does not hold one Agent’s open behind a different Agent’s', async () => {
		const fs = memoryFs();
		const manager = new AgentProfileManager({ root: ROOT, fs });
		let releaseA: () => void = () => undefined;
		const aHeld = new Promise<void>((resolve) => {
			releaseA = resolve;
		});
		const realExists = fs.exists;
		const aDir = join(ROOT, agentProfileDirName(NODE, AGENT_A));
		fs.exists = async (path) => {
			if (path === aDir) await aHeld;
			return realExists(path);
		};
		const a = manager.ensure(NODE, AGENT_A, KEY_1);
		await expect(manager.ensure(NODE, AGENT_B, KEY_1)).resolves.toMatchObject({ created: true });
		releaseA();
		await expect(a).resolves.toMatchObject({ created: true });
	});

	it('keeps serving a profile after an open of it failed', async () => {
		const fs = memoryFs();
		let fail = true;
		const manager = new AgentProfileManager({
			root: ROOT,
			fs,
			requireOwnerOnly: true,
			restrictToOwner: () => {
				if (fail) throw new Error('icacls failed');
			}
		});
		await expect(manager.ensure(NODE, AGENT_A, KEY_1)).rejects.toBeInstanceOf(AgentProfileAccessError);
		fail = false;
		await expect(manager.ensure(NODE, AGENT_A, KEY_1)).resolves.toMatchObject({ created: true });
	});

	it('reports the disk a profile occupies, and zero for one that does not exist', async () => {
		const fs = memoryFs();
		const manager = new AgentProfileManager({ root: ROOT, fs });
		expect(await manager.diskBytes(NODE, AGENT_A)).toBe(0);
		const profile = await manager.ensure(NODE, AGENT_A, KEY_1);
		fs.files.set(join(profile.filesDir, 'report.csv'), 'x'.repeat(100));
		expect(await manager.diskBytes(NODE, AGENT_A)).toBe(100 + KEY_1.length);
	});
});
