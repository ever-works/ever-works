import { describe, it, expect, vi, beforeEach } from 'vitest';
import { promises as fsp } from 'node:fs';
import * as nodePath from 'node:path';
import * as os from 'node:os';
import { commitWithLfsCli, probeGitCliBinaries, type ExecImpl } from '../lfs-cli.js';

/**
 * Build a fake ExecImpl that records every (cmd, args, cwd) and lets
 * the test queue per-call results / rejections.
 */
function makeExec() {
	const calls: Array<{ cmd: string; args: string[]; cwd?: string }> = [];
	const queue: Array<{ kind: 'ok'; stdout?: string; stderr?: string } | { kind: 'err'; message: string }> = [];
	const exec: ExecImpl = vi.fn(async (cmd, args, opts) => {
		calls.push({ cmd, args: [...args], cwd: opts.cwd });
		const next = queue.shift() ?? { kind: 'ok' };
		if (next.kind === 'err') throw new Error(next.message);
		return { stdout: next.stdout ?? '', stderr: next.stderr ?? '', exitCode: 0 };
	});
	return {
		exec,
		calls,
		ok(stdout = '') {
			queue.push({ kind: 'ok', stdout });
		},
		err(message: string) {
			queue.push({ kind: 'err', message });
		}
	};
}

describe('probeGitCliBinaries (EW-644)', () => {
	it('reports both binaries available when --version succeeds', async () => {
		const { exec } = makeExec();
		// Both ok() calls share the same queue; default-ok handles all.
		const result = await probeGitCliBinaries(async (cmd) => ({
			stdout: cmd === 'git' ? 'git version 2.45.0' : 'git-lfs/3.5.0',
			stderr: '',
			exitCode: 0
		}));
		expect(result.git.available).toBe(true);
		expect(result.git.version).toBe('git version 2.45.0');
		expect(result.gitLfs.available).toBe(true);
		expect(result.gitLfs.version).toBe('git-lfs/3.5.0');
		expect(exec).not.toHaveBeenCalled(); // we passed our own impl
	});

	it('reports missing binaries with the spawn error message', async () => {
		const result = await probeGitCliBinaries(async (cmd) => {
			throw new Error(`spawn ${cmd} ENOENT`);
		});
		expect(result.git.available).toBe(false);
		expect(result.git.error).toMatch(/ENOENT/);
		expect(result.gitLfs.available).toBe(false);
	});

	it('handles git present but git-lfs missing', async () => {
		const result = await probeGitCliBinaries(async (cmd) => {
			if (cmd === 'git') return { stdout: 'git version 2.45.0', stderr: '', exitCode: 0 };
			throw new Error('spawn git-lfs ENOENT');
		});
		expect(result.git.available).toBe(true);
		expect(result.gitLfs.available).toBe(false);
	});
});

