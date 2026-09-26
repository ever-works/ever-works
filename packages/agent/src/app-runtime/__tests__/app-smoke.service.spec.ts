/**
 * APW-06 T70 — `AppSmokeService`, plan §5.7 (`plan.md:856-864`) and §9.10:1597-1599.
 *
 * §5.7's body, clause by clause, is what these cases pin:
 *
 * - it **loads the current Deployment** (or the one the payload names), and a Deployment that is not
 *   this Work's — or none at all — is a refusal, not an empty pass;
 * - it runs the **in-cluster** half through `runAppJob` with `AppJobRunRequest { runner: 'smoke',
 *   checks }`, using the **live** image the Deployment recorded;
 * - it runs the **public** half through T23's `AppPublicSmokeService` — the same service §5.6 uses,
 *   with its own window and classifications;
 * - it writes `smokeResult` on that Deployment and emits `app.smoke.passed|failed`;
 * - and it **never rolls back** — no `destroyApp`, no `scaleApp`, no `deployApp`, ever.
 */

import type { AppJobResult } from '@ever-works/plugin';

import {
    APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND,
    APP_SMOKE_CODE_IMAGE_UNAVAILABLE,
    APP_SMOKE_CODE_PUBLIC_URL_UNAVAILABLE,
    APP_SMOKE_CODE_SPEC_UNAVAILABLE,
    APP_SMOKE_DEPLOYMENT_ENVIRONMENT,
    APP_SMOKE_RUNNER_JOB_NAME,
    AppSmokeService,
    checkResultsOf,
    smokeChecksOf,
} from '../app-smoke.service';
import type { AppVerificationSpec } from '../app-verification-target.service';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const OTHER_WORK_ID = '11111111-2222-4333-8444-555555555555';
const DEPLOYMENT_ID = 'dep-1111';
const NAMESPACE = 'ew-helpdesk-0f8e2c1a';
const KUBECONFIG = 'apiVersion: v1\nkind: Config\ncurrent-context: c\n';
const IMAGE = `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`;

const REF = { workId: WORK_ID, namespace: NAMESPACE, target: 'your-cluster' } as const;

const SPEC = {
    input: {
        components: [{ name: 'web', role: 'web', replicas: 2, primary: true }],
        jobs: [],
        cron: [],
        smoke: [
            { name: 'health', component: 'web', http: { path: '/api/health' } },
            { name: 'home', component: 'web', http: { path: '/' } },
        ],
    },
    dependencyKinds: [],
} as unknown as AppVerificationSpec;

const DEPLOYMENT = {
    id: DEPLOYMENT_ID,
    workId: WORK_ID,
    state: 'LIVE',
    buildId: 'build-1',
    commitSha: 'c0ffee1',
    appRender: { image: { reference: IMAGE } },
};

/** The plugin members §5.7 calls, plus the three no smoke run may ever call. */
function pluginFake(overrides: Record<string, unknown> = {}) {
    return {
        deployApp: jest.fn(async () => {
            throw new Error('deployApp must never be called by a smoke run');
        }),
        scaleApp: jest.fn(async () => {
            throw new Error('scaleApp must never be called by a smoke run');
        }),
        destroyApp: jest.fn(async () => {
            throw new Error('destroyApp must never be called by a smoke run');
        }),
        runAppJob: jest.fn(
            async (): Promise<AppJobResult> => ({
                name: 'smoke',
                when: 'post-deploy',
                runName: 'job-smoke-abc',
                status: 'succeeded',
                startedAt: '2026-09-18T10:00:00.000Z',
                http: { name: 'health', status: 'passed', httpStatus: 200, latencyMs: 12 },
            }),
        ),
        ...overrides,
    };
}

function facadeFake(plugin: Record<string, unknown>) {
    return {
        resolveClusterAccess: jest.fn(
            async (_workId: string): Promise<unknown> => ({
                outcome: 'access',
                access: {
                    target: 'your-cluster',
                    ref: REF,
                    credential: KUBECONFIG,
                    pluginId: 'k8s',
                    plugin,
                    clusterSource: 'custom-kubeconfig',
                },
            }),
        ),
    };
}

function deploymentFake(row: Record<string, unknown> | null = DEPLOYMENT) {
    return {
        findById: jest.fn(async (_id: string) => row),
        findLatest: jest.fn(async (_workId: string, _environment: string) => row),
        update: jest.fn(async (_id: string, _fields: { smokeResult?: unknown }) => undefined),
    };
}

