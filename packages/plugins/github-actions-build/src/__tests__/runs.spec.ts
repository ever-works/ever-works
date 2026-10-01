import { zipSync } from 'fflate';
import {
	APP_BUILD_CHECK_NAME_PREFIX,
	APP_BUILD_RESULT_ARTIFACT_FILE,
	APP_BUILD_RESULT_ARTIFACT_NAME,
	APP_BUILD_RESULT_MAX_BYTES,
	APP_BUILD_WORKFLOW_PATH
} from '@ever-works/contracts';
import type { BuildAuth, BuildRef, StartBuildInput } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin, WORKFLOW_FILE_NAME } from '../github-actions-build.plugin.js';
import type { ActionsArtifact, ActionsJob, ActionsRun, ActionsRunsPort } from '../runs/actions-runs.port.js';
import {
	ADOPTION_WINDOW_MS,
	DISPATCH_CLOCK_SKEW_MS,
	correlateDispatchedRun,
	titleNamesBuild
} from '../runs/run-correlator.js';
import { jobBillableMinutes, observeRun, toBuildRunStatus } from '../runs/run-observer.js';
import { RESULT_ARTIFACT_MAX_ZIP_BYTES, parseResultArtifact, readResultArtifact } from '../runs/result-artifact.js';

/**
 * APW-05 T12 — run correlation, observation and the result artifact.
 *
 * Every case below drives a FAKE {@link ActionsRunsPort}, which is what that
 * port exists for: the rules under test are plan §2.3's adoption window,
 * §4.8's minutes arithmetic and "only the `build` job decides", and R-9's
 * refusal to fail a Build for a check — none of which needs a socket, a token
 * or a recorded cassette to be proved, and all of which would be untestable if
 * the plugin held an Octokit instance of its own.
 *
 * The payload shapes are GitHub's, trimmed to the fields this plugin reads (see
 * `actions-runs.port.ts` on why the types are the subset and not the whole).
 */

const REPOSITORY = { owner: 'acme', repo: 'their-app' } as const;
const BUILD_ID = '7f1c0f2e-1111-4111-8111-aaaaaaaaaaaa';
const DISPATCHED_AT = Date.parse('2026-09-21T10:00:00.000Z');
const AUTH: BuildAuth = { token: 'ghs-not-a-real-token' };

/** A run, with only the fields the correlator and observer read. */
function run(overrides: Partial<ActionsRun> = {}): ActionsRun {
	return {
		id: 9001,
		status: 'completed',
		conclusion: 'success',
		run_attempt: 1,
		display_title: `Ever Works build ${BUILD_ID}`,
		event: 'workflow_dispatch',
		head_branch: 'main',
		head_sha: 'a'.repeat(40),
		html_url: 'https://github.com/acme/their-app/actions/runs/9001',
		created_at: new Date(DISPATCHED_AT + 1_000).toISOString(),
		run_started_at: new Date(DISPATCHED_AT + 2_000).toISOString(),
		updated_at: new Date(DISPATCHED_AT + 120_000).toISOString(),
		...overrides
	};
}

/** A job, with only the fields the observer reads. */
function job(name: string, seconds: number, overrides: Partial<ActionsJob> = {}): ActionsJob {
	const started = DISPATCHED_AT + 10_000;
	return {
		id: 1,
		name,
		status: 'completed',
		conclusion: 'success',
		started_at: new Date(started).toISOString(),
		completed_at: new Date(started + seconds * 1000).toISOString(),
		labels: ['ubuntu-latest'],
		...overrides
	};
}

/** A fake port. Every method throws unless a case supplies it — an accidental call is a failure. */
function fakePort(overrides: Partial<ActionsRunsPort> = {}): ActionsRunsPort {
	const refuse = (member: string) => async () => {
		throw new Error(`fake ActionsRunsPort: ${member} was not expected to be called`);
	};
	return {
		dispatchWorkflow: refuse('dispatchWorkflow'),
		listWorkflowRuns: refuse('listWorkflowRuns'),
		getWorkflowRun: refuse('getWorkflowRun'),
		listRunJobs: refuse('listRunJobs'),
		cancelWorkflowRun: refuse('cancelWorkflowRun'),
		listRunArtifacts: refuse('listRunArtifacts'),
		downloadArtifactZip: refuse('downloadArtifactZip'),
		...overrides
	} as ActionsRunsPort;
}

