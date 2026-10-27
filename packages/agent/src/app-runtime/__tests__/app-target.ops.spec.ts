/**
 * Lane aw-ops (2026-10-27) — `AppTargetService`'s Deploy-tab operations (plan §9.1): refresh
 * status, fetch logs and read them back, run a job, run the smoke checks, and the history.
 *
 * The rules pinned hardest:
 *  - the API dials nothing: every op is one `app-cluster-op` dispatch carrying names and ids only
 *    — never a secret value (the log payload especially);
 *  - a log tail is redacted again at read time with the App's secret values, and withheld when
 *    those cannot be read (FR-48, fail closed); another Work's request id misses;
 *  - the `app-op:` entry reads `queued` before the dispatch and `failed worker_unavailable` when
 *    nobody took it, so `GET app-status` never shows a request that silently vanished;
 *  - refresh is once per 15 s per Work (FR-46); a job needs the member's confirmation (FR-51) and is
 *    refused during a Deployment or while a run of it is still going.
 */

import { Logger } from '@nestjs/common';

import { ConfigAppsTierPolicy } from '../../apps-tier/config-apps-tier-policy';
import { AppTargetService } from '../app-target.service';
import { redactAppLogTail } from '../app-log-redaction';

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const OTHER_WORK_ID = '11111111-2222-4333-8444-555555555555';
const DEPLOYMENT_ID = '7d1f3a52-2222-4b3c-8d4e-5f6071829304';
const SECRET = 'sentinel-secret-value-9c41';

/** A `CACHE_MANAGER` over a Map — get/set like cache-manager's. */
function cacheFake() {
    const store = new Map<string, unknown>();
    return {
        store,
        get: jest.fn(async (key: string) => (store.has(key) ? store.get(key) : undefined)),
        set: jest.fn(async (key: string, value: unknown) => {
            store.set(key, value);
        }),
    };
}

function harness(
    row: Record<string, unknown> | null = {
        target: 'your-cluster',
        currentDeploymentId: DEPLOYMENT_ID,
    },
    opts: {
        dispatch?: () => Promise<string | null>;
        secrets?: Record<string, string> | null;
        envSource?: unknown;
    } = {},
) {
    const state = row ? { ...row } : null;
    const states = {
        getOrCreate: jest.fn(async () => (state ? { ...state } : null)),
        patchRuntimeState: jest.fn(async () => undefined),
    };
    const deployments = {
        findByWork: jest.fn(async () => [] as Array<Record<string, unknown>>),
        findById: jest.fn(async () => null as Record<string, unknown> | null),
    };
    const ops = {
        dispatch: jest.fn(opts.dispatch ?? (async () => 'run-1')),
        isEnabled: () => true,
    };
    const cache = cacheFake();
    const envSource =
        opts.envSource !== undefined
            ? opts.envSource
            : {
                  secretValuesForRedaction: jest.fn(async () =>
                      opts.secrets === undefined ? { DATABASE_PASSWORD: SECRET } : opts.secrets,
                  ),
              };
    const service = new AppTargetService(
        states as never,
        undefined,
        deployments as never,
        undefined,
        undefined,
        ops,
        new ConfigAppsTierPolicy({}),
        undefined,
        undefined,
        undefined,
        cache as never,
        envSource as never,
    );
    return { service, states, deployments, ops, cache, envSource };
}

beforeAll(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
});

describe('refreshStatus (POST app-status/refresh, FR-46)', () => {
    it('queues one status-refresh op and records it as queued', async () => {
        const { service, ops, cache } = harness();
        const result = await service.refreshStatus(WORK_ID, 'u-1');

        expect(result).toMatchObject({
            ok: true,
            httpStatus: 202,
            op: 'status-refresh',
            dispatched: true,
        });
        const requestId = (result as { requestId: string }).requestId;
        expect(ops.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                op: 'status-refresh',
                workId: WORK_ID,
                userId: 'u-1',
                requestId,
            }),
        );
        expect(cache.store.get(`app-op:${WORK_ID}:${requestId}`)).toEqual({
            op: 'status-refresh',
            state: 'queued',
        });
    });

    it('allows one refresh per 15 seconds per Work', async () => {
        const { service, ops } = harness();
        await service.refreshStatus(WORK_ID, 'u-1');
        const second = await service.refreshStatus(WORK_ID, 'u-2');

        expect(second).toMatchObject({
            ok: false,
            refusal: { httpStatus: 429, code: 'refresh_too_soon' },
        });
        expect(
            (second as { refusal: { retryAfterSeconds: number } }).refusal.retryAfterSeconds,
        ).toBeGreaterThan(0);
        expect(ops.dispatch).toHaveBeenCalledTimes(1);
    });

    it('refuses a Work with nothing deployed and one being deleted', async () => {
        await expect(
            harness({ target: 'your-cluster' }).service.refreshStatus(WORK_ID, 'u'),
        ).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 409, code: 'app_not_deployed' },
        });
        await expect(
            harness({
                currentDeploymentId: DEPLOYMENT_ID,
                deletionRequestedAt: new Date(),
            }).service.refreshStatus(WORK_ID, 'u'),
        ).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 409, code: 'APP_WORK_DELETING' },
        });
    });

    it('turns the entry failed at once when no worker takes the op', async () => {
        const { service, cache } = harness(undefined, { dispatch: async () => null });
        const result = await service.refreshStatus(WORK_ID, 'u-1');
        expect(result).toMatchObject({ ok: true, dispatched: false });
        const requestId = (result as { requestId: string }).requestId;
        expect(cache.store.get(`app-op:${WORK_ID}:${requestId}`)).toEqual({
            op: 'status-refresh',
            state: 'failed',
            code: 'worker_unavailable',
        });
    });
});

