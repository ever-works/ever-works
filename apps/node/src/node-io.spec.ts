import { describe, expect, it, vi } from 'vitest';
import { isProbeTimedOut, ProbeTimedOutError } from './core/boot-retry';
import type { CommandRunner } from './core/capabilities';
import {
	createCommandRunner,
	planProbeSpawn,
	restrictFileToOwnerWindowsWithRetry,
	searchPathWithRetry,
	windowsAclUser,
	windowsSystemRoot,
	type ProbeSpawnDeps
} from './node-io';

/**
 * works-security finding 4 (node 0.2.7): the Windows probes ran `powershell`
 * / `nvidia-smi` through `cmd.exe` with the node's own working directory, and
 * `cmd.exe` searches the CURRENT DIRECTORY before `PATH` — a planted
 * `powershell.exe` / `nvidia-smi.bat` there ran as the machine owner on every
 * heartbeat. The plan is pure, so every case is pinned on any OS.
 */

const WIN_ENV = {
	SystemRoot: 'C:\\Windows',
	ProgramFiles: 'C:\\Program Files',
	ProgramW6432: 'C:\\Program Files',
	PATH: 'C:\\Windows\\System32'
};

function win(exists: (path: string) => boolean = () => false, env: NodeJS.ProcessEnv = WIN_ENV): ProbeSpawnDeps {
	return { platform: 'win32', env, exists, homedir: () => 'C:\\Users\\owner' };
}

describe('planProbeSpawn — Windows', () => {
	it.each(['powershell', 'powershell.exe', 'PowerShell'])(
		'%s resolves to the absolute System32 binary and starts without cmd.exe',
		(command) => {
			const plan = planProbeSpawn(command, win());
			expect(plan).toMatchObject({
				file: 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe',
				shell: false,
				cwd: 'C:\\Windows\\System32'
			});
		}
	);

	it('resolves where / icacls to System32 too', () => {
		expect(planProbeSpawn('where', win())?.file).toBe('C:\\Windows\\System32\\where.exe');
		expect(planProbeSpawn('icacls', win())?.file).toBe('C:\\Windows\\System32\\icacls.exe');
	});

	it('finds nvidia-smi only at the driver install locations, and never searches for it', () => {
		const dch = 'C:\\Windows\\System32\\nvidia-smi.exe';
		const legacy = 'C:\\Program Files\\NVIDIA Corporation\\NVSMI\\nvidia-smi.exe';
		expect(
			planProbeSpawn(
				'nvidia-smi',
				win((p) => p === dch)
			)
		).toMatchObject({ file: dch, shell: false });
		expect(
			planProbeSpawn(
				'nvidia-smi',
				win((p) => p === legacy)
			)
		).toMatchObject({ file: legacy, shell: false });
		// Not installed: nothing to spawn — the runner reports ENOENT.
		expect(planProbeSpawn('nvidia-smi', win())).toBeNull();
	});

	it('keeps cmd.exe for the model-CLI shims but pins the cwd and turns off the current-directory search', () => {
		const plan = planProbeSpawn('claude', win());
		expect(plan).toMatchObject({ file: 'claude', shell: true, cwd: 'C:\\Windows\\System32' });
		expect(plan?.env.NoDefaultCurrentDirectoryInExePath).toBe('1');
		// The caller's environment is copied, never mutated.
		expect((WIN_ENV as NodeJS.ProcessEnv).NoDefaultCurrentDirectoryInExePath).toBeUndefined();
	});

	it('never rewrites a path-qualified command', () => {
		expect(planProbeSpawn('C:\\tools\\powershell.exe', win())?.file).toBe('C:\\tools\\powershell.exe');
	});

	it('ignores a SystemRoot that is relative, quoted or a UNC path', () => {
		for (const SystemRoot of ['..\\evil', '"C:\\Windows"', '\\\\host\\share', 'C:Windows', '']) {
			expect(windowsSystemRoot({ SystemRoot })).toBe('C:\\Windows');
		}
		expect(windowsSystemRoot({ SystemRoot: 'D:\\WINNT\\' })).toBe('D:\\WINNT');
		expect(windowsSystemRoot({ windir: 'E:\\Win' })).toBe('E:\\Win');
		expect(windowsSystemRoot({ SystemRoot: 'C:\\' })).toBe('C:\\');
	});
});

