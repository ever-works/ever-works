import type { BuildAuth, BuildRef } from '@ever-works/plugin';
import { describe, expect, it, vi } from 'vitest';

import { GitHubActionsBuildPlugin } from '../github-actions-build.plugin.js';
import type { ActionsJob, ActionsRun, ActionsRunsPort } from '../runs/actions-runs.port.js';
import { LOG_TAIL_MAX_BYTES, readJobLogTail } from '../runs/log-tail.js';

/**
 * APW-05 T13, second half — the failing job's log, and the `failure` block
 * `getBuild` builds out of it.
 *
 * `failure-classifier.spec.ts` already proves every row of plan §4.9 against a
 * log string. What is NOT proved there, and is proved here, is everything
 * between GitHub and that string:
 *
 *   - the read is BOUNDED, on the request and again on the response;
 *   - a missing, expired or unreadable log is empty, never a thrown observation;
 *   - the first line of a partial response is dropped, because a byte range does
 *     not start on a line boundary;
 *   - `getBuild` reads the log **only** for a failed run, picks the `build`
 *     job's log rather than whichever job happens to be first, and threads
 *     APW-07's redactor into the excerpt.
 */

const REPOSITORY = { owner: 'acme', repo: 'their-app' } as const;
const BUILD_ID = '7f1c0f2e-1111-4111-8111-aaaaaaaaaaaa';
const AUTH: BuildAuth = { token: 'ghs-not-a-real-token' };
const RUN_ID = 9001;

const REF: BuildRef = {
	repository: {
		owner: 'acme',
		repo: 'their-app',
		visibility: 'public',
		trackedBranch: 'main',
		createdByAppWork: true
	},
	buildId: BUILD_ID,
	providerRunId: String(RUN_ID)
};

function run(overrides: Partial<ActionsRun> = {}): ActionsRun {
	return {
		id: RUN_ID,
		status: 'completed',
		conclusion: 'failure',
		run_attempt: 1,
		display_title: `Ever Works build ${BUILD_ID}`,
		event: 'workflow_dispatch',
		head_branch: 'main',
		head_sha: 'a'.repeat(40),
		html_url: `https://github.com/acme/their-app/actions/runs/${RUN_ID}`,
		...overrides
	};
}

function job(name: string, overrides: Partial<ActionsJob> = {}): ActionsJob {
	return {
		id: 1,
		name,
		status: 'completed',
		conclusion: 'failure',
		labels: ['ubuntu-latest'],
		...overrides
	};
}

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

class TestPlugin extends GitHubActionsBuildPlugin {
	constructor(private readonly port: ActionsRunsPort) {
		super();
	}
	protected actionsPort(): ActionsRunsPort {
		return this.port;
	}
}

const utf8 = (text: string) => new TextEncoder().encode(text);

describe('readJobLogTail (plan §4.8)', () => {
	it('asks the server for the tail rather than reading it all and slicing', async () => {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: utf8('done\n'), partial: false }));

		await readJobLogTail(fakePort({ downloadJobLogTail }), { repository: REPOSITORY, jobId: 42 });

		// The whole point of the bound: a build stuck in a retry loop can print
		// hundreds of megabytes, and reading-then-slicing has already paid for all
		// of it, per poll, per Build.
		expect(downloadJobLogTail).toHaveBeenCalledWith({
			repository: REPOSITORY,
			jobId: 42,
			maxBytes: LOG_TAIL_MAX_BYTES
		});
		expect(LOG_TAIL_MAX_BYTES).toBe(2 * 1024 * 1024);
	});

	it('cuts again when the server ignored the range — a header is a request, not a promise', async () => {
		const oversized = utf8('x'.repeat(LOG_TAIL_MAX_BYTES + 5_000));
		const port = fakePort({ downloadJobLogTail: async () => ({ bytes: oversized, partial: false }) });

		const tail = await readJobLogTail(port, { repository: REPOSITORY, jobId: 42 });

		expect(tail.length).toBe(LOG_TAIL_MAX_BYTES);
	});

	it('drops the first line of a PARTIAL response, because a byte range splits one', async () => {
		const port = fakePort({
			downloadJobLogTail: async () => ({ bytes: utf8('ing the last layer\nERROR: boom\n'), partial: true })
		});

		const tail = await readJobLogTail(port, { repository: REPOSITORY, jobId: 42 });

		// `ing the last layer` is a fragment, and a fragment in an excerpt reads
		// as corruption to the member trying to work out what broke.
		expect(tail).toBe('ERROR: boom\n');
	});

	it('keeps every line of a WHOLE response — nothing was split', async () => {
		const port = fakePort({
			downloadJobLogTail: async () => ({ bytes: utf8('first\nERROR: boom\n'), partial: false })
		});

		expect(await readJobLogTail(port, { repository: REPOSITORY, jobId: 42 })).toBe('first\nERROR: boom\n');
	});

	it('a partial response with no line break at all is empty, not a fragment', async () => {
		const port = fakePort({ downloadJobLogTail: async () => ({ bytes: utf8('no break here'), partial: true }) });

		expect(await readJobLogTail(port, { repository: REPOSITORY, jobId: 42 })).toBe('');
	});

	it('an expired or absent log is empty, never a throw', async () => {
		// Logs age out, a cancelled job may have none, and a job that never
		// started has nothing to print. A Build whose log expired must still
		// report the status it already knows.
		const missing = fakePort({ downloadJobLogTail: async () => null });
		const broken = fakePort({
			downloadJobLogTail: async () => {
				throw new Error('410 Gone');
			}
		});

		expect(await readJobLogTail(missing, { repository: REPOSITORY, jobId: 42 })).toBe('');
		expect(await readJobLogTail(broken, { repository: REPOSITORY, jobId: 42 })).toBe('');
	});

	it('a port that predates this member answers empty rather than crashing the observation', async () => {
		// `downloadJobLogTail` is the one OPTIONAL member of the port. A caller
		// whose token cannot read logs still gets a classified failure.
		expect(await readJobLogTail(fakePort(), { repository: REPOSITORY, jobId: 42 })).toBe('');
	});
});

