import { ActionsRunnersFacadeError } from '../../../facades/actions-runners.facade';
import { readFleetMachineError } from '../../machine/fleet-machine.errors';
import { jobUnassignableItems } from '../fleet-actions-jobs-needs-a-look.producer';
import { FleetActionsRunnersService } from '../fleet-actions-runners.service';

/**
 * Actions runners on computers (FL-18 P2, T-22 – T-24, plan §14) — the Actions
 * jobs read against in-memory doubles: the default watched list, the diagnosis
 * against the caller's own runners (GitHub's labels included), unreadable
 * targets named rather than hidden, the 30 s cache, Cancel workflow run (the
 * confirmation names the run, the kill switch refuses it, one audit row with no
 * token), the watched list validated against the App's coverage, and the
 * `job-unassignable` items.
 */

const OWNER = '7d1c0a52-3a8e-4c55-9b7d-2f8c0b1a9e01';
const NODE = '3f6e2a10-1b2c-4d3e-8f4a-5b6c7d8e9f00';

function harness(opts: { stopped?: boolean; runnerState?: string; jobs?: Array<Record<string, unknown>>; saved?: unknown } = {}) {
    const node = {
        id: NODE,
        userId: OWNER,
        name: 'build-01',
        kind: 'node',
        status: 'online',
        lastHeartbeatAt: new Date(),
        consents: { work: true },
        capabilities: ['actions-runner', 'os:linux', 'arch:x64'],
    };
    const rows = [
        {
            id: 'r1',
            nodeId: NODE,
            ownerUserId: OWNER,
            name: 'build-01-1',
            scope: 'repo',
            target: 'acme/api',
            labels: ['gpu'],
            state: opts.runnerState ?? 'idle',
            removedAt: null,
        },
    ];
    const runners = { listForOwner: jest.fn(async () => rows) };
    const nodes = { findById: jest.fn(async () => node) };
    const queuedAt = new Date(Date.now() - 10 * 60_000).toISOString();
    const jobs = opts.jobs ?? [
        {
            repository: 'acme/api',
            runId: 4822,
            runNumber: 17,
            jobId: 1,
            name: 'e2e · windows',
            workflowName: 'CI',
            labels: ['self-hosted', 'windows'],
            status: 'queued',
            runnerName: null,
            runnerId: null,
            startedAt: null,
            queuedAt,
            url: 'https://github.com/acme/api/actions/runs/4822/job/1',
        },
        {
            repository: 'acme/api',
            runId: 4823,
            runNumber: 18,
            jobId: 2,
            name: 'test · linux',
            workflowName: 'CI',
            labels: ['self-hosted', 'linux', 'x64'],
            status: 'queued',
            runnerName: null,
            runnerId: null,
            startedAt: null,
            queuedAt,
            url: null,
        },
    ];
    const facade = {
        getWatchedTargets: jest.fn(async () => opts.saved ?? null),
        setWatchedTargets: jest.fn(async () => undefined),
        listTargets: jest.fn(async () => [
            { scope: 'repo', target: 'acme/api', accountLogin: 'acme', installationEntityId: 'inst-1' },
            { scope: 'org', target: 'acme', accountLogin: 'acme', installationEntityId: 'inst-1' },
        ]),
        resolveTarget: jest.fn(async (_u: string, scope: string, target: string) => {
            if (target.toLowerCase() !== 'acme/api' && target.toLowerCase() !== 'acme') {
                throw new ActionsRunnersFacadeError(`install the Ever Works GitHub App on ${target} first`, 'resolveTarget', 'not-covered');
            }
            return { scope, target, installationId: '1', installationEntityId: 'inst-1', accountLogin: 'acme', targetType: 'Organization', repositoryId: '7' };
        }),
        repositoriesOf: jest.fn(async () => [{ fullName: 'acme/api', githubRepoId: '7' }]),
        listJobs: jest.fn(async () => ({ jobs, etag: null, notModified: false, rateLimitedUntil: null, rateLimitRemaining: null })),
        cancelRun: jest.fn(async () => undefined),
        checkPermission: jest.fn(async () => ({
            ok: false,
            missing: 'Self-hosted runners: Read and write',
            grantUrl: 'https://github.com/organizations/acme/settings/installations/1',
        })),
    };
    const audit = { tryRecord: jest.fn(async () => true) };
    const killSwitch = { isStopped: jest.fn(async () => Boolean(opts.stopped)) };
    const service = new FleetActionsRunnersService(
        runners as never,
        nodes as never,
        {} as never,
        {} as never,
        facade as never,
        undefined,
        killSwitch as never,
        audit as never,
        undefined,
    );
    return { service, facade, audit, killSwitch, rows, node };
}

const caller = { kind: 'user' as const, userId: OWNER };

async function refusal(promise: Promise<unknown>) {
    try {
        await promise;
    } catch (error) {
        const known = readFleetMachineError(error);
        if (known) return known;
        throw error;
    }
    throw new Error('expected a refusal');
}

