import { describe, expect, it } from 'vitest';
import { FLEET_CHANGES_MAX_FILE_BYTES } from '@ever-works/contracts';
import type { CheckoutGitRunner } from './checkout-git';
import {
	changesPathspec,
	parseNumstatZ,
	parsePorcelainV2Changes,
	readCheckoutChanges,
	splitUnifiedDiff
} from './checkout-changes';

const STATUS_Z = [
	'1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts',
	'1 A. N... 000000 100644 100644 0000 bbbb src/new.ts',
	'1 D. N... 100644 000000 000000 aaaa 0000 src/gone.ts',
	'2 R. N... 100644 100644 100644 aaaa bbbb R100 src/b.ts',
	'src/old-b.ts',
	'u UU N... 100644 100644 100644 100644 aaaa bbbb cccc src/c.ts',
	'? notes.md',
	'? .ever-works/state.json',
	'? .mounts/x/y',
	'1 .M N... 100644 100644 100644 aaaa bbbb img.png',
	''
].join('\0');

const DIFF = [
	'diff --git a/src/a file.ts b/src/a file.ts',
	'index aaaa..bbbb 100644',
	'--- a/src/a file.ts',
	'+++ b/src/a file.ts',
	'@@ -1 +1 @@',
	'-old <b>bold</b>',
	'+new <script>alert(1)</script>',
	'diff --git a/src/gone.ts b/src/gone.ts',
	'deleted file mode 100644',
	'--- a/src/gone.ts',
	'+++ /dev/null',
	'@@ -1 +0,0 @@',
	'-bye',
	''
].join('\n');

describe('parsePorcelainV2Changes (FL-06 FR-9)', () => {
	it('reads every kind of entry, keeps spaces in paths, and drops the node’s own folders', () => {
		expect(parsePorcelainV2Changes(STATUS_Z)).toEqual([
			{ path: 'src/a file.ts', previousPath: null, status: 'modified' },
			{ path: 'src/new.ts', previousPath: null, status: 'added' },
			{ path: 'src/gone.ts', previousPath: null, status: 'deleted' },
			{ path: 'src/b.ts', previousPath: 'src/old-b.ts', status: 'renamed' },
			{ path: 'src/c.ts', previousPath: null, status: 'conflicted' },
			{ path: 'notes.md', previousPath: null, status: 'untracked' },
			{ path: 'img.png', previousPath: null, status: 'modified' }
		]);
	});

	it('excludes .ever-works and .mounts by pathspec on every command', () => {
		expect(changesPathspec()).toEqual(['--', '.', ':(exclude).ever-works', ':(exclude).mounts']);
	});
});

describe('parseNumstatZ / splitUnifiedDiff', () => {
	it('marks binary files and keys sections by path', () => {
		const counts = parseNumstatZ('1\t1\tsrc/a file.ts\0-\t-\timg.png\0');
		expect(counts.get('src/a file.ts')).toEqual({ added: 1, removed: 1, binary: false });
		expect(counts.get('img.png')).toEqual({ added: null, removed: null, binary: true });
		const sections = splitUnifiedDiff(DIFF);
		expect([...sections.keys()]).toEqual(['src/a file.ts', 'src/gone.ts']);
		expect(sections.get('src/gone.ts')).toContain('-bye');
	});
});

describe('readCheckoutChanges', () => {
	function runner(outputs: { status: string; numstat?: string; diff?: string; diffCode?: number }): {
		git: CheckoutGitRunner;
		calls: string[][];
	} {
		const calls: string[][] = [];
		const git: CheckoutGitRunner = async (args) => {
			calls.push([...args]);
			if (args.includes('status')) return { code: 0, stdout: outputs.status, stderr: '' };
			if (args.includes('--numstat')) return { code: 0, stdout: outputs.numstat ?? '', stderr: '' };
			return { code: outputs.diffCode ?? 0, stdout: outputs.diff ?? '', stderr: '' };
		};
		return { git, calls };
	}

	it('returns the patch as plain text — markup stays text — and binary files without one', async () => {
		const { git, calls } = runner({
			status: STATUS_Z,
			numstat: '1\t1\tsrc/a file.ts\0-\t-\timg.png\0',
			diff: DIFF
		});
		const reply = await readCheckoutChanges('/work/api', git, {
			now: () => Date.parse('2026-10-21T10:00:00Z'),
			readUntracked: async () => 'diff --git a/notes.md b/notes.md\nnew file\n--- /dev/null\n+++ b/notes.md\n@@ -0,0 +1,1 @@\n+hello\n'
		});
		const byPath = new Map(reply.files.map((file) => [file.path, file]));
		expect(byPath.get('src/a file.ts')?.patch).toContain('+new <script>alert(1)</script>');
		expect(byPath.get('img.png')).toMatchObject({ binary: true, patch: null, added: null });
		expect(byPath.get('notes.md')).toMatchObject({ status: 'untracked', added: 1, removed: 0 });
		expect(reply.truncated).toBe(false);
		expect(reply.at).toBe('2026-10-21T10:00:00.000Z');
		// Never a remote, never an external diff driver.
		for (const call of calls) {
			expect(call).not.toContain('fetch');
			if (call.includes('diff') && !call.includes('--numstat')) expect(call).toContain('--no-ext-diff');
		}
	});

	it('caps one file at 64 KiB and the whole reply at maxBytes, counting what it left out', async () => {
		const big = `diff --git a/src/a file.ts b/src/a file.ts\n--- a/src/a file.ts\n+++ b/src/a file.ts\n${'+x\n'.repeat(
			FLEET_CHANGES_MAX_FILE_BYTES
		)}`;
		const { git } = runner({ status: '1 .M N... 100644 100644 100644 aaaa bbbb src/a file.ts\0', diff: big });
		const reply = await readCheckoutChanges('/work/api', git, { maxBytes: 8192 });
		expect(reply.files[0].patch).toBeNull();
		expect(reply.truncated).toBe(true);
		expect(reply.omittedFiles).toBe(1);
		expect(reply.omittedBytes).toBeGreaterThan(0);
	});

	it('keeps what arrived when the diff overflowed the buffer, and says it was cut', async () => {
		const { git } = runner({ status: STATUS_Z, diff: DIFF, diffCode: 1 });
		const reply = await readCheckoutChanges('/work/api', git, { readUntracked: async () => null });
		expect(reply.truncated).toBe(true);
		expect(reply.files.find((file) => file.path === 'src/gone.ts')?.patch).toContain('-bye');
	});
});