function publicSmokeFake(overrides: Record<string, unknown> = {}) {
    return {
        run: jest.fn(async () => ({
            checks: [{ name: 'health', status: 'passed', httpStatus: 200 }],
            passed: true,
            outcome: 'passed',
            warnings: [],
            failures: [],
            healthRelevant: false,
            windowSeconds: 180,
            attempts: 1,
            dns: null,
            observedAt: '2026-09-18T10:00:00.000Z',
        })),
        ...overrides,
    };
}

/**
 * T26's hosts service. `noHost` builds the one answer that leaves the public half with nothing to
 * dial: no primary host at all.
 */
function hostsFake(primaryUrl: string | null = 'https://helpdesk.ever.works') {
    return {
        resolveHosts: jest.fn(async (_workId: string) => ({
            primary: primaryUrl ? 'helpdesk.ever.works' : null,
            extra: [],
            previous: [],
            primaryUrl,
        })),
    };
}

function stateFake(row: Record<string, unknown> | null = { namespace: NAMESPACE }) {
    return { getOrCreate: jest.fn(async (_workId: string) => row) };
}

/**
 * One service, assembled from fakes. A collaborator **present in `options`** is passed verbatim —
 * including `undefined`, which is how the "unbound collaborator" cases construct the service exactly
 * as the worker's context would when a token has no provider.
 */
function build(
    options: {
        plugin?: Record<string, unknown>;
        facade?: unknown;
        deployments?: ReturnType<typeof deploymentFake>;
        publicSmoke?: ReturnType<typeof publicSmokeFake>;
        hosts?: ReturnType<typeof hostsFake>;
        specs?: unknown;
        events?: unknown;
        states?: unknown;
    } = {},
) {
    const plugin = options.plugin ?? pluginFake();
    const deployments = options.deployments ?? deploymentFake();

    const service = new AppSmokeService(
        ('facade' in options ? options.facade : facadeFake(plugin)) as never,
        deployments as never,
        (options.publicSmoke ?? publicSmokeFake()) as never,
        ('hosts' in options ? options.hosts : hostsFake()) as never,
        ('specs' in options
            ? options.specs
            : { readVerificationSpec: jest.fn(async () => SPEC) }) as never,
        ('events' in options ? options.events : { emit: jest.fn(async () => undefined) }) as never,
        ('states' in options ? options.states : stateFake()) as never,
    );

    return { service, plugin, deployments };
}

/* -------------------------------------------------------------------------- *
 * The pure helper
 * -------------------------------------------------------------------------- */

