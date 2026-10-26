import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { CheckoutGitRunner } from './checkout-git';
import { EVIDENCE_UNKNOWN, evidenceGrew, isEvidenceClean, readChangesEvidence } from './checkout-evidence';

describe('delete evidence (FL-14 spec FR-24, S7)', () => {
	let dir: string;
	beforeEach(async () => {
		dir = await mkdtemp(join(tmpdir(), 'fl14-evidence-'));
		await mkdir(join(dir, '.git'));
	});
	afterEach(async () => {
		await rm(dir, { recursive: true, force: true });
	});

	const git =
		(answers: Record<string, { code: number; stdout: string; stderr?: string }>): CheckoutGitRunner =>
		async (args) => {
			const answer = answers[args.join(' ')];
			return answer ? { stderr: '', ...answer } : { code: 1, stdout: '', stderr: '' };
		};

	it('counts uncommitted files and commits on no remote', async () => {
		const evidence = await readChangesEvidence(
			dir,
			git({
				'status --porcelain=v2 --branch --untracked-files=normal': {
					code: 0,
					stdout: '# branch.head x\n1 .M N... 1 1 1 a b f.ts\n? new.md\n'
				},
				'rev-parse --verify --quiet HEAD': { code: 0, stdout: 'abc\n' },
				'rev-list --count HEAD --not --remotes': { code: 0, stdout: '1\n' },
				'rev-parse --git-dir': { code: 0, stdout: '.git\n' }
			})
		);
		expect(evidence).toEqual({ uncommitted: 2, unpushedCommits: 1, hasLocks: false });
		expect(isEvidenceClean(evidence)).toBe(false);
	});

	it('fails closed: what git cannot establish counts as would-be-lost', async () => {
		const evidence = await readChangesEvidence(
			dir,
			git({ 'rev-parse --verify --quiet HEAD': { code: 0, stdout: 'a' } })
		);
		expect(evidence.uncommitted).toBe(EVIDENCE_UNKNOWN);
		expect(evidence.unpushedCommits).toBe(EVIDENCE_UNKNOWN);
	});

	it('sees a git lock file', async () => {
		await writeFile(join(dir, '.git', 'index.lock'), '');
		const evidence = await readChangesEvidence(
			dir,
			git({
				'status --porcelain=v2 --branch --untracked-files=normal': { code: 0, stdout: '' },
				'rev-parse --verify --quiet HEAD': { code: 1, stdout: '' },
				'rev-parse --git-dir': { code: 0, stdout: '.git' }
			})
		);
		expect(evidence).toEqual({ uncommitted: 0, unpushedCommits: 0, hasLocks: true });
	});

	it('refuses an execute whose evidence grew past what was confirmed (plan §6)', () => {
		expect(evidenceGrew({ uncommitted: 2, unpushedCommits: 1 }, { uncommitted: 2, unpushedCommits: 1 })).toBe(
			false
		);
		expect(evidenceGrew({ uncommitted: 3, unpushedCommits: 1 }, { uncommitted: 2, unpushedCommits: 1 })).toBe(true);
		expect(evidenceGrew({ uncommitted: 0, unpushedCommits: 0 }, undefined)).toBe(false);
		expect(evidenceGrew({ uncommitted: 1, unpushedCommits: 0 }, undefined)).toBe(true);
	});
});
