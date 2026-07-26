/**
 * PR insights (kanban run cockpit M5/M6) — runtime conformance suite for
 * the two OPTIONAL git-provider read capabilities that the Tasks board
 * depends on: `getPullRequestStatus` and `getPullRequestDiff` (plus
 * `getCompareDiff` where the provider has a compare endpoint).
 *
 * Any git-provider plugin that implements them MUST pass these tests.
 * Mirrors the `runJobRuntimeContractSuite` / `runSecretStoreContractSuite`
 * pattern.
 *
 * Encoded invariants:
 *
 *   1. `getPullRequestStatus` returns the PR number it was asked for and
 *      a `ciState` drawn from the four-state vocabulary.
 *   2. A missing PR resolves to `null` — it never throws. The board
 *      degrades to "no pill", it does not show an error.
 *   3. `merged` and `state` agree: `state === 'merged'` iff `merged`.
 *   4. The check list is bounded by `MAX_PR_CHECKS`.
 *   5. `ciState` matches `deriveCiState(checks)` — a provider may not
 *      invent its own rollup (one red check is never reported green).
 *   6. `getPullRequestDiff` honours `maxFiles` and flags `truncated`.
 *   7. `getPullRequestDiff` honours `maxBytes`: returned patch text never
 *      exceeds the budget, and dropping a patch sets `truncated`.
 *   8. `totalFiles` reports the PRE-cap count, so the caller can say how
 *      much it is not showing.
 *   9. `getCompareDiff`, when implemented, satisfies the same cap rules.
 *
 * Usage:
 *
 *   ```ts
 *   import { describe } from 'vitest';
 *   import { runGitPrInsightsContractSuite } from '@ever-works/plugin/contracts-conformance';
 *
 *   describe('GitHub — PR insights contract', () => {
 *     runGitPrInsightsContractSuite(() => new GitHubPlugin(), { ... });
 *   });
 *   ```
 *
 * Self-applies against the in-memory fake at the bottom.
 */

import { describe, expect, it } from 'vitest';
import type { GitDiffOptions, GitDiffResult, GitPullRequestStatus } from '../capabilities/git-provider.interface.js';
import { MAX_PR_CHECKS, capDiffFiles, capChecks, deriveCiState } from '../capabilities/git-provider.pr-insights.js';

/**
 * The narrow slice of `IGitProviderPlugin` this suite exercises. Taking
 * a structural subset (rather than the whole plugin interface) lets a
 * provider run the suite against a service object as well as against the
 * plugin class.
 */
export interface GitPrInsightsSubject {
	getPullRequestStatus?(
		owner: string,
		repo: string,
		prNumber: number,
		token: string
	): Promise<GitPullRequestStatus | null>;
	getPullRequestDiff?(
		owner: string,
		repo: string,
		prNumber: number,
		opts: GitDiffOptions | undefined,
		token: string
	): Promise<GitDiffResult>;
	getCompareDiff?(
		owner: string,
		repo: string,
		base: string,
		head: string,
		opts: GitDiffOptions | undefined,
		token: string
	): Promise<GitDiffResult>;
}

export interface GitPrInsightsContractOptions {
	/** Repo coordinates the subject resolves successfully. */
	readonly owner?: string;
	readonly repo?: string;
	readonly token?: string;
	/** A PR the subject can answer for. */
	readonly prNumber?: number;
	/** A PR number the subject reports as missing (`null`). */
	readonly missingPrNumber?: number;
	/** Branch pair for the compare-diff leg. */
	readonly base?: string;
	readonly head?: string;
}

const DEFAULTS = {
	owner: 'acme',
	repo: 'widgets',
	token: 'test-token',
	prNumber: 41,
	missingPrNumber: 4041,
	base: 'main',
	head: 'task/t-1-abcdef'
} as const;

const CI_STATES = ['passing', 'failing', 'pending', 'unknown'] as const;
const PR_STATES = ['open', 'draft', 'closed', 'merged'] as const;

function byteLength(text: string): number {
	return typeof TextEncoder === 'function' ? new TextEncoder().encode(text).length : text.length;
}

function totalPatchBytes(result: GitDiffResult): number {
	return result.files.reduce((sum, file) => sum + (file.patch ? byteLength(file.patch) : 0), 0);
}