/** The plugin with its two seams replaced — no Octokit, no wall clock. */
class TestPlugin extends GitHubActionsBuildPlugin {
	constructor(
		private readonly port: ActionsRunsPort,
		private readonly clock: number = DISPATCHED_AT
	) {
		super();
	}
	protected actionsPort(): ActionsRunsPort {
		return this.port;
	}
	protected now(): number {
		return this.clock;
	}
}

describe('run correlation (plan §2.3)', () => {
	it('adopts the run whose display_title names the Build', async () => {
		const port = fakePort({
			listWorkflowRuns: async () => [run({ id: 4242 })]
		});

		const result = await correlateDispatchedRun(port, {
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: BUILD_ID,
			dispatchedAtMs: DISPATCHED_AT
		});

		expect(result.providerRunId).toBe('4242');
	});

	it('never adopts "the newest run" — a different Build id is not this Build', async () => {
		// Two Builds of the same App Work dispatched seconds apart would otherwise
		// each adopt the other's run, and the platform would cancel, bill and
		// report against the wrong one.
		const port = fakePort({
			listWorkflowRuns: async () => [
				run({ id: 5000, display_title: 'Ever Works build 00000000-2222-4222-8222-bbbbbbbbbbbb' })
			]
		});

		const result = await correlateDispatchedRun(port, {
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: BUILD_ID,
			dispatchedAtMs: DISPATCHED_AT
		});

		expect(result).toEqual({ providerRunId: null, reason: 'noMatch' });
	});

	it(`accepts a run created up to ${DISPATCH_CLOCK_SKEW_MS} ms BEFORE the dispatch`, async () => {
		// The two clocks are GitHub's and ours, and they are not the same clock.
		const port = fakePort({
			listWorkflowRuns: async () => [
				run({ id: 6000, created_at: new Date(DISPATCHED_AT - DISPATCH_CLOCK_SKEW_MS).toISOString() })
			]
		});

		const result = await correlateDispatchedRun(port, {
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: BUILD_ID,
			dispatchedAtMs: DISPATCHED_AT
		});

		expect(result.providerRunId).toBe('6000');
	});

	it('refuses a title match outside the adoption window, and says so distinctly', async () => {
		const port = fakePort({
			listWorkflowRuns: async () => [
				run({
					id: 7000,
					created_at: new Date(DISPATCHED_AT + ADOPTION_WINDOW_MS + 1_000).toISOString()
				})
			]
		});

		const result = await correlateDispatchedRun(port, {
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: BUILD_ID,
			dispatchedAtMs: DISPATCHED_AT
		});

		// Distinct from `noMatch` because it means something different to whoever
		// reads the log: this Build HAS run before, and this dispatch has not
		// produced its run yet.
		expect(result).toEqual({ providerRunId: null, reason: 'outsideWindow' });
	});

	it('does not adopt a run GitHub gave no creation time — that would be guessing', async () => {
		const port = fakePort({
			listWorkflowRuns: async () => [run({ id: 8000, created_at: null, run_started_at: null })]
		});

		const result = await correlateDispatchedRun(port, {
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			buildId: BUILD_ID,
			dispatchedAtMs: DISPATCHED_AT
		});

		expect(result.providerRunId).toBeNull();
	});

	it('matches on a substring, not equality — the title is prose around the id', () => {
		expect(titleNamesBuild(run(), BUILD_ID)).toBe(true);
		expect(titleNamesBuild(run({ display_title: null }), BUILD_ID)).toBe(false);
		expect(titleNamesBuild(run(), '')).toBe(false);
	});
});