describe('requestLogs / readLogs (FR-48)', () => {
    it('dispatches names and ids only — never a secret value — and marks the request pending', async () => {
        const { service, ops, cache } = harness();
        const result = await service.requestLogs(WORK_ID, 'u-1', {
            component: 'web',
            lines: 900,
            previous: true,
        });

        expect(result).toMatchObject({ ok: true, httpStatus: 202, op: 'logs' });
        const requestId = (result as { requestId: string }).requestId;
        const payload = (ops.dispatch.mock.calls as unknown as unknown[][])[0]?.[0] as Record<
            string,
            unknown
        >;
        expect(payload).toEqual({
            op: 'logs',
            workId: WORK_ID,
            userId: 'u-1',
            requestId,
            component: 'web',
            previous: true,
            lines: 500,
        });
        expect(JSON.stringify(ops.dispatch.mock.calls)).not.toContain(SECRET);
        expect(cache.store.get(`app-logs:${WORK_ID}:${requestId}`)).toEqual({ state: 'pending' });
    });

    it('refuses a request that names both, neither, or a malformed target', async () => {
        const { service, ops } = harness();
        await expect(
            service.requestLogs(WORK_ID, 'u', { component: 'web', job: 'migrate' }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'log_target_ambiguous' },
        });
        await expect(service.requestLogs(WORK_ID, 'u', {})).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'log_target_required' },
        });
        await expect(service.requestLogs(WORK_ID, 'u', { job: '../etc' })).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'invalid_log_target' },
        });
        await expect(
            service.requestLogs(WORK_ID, 'u', { job: 'migrate', lines: 0 }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'invalid_lines' },
        });
        expect(ops.dispatch).not.toHaveBeenCalled();
    });

    it('allows logs of a Work whose Deployment failed (no current one), but not of target none', async () => {
        const failed = harness({ target: 'your-cluster', currentDeploymentId: null });
        await expect(
            failed.service.requestLogs(WORK_ID, 'u', { job: 'migrate' }),
        ).resolves.toMatchObject({
            ok: true,
        });
        const none = harness({ target: 'none' });
        await expect(
            none.service.requestLogs(WORK_ID, 'u', { job: 'migrate' }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 409, code: 'app_target_none' },
        });
    });

    it('reads pending, then a READY tail redacted again with the App’s secret values', async () => {
        const { service, cache } = harness();
        const accepted = (await service.requestLogs(WORK_ID, 'u', { component: 'web' })) as {
            requestId: string;
        };

        await expect(service.readLogs(WORK_ID, accepted.requestId)).resolves.toEqual({
            ok: true,
            body: { requestId: accepted.requestId, status: 'pending' },
        });

        // The worker's write — its own pass had no secret values to redact with.
        cache.store.set(`app-logs:${WORK_ID}:${accepted.requestId}`, {
            state: 'done',
            tail: {
                containers: [
                    {
                        pod: 'web-1',
                        container: 'web',
                        lines: [`connecting with ${SECRET}`, 'ready'],
                        truncated: false,
                    },
                ],
                redactedNames: [],
                fetchedAt: '2026-10-27T00:00:00.000Z',
            },
        });

        const read = await service.readLogs(WORK_ID, accepted.requestId);
        expect(read).toMatchObject({ ok: true, body: { status: 'ready' } });
        expect(JSON.stringify(read)).not.toContain(SECRET);
        const body = (
            read as unknown as {
                body: { tail: { containers: Array<{ lines: string[] }>; redactedNames: string[] } };
            }
        ).body;
        expect(body.tail.containers[0].lines).toEqual([
            'connecting with DATABASE_PASSWORD',
            'ready',
        ]);
        expect(body.tail.redactedNames).toEqual(['DATABASE_PASSWORD']);
    });

    it('withholds a ready tail when the secret values cannot be read (fail closed)', async () => {
        const unreadable = harness(undefined, { secrets: null });
        const accepted = (await unreadable.service.requestLogs(WORK_ID, 'u', {
            component: 'web',
        })) as {
            requestId: string;
        };
        unreadable.cache.store.set(`app-logs:${WORK_ID}:${accepted.requestId}`, {
            state: 'done',
            tail: {
                containers: [{ pod: 'p', container: 'c', lines: [SECRET], truncated: false }],
                redactedNames: [],
                fetchedAt: '',
            },
        });
        const read = await unreadable.service.readLogs(WORK_ID, accepted.requestId);
        expect(read).toEqual({
            ok: true,
            body: {
                requestId: accepted.requestId,
                status: 'failed',
                code: 'redaction_unavailable',
            },
        });

        const noSource = harness(undefined, { envSource: null });
        const second = (await noSource.service.requestLogs(WORK_ID, 'u', { component: 'web' })) as {
            requestId: string;
        };
        noSource.cache.store.set(`app-logs:${WORK_ID}:${second.requestId}`, {
            state: 'done',
            tail: { containers: [], redactedNames: [], fetchedAt: '' },
        });
        await expect(noSource.service.readLogs(WORK_ID, second.requestId)).resolves.toMatchObject({
            body: { status: 'failed', code: 'redaction_unavailable' },
        });
    });

    it('misses for another Work’s request id, an expired one and a malformed one', async () => {
        const { service } = harness();
        const accepted = (await service.requestLogs(WORK_ID, 'u', { component: 'web' })) as {
            requestId: string;
        };

        await expect(service.readLogs(OTHER_WORK_ID, accepted.requestId)).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 404, code: 'logs_request_not_found' },
        });
        await expect(
            service.readLogs(WORK_ID, 'b5e1c7a0-3333-4c4d-9e5f-607182930415'),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 404 },
        });
        await expect(service.readLogs(WORK_ID, 'not-a-uuid')).resolves.toMatchObject({
            refusal: { httpStatus: 404 },
        });
    });

    it('passes a worker failure through with its code', async () => {
        const { service, cache } = harness();
        const accepted = (await service.requestLogs(WORK_ID, 'u', { job: 'migrate' })) as {
            requestId: string;
        };
        cache.store.set(`app-logs:${WORK_ID}:${accepted.requestId}`, {
            state: 'failed',
            code: 'cluster_unreachable',
        });
        await expect(service.readLogs(WORK_ID, accepted.requestId)).resolves.toEqual({
            ok: true,
            body: { requestId: accepted.requestId, status: 'failed', code: 'cluster_unreachable' },
        });
    });
});