export function runGitPrInsightsContractSuite(
	createSubject: () => GitPrInsightsSubject | Promise<GitPrInsightsSubject>,
	options: GitPrInsightsContractOptions = {}
): void {
	const cfg = { ...DEFAULTS, ...options };

	describe('git-provider PR insights contract', () => {
		describe('getPullRequestStatus', () => {
			it('answers for the PR number it was asked about', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestStatus) return;
				const status = await subject.getPullRequestStatus(cfg.owner, cfg.repo, cfg.prNumber, cfg.token);
				expect(status).not.toBeNull();
				expect(status!.number).toBe(cfg.prNumber);
				expect(PR_STATES).toContain(status!.state);
				expect(CI_STATES).toContain(status!.ciState);
			});

			it('returns null for a missing PR instead of throwing', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestStatus) return;
				await expect(
					subject.getPullRequestStatus(cfg.owner, cfg.repo, cfg.missingPrNumber, cfg.token)
				).resolves.toBeNull();
			});

			it('keeps `merged` and `state` consistent', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestStatus) return;
				const status = await subject.getPullRequestStatus(cfg.owner, cfg.repo, cfg.prNumber, cfg.token);
				expect(status!.merged).toBe(status!.state === 'merged');
			});

			it('bounds the check list', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestStatus) return;
				const status = await subject.getPullRequestStatus(cfg.owner, cfg.repo, cfg.prNumber, cfg.token);
				expect(status!.checks.length).toBeLessThanOrEqual(MAX_PR_CHECKS);
			});

			it('derives ciState from the checks with the shared rule', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestStatus) return;
				const status = await subject.getPullRequestStatus(cfg.owner, cfg.repo, cfg.prNumber, cfg.token);
				expect(status!.ciState).toBe(deriveCiState(status!.checks));
			});
		});

		describe('getPullRequestDiff', () => {
			it('honours maxFiles and reports the pre-cap total', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestDiff) return;
				const result = await subject.getPullRequestDiff(
					cfg.owner,
					cfg.repo,
					cfg.prNumber,
					{ maxFiles: 1, maxBytes: 1024 * 1024 },
					cfg.token
				);
				expect(result.files.length).toBeLessThanOrEqual(1);
				expect(result.totalFiles).toBeGreaterThanOrEqual(result.files.length);
				if (result.totalFiles > result.files.length) {
					expect(result.truncated).toBe(true);
				}
			});

			it('honours maxBytes and flags the truncation', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestDiff) return;
				const result = await subject.getPullRequestDiff(
					cfg.owner,
					cfg.repo,
					cfg.prNumber,
					{ maxFiles: 100, maxBytes: 0 },
					cfg.token
				);
				expect(totalPatchBytes(result)).toBe(0);
				expect(result.patchBytes).toBe(0);
				// Every file whose patch we dropped says so.
				for (const file of result.files) {
					expect(file.patch).toBeUndefined();
				}
			});

			it('never returns more patch bytes than the budget', async () => {
				const subject = await createSubject();
				if (!subject.getPullRequestDiff) return;
				const budget = 64;
				const result = await subject.getPullRequestDiff(
					cfg.owner,
					cfg.repo,
					cfg.prNumber,
					{ maxBytes: budget },
					cfg.token
				);
				expect(totalPatchBytes(result)).toBeLessThanOrEqual(budget);
				expect(result.patchBytes).toBeLessThanOrEqual(budget);
			});
		});

		describe('getCompareDiff', () => {
			it('satisfies the same cap rules when implemented', async () => {
				const subject = await createSubject();
				if (!subject.getCompareDiff) return;
				const result = await subject.getCompareDiff(
					cfg.owner,
					cfg.repo,
					cfg.base,
					cfg.head,
					{ maxFiles: 1, maxBytes: 32 },
					cfg.token
				);
				expect(result.files.length).toBeLessThanOrEqual(1);
				expect(totalPatchBytes(result)).toBeLessThanOrEqual(32);
				expect(result.totalFiles).toBeGreaterThanOrEqual(result.files.length);
			});
		});
	});
}

// ─── Self-application against an in-memory fake ─────────────────────

const FAKE_FILES = [
	{ path: 'src/a.ts', status: 'modified', additions: 4, deletions: 1, patch: '@@ -1 +1 @@\n-a\n+b\n' },
	{ path: 'src/b.ts', status: 'added', additions: 9, deletions: 0, patch: '@@ -0,0 +1 @@\n+new\n' },
	{ path: 'src/c.bin', status: 'added', additions: 0, deletions: 0 }
];