describe('FleetActionsRunnersService — Actions jobs (FL-18 P2)', () => {
    const saved = { ...process.env };
    beforeEach(() => {
        process.env.FLEET_ENABLED = 'true';
        process.env.FLEET_ACTIONS_RUNNERS_ENABLED = 'true';
    });
    afterEach(() => {
        process.env = { ...saved };
    });

    it('watches every target the owner has runners for by default, and diagnoses each queued job (GitHub labels included)', async () => {
        const { service } = harness();
        const view = await service.jobs(caller);
        expect(view.watched).toEqual([{ scope: 'repo', target: 'acme/api' }]);
        expect(view.watchedSaved).toBe(false);
        expect(view.available).toHaveLength(2);
        const byJob = new Map(view.jobs.map((job) => [job.jobId, job]));
        expect(byJob.get(1)).toMatchObject({ diagnosis: 'missing-label', diagnosisDetail: 'windows', unassignable: true });
        // `linux` / `x64` are labels GitHub adds itself: the runner matches and is idle.
        expect(byJob.get(2)).toMatchObject({ diagnosis: null, unassignable: false });
        expect(view).toMatchObject({ busyRunners: 0, totalRunners: 1, killSwitch: false, canCancel: true });
    });

    it('a busy matching runner is "waiting for", not a problem; an offline one is', async () => {
        const busy = await harness({ runnerState: 'working' }).service.jobs(caller);
        expect(busy.jobs.find((job) => job.jobId === 2)).toMatchObject({ diagnosis: 'all-busy', unassignable: false });
        const offline = await harness({ runnerState: 'offline' }).service.jobs(caller);
        expect(offline.jobs.find((job) => job.jobId === 2)).toMatchObject({ diagnosis: 'offline-matching-runner', unassignable: true });
    });

    it('names a watched target it cannot read instead of hiding it, and reads through a 30 s cache', async () => {
        const h = harness({ saved: [{ scope: 'repo', target: 'acme/api' }, { scope: 'repo', target: 'other/repo' }] });
        const view = await h.service.jobs(caller);
        expect(view.watchedSaved).toBe(true);
        expect(view.unreadable).toEqual([
            expect.objectContaining({ scope: 'repo', target: 'other/repo', reason: expect.stringContaining('install the Ever Works GitHub App') }),
        ]);
        await h.service.jobs(caller);
        expect(h.facade.listJobs).toHaveBeenCalledTimes(1);
        expect(h.service.cachedJobs(OWNER)).toHaveLength(2);
    });

    it('produces job-unassignable items on the computer of a covering runner', async () => {
        const { service, node, rows } = harness();
        const view = await service.jobs(caller);
        const items = jobUnassignableItems([{ id: NODE, name: node.name } as never], view.jobs, rows as never);
        expect(items).toEqual([
            expect.objectContaining({
                id: 'fleet-actions-job:acme/api:1:unassignable',
                nodeId: NODE,
                kind: 'job-unassignable',
                detail: 'needs label windows',
            }),
        ]);
        expect(jobUnassignableItems([], view.jobs, rows as never)).toEqual([]);
    });

    it('cancels a workflow run only with the confirmation naming it, writes one audit row, refuses under the kill switch', async () => {
        const h = harness();
        const first = await refusal(h.service.cancelRun(caller, { repository: 'acme/api', runId: 4822, runNumber: 17 }));
        expect(first.code).toBe('confirmation_required');
        expect(first.details?.summary).toBe('Cancel workflow run #17 of acme/api? Every job in it stops. This cannot be undone.');
        expect(h.facade.cancelRun).not.toHaveBeenCalled();
        await expect(
            h.service.cancelRun(caller, { repository: 'acme/api', runId: 4822, runNumber: 17, fields: { confirm: true } }),
        ).resolves.toEqual({ repository: 'acme/api', runId: 4822, cancelled: true });
        expect(h.facade.cancelRun).toHaveBeenCalledWith(OWNER, expect.objectContaining({ target: 'acme/api' }), 4822);
        expect(h.audit.tryRecord).toHaveBeenCalledWith(
            expect.objectContaining({
                action: 'node.runner.job.cancel',
                details: expect.objectContaining({ family: 'machines', target: 'acme/api#4822', outcome: 'ok' }),
            }),
        );

        const stopped = harness({ stopped: true });
        expect((await refusal(stopped.service.cancelRun(caller, { repository: 'acme/api', runId: 1, fields: { confirm: true } }))).code).toBe(
            'kill_switch',
        );
        expect(stopped.facade.cancelRun).not.toHaveBeenCalled();
        expect((await refusal(h.service.cancelRun(caller, { repository: 'other/repo', runId: 1, fields: { confirm: true } }))).code).toBe(
            'permission_denied',
        );
    });

    it('saves a watched list only of targets the App covers; an empty list goes back to the default', async () => {
        const h = harness();
        expect(await h.service.setWatched(caller, [{ scope: 'org', target: 'acme' }])).toEqual({ watched: [{ scope: 'org', target: 'acme' }] });
        expect(h.facade.setWatchedTargets).toHaveBeenCalledWith(OWNER, [{ scope: 'org', target: 'acme' }]);
        expect((await refusal(h.service.setWatched(caller, [{ scope: 'repo', target: 'other/repo' }]))).code).toBe('permission_denied');
        expect((await refusal(h.service.setWatched(caller, 'acme/api'))).code).toBe('invalid');
        expect(await h.service.setWatched(caller, [])).toEqual({ watched: [{ scope: 'repo', target: 'acme/api' }] });
        expect(h.facade.setWatchedTargets).toHaveBeenLastCalledWith(OWNER, null);
    });

    it('answers the organisation permission check with the exact permission and the installation page', async () => {
        const { service } = harness();
        expect(await service.permission(caller, 'org', 'acme')).toEqual({
            scope: 'org',
            target: 'acme',
            ok: false,
            missing: 'Self-hosted runners: Read and write',
            grantUrl: 'https://github.com/organizations/acme/settings/installations/1',
        });
    });
});