describe('runJob (POST app-jobs/:name/run, FR-51)', () => {
    it('requires the member’s confirmation before anything is dispatched', async () => {
        const { service, ops } = harness();
        await expect(service.runJob(WORK_ID, 'u', 'migrate', {})).resolves.toMatchObject({
            ok: false,
            refusal: { httpStatus: 422, code: 'job_confirmation_required' },
        });
        expect(ops.dispatch).not.toHaveBeenCalled();
    });

    it('dispatches job-run with the job name and the confirmation, and lists it in app-status', async () => {
        const { service, ops } = harness();
        const result = await service.runJob(WORK_ID, 'u-1', 'migrate', {
            confirmFirstDeploy: true,
        });

        expect(result).toMatchObject({ ok: true, httpStatus: 202, op: 'job-run' });
        expect(ops.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                op: 'job-run',
                jobName: 'migrate',
                confirmFirstDeploy: true,
                workId: WORK_ID,
            }),
        );
        const status = await service.getStatus(WORK_ID);
        expect(status.requests).toEqual([
            expect.objectContaining({
                requestId: (result as { requestId: string }).requestId,
                op: 'job-run',
                state: 'queued',
                jobName: 'migrate',
            }),
        ]);
    });

    it('refuses during a Deployment, while a run of the job is going, and on a malformed name', async () => {
        const locked = harness({
            target: 'your-cluster',
            currentDeploymentId: DEPLOYMENT_ID,
            deployLockId: 'd-2',
        });
        await expect(
            locked.service.runJob(WORK_ID, 'u', 'migrate', { confirmFirstDeploy: true }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 409, code: 'deploy_in_progress' },
        });

        const running = harness({
            target: 'your-cluster',
            currentDeploymentId: DEPLOYMENT_ID,
            statusSnapshot: { jobs: [{ name: 'migrate', last: { status: 'running' } }] },
        });
        await expect(
            running.service.runJob(WORK_ID, 'u', 'migrate', { confirmFirstDeploy: true }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 409, code: 'job_active' },
        });
        // Another job is not blocked by it.
        await expect(
            running.service.runJob(WORK_ID, 'u', 'seed', { confirmFirstDeploy: true }),
        ).resolves.toMatchObject({
            ok: true,
        });

        await expect(
            harness().service.runJob(WORK_ID, 'u', 'a b', { confirmFirstDeploy: true }),
        ).resolves.toMatchObject({
            refusal: { httpStatus: 400, code: 'invalid_job_name' },
        });
    });
});