describe('run observation (plan §4.8)', () => {
	it('ACC-05-20: minutes are per job, rounded up, then summed — 61 s + 30 s is 3, not 2', () => {
		// `ceil(91/60)` would be 2. GitHub bills per job, and so does the receipt.
		expect(jobBillableMinutes(job('build', 61))).toBe(2);
		expect(jobBillableMinutes(job('other', 30))).toBe(1);

		const snapshot = observeRun({
			run: run(),
			jobs: [job('build', 61), job('other', 30)],
			mode: 'build'
		});

		expect(snapshot.billableMinutes).toBe(3);
	});

	it('ACC-05-29 / R-9: a failed check job never fails the Build, and its minutes are reported apart', () => {
		const snapshot = observeRun({
			run: run(),
			jobs: [job('build', 30), job(`${APP_BUILD_CHECK_NAME_PREFIX}lint`, 45, { conclusion: 'failure' })],
			mode: 'build'
		});

		// The single behaviour R-9 exists to prevent: failing a Build for lint.
		expect(snapshot.status).toBe('succeeded');
		expect(snapshot.conclusion).toBe('success');
		// A subset of `billableMinutes`, never an addition: 1 + 1 = 2 total, of
		// which the check is 1.
		expect(snapshot.billableMinutes).toBe(2);
		expect(snapshot.checksBillableMinutes).toBe(1);
	});

	it('reports `checksBillableMinutes` as 0 when checks ran and cost nothing, and omits it when none ran', () => {
		// "The checks cost nothing" and "there were no checks" are different facts.
		const withChecks = observeRun({
			run: run(),
			jobs: [
				job('build', 30),
				job(`${APP_BUILD_CHECK_NAME_PREFIX}lint`, 0, { started_at: null, completed_at: null })
			],
			mode: 'build'
		});
		expect(withChecks.checksBillableMinutes).toBe(0);

		const withoutChecks = observeRun({ run: run(), jobs: [job('build', 30)], mode: 'build' });
		expect(withoutChecks.checksBillableMinutes).toBeUndefined();
	});

	it('a pull-request run reports the HEAD sha, not a merge sha', () => {
		const head = 'b'.repeat(40);
		const snapshot = observeRun({
			run: run({ event: 'pull_request', head_sha: head, pull_requests: [{ number: 42 }] }),
			jobs: [job('build', 30)],
			mode: 'build'
		});

		expect(snapshot.trigger).toBe('pull_request');
		expect(snapshot.commitSha).toBe(head);
		expect(snapshot.pullRequestNumber).toBe(42);
	});

	it('ACC-05-11: queued, then running, then completed each map to their own status', () => {
		const statuses = (['queued', 'in_progress', 'completed'] as const).map(
			(status) =>
				observeRun({
					run: run({ status, conclusion: status === 'completed' ? 'success' : null }),
					jobs: [job('build', 30, { status, conclusion: status === 'completed' ? 'success' : null })],
					mode: 'build'
				}).status
		);

		expect(statuses).toEqual(['queued', 'running', 'succeeded']);
	});

	it('`completed` with no conclusion is `running`, never `succeeded`', () => {
		// GitHub reports that combination briefly while a run settles. Calling it
		// a success would publish an image nobody built.
		expect(toBuildRunStatus('completed', null)).toBe('running');
		expect(toBuildRunStatus('completed', 'success')).toBe('succeeded');
		expect(toBuildRunStatus('completed', 'cancelled')).toBe('cancelled');
		expect(toBuildRunStatus('completed', 'timed_out')).toBe('failed');
		// A conclusion nobody has seen yet is a FAILED Build, not a passing one.
		expect(toBuildRunStatus('completed', 'some_future_conclusion')).toBe('failed');
	});

	it('a verification dispatch is `verification`, a plain dispatch is `manual`', () => {
		expect(observeRun({ run: run(), jobs: [], mode: 'verify' }).trigger).toBe('verification');
		expect(observeRun({ run: run(), jobs: [], mode: 'build' }).trigger).toBe('manual');
	});

	it('falls back to the run when there is no `build` job at all (a checks-only file)', () => {
		const snapshot = observeRun({
			run: run({ conclusion: 'failure' }),
			jobs: [job(`${APP_BUILD_CHECK_NAME_PREFIX}lint`, 10, { conclusion: 'failure' })],
			mode: 'build'
		});

		expect(snapshot.status).toBe('failed');
	});
});