describe('getBuild attaches the failure (plan §4.9)', () => {
	function failingPlugin(log: string, jobs?: readonly ActionsJob[]) {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: utf8(log), partial: false }));
		const port = fakePort({
			getWorkflowRun: async () => run(),
			listRunJobs: async () => jobs ?? [job('build')],
			listRunArtifacts: async () => [],
			downloadJobLogTail
		});
		return { plugin: new TestPlugin(port), downloadJobLogTail };
	}

	it('classifies a failed run from its log', async () => {
		const { plugin } = failingPlugin('Step 7/9\nEW_MISSING:DATABASE_URL\n');

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text);

		expect(snapshot?.status).toBe('failed');
		expect(snapshot?.failure?.class).toBe('missingBuildValue');
		expect(snapshot?.failure?.detail).toEqual({ names: ['DATABASE_URL'] });
		expect(snapshot?.failure?.excerpt.at(-1)).toContain('EW_MISSING:DATABASE_URL');
	});

	it('reads the BUILD job’s log, not whichever failing job comes first', async () => {
		// A failed `Ever Works check:` job never flips a Build to `failed` (R-9),
		// so classifying its log would explain the wrong failure entirely.
		const { plugin, downloadJobLogTail } = failingPlugin('EW_MISSING:API_KEY\n', [
			job('Ever Works check: smoke', { id: 55 }),
			job('build', { id: 66 })
		]);

		await plugin.getBuild(REF, AUTH, (text) => text);

		expect(downloadJobLogTail.mock.calls[0][0]).toMatchObject({ jobId: 66 });
	});

	it('spends nothing on the log when the Build SUCCEEDED', async () => {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: utf8('never read'), partial: false }));
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run({ conclusion: 'success' }),
				listRunJobs: async () => [job('build', { conclusion: 'success' })],
				listRunArtifacts: async () => [],
				downloadJobLogTail
			})
		);

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text);

		expect(snapshot?.status).toBe('succeeded');
		expect(snapshot?.failure).toBeUndefined();
		expect(downloadJobLogTail).not.toHaveBeenCalled();
	});

	it('spends nothing on the log while the run is still going', async () => {
		// An in-progress Build is polled repeatedly; buying its log every tick
		// would cost the tail of a growing file over and over.
		const downloadJobLogTail = vi.fn(async () => ({ bytes: utf8('in progress'), partial: false }));
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run({ status: 'in_progress', conclusion: null }),
				listRunJobs: async () => [job('build', { status: 'in_progress', conclusion: null })],
				downloadJobLogTail
			})
		);

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text);

		expect(snapshot?.status).toBe('running');
		expect(downloadJobLogTail).not.toHaveBeenCalled();
	});

	it('threads APW-07’s redactor through every excerpt line (FR-38)', async () => {
		const { plugin } = failingPlugin('connecting to hunter2-the-db\nEW_MISSING:DATABASE_URL\n');

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text.replaceAll('hunter2', '[redacted]'));

		expect(snapshot?.failure?.excerpt.join('\n')).toContain('[redacted]-the-db');
		expect(snapshot?.failure?.excerpt.join('\n')).not.toContain('hunter2');
	});

	it('a run with NO jobs is workflowInvalid — and no log is fetched for a job that does not exist', async () => {
		const downloadJobLogTail = vi.fn(async () => ({ bytes: utf8(''), partial: false }));
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run({ conclusion: 'startup_failure' }),
				listRunJobs: async () => [],
				listRunArtifacts: async () => [],
				downloadJobLogTail
			})
		);

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text);

		expect(snapshot?.failure?.class).toBe('workflowInvalid');
		expect(downloadJobLogTail).not.toHaveBeenCalled();
	});

	it('a log that expired still produces a failure block, classified `unknown`', async () => {
		const plugin = new TestPlugin(
			fakePort({
				getWorkflowRun: async () => run(),
				listRunJobs: async () => [job('build')],
				listRunArtifacts: async () => [],
				downloadJobLogTail: async () => null
			})
		);

		const snapshot = await plugin.getBuild(REF, AUTH, (text) => text);

		// "We could not tell you why" is an answer; a thrown observation would
		// instead make the Build unreadable for as long as the log stays gone.
		expect(snapshot?.failure?.class).toBe('unknown');
	});
});
