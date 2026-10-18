import { describe, expect, it } from 'vitest';
import { createCommandRunner, planProbeSpawn, windowsSystemRoot, type ProbeSpawnDeps } from './node-io';

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