describe('the result artifact (plan §4.8 — untrusted input)', () => {
	const digest = `sha256:${'a'.repeat(64)}`;

	function zipOf(body: unknown, file = APP_BUILD_RESULT_ARTIFACT_FILE): Uint8Array {
		const text = typeof body === 'string' ? body : JSON.stringify(body);
		return zipSync({ [file]: new TextEncoder().encode(text) });
	}

	function artifact(overrides: Partial<ActionsArtifact> = {}): ActionsArtifact {
		return { id: 77, name: APP_BUILD_RESULT_ARTIFACT_NAME, size_in_bytes: 512, ...overrides };
	}

	it('reads a well-formed result', async () => {
		const port = fakePort({
			listRunArtifacts: async () => [artifact()],
			downloadArtifactZip: async () => zipOf({ digest, imageRepository: 'ghcr.io/acme/app' })
		});

		const outcome = await readResultArtifact(port, { repository: REPOSITORY, runId: 9001 });

		expect(outcome).toEqual({
			ok: true,
			result: { digest, imageRepository: 'ghcr.io/acme/app' }
		});
	});

	it('refuses an oversized zip on the REPORTED size, without downloading it', async () => {
		const downloadArtifactZip = vi.fn(async () => new Uint8Array(0));
		const port = fakePort({
			listRunArtifacts: async () => [artifact({ size_in_bytes: RESULT_ARTIFACT_MAX_ZIP_BYTES + 1 })],
			downloadArtifactZip
		});

		const outcome = await readResultArtifact(port, { repository: REPOSITORY, runId: 9001 });

		expect(outcome).toEqual({ ok: false, refusal: 'zipTooLarge' });
		expect(downloadArtifactZip).not.toHaveBeenCalled();
	});

	it('refuses an oversized zip on the ACTUAL bytes too — the reported size is the provider’s claim', async () => {
		const port = fakePort({
			listRunArtifacts: async () => [artifact({ size_in_bytes: 10 })],
			downloadArtifactZip: async () => new Uint8Array(RESULT_ARTIFACT_MAX_ZIP_BYTES + 1)
		});

		expect(await readResultArtifact(port, { repository: REPOSITORY, runId: 9001 })).toEqual({
			ok: false,
			refusal: 'zipTooLarge'
		});
	});

	it('refuses an entry over the inflated cap — the check that actually stops a zip bomb', async () => {
		const huge = { digest, imageRepository: 'x'.repeat(APP_BUILD_RESULT_MAX_BYTES) };
		const port = fakePort({
			listRunArtifacts: async () => [artifact()],
			downloadArtifactZip: async () => zipOf(huge)
		});

		expect(await readResultArtifact(port, { repository: REPOSITORY, runId: 9001 })).toEqual({
			ok: false,
			refusal: 'entryTooLarge'
		});
	});

	it('answers `absent` for a run that uploaded none, and `expired` for one that has aged out', async () => {
		expect(
			await readResultArtifact(fakePort({ listRunArtifacts: async () => [] }), {
				repository: REPOSITORY,
				runId: 9001
			})
		).toEqual({ ok: false, refusal: 'absent' });

		expect(
			await readResultArtifact(fakePort({ listRunArtifacts: async () => [artifact({ expired: true })] }), {
				repository: REPOSITORY,
				runId: 9001
			})
		).toEqual({ ok: false, refusal: 'expired' });
	});

	it('refuses an unknown key rather than ignoring it', () => {
		// "Ignore what you do not recognise" is how an injected field becomes a
		// trusted one later.
		expect(parseResultArtifact({ digest, somethingElse: 1 })).toEqual({
			ok: false,
			refusal: 'unknownKeys'
		});
	});

	it('refuses a digest that is not `sha256:<64 hex>`', () => {
		for (const bad of ['sha256:short', `sha512:${'a'.repeat(64)}`, `sha256:${'A'.repeat(64)}`, '']) {
			expect(parseResultArtifact({ digest: bad }).ok).toBe(false);
		}
		expect(parseResultArtifact({ digest }).ok).toBe(true);
	});
});