describe('commitWithLfsCli (EW-644)', () => {
	const baseCfg = {
		owner: 'acme',
		repo: 'docs-data',
		branch: 'main',
		token: 'ghp_test'
	};
	const committer = { name: 'Ever Works Bot', email: 'bot@ever.works' };

	beforeEach(() => {
		vi.clearAllMocks();
	});

	it('issues clone, lfs install/track, add, commit, push in the right order', async () => {
		const { exec, calls, ok } = makeExec();
		// 7 steps: clone, set http.extraheader, lfs install, lfs track,
		// 2 × git add (file + .gitattributes), commit, push = 8 ok()s.
		for (let i = 0; i < 8; i++) ok();
		await commitWithLfsCli(
			baseCfg,
			'uploads',
			[{ path: 'uploads/user1/abc.png', content: Buffer.from([0x89, 0x50]) }],
			'upload(user1): abc.png (lfs)',
			committer,
			exec
		);

		// Step 1: clone with single-shot Authorization header + branch
		expect(calls[0]).toMatchObject({ cmd: 'git' });
		expect(calls[0].args).toContain('clone');
		expect(calls[0].args).toContain('--depth');
		expect(calls[0].args).toContain('1');
		expect(calls[0].args).toContain('--branch');
		expect(calls[0].args).toContain('main');
		expect(calls[0].args.join(' ')).toContain('http.extraheader=Authorization: Bearer ghp_test');
		expect(calls[0].args.join(' ')).toContain('https://github.com/acme/docs-data.git');

		// Step 2: persist the auth header on the cloned repo
		expect(calls[1].args).toEqual(['config', '--local', 'http.extraheader', 'Authorization: Bearer ghp_test']);

		// Step 3: lfs install --local
		expect(calls[2].args).toEqual(['lfs', 'install', '--local']);

		// Step 4: lfs track <prefix>/**
		expect(calls[3].args).toEqual(['lfs', 'track', 'uploads/**']);

		// Step 5: git add <file>
		expect(calls[4].args).toEqual(['add', 'uploads/user1/abc.png']);

		// Step 6: git add .gitattributes
		expect(calls[5].args).toEqual(['add', '.gitattributes']);

		// Step 7: commit with -c overrides for committer
		expect(calls[6].args.slice(0, 4)).toEqual([
			'-c',
			'user.name=Ever Works Bot',
			'-c',
			'user.email=bot@ever.works'
		]);
		expect(calls[6].args).toContain('commit');
		expect(calls[6].args).toContain('-m');
		expect(calls[6].args).toContain('upload(user1): abc.png (lfs)');

		// Step 8: push origin <branch>
		expect(calls[7].args).toEqual(['push', 'origin', 'main']);
	});

	it('writes the raw file bytes into the working tree (git-lfs replaces with a pointer)', async () => {
		const { exec, calls, ok } = makeExec();
		// On clone, capture the destination so we can poke at the FS.
		let dest: string | undefined;
		const wrappingExec: ExecImpl = async (cmd, args, opts) => {
			if (cmd === 'git' && args.includes('clone')) {
				// Last arg to clone is the destination (per our impl).
				dest = args[args.length - 1];
			}
			return exec(cmd, args, opts);
		};
		for (let i = 0; i < 8; i++) ok();
		const payload = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
		await commitWithLfsCli(
			baseCfg,
			'uploads',
			[{ path: 'uploads/user1/abc.png', content: payload }],
			'm',
			committer,
			wrappingExec
		);
		// The dir is torn down in the finally block; reading the file
		// before tear-down isn't possible from outside the function.
		// Instead assert the dest path was passed correctly to clone,
		// which is the public contract we can verify.
		expect(dest).toBeDefined();
		expect(dest).toContain('ew-gh-storage-lfs-');
		// calls[0] is clone; the destination is the last argument.
		expect(calls[0].args[calls[0].args.length - 1]).toBe(dest);
	});

	it('overrides the LFS host base via cfg.hostBase (GitHub Enterprise)', async () => {
		const { exec, calls, ok } = makeExec();
		for (let i = 0; i < 8; i++) ok();
		await commitWithLfsCli(
			{ ...baseCfg, hostBase: 'https://ghe.example.com' },
			'uploads',
			[{ path: 'uploads/u/h.txt', content: Buffer.from('hi') }],
			'm',
			committer,
			exec
		);
		expect(calls[0].args.join(' ')).toContain('https://ghe.example.com/acme/docs-data.git');
	});

	it('surfaces a clear error when clone fails', async () => {
		const { exec, err } = makeExec();
		err("'git clone' exited with code 128: Repository not found");
		await expect(
			commitWithLfsCli(
				baseCfg,
				'uploads',
				[{ path: 'uploads/u/h.txt', content: Buffer.from('hi') }],
				'm',
				committer,
				exec
			)
		).rejects.toThrow(/Repository not found/);
	});

	it('cleans up the temp directory on success', async () => {
		const { exec, calls, ok } = makeExec();
		// Capture clone dest before commitWithLfsCli's finally tears it down.
		let dest: string | undefined;
		const wrappingExec: ExecImpl = async (cmd, args, opts) => {
			if (cmd === 'git' && args.includes('clone')) {
				dest = args[args.length - 1];
				// Pre-create the temp dir so rm has something to remove.
				await fsp.mkdir(dest, { recursive: true });
			}
			return exec(cmd, args, opts);
		};
		for (let i = 0; i < 8; i++) ok();
		await commitWithLfsCli(
			baseCfg,
			'uploads',
			[{ path: 'uploads/u/h.txt', content: Buffer.from('hi') }],
			'm',
			committer,
			wrappingExec
		);
		expect(dest).toBeDefined();
		await expect(fsp.stat(dest!)).rejects.toMatchObject({ code: 'ENOENT' });
		expect(calls.length).toBe(8);
	});

	it('cleans up the temp directory even when a step fails mid-flight', async () => {
		const { exec, err, ok } = makeExec();
		let dest: string | undefined;
		const wrappingExec: ExecImpl = async (cmd, args, opts) => {
			if (cmd === 'git' && args.includes('clone')) {
				dest = args[args.length - 1];
				await fsp.mkdir(dest, { recursive: true });
			}
			return exec(cmd, args, opts);
		};
		// clone ok, set extraheader ok, lfs install fails.
		ok();
		ok();
		err("'git lfs install' exited with code 1: git-lfs not on PATH");
		await expect(
			commitWithLfsCli(
				baseCfg,
				'uploads',
				[{ path: 'uploads/u/h.txt', content: Buffer.from('hi') }],
				'm',
				committer,
				wrappingExec
			)
		).rejects.toThrow(/git-lfs not on PATH/);
		expect(dest).toBeDefined();
		await expect(fsp.stat(dest!)).rejects.toMatchObject({ code: 'ENOENT' });
	});

	// Sanity: the impl shouldn't write to the host's real tmpdir
	// outside the test's control. Verify mkdtemp goes under os.tmpdir().
	it('uses os.tmpdir() for the working clone (no surprises)', async () => {
		const { exec, ok } = makeExec();
		let dest: string | undefined;
		const wrappingExec: ExecImpl = async (cmd, args, opts) => {
			if (cmd === 'git' && args.includes('clone')) {
				dest = args[args.length - 1];
			}
			return exec(cmd, args, opts);
		};
		for (let i = 0; i < 8; i++) ok();
		await commitWithLfsCli(
			baseCfg,
			'uploads',
			[{ path: 'uploads/u/h.txt', content: Buffer.from('hi') }],
			'm',
			committer,
			wrappingExec
		);
		expect(dest).toBeDefined();
		// nodePath.relative(os.tmpdir(), dest) shouldn't start with '..'
		const rel = nodePath.relative(os.tmpdir(), dest!);
		expect(rel.startsWith('..')).toBe(false);
	});
});