describe('runSmoke (POST app-smoke)', () => {
    it('queues the smoke op for the live Deployment', async () => {
        const { service, ops } = harness();
        await expect(service.runSmoke(WORK_ID, 'u-1')).resolves.toMatchObject({
            ok: true,
            op: 'smoke',
        });
        expect(ops.dispatch).toHaveBeenCalledWith(
            expect.objectContaining({
                op: 'smoke',
                deploymentId: DEPLOYMENT_ID,
                trigger: 'manual',
            }),
        );
    });

    it('refuses a paused app and a running Deployment', async () => {
        await expect(
            harness({
                target: 'your-cluster',
                currentDeploymentId: DEPLOYMENT_ID,
                paused: true,
            }).service.runSmoke(WORK_ID, 'u'),
        ).resolves.toMatchObject({ refusal: { httpStatus: 409, code: 'app_paused' } });
        await expect(
            harness({
                target: 'your-cluster',
                currentDeploymentId: DEPLOYMENT_ID,
                deployLockId: 'x',
            }).service.runSmoke(WORK_ID, 'u'),
        ).resolves.toMatchObject({ refusal: { httpStatus: 409, code: 'deploy_in_progress' } });
    });
});

describe('getStatus smoke and listDeployments', () => {
    it('shows the live Deployment’s smoke checks without their response excerpts', async () => {
        const { service, deployments } = harness();
        deployments.findById.mockResolvedValue({
            id: DEPLOYMENT_ID,
            workId: WORK_ID,
            state: 'READY',
            smokeResult: {
                observedAt: '2026-10-27T00:00:00.000Z',
                inCluster: [
                    { name: 'health', status: 'passed', httpStatus: 200, found: `token=${SECRET}` },
                ],
                public: [{ name: 'home', status: 'failed', classification: 'tls_not_ready' }],
            },
        });
        const status = await service.getStatus(WORK_ID);
        expect(status.smoke).toEqual({
            deploymentId: DEPLOYMENT_ID,
            observedAt: '2026-10-27T00:00:00.000Z',
            inCluster: [{ name: 'health', status: 'passed', httpStatus: 200 }],
            public: [{ name: 'home', status: 'failed', classification: 'tls_not_ready' }],
            hairpin: null,
        });
        expect(JSON.stringify(status.smoke)).not.toContain(SECRET);
    });

    it('lists the history as ids, states and times, marking the current one', async () => {
        const { service, deployments } = harness();
        deployments.findByWork.mockResolvedValue([
            {
                id: DEPLOYMENT_ID,
                state: 'READY',
                appTrigger: 'manual',
                buildId: 'b-1',
                commitSha: 'abc',
                appRender: {
                    image: { digest: 'sha256:1234' },
                    envFingerprints: { SECRET_KEY: 'fp' },
                },
                createdAt: new Date('2026-10-27T00:00:00.000Z'),
                lastError: null,
            },
            { id: 'd-old', state: 'ERROR', lastError: 'rollout_timeout: web never became ready' },
        ]);
        const history = await service.listDeployments(WORK_ID);
        expect(history[0]).toMatchObject({
            id: DEPLOYMENT_ID,
            state: 'READY',
            trigger: 'manual',
            buildId: 'b-1',
            commitSha: 'abc',
            imageDigest: 'sha256:1234',
            current: true,
            code: null,
        });
        expect(history[1]).toMatchObject({ id: 'd-old', current: false, code: 'rollout_timeout' });
        expect(JSON.stringify(history)).not.toContain('envFingerprints');
    });
});

describe('redactAppLogTail', () => {
    it('replaces values of 8+ characters by their name, longest first, and leaves short ones', () => {
        const tail = redactAppLogTail(
            {
                containers: [
                    {
                        pod: 'p',
                        container: 'c',
                        lines: ['a=longsecret123 b=longsecret short=abc'],
                        truncated: true,
                    },
                ],
                redactedNames: ['FROM_WORKER'],
                fetchedAt: 'now',
            },
            { LONG: 'longsecret123', SHORTER: 'longsecret', TINY: 'abc' },
        );
        expect(tail?.containers[0].lines).toEqual(['a=LONG b=SHORTER short=abc']);
        expect(tail?.containers[0].truncated).toBe(true);
        expect(tail?.redactedNames).toEqual(['FROM_WORKER', 'LONG', 'SHORTER']);
    });

    it('answers null for something that is not a tail', () => {
        expect(redactAppLogTail(null, {})).toBeNull();
        expect(redactAppLogTail({} as never, {})).toBeNull();
    });
});