describe('GitHubActionsBuildPlugin — the four members T12 fills', () => {
	const startInput: StartBuildInput = {
		workId: 'w1',
		buildId: BUILD_ID,
		repository: {
			owner: 'acme',
			repo: 'their-app',
			visibility: 'public',
			trackedBranch: 'main',
			createdByAppWork: true
		},
		ref: 'refs/heads/feature',
		sha: 'c'.repeat(40),
		mode: 'build',
		settings: {}
	};

	const ref: BuildRef = {
		repository: startInput.repository,
		buildId: BUILD_ID,
		providerRunId: '9001'
	};

	it('dispatches on the TRACKED branch, never the ref being built (FR-14)', async () => {
		const dispatchWorkflow = vi.fn(async () => undefined);
		const plugin = new TestPlugin(fakePort({ dispatchWorkflow, listWorkflowRuns: async () => [] }));

		await plugin.startBuild(startInput, AUTH);

		expect(dispatchWorkflow).toHaveBeenCalledWith({
			repository: REPOSITORY,
			workflowFile: WORKFLOW_FILE_NAME,
			// `refs/heads/feature` is what to BUILD; `main` is where the reviewed
			// workflow file lives, and the only ref a dispatch may name.
			ref: 'main',
			inputs: { ew_build_id: BUILD_ID, ew_sha: startInput.sha, ew_mode: 'build' }
		});
	});

	it('names the workflow FILE, which is what GitHub’s `workflow_id` accepts', () => {
		expect(WORKFLOW_FILE_NAME).toBe('ever-works-build.yml');
		expect(APP_BUILD_WORKFLOW_PATH.endsWith(WORKFLOW_FILE_NAME)).toBe(true);
	});

	it('sends the optional inputs only when they have a value', async () => {
		const dispatchWorkflow = vi.fn(async () => undefined);
		const plugin = new TestPlugin(fakePort({ dispatchWorkflow, listWorkflowRuns: async () => [] }));

		await plugin.startBuild(
			{
				...startInput,
				reuseImageDigest: `sha256:${'d'.repeat(64)}`,
				verification: { json: '{"checks":[]}', promptedNames: [] }
			},
			AUTH
		);

		expect(dispatchWorkflow.mock.calls[0][0].inputs).toEqual({
			ew_build_id: BUILD_ID,
			ew_sha: startInput.sha,
			ew_mode: 'build',
			ew_reuse_digest: `sha256:${'d'.repeat(64)}`,
			ew_verify_plan: '{"checks":[]}'
		});
	});

	it('answers a null run id without failing — the run is not listed that fast', async () => {
		const plugin = new TestPlugin(
			fakePort({ dispatchWorkflow: async () => undefined, listWorkflowRuns: async () => [] })
		);

		const result = await plugin.startBuild(startInput, AUTH);

		expect(result.providerRunId).toBeNull();
		expect(result.dispatchedAt).toBe(new Date(DISPATCHED_AT).toISOString());
	});

	it('observes a run and attaches the artifact digest as UNCONFIRMED', async () => {
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run(),
				listRunJobs: async () => [job('build', 61)],
				listRunArtifacts: async () => [{ id: 77, name: APP_BUILD_RESULT_ARTIFACT_NAME, size_in_bytes: 256 }],
				downloadArtifactZip: async () =>
					zipSync({
						[APP_BUILD_RESULT_ARTIFACT_FILE]: new TextEncoder().encode(
							JSON.stringify({
								digest: `sha256:${'e'.repeat(64)}`,
								imageRepository: 'ghcr.io/acme/app',
								tags: ['sha-abc']
							})
						)
					})
			})
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.status).toBe('succeeded');
		expect(snapshot?.billableMinutes).toBe(2);
		// Never believed, only confirmed — and confirming is `checkImageAccess`.
		expect(snapshot?.image).toEqual({
			repository: 'ghcr.io/acme/app',
			digest: `sha256:${'e'.repeat(64)}`,
			tags: ['sha-abc'],
			confirmed: false
		});
	});

	it('does not spend a request on the artifact while the run is still going', async () => {
		const listRunArtifacts = vi.fn(async () => []);
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run({ status: 'in_progress', conclusion: null }),
				listRunJobs: async () => [job('build', 0, { status: 'in_progress', conclusion: null })],
				listRunArtifacts
			})
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.status).toBe('running');
		expect(listRunArtifacts).not.toHaveBeenCalled();
	});

	it('answers null for a run GitHub does not have — "no such run", not a throw', async () => {
		const plugin = new TestPlugin(fakePort({ getWorkflowRun: async () => null }));

		expect(await plugin.getBuild(ref, AUTH, (text) => text)).toBeNull();
	});

	it('correlates when the ref carries no run id yet', async () => {
		const plugin = new TestPlugin(
			fakePort({
				listWorkflowRuns: async () => [run({ id: 4242 })],
				getWorkflowRun: async ({ runId }) => (runId === 4242 ? run({ id: 4242 }) : null),
				listRunJobs: async () => [job('build', 30)],
				listRunArtifacts: async () => []
			})
		);

		const snapshot = await plugin.getBuild(
			{ ...ref, providerRunId: null, dispatchedAt: new Date(DISPATCHED_AT).toISOString() },
			AUTH,
			(text) => text
		);

		expect(snapshot?.providerRunId).toBe('4242');
	});

	it('ACC-05-09: cancel calls the cancel endpoint, and a cancelled run reads as cancelled', async () => {
		const cancelWorkflowRun = vi.fn(async () => undefined);
		const plugin = new TestPlugin(fakePort({ cancelWorkflowRun }));

		await plugin.cancelBuild(ref, AUTH);

		expect(cancelWorkflowRun).toHaveBeenCalledWith({ repository: REPOSITORY, runId: 9001 });
		expect(
			observeRun({
				run: run({ conclusion: 'cancelled' }),
				jobs: [job('build', 10, { conclusion: 'cancelled' })],
				mode: 'build'
			}).status
		).toBe('cancelled');
	});

	it('cancelling a Build with no run is a no-op, not a throw', async () => {
		const cancelWorkflowRun = vi.fn(async () => undefined);
		const plugin = new TestPlugin(fakePort({ cancelWorkflowRun, listWorkflowRuns: async () => [] }));

		await expect(plugin.cancelBuild({ ...ref, providerRunId: null }, AUTH)).resolves.toBeUndefined();
		expect(cancelWorkflowRun).not.toHaveBeenCalled();
	});

	it('answers the run’s own page as the logs URL', async () => {
		const plugin = new TestPlugin(fakePort({ getWorkflowRun: async () => run() }));

		expect(await plugin.getLogsUrl(ref, AUTH)).toBe('https://github.com/acme/their-app/actions/runs/9001');
	});
});

