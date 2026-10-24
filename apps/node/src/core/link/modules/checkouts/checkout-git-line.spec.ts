import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckoutGitRunner } from './checkout-git';
import { parseNumstat, parsePorcelainV2, readCheckoutFacts, readWorktreeMain } from './checkout-git-line';

const STATUS = [
	'# branch.oid 0123456789abcdef0123456789abcdef01234567',
	'# branch.head nina/fix-login',
	'# branch.upstream origin/nina/fix-login',
	'# branch.ab +3 -1',
	'1 .M N... 100644 100644 100644 aaaa bbbb src/a.ts',
	'2 R. N... 100644 100644 100644 aaaa bbbb R100 src/b.ts\tsrc/old-b.ts',
	'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/c.ts',
	'? notes.md',
	'? tmp/out.log',
	''
].join('\n');

describe('parsePorcelainV2 (FL-14 CONTRACTS §4.7)', () => {
	it('reads branch, upstream, ahead/behind and counts', () => {
		expect(parsePorcelainV2(STATUS)).toEqual({
			headSha: '0123456789abcdef0123456789abcdef01234567',
			branch: 'nina/fix-login',
			upstream: 'origin/nina/fix-login',
			ahead: 3,
			behind: 1,
			changed: 3,
			untracked: 2
		});
	});

	it('reads a detached HEAD and a branch with no upstream', () => {
		const status = parsePorcelainV2('# branch.oid (initial)\n# branch.head (detached)\n');
		expect(status.branch).toBeNull();
		expect(status.headSha).toBeNull();
		expect(status.ahead).toBeNull();
	});
});

describe('parseNumstat', () => {
	it('sums lines and counts binary files as changed', () => {
		expect(parseNumstat('10\t2\tsrc/a.ts\n-\t-\tlogo.png\n204\t36\tsrc/b.ts\n')).toEqual({
			added: 214,
			removed: 38,
			files: 3
		});
	});
});

describe('readCheckoutFacts — never contacts the remote (spec FR-10, ACC-FL14-05)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'fl14-line-'));
		await mkdir(join(dir, '.git'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	it('builds every §4.7 field from three local reads', async () => {
		const calls: string[][] = [];
		const git: CheckoutGitRunner = async (args) => {
			calls.push([...args]);
			if (args[0] === 'status') return { code: 0, stdout: STATUS, stderr: '' };
			if (args[0] === 'diff') return { code: 0, stdout: '214\t38\tsrc/a.ts\n', stderr: '' };
			if (args[0] === 'config' && args[2] === 'remote.origin.url')
				return { code: 0, stdout: 'https://x:secret@github.com/acme/api.git\n', stderr: '' };
			return { code: 1, stdout: '', stderr: '' };
		};
		const facts = await readCheckoutFacts(dir, git, { now: () => Date.parse('2026-10-21T10:00:00.000Z') });
		expect(facts?.gitLine).toEqual({
			branch: 'nina/fix-login',
			isWorktree: false,
			baseRef: 'origin/nina/fix-login',
			ahead: 3,
			behind: 1,
			added: 214,
			removed: 38,
			filesChanged: 3,
			uncommitted: 5,
			pr: null,
			at: '2026-10-21T10:00:00.000Z'
		});
		// Token-free before it leaves the machine (spec FR-5).
		expect(facts?.remoteUrl).toBe('https://github.com/acme/api.git');
		expect(facts?.remoteHadCredential).toBe(true);
		for (const argv of calls) {
			expect(argv).not.toContain('fetch');
			expect(argv).not.toContain('ls-remote');
			expect(argv).not.toContain('pull');
		}
	});

	it('answers null when git cannot read the folder', async () => {
		const git: CheckoutGitRunner = async () => ({ code: 128, stdout: '', stderr: 'not a git repository' });
		expect(await readCheckoutFacts(dir, git)).toBeNull();
	});

	it('reads a linked worktree and its main checkout from the .git file', async () => {
		const tree = await mkdtemp(join(tmpdir(), 'fl14-tree-'));
		try {
			await writeFile(join(tree, '.git'), 'gitdir: /home/nina/code/api/.git/worktrees/fix-login\n');
			expect(await readWorktreeMain(tree)).toEqual({ isWorktree: true, mainPath: '/home/nina/code/api' });
			expect(await readWorktreeMain(dir)).toEqual({ isWorktree: false, mainPath: null });
		} finally {
			await rm(tree, { recursive: true, force: true });
		}
	});
});
