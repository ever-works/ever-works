import { afterEach, describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
import { existsSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { promises as fs } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
	execFileWithVerifiedCancellation,
	linuxProcessGroupHasOnlyExitedMembers,
	ProcessTreeTerminationError,
	type ProcFsReader
} from '../verified-exec.js';

const roots: string[] = [];
const ownedPids: number[] = [];

afterEach(async () => {
	for (const pid of ownedPids.splice(0)) {
		if (!isAlive(pid)) continue;
		try {
			if (process.platform === 'win32') {
				execFileSync('taskkill', ['/PID', String(pid), '/T', '/F'], { windowsHide: true });
			} else {
				process.kill(pid, 'SIGKILL');
			}
		} catch {
			// Best effort for a test-owned process after a failed assertion.
		}
	}
	for (const root of roots.splice(0)) {
		await fs.rm(root, { recursive: true, force: true, maxRetries: 3 });
	}
});

describe('verified Git/helper process cancellation', () => {
	it('kills and verifies a real parent plus descendant before reporting AbortError', async () => {
		const root = mkdtempSync(join(tmpdir(), 'ew-git-tree-'));
		roots.push(root);
		const ready = join(root, 'pids.json');
		const script = join(root, 'tree.cjs');
		writeFileSync(
			script,
			`const {spawn}=require('node:child_process');const fs=require('node:fs');` +
				`const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});` +
				`fs.writeFileSync(${JSON.stringify(ready)},JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`
		);
		const controller = new AbortController();
		const pending = execFileWithVerifiedCancellation(process.execPath, [script], {
			signal: controller.signal,
			maxBuffer: 1024 * 1024
		});

		await expect.poll(() => existsSync(ready), { timeout: 2_500 }).toBe(true);
		const pids = JSON.parse(readFileSync(ready, 'utf8')) as number[];
		ownedPids.push(...pids);
		controller.abort(new Error('test cancellation'));
		await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
		await expect.poll(() => pids.every((pid) => !isAlive(pid)), { timeout: 2_500 }).toBe(true);
	});

	it.each([
		['rejects', () => Promise.reject(new Error('whole-tree verifier failed'))],
		['does not settle', () => new Promise<void>(() => undefined)]
	])(
		'quarantines when output overflows and the injected tree terminator %s',
		async (_description, terminateProcessTree) => {
			const root = mkdtempSync(join(tmpdir(), 'ew-git-overflow-'));
			roots.push(root);
			const ready = join(root, 'pid.txt');
			const script = join(root, 'overflow.cjs');
			writeFileSync(
				script,
				`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));` +
					`process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);`
			);

			const pending = execFileWithVerifiedCancellation(process.execPath, [script], {
				maxBuffer: 64,
				terminateProcessTree,
				terminationTimeoutMs: 50
			});
			const rejected = expect(pending).rejects.toEqual(
				expect.objectContaining({
					name: ProcessTreeTerminationError.name,
					message: expect.stringContaining('process output exceeded 64 bytes'),
					cause: expect.objectContaining({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
				})
			);
			await expect.poll(() => existsSync(ready), { timeout: 2_500 }).toBe(true);
			ownedPids.push(Number(readFileSync(ready, 'utf8')));

			await rejected;
		}
	);

	it.each(['rejects', 'does not settle'] as const)(
		'coordinates overflow plus AbortSignal when the first tree terminator %s',
		async (mode) => {
			const root = mkdtempSync(join(tmpdir(), 'ew-git-overflow-abort-'));
			roots.push(root);
			const ready = join(root, 'pid.txt');
			const script = join(root, 'overflow-abort.cjs');
			writeFileSync(
				script,
				`require('node:fs').writeFileSync(${JSON.stringify(ready)},String(process.pid));` +
					`process.stdout.write('x'.repeat(8192));setInterval(()=>{},1000);`
			);
			const controller = new AbortController();
			let terminationCalls = 0;
			const pending = execFileWithVerifiedCancellation(process.execPath, [script], {
				signal: controller.signal,
				maxBuffer: 64,
				terminationTimeoutMs: 50,
				terminateProcessTree: async () => {
					terminationCalls += 1;
					if (terminationCalls > 1) return;
					controller.abort(new Error('operator abort during overflow'));
					if (mode === 'rejects') throw new Error('whole-tree verifier rejected');
					await new Promise<void>(() => undefined);
				}
			});
			const captured = pending.catch((caught: unknown) => caught);

			await expect.poll(() => existsSync(ready), { timeout: 2_500 }).toBe(true);
			ownedPids.push(Number(readFileSync(ready, 'utf8')));
			const error = await captured;

			expect(error).toEqual(
				expect.objectContaining({
					name: ProcessTreeTerminationError.name,
					message: expect.stringContaining('process output exceeded 64 bytes'),
					cause: expect.objectContaining({ code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER' })
				})
			);
			expect((error as Error).message).toContain('operator abort during overflow');
			expect(terminationCalls).toBe(1);
		}
	);
});

describe('a process group whose members all exited (Linux, no reaping PID 1)', () => {
	// Captured from a container whose PID 1 is a plain `sleep` (no init): a detached
	// group led by pid 13 was SIGKILLed; its child 15 was re-parented to PID 1 and is
	// left a zombie in group 13, so `kill(-13, 0)` keeps succeeding (stage 2026-11-05).
	const SELF = '7 (sh) S 0 7 7 0 -1 4194560 1121 541 0 0 5 2 0 0 20 0 1 0 4726693';
	const PID1 = '1 (sleep) S 0 1 1 0 -1 4194560 1078 0 0 0 3 3 0 0 20 0 1 0 4726503';
	const ZOMBIE = '15 (sleep) Z 1 13 13 0 -1 4228108 55 0 0 0 0 0 0 0 20 0 1 0 4726701 0 0';
	const PROC_MOUNT = '591 589 0:115 / /proc rw,nosuid,nodev,noexec,relatime - proc proc rw';

	function reader(
		stats: Record<string, string | NodeJS.ErrnoException>,
		mountinfo = `${PROC_MOUNT}\n`,
		tasks: Record<string, string[] | NodeJS.ErrnoException> = {}
	): ProcFsReader {
		return {
			readdir: (path) => {
				if (path === '/proc') return ['self', 'thread-self', 'sys', ...Object.keys(stats)];
				// A real zombie lists exactly itself under task/ (captured: `task=[13]`).
				const pid = /^\/proc\/(\d+)\/task$/.exec(path)?.[1] ?? '';
				const listed = tasks[pid] ?? (pid in stats ? [pid] : undefined);
				if (listed === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
				if (!Array.isArray(listed)) throw listed;
				return listed;
			},
			readFile: (path) => {
				if (path === '/proc/self/stat') return SELF;
				if (path === '/proc/self/mountinfo') return mountinfo;
				const value = stats[/^\/proc\/(\d+)\/stat$/.exec(path)?.[1] ?? ''];
				if (value === undefined) throw Object.assign(new Error(`ENOENT: ${path}`), { code: 'ENOENT' });
				if (typeof value !== 'string') throw value;
				return value;
			}
		};
	}
	const errno = (code: string) => Object.assign(new Error(code), { code });

	it('calls a group stopped when every member is a zombie', () => {
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 1: PID1, 7: SELF, 15: ZOMBIE }), 7)).toBe(true);
	});

	it('keeps a group alive while any member still runs', () => {
		const live = '16 (git-remote-https) S 15 13 13 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 4726702';
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 1: PID1, 15: ZOMBIE, 16: live }), 7)).toBe(false);
	});

	it('keeps a group alive whose zombie-state leader still has running threads (`Zl`)', () => {
		const tasks = { 15: ['15', '17'] };
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, undefined, tasks), 7)).toBe(false);
		const unreadable = { 15: errno('EACCES') };
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, undefined, unreadable), 7)).toBe(false);
	});

	it('reads the state after the LAST parenthesis, whatever the command name holds', () => {
		const tricky = '16 (a) Z 1 13 13 (b) S 15 13 13 0 -1 4194560 0 0 0 0 0 0 0 0 20 0 1 0 1';
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE, 16: tricky }), 7)).toBe(false);
	});

	it('proves nothing from a group with no listed member', () => {
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 1: PID1, 7: SELF }), 7)).toBe(false);
	});

	it('skips an entry reaped mid-scan, and refuses one it cannot read', () => {
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE, 20: errno('ENOENT') }), 7)).toBe(true);
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE, 20: errno('ESRCH') }), 7)).toBe(true);
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE, 20: errno('EACCES') }), 7)).toBe(false);
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE, 20: 'garbage' }), 7)).toBe(false);
	});

	it('refuses a /proc from another PID namespace', () => {
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }), 4242)).toBe(false);
	});

	it.each(['hidepid=2', 'hidepid=invisible', 'hidepid=1', 'hidepid=noaccess', 'hidepid=ptraceable'])(
		'refuses a /proc mounted with %s (a live member could be hidden)',
		(option) => {
			const superOptions = PROC_MOUNT.replace(/ rw$/, ` rw,${option}`);
			const perMount = PROC_MOUNT.replace('relatime -', `relatime,${option} -`);
			expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, superOptions), 7)).toBe(false);
			expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, perMount), 7)).toBe(false);
		}
	);

	it('accepts hidepid=0 / off, and refuses when no /proc mount is listed at all', () => {
		const off = PROC_MOUNT.replace(/ rw$/, ' rw,hidepid=off');
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, off), 7)).toBe(true);
		const zero = PROC_MOUNT.replace(/ rw$/, ' rw,hidepid=0');
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, zero), 7)).toBe(true);
		const procSub = '600 591 0:115 / /proc/sys ro,nosuid - proc proc rw';
		expect(linuxProcessGroupHasOnlyExitedMembers(13, reader({ 15: ZOMBIE }, procSub), 7)).toBe(false);
	});

	it('refuses when /proc cannot be listed', () => {
		const broken: ProcFsReader = {
			...reader({ 15: ZOMBIE }),
			readdir: () => {
				throw errno('EACCES');
			}
		};
		expect(linuxProcessGroupHasOnlyExitedMembers(13, broken, 7)).toBe(false);
	});
});

/**
 * Whether `pid` can still run. A zombie (state `Z`) has exited; it only waits to be
 * reaped, and a container whose PID 1 reaps nothing (the in-cluster CI runner) keeps
 * a killed, re-parented descendant one forever — `kill(pid, 0)` alone would call it alive.
 */
function isAlive(pid: number): boolean {
	try {
		process.kill(pid, 0);
	} catch (error) {
		return (error as NodeJS.ErrnoException).code !== 'ESRCH';
	}
	if (process.platform !== 'linux') return true;
	try {
		const stat = readFileSync(`/proc/${pid}/stat`, 'utf8');
		const state = stat
			.slice(stat.lastIndexOf(')') + 1)
			.trim()
			.split(/\s+/)[0];
		if (state !== 'Z' && state !== 'X') return true;
		// A zombie-state leader whose other threads still run (`Zl`) is alive.
		return readdirSync(`/proc/${pid}/task`).length > 1;
	} catch {
		// Gone between the two reads, or unreadable: only a vanished entry is "dead".
		return existsSync(`/proc/${pid}`);
	}
}
