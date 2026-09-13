/**
 * Release promotion lane (self-build slice AI, EW-808) —
 * `GitHubApiService.getWorkflowRunForCommit`.
 *
 * The read that answers "what did `promotion-gate.yml` say about THIS
 * commit?", which the rolled-up `getPullRequestStatus` cannot: that roll-up
 * folds `skipped` and `cancelled` into `passing`, and it cannot see a
 * workflow that never ran at all.
 *
 * The distinction this file mostly asserts is `null` versus a THROW.
 * `null` means "the gate has no run for this commit" — a real answer. A
 * throw means the lookup is broken. The promotion lane refuses on both and
 * sends the operator to different places, so collapsing one into the other
 * would be a silent downgrade.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('libsodium-wrappers', () => ({
	default: {
		ready: Promise.resolve(),
		from_base64: vi.fn(),
		crypto_box_seal: vi.fn(),
		to_base64: vi.fn()
	}
}));

const listWorkflowRunsForRepoMock = vi.fn();

vi.mock('octokit', () => {
	class FakeOctokit {
		rest = {
			actions: {
				listWorkflowRunsForRepo: listWorkflowRunsForRepoMock
			},
			orgs: { checkMembershipForUser: vi.fn() }
		};
		constructor(public opts: unknown) {}
	}
	class FakeRequestError extends Error {
		readonly status: number;
		constructor(message: string, status: number) {
			super(message);
			this.status = status;
		}
	}
	return { Octokit: FakeOctokit, RequestError: FakeRequestError };
});

const { GitHubApiService } = await import('../github-api.service.js');
const { RequestError } = await import('octokit');

const OWNER = 'ever-works';
const REPO = 'ever-works';
const TOKEN = 'gh-token';
const SHA = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

function run(overrides: Record<string, unknown> = {}) {
	return {
		id: 1001,
		path: '.github/workflows/promotion-gate.yml',
		head_sha: SHA,
		status: 'completed',
		conclusion: 'success',
		html_url: 'https://github.com/ever-works/ever-works/actions/runs/1001',
		run_attempt: 1,
		...overrides
	};
}

function service() {
	return new GitHubApiService();
}

beforeEach(() => {
	listWorkflowRunsForRepoMock.mockReset();
});

describe('getWorkflowRunForCommit', () => {
	it('asks for exactly the commit, in one request', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [run()] } });

		await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);

		expect(listWorkflowRunsForRepoMock).toHaveBeenCalledTimes(1);
		expect(listWorkflowRunsForRepoMock).toHaveBeenCalledWith(
			expect.objectContaining({ owner: OWNER, repo: REPO, head_sha: SHA })
		);
	});

	it('maps the run onto the provider-neutral shape', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [run()] } });

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);

		expect(result).toEqual({
			id: 1001,
			workflowPath: '.github/workflows/promotion-gate.yml',
			headSha: SHA,
			status: 'completed',
			conclusion: 'success',
			url: 'https://github.com/ever-works/ever-works/actions/runs/1001',
			runAttempt: 1
		});
	});

	it('matches on the FILE NAME, so a bare name and a full path both work', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [run()] } });
		const api = service();

		await expect(
			api.getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)
		).resolves.not.toBeNull();
		await expect(
			api.getWorkflowRunForCommit(OWNER, REPO, '.github/workflows/promotion-gate.yml', SHA, TOKEN)
		).resolves.not.toBeNull();
		await expect(
			api.getWorkflowRunForCommit(OWNER, REPO, 'PROMOTION-GATE.YML', SHA, TOKEN)
		).resolves.not.toBeNull();
	});

	it('ignores every OTHER workflow that ran on the same commit', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: {
				workflow_runs: [
					run({ id: 900, path: '.github/workflows/ci.yml', conclusion: 'success' }),
					run({ id: 901, path: '.github/workflows/e2e.yml', conclusion: 'success' })
				]
			}
		});

		// A commit whose OTHER checks are green but whose gate never ran is
		// exactly the case the rolled-up CI state gets wrong.
		await expect(
			service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)
		).resolves.toBeNull();
	});

	it('returns null when the commit has no runs at all', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [] } });
		await expect(
			service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)
		).resolves.toBeNull();
	});

	it('returns null when the payload has no runs array', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: {} });
		await expect(
			service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)
		).resolves.toBeNull();
	});

	it('returns null for a missing repository (404), which is a real answer', async () => {
		listWorkflowRunsForRepoMock.mockRejectedValue(new RequestError('Not Found', 404));
		await expect(
			service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)
		).resolves.toBeNull();
	});

	it('THROWS on a 403 — a token without actions:read is a broken gate, not a missing run', async () => {
		listWorkflowRunsForRepoMock.mockRejectedValue(new RequestError('Forbidden', 403));
		await expect(service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)).rejects.toThrow(
			'Forbidden'
		);
	});

	it('THROWS on a 5xx rather than reporting the gate absent', async () => {
		listWorkflowRunsForRepoMock.mockRejectedValue(new RequestError('Bad gateway', 502));
		await expect(service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN)).rejects.toThrow(
			'Bad gateway'
		);
	});

	it('reports the NEWEST run when the workflow ran more than once for the commit', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: {
				workflow_runs: [
					run({ id: 1000, conclusion: 'failure' }),
					run({ id: 1002, conclusion: 'success' }),
					run({ id: 1001, conclusion: 'failure' })
				]
			}
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.id).toBe(1002);
		expect(result?.conclusion).toBe('success');
	});

	it('prefers the latest ATTEMPT when a run was re-run in place', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: {
				workflow_runs: [
					run({ id: 1001, run_attempt: 1, conclusion: 'failure' }),
					run({ id: 1001, run_attempt: 3, conclusion: 'success' })
				]
			}
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.runAttempt).toBe(3);
		expect(result?.conclusion).toBe('success');
	});

	it('carries a run that has not finished through as pending, with a null conclusion', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: { workflow_runs: [run({ status: 'in_progress', conclusion: null })] }
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.status).toBe('in_progress');
		expect(result?.conclusion).toBeNull();
	});

	it.each([
		['cancelled', 'cancelled'],
		['skipped', 'skipped'],
		['neutral', 'neutral'],
		['stale', 'stale'],
		['timed_out', 'timed_out'],
		['action_required', 'action_required']
	])('passes a %s conclusion through verbatim rather than laundering it', async (raw, expected) => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: { workflow_runs: [run({ conclusion: raw })] }
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.conclusion).toBe(expected);
	});

	it('reports an UNKNOWN conclusion as null rather than guessing', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: { workflow_runs: [run({ conclusion: 'quantum' })] }
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		// Unrecognised must never be laundered into a pass; the lane maps
		// "completed with no readable conclusion" to `unreadable`.
		expect(result?.conclusion).toBeNull();
	});

	it('reports an UNKNOWN status as unknown rather than as completed', async () => {
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: { workflow_runs: [run({ status: 'teleporting', conclusion: 'success' })] }
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.status).toBe('unknown');
	});

	// Each row isolates ONE guard: the workflow name and the commit are
	// varied INDEPENDENTLY, so deleting either half of
	// `if (!wanted || !headSha) return null` reds a row. The previous
	// version blanked both on the "empty workflow name" row, which left
	// `!wanted` with no coverage at all — a caller passing an empty
	// workflow name would then have matched the first run of ANY workflow
	// on the commit, silently.
	it.each([
		['an empty workflow name, with a real commit', '', SHA],
		['a workflow name that is only whitespace, with a real commit', '   ', SHA],
		['an empty commit, with a real workflow name', 'promotion-gate.yml', ''],
		['a workflow name and a commit that are both empty', '', '']
	])('short-circuits on %s without calling the API', async (_label, workflow, commit) => {
		await expect(service().getWorkflowRunForCommit(OWNER, REPO, workflow, commit, TOKEN)).resolves.toBeNull();
		expect(listWorkflowRunsForRepoMock).not.toHaveBeenCalled();
	});

	it('reports which pull requests the run was for, so a caller can refuse a run that is not its own', async () => {
		// A workflow run is keyed by COMMIT, and one commit can head more
		// than one pull request — `stage` can be the head of both a
		// `stage -> main` promotion and somebody's comparison branch. The
		// override label is per pull request, so a run adopted off the
		// commit alone can differ in exactly the way that matters.
		listWorkflowRunsForRepoMock.mockResolvedValue({
			data: {
				workflow_runs: [run({ pull_requests: [{ number: 42 }, null, { number: 43 }, {}] })]
			}
		});

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result?.pullRequestNumbers).toEqual([42, 43]);
	});

	it('omits the association entirely when the provider did not report one', async () => {
		// `undefined` is "the provider did not say", which is NOT the same
		// as "this run belongs to no pull request" — the caller must not
		// manufacture a mismatch out of it.
		listWorkflowRunsForRepoMock.mockResolvedValue({ data: { workflow_runs: [run()] } });

		const result = await service().getWorkflowRunForCommit(OWNER, REPO, 'promotion-gate.yml', SHA, TOKEN);
		expect(result).not.toHaveProperty('pullRequestNumbers');
	});
});