describe('planProbeSpawn — POSIX', () => {
	it('keeps the bare name (execvp searches PATH only) and pins the cwd to the home directory', () => {
		const plan = planProbeSpawn('nvidia-smi', {
			platform: 'linux',
			env: { PATH: '/usr/bin' },
			exists: () => false,
			homedir: () => '/home/owner'
		});
		expect(plan).toEqual({ file: 'nvidia-smi', shell: false, cwd: '/home/owner', env: { PATH: '/usr/bin' } });
	});
});

describe('createCommandRunner', () => {
	it('reports a tool that is not there as a spawn failure, not an answer', async () => {
		const result = await createCommandRunner().run('ew-definitely-not-a-real-tool-0x7', ['--version'], {
			timeoutMs: 20_000
		});
		expect(result.code).not.toBe(0);
	});
});

/**
 * Boot-probe retry — the boot-time probes a busy PC used to answer wrongly. A runner
 * result with `timedOut: true` is what `execFile` reports when it killed the
 * child at its deadline; the fake below plays a slow machine with it.
 */
type RunResult = Awaited<ReturnType<CommandRunner['run']>>;
const TIMED_OUT: RunResult = { code: 1, stdout: '', stderr: '', timedOut: true };

function scriptedRunner(results: RunResult[]) {
	const calls: Array<{ command: string; args: string[]; timeoutMs: number | undefined }> = [];
	const runner: CommandRunner = {
		run: vi.fn(async (command: string, args: string[], options?: { timeoutMs?: number }) => {
			calls.push({ command, args, timeoutMs: options?.timeoutMs });
			const next = results.shift();
			if (!next) throw new Error('spawned more often than scripted');
			return next;
		})
	};
	return { runner, calls };
}

const noWait = async (): Promise<void> => undefined;
const OWNER_ENV = { USERDOMAIN: 'EVERDESK1', USERNAME: 'owner' };
const MARKER = 'C:\\Users\\owner\\AppData\\Roaming\\ever-works-node\\node-config.json.worker-session';