describe('app-smoke — the in-cluster results (§4.8)', () => {
    it('reports the runner’s own finding, named after the check it belongs to', () => {
        const job: AppJobResult = {
            name: 'smoke',
            when: 'post-deploy',
            runName: 'job-smoke-abc',
            status: 'succeeded',
            startedAt: '2026-09-18T10:00:00.000Z',
            http: { name: '', status: 'passed', httpStatus: 200 },
        };

        expect(checkResultsOf(job, smokeChecksOf(SPEC))).toEqual([
            { name: 'health', status: 'passed', httpStatus: 200 },
        ]);
        expect(smokeChecksOf(SPEC)).toHaveLength(2);
    });

    it('never reports a pass for a job with no HTTP finding', () => {
        const job: AppJobResult = {
            name: 'smoke',
            when: 'post-deploy',
            runName: 'job-smoke-abc',
            status: 'timeout',
            startedAt: '2026-09-18T10:00:00.000Z',
        };

        expect(checkResultsOf(job, smokeChecksOf(SPEC))).toEqual([
            { name: APP_SMOKE_RUNNER_JOB_NAME, status: 'failed', classification: 'unreachable' },
        ]);
        expect(checkResultsOf(null, smokeChecksOf(SPEC))).toEqual([
            { name: APP_SMOKE_RUNNER_JOB_NAME, status: 'failed' },
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * §5.7 — the run
 * -------------------------------------------------------------------------- */

describe('app-smoke — the run (APW-06 T70)', () => {
    it('runs the in-cluster half with the live image, the public half, then writes and emits', async () => {
        const events = { emit: jest.fn(async () => undefined) };
        const publicSmoke = publicSmokeFake();
        const { service, plugin, deployments } = build({ events, publicSmoke });

        const result = await service.run({ workId: WORK_ID, trigger: 'manual', userId: 'user-1' });

        expect(plugin.runAppJob).toHaveBeenCalledWith(REF, KUBECONFIG, {
            name: 'smoke',
            image: IMAGE,
            runner: 'smoke',
            checks: smokeChecksOf(SPEC),
        });
        expect(publicSmoke.run).toHaveBeenCalledWith(
            expect.objectContaining({
                workId: WORK_ID,
                urls: ['https://helpdesk.ever.works'],
                checks: smokeChecksOf(SPEC),
            }),
        );
        expect(deployments.update).toHaveBeenCalledWith(DEPLOYMENT_ID, {
            smokeResult: expect.objectContaining({
                inCluster: [{ name: 'health', status: 'passed', httpStatus: 200, latencyMs: 12 }],
                public: [{ name: 'health', status: 'passed', httpStatus: 200 }],
            }),
        });
        expect(events.emit).toHaveBeenCalledWith({
            name: 'app.smoke.passed',
            payload: {
                workId: WORK_ID,
                userId: 'user-1',
                deploymentId: DEPLOYMENT_ID,
                target: 'your-cluster',
                names: ['health', 'health'],
            },
        });
        expect(result.state).toBe('done');
        expect(result.passed).toBe(true);
        expect(result.smokeResultWritten).toBe('written');
        expect(result.events).toBe('emitted');
    });

    it('loads the Deployment the payload names, and refuses a row of another Work', async () => {
        const deployments = deploymentFake({ ...DEPLOYMENT, workId: OTHER_WORK_ID });
        const { service, plugin } = build({ deployments });

        const result = await service.run({ workId: WORK_ID, deploymentId: DEPLOYMENT_ID });

        expect(deployments.findById).toHaveBeenCalledWith(DEPLOYMENT_ID);
        expect(result.state).toBe('refused');
        expect(result.code).toBe(APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND);
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it('loads the latest production Deployment when the payload names none', async () => {
        const deployments = deploymentFake();
        const { service } = build({ deployments });

        await service.run({ workId: WORK_ID });

        expect(deployments.findLatest).toHaveBeenCalledWith(
            WORK_ID,
            APP_SMOKE_DEPLOYMENT_ENVIRONMENT,
        );
        expect(APP_SMOKE_DEPLOYMENT_ENVIRONMENT).toBe('production');
    });

    it('refuses when there is no current Deployment', async () => {
        const { service } = build({ deployments: deploymentFake(null) });

        const result = await service.run({ workId: WORK_ID });

        expect(result.code).toBe(APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND);
    });

    it('refuses when the Deployment recorded no image — a guessed tag is worse than a refusal', async () => {
        const { service, plugin } = build({
            deployments: deploymentFake({ ...DEPLOYMENT, appRender: {} }),
        });

        const result = await service.run({ workId: WORK_ID });

        expect(result.code).toBe(APP_SMOKE_CODE_IMAGE_UNAVAILABLE);
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it('refuses when the App spec cannot be read — the checks would be invented', async () => {
        const { service, plugin } = build({
            specs: { readVerificationSpec: jest.fn(async () => undefined) },
        });

        const result = await service.run({ workId: WORK_ID });

        expect(result.code).toBe(APP_SMOKE_CODE_SPEC_UNAVAILABLE);
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it('refuses when no public address can be resolved', async () => {
        const { service, plugin } = build({ hosts: hostsFake(null) });

        const result = await service.run({ workId: WORK_ID });

        expect(result.code).toBe(APP_SMOKE_CODE_PUBLIC_URL_UNAVAILABLE);
        expect(plugin.runAppJob).toHaveBeenCalledTimes(1);
    });

    it('refuses a smoke run against an App Work that is being deleted (R-15)', async () => {
        const { service, plugin } = build({
            states: stateFake({ deletionRequestedAt: '2026-09-18T09:00:00.000Z' }),
        });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('refused');
        expect(result.code).toBe('app_work_deleting');
        expect(plugin.runAppJob).not.toHaveBeenCalled();
    });

    it('reports a failed run as a completed run with `app.smoke.failed` — never a throw', async () => {
        const plugin = pluginFake({
            runAppJob: jest.fn(async () => ({
                name: 'smoke',
                when: 'post-deploy',
                runName: 'job-smoke-abc',
                status: 'failed',
                startedAt: '2026-09-18T10:00:00.000Z',
                http: { name: 'health', status: 'failed', httpStatus: 500 },
            })),
        });
        const events = { emit: jest.fn(async () => undefined) };
        const { service } = build({ plugin, events });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('done');
        expect(result.passed).toBe(false);
        expect(result.code).toBe('smoke_failed');
        expect(events.emit).toHaveBeenCalledWith(
            expect.objectContaining({ name: 'app.smoke.failed' }),
        );
    });

    it('reports a refused runner as a red check, not as a lost run', async () => {
        const plugin = pluginFake({
            runAppJob: jest.fn(async () => {
                throw new Error('the runner image is not pullable');
            }),
        });
        const { service } = build({ plugin });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('done');
        expect(result.record?.inCluster).toEqual([
            {
                name: APP_SMOKE_RUNNER_JOB_NAME,
                status: 'failed',
                classification: 'unreachable',
                found: 'the runner image is not pullable',
            },
        ]);
    });

    it('never rolls back — no destroyApp, no scaleApp, no deployApp', async () => {
        const plugin = pluginFake({
            runAppJob: jest.fn(async () => ({
                name: 'smoke',
                when: 'post-deploy',
                runName: 'job-smoke-abc',
                status: 'failed',
                startedAt: '2026-09-18T10:00:00.000Z',
            })),
        });
        const publicSmoke = publicSmokeFake({
            run: jest.fn(async () => ({
                checks: [{ name: 'health', status: 'failed', classification: 'check_failed' }],
                passed: false,
                outcome: 'failed',
                warnings: [],
                failures: [
                    {
                        name: 'health',
                        status: 'failed',
                        classification: 'check_failed',
                        healthRelevant: true,
                    },
                ],
                healthRelevant: true,
                windowSeconds: 180,
                attempts: 2,
                dns: null,
                observedAt: '2026-09-18T10:00:00.000Z',
            })),
        });
        const { service, plugin: p } = build({ plugin, publicSmoke });

        const result = await service.run({ workId: WORK_ID });

        expect(p.destroyApp).not.toHaveBeenCalled();
        expect(p.scaleApp).not.toHaveBeenCalled();
        expect(p.deployApp).not.toHaveBeenCalled();
        expect(result.healthRelevant).toBe(true);
        expect(result.publicOutcome).toBe('failed');
    });

    it('reports an unbound Deployment store rather than claiming the record was written', async () => {
        const row = DEPLOYMENT;
        const { service } = build({
            deployments: {
                findById: jest.fn(async (_id: string) => row),
                findLatest: jest.fn(async (_workId: string, _environment: string) => row),
            } as never,
        });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('done');
        expect(result.smokeResultWritten).toBe('unbound');
    });

    it('reports an unbound event sink rather than pretending the event was emitted', async () => {
        const { service } = build({ events: undefined });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('done');
        expect(result.events).toBe('unbound');
    });

    it('refuses when the resolved plugin has no runAppJob', async () => {
        const plugin = pluginFake({ runAppJob: undefined });
        const { service } = build({ plugin });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('refused');
        expect(result.code).toBe('op_unsupported_on_target');
    });

    it('refuses when no facade is bound — R-5 has nothing to assemble credentials from', async () => {
        const { service } = build({ facade: undefined });

        const result = await service.run({ workId: WORK_ID });

        expect(result.state).toBe('refused');
        expect(result.code).toBe('facade_unavailable');
    });

    it('refuses a payload with no Work', async () => {
        const { service } = build({});

        const result = await service.run({ workId: '' });

        expect(result.state).toBe('refused');
        expect(result.code).toBe(APP_SMOKE_CODE_DEPLOYMENT_NOT_FOUND);
    });

    it('passes the check names — and only names — to the event payload', async () => {
        const events = { emit: jest.fn(async (_event: unknown) => undefined) };
        const { service } = build({ events });

        await service.run({ workId: WORK_ID });

        const emitted = events.emit.mock.calls[0][0] as {
            name: string;
            payload: Record<string, unknown>;
        };
        expect(emitted.name).toBe('app.smoke.passed');
        expect(Object.keys(emitted.payload).sort()).toEqual([
            'deploymentId',
            'names',
            'target',
            'userId',
            'workId',
        ]);
    });
});