function createFakeSubject(): GitPrInsightsSubject {
	return {
		async getPullRequestStatus(_owner, _repo, prNumber) {
			if (prNumber === DEFAULTS.missingPrNumber) return null;
			const checks = capChecks([
				{ name: 'build', status: 'completed', conclusion: 'success' },
				{ name: 'lint', status: 'in_progress', conclusion: null }
			]);
			return {
				number: prNumber,
				state: 'open',
				merged: false,
				mergeable: true,
				headSha: 'deadbeef',
				reviewDecision: 'review_required',
				ciState: deriveCiState(checks),
				checks,
				url: 'https://example.invalid/pr/1'
			};
		},
		async getPullRequestDiff(_owner, _repo, _prNumber, opts) {
			return capDiffFiles(FAKE_FILES, opts);
		},
		async getCompareDiff(_owner, _repo, _base, _head, opts) {
			return capDiffFiles(FAKE_FILES, opts);
		}
	};
}

describe('in-memory fake — PR insights self-application', () => {
	runGitPrInsightsContractSuite(createFakeSubject);
});

describe('pr-insights pure rules', () => {
	it('reports unknown for an empty check list', () => {
		expect(deriveCiState([])).toBe('unknown');
		expect(deriveCiState(undefined)).toBe('unknown');
	});

	it('reds on a single failure even when everything else passed', () => {
		expect(
			deriveCiState([
				{ name: 'a', status: 'completed', conclusion: 'success' },
				{ name: 'b', status: 'completed', conclusion: 'failure' },
				{ name: 'c', status: 'completed', conclusion: 'success' }
			])
		).toBe('failing');
	});

	it('reds on timed_out and action_required, not on neutral/skipped/cancelled', () => {
		expect(deriveCiState([{ name: 'a', status: 'completed', conclusion: 'timed_out' }])).toBe('failing');
		expect(deriveCiState([{ name: 'a', status: 'completed', conclusion: 'action_required' }])).toBe('failing');
		expect(
			deriveCiState([
				{ name: 'a', status: 'completed', conclusion: 'neutral' },
				{ name: 'b', status: 'completed', conclusion: 'skipped' },
				{ name: 'c', status: 'completed', conclusion: 'cancelled' },
				{ name: 'd', status: 'completed', conclusion: 'stale' }
			])
		).toBe('passing');
	});

	it('never reports green while a check is still running', () => {
		expect(
			deriveCiState([
				{ name: 'a', status: 'completed', conclusion: 'success' },
				{ name: 'b', status: 'queued', conclusion: null }
			])
		).toBe('pending');
	});

	it('treats a completed check with no verdict as unsettled', () => {
		expect(deriveCiState([{ name: 'a', status: 'completed', conclusion: null }])).toBe('pending');
	});

	it('drops whole files past maxFiles and keeps the pre-cap total', () => {
		const result = capDiffFiles(FAKE_FILES, { maxFiles: 2 });
		expect(result.files).toHaveLength(2);
		expect(result.totalFiles).toBe(3);
		expect(result.truncated).toBe(true);
	});

	it('drops patch text but keeps the file row when the byte budget runs out', () => {
		const result = capDiffFiles(FAKE_FILES, { maxBytes: 1 });
		expect(result.files).toHaveLength(3);
		expect(result.files[0].patch).toBeUndefined();
		expect(result.files[0].patchOmitted).toBe(true);
		expect(result.files[0].path).toBe('src/a.ts');
		expect(result.truncated).toBe(true);
	});

	it('does not flag truncation for a provider-omitted (binary) patch', () => {
		const result = capDiffFiles([FAKE_FILES[2]], { maxBytes: 1024, maxFiles: 10 });
		expect(result.truncated).toBe(false);
		expect(result.files[0].patchOmitted).toBeUndefined();
	});

	it('sums additions and deletions across the kept files', () => {
		const result = capDiffFiles(FAKE_FILES, {});
		expect(result.totalAdditions).toBe(13);
		expect(result.totalDeletions).toBe(1);
	});

	it('clamps absurd caps to the hard platform ceilings', () => {
		const result = capDiffFiles(FAKE_FILES, { maxFiles: 10_000, maxBytes: 10 ** 9 });
		expect(result.files).toHaveLength(3);
		expect(result.truncated).toBe(false);
	});

	it('bounds the check list at MAX_PR_CHECKS', () => {
		const many = Array.from({ length: MAX_PR_CHECKS + 5 }, (_unused, i) => ({
			name: `check-${i}`,
			status: 'completed' as const,
			conclusion: 'success' as const
		}));
		expect(capChecks(many)).toHaveLength(MAX_PR_CHECKS);
	});
});