/**
 * APW-05 T14 remainder — `getBuild` carries the digest the build job's `Push`
 * step logged as `image.pushLogDigest` (plan §4.8's no-token fallback). The
 * digest is still reported `confirmed: false`: the agent decides what the log
 * line is worth, and only when the registry itself cannot be read.
 */
describe('GitHubActionsBuildPlugin.getBuild — the Push-step digest (plan §4.8, T14 remainder)', () => {
	const sha = 'a'.repeat(40);
	const digest = `sha256:${'e'.repeat(64)}`;
	const ref: BuildRef = {
		repository: {
			owner: 'acme',
			repo: 'their-app',
			visibility: 'private',
			trackedBranch: 'main',
			createdByAppWork: true
		},
		buildId: BUILD_ID,
		providerRunId: '9001'
	};

	function artifactPort(overrides: Partial<ActionsRunsPort>): ActionsRunsPort {
		return fakePort({
			listRunJobs: async () => [job('build', 61, { id: 314 })],
			listRunArtifacts: async () => [{ id: 77, name: APP_BUILD_RESULT_ARTIFACT_NAME, size_in_bytes: 256 }],
			downloadArtifactZip: async () =>
				zipSync({
					[APP_BUILD_RESULT_ARTIFACT_FILE]: new TextEncoder().encode(
						JSON.stringify({
							digest,
							imageRepository: 'ghcr.io/acme/their-app/ever-works-app',
							tags: [`sha-${sha}`]
						})
					)
				}),
			...overrides
		});
	}

	function pushLog(lines: readonly string[]): Uint8Array {
		return new TextEncoder().encode(
			[
				'2026-09-21T10:03:00.0000000Z ##[group]Run docker push --all-tags "$EW_IMAGE"',
				'2026-09-21T10:03:00.0000000Z ##[endgroup]',
				'2026-09-21T10:03:01.0000000Z The push refers to repository [ghcr.io/acme/their-app/ever-works-app]',
				...lines.map((content) => `2026-09-21T10:03:02.0000000Z ${content}`),
				'2026-09-21T10:03:04.0000000Z ##[group]Run set -euo pipefail'
			].join('\n')
		);
	}

	it('a succeeded push run with an artifact carries the Push step’s digest, still unconfirmed', async () => {
		const downloadJobLogTail = vi.fn(async () => ({
			bytes: pushLog([`sha-${sha}: digest: ${digest} size: 1570`]),
			partial: false
		}));
		const plugin = new TestPlugin(
			artifactPort({ getWorkflowRun: async () => run({ event: 'push' }), downloadJobLogTail })
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.image).toEqual({
			repository: 'ghcr.io/acme/their-app/ever-works-app',
			digest,
			tags: [`sha-${sha}`],
			confirmed: false,
			pushLogDigest: digest
		});
		// The BUILD job's log — the one holding the Push step — read as a bounded tail.
		expect(downloadJobLogTail).toHaveBeenCalledTimes(1);
		expect(downloadJobLogTail.mock.calls[0]).toEqual([
			expect.objectContaining({ repository: REPOSITORY, jobId: 314 })
		]);
	});

	it('reads it for a manual run too', async () => {
		const plugin = new TestPlugin(
			artifactPort({
				getWorkflowRun: async () => run({ event: 'workflow_dispatch' }),
				downloadJobLogTail: async () => ({
					bytes: pushLog([`sha-${sha}: digest: ${digest} size: 1570`]),
					partial: false
				})
			})
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.trigger).toBe('manual');
		expect(snapshot?.image?.pushLogDigest).toBe(digest);
	});

	it('omits pushLogDigest when the Push step logged no digest for the Build’s sha', async () => {
		const plugin = new TestPlugin(
			artifactPort({
				getWorkflowRun: async () => run({ event: 'push' }),
				downloadJobLogTail: async () => ({ bytes: pushLog(['branch-main: digest: x size: 1']), partial: false })
			})
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.image).toBeDefined();
		expect(snapshot?.image && 'pushLogDigest' in snapshot.image).toBe(false);
	});

	it('an unreadable log costs the fallback, never the observation', async () => {
		const plugin = new TestPlugin(
			artifactPort({
				getWorkflowRun: async () => run({ event: 'push' }),
				downloadJobLogTail: async () => {
					throw new Error('log expired');
				}
			})
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.status).toBe('succeeded');
		expect(snapshot?.image?.digest).toBe(digest);
		expect(snapshot?.image?.pushLogDigest).toBeUndefined();
	});

	it('does not read the log for a pull request run — it never pushes (FR-11)', async () => {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: pushLog([]), partial: false }));
		const plugin = new TestPlugin(
			artifactPort({ getWorkflowRun: async () => run({ event: 'pull_request' }), downloadJobLogTail })
		);

		const snapshot = await plugin.getBuild(ref, AUTH, (text) => text);

		expect(snapshot?.trigger).toBe('pull_request');
		expect(downloadJobLogTail).not.toHaveBeenCalled();
	});

	it('does not read the log for a run that is still going, or one with no artifact', async () => {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: pushLog([]), partial: false }));
		const running = new TestPlugin(
			artifactPort({
				getWorkflowRun: async () => run({ status: 'in_progress', conclusion: null }),
				listRunJobs: async () => [job('build', 0, { status: 'in_progress', conclusion: null })],
				downloadJobLogTail
			})
		);
		const noArtifact = new TestPlugin(
			artifactPort({
				getWorkflowRun: async () => run({ event: 'push' }),
				listRunArtifacts: async () => [],
				downloadJobLogTail
			})
		);

		await running.getBuild(ref, AUTH, (text) => text);
		await noArtifact.getBuild(ref, AUTH, (text) => text);

		expect(downloadJobLogTail).not.toHaveBeenCalled();
	});
});