describe('restrictFileToOwnerWindowsWithRetry (boot-probe retry)', () => {
	it('retries a timed-out icacls with a growing deadline and succeeds — the same ACL every time', async () => {
		const { runner, calls } = scriptedRunner([
			TIMED_OUT,
			TIMED_OUT,
			{ code: 0, stdout: 'Successfully processed 1 files', stderr: '' }
		]);
		const warn = vi.fn();

		await expect(
			restrictFileToOwnerWindowsWithRetry(MARKER, { runner, env: OWNER_ENV, sleep: noWait, logger: { warn } })
		).resolves.toBeUndefined();

		expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 20_000, 30_000]);
		for (const call of calls) {
			expect(call).toMatchObject({
				command: 'icacls',
				args: [MARKER, '/inheritance:r', '/grant:r', 'EVERDESK1\\owner:(F)']
			});
		}
		expect(warn).toHaveBeenCalledTimes(2);
		expect(warn.mock.calls[0]?.[0]).toMatch(
			/timed out after 10 s \(attempt 1\/4\).*retrying in 1 s with a 20 s deadline/
		);
	});

	it('fails at once, without a retry, when icacls ANSWERS with a refusal', async () => {
		const { runner, calls } = scriptedRunner([{ code: 5, stdout: '', stderr: 'Access is denied.\r\n' }]);

		const failure = restrictFileToOwnerWindowsWithRetry(MARKER, { runner, env: OWNER_ENV, sleep: noWait });
		await expect(failure).rejects.toThrow('icacls exited 5: Access is denied.');
		await failure.catch((error) => expect(isProbeTimedOut(error)).toBe(false));
		expect(calls).toHaveLength(1);
	});

	it('fails at once when icacls cannot be started at all', async () => {
		const { runner, calls } = scriptedRunner([{ code: 1, stdout: '', stderr: '', spawnError: 'ENOENT' }]);
		await expect(
			restrictFileToOwnerWindowsWithRetry(MARKER, { runner, env: OWNER_ENV, sleep: noWait })
		).rejects.toThrow(/could not be started \(ENOENT\)/);
		expect(calls).toHaveLength(1);
	});

	it('reports "probe timed out" — not a refusal — when every attempt timed out', async () => {
		const { runner, calls } = scriptedRunner([TIMED_OUT, TIMED_OUT, TIMED_OUT, TIMED_OUT]);

		const failure = restrictFileToOwnerWindowsWithRetry(MARKER, { runner, env: OWNER_ENV, sleep: noWait });
		await expect(failure).rejects.toBeInstanceOf(ProbeTimedOutError);
		await expect(failure).rejects.toThrow(
			/^probe timed out: owner-only ACL \(icacls\) did not finish in 4 attempts/
		);
		expect(calls.map((call) => call.timeoutMs)).toEqual([10_000, 20_000, 30_000, 40_000]);
	});

	it('refuses before spawning when the Windows user is unknown', async () => {
		const { runner, calls } = scriptedRunner([]);
		await expect(restrictFileToOwnerWindowsWithRetry(MARKER, { runner, env: {}, sleep: noWait })).rejects.toThrow(
			/Cannot determine the current Windows user/
		);
		expect(calls).toHaveLength(0);
		expect(windowsAclUser({ USERNAME: 'solo' })).toBe('solo');
		expect(windowsAclUser({ USERDOMAIN: 'D', USERNAME: '' })).toBe('D\\');
		expect(windowsAclUser({ USERNAME: '  ' })).toBeNull();
	});
});

describe('searchPathWithRetry (boot-probe retry)', () => {
	it('retries a timed-out lookup and returns every hit', async () => {
		const { runner, calls } = scriptedRunner([
			TIMED_OUT,
			{ code: 0, stdout: 'C:\\npm\\claude\r\nC:\\npm\\claude.cmd\r\n', stderr: '' }
		]);
		await expect(searchPathWithRetry('claude', { runner, platform: 'win32', sleep: noWait })).resolves.toEqual({
			status: 'found',
			hits: ['C:\\npm\\claude', 'C:\\npm\\claude.cmd']
		});
		expect(calls.map((call) => [call.command, call.timeoutMs])).toEqual([
			['where', 5_000],
			['where', 10_000]
		]);
	});

	it('believes "not found" at once', async () => {
		const { runner, calls } = scriptedRunner([{ code: 1, stdout: '', stderr: 'INFO: Could not find files' }]);
		await expect(searchPathWithRetry('codex', { runner, platform: 'linux', sleep: noWait })).resolves.toEqual({
			status: 'not-found'
		});
		expect(calls).toEqual([{ command: 'which', args: ['codex'], timeoutMs: 5_000 }]);
	});

	it('says timed out — never not found — when every attempt timed out', async () => {
		const { runner, calls } = scriptedRunner([TIMED_OUT, TIMED_OUT, TIMED_OUT, TIMED_OUT]);
		const result = await searchPathWithRetry('claude', { runner, platform: 'win32', sleep: noWait });
		expect(result).toMatchObject({ status: 'timed-out' });
		expect(result.status === 'timed-out' && result.detail).toMatch(
			/^probe timed out: PATH lookup \(where claude\) did not finish in 4 attempts \(deadlines 5 s, 10 s, 20 s, 30 s\)/
		);
		expect(calls).toHaveLength(4);
	});
});
