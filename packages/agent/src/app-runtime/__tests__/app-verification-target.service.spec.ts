/**
 * APW-06 T60 — verification targets (`purpose: 'verification'`), the agent half (plan §4.12).
 *
 * Every assertion here is one line of the contract:
 *
 * - §4.12:640-646 — the namespace is `<ns>-v<first 6 hex of provisioningId>-<attempt>`, EPIC-owned
 *   and returned to APW-04 as a handle, and a re-provision cannot collide with an earlier attempt's
 *   leftover;
 * - §9.2:1283 — `checkAppCluster` runs **first**, with its 10 s budget;
 * - APW06-G08 — the namespace and its policies, **then** `provisionEphemeral`, **then** the
 *   workloads. The order is asserted as a *sequence* over one shared journal, not as three call
 *   counts that happen to match;
 * - APW06-G09 — the sink carries the result, once per phase, and every report carries components,
 *   jobs and smoke **only**;
 * - ACC-06-48 — zero `work_deployments` inserts, zero runtime-state writes, and the **stored** env
 *   path (`AppRuntimeEnvSource.resolve`) is never called: only `resolveEphemeral`;
 * - §4.12:653-656 — exactly one `provisionEphemeral` call, with the verification namespace and the
 *   declared kind set, and no APW-07 method that would write a `work_app_dependencies` row.
 *
 * The fakes are the only world the service sees: it is constructed with exactly the five
 * collaborators it declares, and the arity pin below fails if a sixth — a `WorkDeployment` writer, a
 * runtime-state store — is ever added.
 */

import { readFileSync } from 'node:fs';
import * as path from 'node:path';

import type {
    AppClusterCheck,
    AppDeployHooks,
    AppDeployResult,
    AppDestroyResult,
    AppRenderInput,
    AppStatusSnapshot,
    AppStatusSpec,
    AppTargetRef,
} from '@ever-works/plugin';

import {
    APP_VERIFICATION_CLUSTER_CHECK_TIMEOUT_MS,
    APP_VERIFICATION_DESTROY_OP,
    APP_VERIFICATION_DEPLOY_OP,
    APP_VERIFICATION_STATUS_OP,
    APP_VERIFICATION_TTL_MAX_MINUTES,
    AppVerificationTargetService,
    AppVerificationUnavailableError,
    statusSpecForSpec,
    verificationExpiresAt,
    verificationNamespaceName,
    verificationStateForOutcome,
    verificationStateForSnapshot,
    type AppRuntimeVerificationFacade,
    type AppVerificationAccess,
    type AppVerificationDestroyOp,
    type AppVerificationDeployOp,
    type AppVerificationSpec,
    type AppVerificationSpecSource,
    type AppVerificationStatusOp,
    type AppEphemeralDependencyProvisioner,
} from '../app-verification-target.service';
import {
    APP_RUNTIME_ENV_SOURCE,
    APP_VERIFICATION_SINK,
    AppPortUnavailableError,
    type AppRuntimeEnvSource,
    type AppVerificationSink,
    type AppVerificationUpdate,
} from '../ports';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const PROVISIONING_ID = '4f3a2b90-1111-4222-8333-444444444444';
const OTHER_PROVISIONING_ID = 'ffffffff-9999-4888-8777-666666666666';
const LIVE_NAMESPACE = 'ew-helpdesk-0f8e2c1a';
const KUBECONFIG = 'apiVersion: v1\nkind: Config\ncurrent-context: c\n';
const NOW = Date.parse('2026-09-18T10:00:00.000Z');

const REF: AppTargetRef = { workId: WORK_ID, namespace: LIVE_NAMESPACE, target: 'your-cluster' };

/** A minimal §3.1 input — only what §4.12's flow reads. */
function renderInput(namespace: string): Omit<AppRenderInput, 'env'> {
    return {
        ref: { ...REF, namespace },
        purpose: 'verification',
        ttlMinutes: 90,
        workSlug: 'helpdesk',
        deploymentId: 'provisioning-attempt-1',
        deploymentShort: 'a1b2c3d4',
        specCommitSha: 'c0ffee1',
        isFirstDeploymentOnCluster: true,
        skipPreDeployJobs: false,
        image: { reference: `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}` },
        components: [
            {
                name: 'web',
                role: 'web',
                port: 8080,
                replicas: 1,
                writableRootFilesystem: false,
                probes: {},
                resources: { requests: { cpu: '250m', memory: '512Mi' } },
                volumes: [],
                primary: true,
                deadlineSeconds: 750,
                internalUrl: `http://web.${namespace}.svc.cluster.local`,
            },
        ],
        jobs: [
            {
                name: 'migrate',
                when: 'pre-deploy',
                component: 'web',
                command: ['node', 'dist/migrate.js'],
            },
        ],
        cron: [],
        smoke: [{ name: 'health', component: 'web', http: { path: '/api/health' } }],
        hosts: { primary: null, extra: [], previous: [] },
        ingress: { className: null, controllerNamespace: null, tls: 'none', issuer: null },
        network: { isolation: true, extraEgress: [], needsHairpin: false },
        policy: {
            podSecurity: 'baseline',
            allowRoot: false,
            runtimeClassName: null,
            quota: null,
            limitRange: {
                defaultRequest: { cpu: '100m', memory: '128Mi' },
                defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
                max: { cpu: '8', memory: '64Gi' },
            },
            cronMinIntervalMinutes: 15,
            scaleFailedFirstDeployToZero: false,
            requireIsolationEnforced: false,
        },
    } as unknown as Omit<AppRenderInput, 'env'>;
}

const COMPONENTS = [{ name: 'web', role: 'web' as const, desired: 1, ready: 1, restarts: 0 }];
const JOBS = [
    {
        name: 'migrate',
        when: 'pre-deploy' as const,
        runName: 'job-migrate-a1b2c3d4',
        status: 'succeeded' as const,
        startedAt: '2026-09-18T10:00:10.000Z',
        completedAt: '2026-09-18T10:00:20.000Z',
    },
];
const SMOKE = {
    inCluster: [{ name: 'health', status: 'passed' as const }],
    public: [],
    observedAt: '2026-09-18T10:01:00.000Z',
};

/* -------------------------------------------------------------------------- *
 * Fakes — every call lands in one shared journal, so "the order" is one value
 * -------------------------------------------------------------------------- */

interface Harness {
    service: AppVerificationTargetService;
    order: string[];
    reports: AppVerificationUpdate[];
    envCalls: Array<{ method: string; ctx: unknown }>;
    dependencyCalls: Array<{ workId: string; namespace: string; kinds: readonly string[] }>;
    destroyCalls: Array<{ namespace: string; deleteVolumes: boolean }>;
    /** How many times the spec (APW-06 T22) was read. */
    specCalls: number;
    clusterChecks: Array<{ namespace: string; needsCreateNamespace: boolean }>;
    prepareCalls: Array<{ namespace: string; target: string; isolation: boolean | undefined }>;
    /** Anything at all that would have written a row. Empty for every verification op. */
    rowWrites: string[];
}

/**
 * The service with a pinned clock. `nowMs()` is `protected` for exactly this — the seam
 * `AppRuntimeDeletionService.nowMs` documents — so an expiry is a value rather than a race.
 */
class PinnedService extends AppVerificationTargetService {
    protected nowMs(): number {
        return NOW;
    }
}

class FakeSink implements AppVerificationSink {
    readonly reports: AppVerificationUpdate[] = [];

    constructor(private readonly order: string[]) {}

    async report(update: AppVerificationUpdate): Promise<void> {
        this.reports.push(update);
        this.order.push(`sink:report:${update.state}:${update.phase}`);
    }
}

/** APW-07 through its **ephemeral** method only; any other method is a row write and is recorded. */
class FakeDependencies implements AppEphemeralDependencyProvisioner {
    readonly calls: Harness['dependencyCalls'] = [];

    constructor(
        private readonly order: string[],
        private readonly rowWrites: string[],
    ) {}

    async provisionEphemeral(
        workId: string,
        namespace: string,
        kinds: readonly string[],
    ): Promise<unknown> {
        this.calls.push({ workId, namespace, kinds: [...kinds] });
        this.order.push(`dependencies:provisionEphemeral:${namespace}:${[...kinds].join(',')}`);
        return { ephemeral: true };
    }

    /** A `work_app_dependencies` write would look like this — nothing calls it. */
    async provision(workId: string): Promise<unknown> {
        this.rowWrites.push(`work_app_dependencies:${workId}`);
        return {};
    }

    async reconcile(workId: string): Promise<unknown> {
        this.rowWrites.push(`work_app_dependencies:reconcile:${workId}`);
        return {};
    }
}

/** APW-07's env source: both paths are recorded, so "the stored path was never used" is provable. */
class FakeEnv implements AppRuntimeEnvSource {
    readonly calls: Harness['envCalls'] = [];

    constructor(
        private readonly order: string[],
        private readonly answer: {
            values?: Record<string, string>;
            secretNames?: string[];
            unsetRequired?: string[];
        } = { values: { DATABASE_URL: 'postgres://verify' }, secretNames: ['DATABASE_URL'] },
    ) {}

    async resolve(workId: string, specCommitSha: string, ctx: unknown): Promise<never> {
        this.calls.push({ method: 'resolve', ctx });
        this.order.push('env:resolve');
        throw new Error(
            `the stored env path must never be used for a verification (${workId}@${specCommitSha})`,
        );
    }

    async resolveEphemeral(
        workId: string,
        specCommitSha: string,
        ctx: unknown,
    ): Promise<{
        values?: Record<string, string>;
        secretNames: string[];
        unsetRequired: string[];
    }> {
        this.calls.push({ method: 'resolveEphemeral', ctx });
        void workId;
        void specCommitSha;
        this.order.push(`env:resolveEphemeral:${(ctx as { target?: string })?.target}`);
        return {
            values: this.answer.values,
            secretNames: this.answer.secretNames ?? [],
            unsetRequired: this.answer.unsetRequired ?? [],
        };
    }
}

/** The service under test, with every seam bound to a fake that journals its calls. */
function harness(
    options: {
        target?: 'your-cluster' | 'ever-works-apps';
        withFacade?: boolean;
        withSpecs?: boolean;
        withEnv?: boolean;
        withDependencies?: boolean;
        withSink?: boolean;
        facadeUnavailable?: string;
        specCommitSha?: string | null;
        kinds?: string[];
        clusterCheck?: Partial<AppClusterCheck> | 'throws' | 'hangs';
        deployOutcome?: AppDeployResult['outcome'];
        deployThrows?: Error | null;
        prepareThrows?: Error | null;
        dependencyKindsUnbound?: boolean;
        unsetRequired?: string[];
        namespaceExpiry?: string | null;
        destroyResult?: Partial<AppDestroyResult>;
        destroyThrows?: Error | null;
        statusSnapshot?: AppStatusSnapshot;
        phases?: string[];
    } = {},
): Harness {
    const order: string[] = [];
    const rowWrites: string[] = [];
    const reports: AppVerificationUpdate[] = [];
    const envCalls: Harness['envCalls'] = [];
    const destroyCalls: Harness['destroyCalls'] = [];
    const clusterChecks: Harness['clusterChecks'] = [];
    const kinds = options.kinds ?? ['postgres', 'redis'];
    let specCalls = 0;

    const sink = new FakeSink(order);
    const dependencies = new FakeDependencies(order, rowWrites);
    const prepareCalls: Harness['prepareCalls'] = [];
    const env = new FakeEnv(order, {
        values: { DATABASE_URL: 'postgres://verify' },
        secretNames: ['DATABASE_URL'],
        unsetRequired: options.unsetRequired ?? [],
    });

    const access: AppVerificationAccess = {
        target: options.target ?? 'your-cluster',
        ref: { ...REF },
        credential: KUBECONFIG,
        async checkAppCluster(_credential: string, req): Promise<AppClusterCheck> {
            clusterChecks.push({
                namespace: req.namespace,
                needsCreateNamespace: req.needsCreateNamespace,
            });
            order.push(`checkAppCluster:${req.namespace}:${req.needsCreateNamespace}`);
            if (options.clusterCheck === 'throws') {
                throw new Error('connect ECONNREFUSED 127.0.0.1:6443');
            }
            if (options.clusterCheck === 'hangs') {
                return new Promise<AppClusterCheck>(() => undefined);
            }
            return {
                ok: true,
                fingerprint: 'fingerprint-1',
                serverVersion: 'v1.31.0',
                missingPermissions: [],
                optionalMissing: [],
                ingressClasses: [],
                controllerNamespace: null,
                clusterIssuers: [],
                storageClasses: [],
                ...(options.clusterCheck ?? {}),
            };
        },
        async prepareAppNamespace(ref, _credential, opts) {
            prepareCalls.push({
                namespace: String(ref?.namespace ?? ''),
                target: String(ref?.target ?? ''),
                isolation: opts?.isolation,
            });
            order.push(
                `prepare:namespace+policies:${String(ref?.namespace ?? '')}:isolation=${opts?.isolation}`,
            );
            if (options.prepareThrows) {
                throw options.prepareThrows;
            }
            return { warnings: [] };
        },
        async deployApp(
            input: AppRenderInput,
            _credential: string,
            hooks: AppDeployHooks,
        ): Promise<AppDeployResult> {
            order.push(`deployApp:${input?.ref?.namespace}`);
            if (options.deployThrows) {
                throw options.deployThrows;
            }
            for (const phase of options.phases ?? [
                'prepare',
                'rollout',
                'in-cluster-smoke',
                'done',
            ]) {
                await hooks.onPhase(phase as never);
            }
            return {
                outcome: options.deployOutcome ?? 'succeeded',
                warnings: [],
                components: COMPONENTS,
                jobs: JOBS,
                smoke: SMOKE,
                ingressAddress: null,
                isolationEnforced: true,
                firstDeployJobsCompleted: true,
            } as unknown as AppDeployResult;
        },
        async getAppStatus(_ref, _credential, _spec: AppStatusSpec): Promise<AppStatusSnapshot> {
            order.push('getAppStatus');
            return (
                options.statusSnapshot ?? {
                    observedAt: '2026-09-18T10:01:00.000Z',
                    components: COMPONENTS,
                    jobs: JOBS.map((job) => ({ name: job.name, last: job })),
                    cron: [],
                    smoke: SMOKE,
                    isolationEnforced: true,
                }
            );
        },
        async destroyApp(
            _ref,
            _credential,
            opts: { deleteVolumes: boolean },
        ): Promise<AppDestroyResult> {
            destroyCalls.push({
                namespace: String(_ref?.namespace ?? ''),
                deleteVolumes: opts.deleteVolumes,
            });
            order.push(`destroyApp:${_ref?.namespace}:deleteVolumes=${opts.deleteVolumes}`);
            if (options.destroyThrows) {
                throw options.destroyThrows;
            }
            return {
                deleted: [{ kind: 'Namespace', name: String(_ref?.namespace ?? '') }],
                kept: [],
                namespaceDeleted: true,
                ...(options.destroyResult ?? {}),
            };
        },
        async readNamespaceExpiry(namespaceName: string): Promise<string | null> {
            order.push(`readNamespaceExpiry:${namespaceName}`);
            return options.namespaceExpiry ?? '2026-09-18T11:30:00.000Z';
        },
    };

    const facade: AppRuntimeVerificationFacade = {
        async resolveVerificationTarget(workId: string) {
            order.push('facade:resolveVerificationTarget');
            if (options.facadeUnavailable) {
                return { unavailable: options.facadeUnavailable as never };
            }
            void workId;
            return access;
        },
    };

    const specs: AppVerificationSpecSource = {
        async readVerificationSpec(req): Promise<AppVerificationSpec | undefined> {
            specCalls += 1;
            order.push(`spec:readVerificationSpec:${req.namespace}`);
            return { input: renderInput(req.namespace), dependencyKinds: kinds };
        },
    };

    const service = new PinnedService(
        options.withFacade === false ? undefined : facade,
        options.withSpecs === false ? undefined : specs,
        options.withEnv === false ? undefined : env,
        options.withDependencies === false ? undefined : dependencies,
        options.withSink === false ? undefined : sink,
    );

    return {
        service,
        order,
        reports: sink.reports,
        envCalls: env.calls,
        dependencyCalls: dependencies.calls,
        destroyCalls,
        get specCalls() {
            return specCalls;
        },
        clusterChecks,
        prepareCalls,
        rowWrites,
    };
}

function deployOp(overrides: Partial<AppVerificationDeployOp> = {}): AppVerificationDeployOp {
    return {
        op: APP_VERIFICATION_DEPLOY_OP,
        workId: WORK_ID,
        provisioningId: PROVISIONING_ID,
        attempt: 1,
        buildId: 'build-1',
        imageDigest: `sha256:${'a'.repeat(64)}`,
        specCommitSha: 'c0ffee1',
        ttlMinutes: 90,
        ...overrides,
    };
}

/* -------------------------------------------------------------------------- *
 * §4.12:640-646 — the name the epic owns
 * -------------------------------------------------------------------------- */

describe('verificationNamespaceName (plan §4.12:640-646)', () => {
    it('is `<ns>-v<first 6 hex of provisioningId>-<attempt>`', () => {
        expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1)).toBe(
            `${LIVE_NAMESPACE}-v4f3a2b-1`,
        );
    });

    it('gives a re-provision with a different provisioningId a different name for attempt 1', () => {
        // ACC-06-48: attempt 1 of a re-provision must not collide with a leftover — or a still
        // `Terminating` — namespace from an earlier run.
        const first = verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1);
        const second = verificationNamespaceName(LIVE_NAMESPACE, OTHER_PROVISIONING_ID, 1);

        expect(second).not.toBe(first);
        expect(second.startsWith(`${LIVE_NAMESPACE}-v`)).toBe(true);
    });

    it('distinguishes attempts, clamps them into 1…9, and stays inside 63/52 characters', () => {
        const attemptOne = verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 1);
        expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 2)).not.toBe(attemptOne);
        expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 12)).toBe(
            verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 9),
        );
        expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 0)).toBe(attemptOne);
        expect(
            verificationNamespaceName('n'.repeat(63), PROVISIONING_ID, 9).length,
        ).toBeLessThanOrEqual(63);
        // §4.12:644: "the whole name stays within 52 characters" for a §4.1 namespace.
        expect(
            verificationNamespaceName('ew-' + 's'.repeat(30) + '-0f8e2c1a', PROVISIONING_ID, 9)
                .length,
        ).toBeLessThanOrEqual(52);
    });

    it('is deterministic — the name returned is the name taken back as a handle', () => {
        expect(verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 3)).toBe(
            verificationNamespaceName(LIVE_NAMESPACE, PROVISIONING_ID, 3),
        );
    });
});

/* -------------------------------------------------------------------------- *
 * §4.12:661-666, ACC-06-48 — the happy path
 * -------------------------------------------------------------------------- */

describe('verification-deploy (plan §4.12, §9.2:1276-1285)', () => {
    it('derives the epic-owned namespace, reports it, and returns it as the handle', async () => {
        const h = harness();
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.namespace).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
        expect(result.state).toBe('green');
        // §4.12:646 — the expiry is `now + ttlMinutes`, on the namespace's own annotation.
        expect(result.expiresAt).toBe(verificationExpiresAt(90, NOW));
        expect(result.components).toEqual(COMPONENTS);
        expect(result.jobs).toEqual(JOBS);
        expect(result.smoke).toEqual(SMOKE);
    });

    it('runs checkAppCluster FIRST, for the verification namespace and its creation (§9.2:1283)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        expect(h.clusterChecks).toEqual([
            { namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`, needsCreateNamespace: true },
        ]);
        expect(h.order.indexOf('checkAppCluster:ew-helpdesk-0f8e2c1a-v4f3a2b-1:true')).toBe(1);
        expect(h.order[0]).toBe('facade:resolveVerificationTarget');
    });

    it('prepares the VERIFICATION namespace, never the live one — every call of the attempt is aimed at the handle', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        // The trap this asserts against: `access.ref` names the **live** namespace, and passing it
        // straight to `prepareAppNamespace` would draw the namespace and policies of the running app
        // instead of the attempt's own.
        expect(h.prepareCalls).toEqual([
            { namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`, target: 'your-cluster', isolation: true },
        ]);
        expect(h.prepareCalls.some((call) => call.namespace === LIVE_NAMESPACE)).toBe(false);
        expect(h.clusterChecks[0].namespace).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
        expect(h.dependencyCalls[0].namespace).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
        expect(h.order).toContain(`deployApp:${LIVE_NAMESPACE}-v4f3a2b-1`);
    });

    it('applies the namespace and its policies, THEN provisions dependencies, THEN the workloads (APW06-G08)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        const namespace = `${LIVE_NAMESPACE}-v4f3a2b-1`;
        const prepared = h.order.findIndex((entry) =>
            entry.startsWith(`prepare:namespace+policies:${namespace}:`),
        );
        const provisioned = h.order.indexOf(
            `dependencies:provisionEphemeral:${namespace}:postgres,redis`,
        );
        const deployed = h.order.indexOf(`deployApp:${namespace}`);

        // The order itself, not three counts that happen to match.
        expect(prepared).toBeGreaterThan(-1);
        expect(provisioned).toBeGreaterThan(prepared);
        expect(deployed).toBeGreaterThan(provisioned);

        // …and the cluster check precedes all three.
        expect(h.order.indexOf(`checkAppCluster:${namespace}:true`)).toBeLessThan(prepared);
    });

    it('provisions the declared kind set exactly once, with the verification namespace (§4.12:653-656)', async () => {
        const h = harness({ kinds: ['postgres', 'redis'] });
        await h.service.handleVerificationDeploy(deployOp());

        expect(h.dependencyCalls).toEqual([
            {
                workId: WORK_ID,
                namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`,
                kinds: ['postgres', 'redis'],
            },
        ]);
        // ACC-06-48: nothing wrote a `work_app_dependencies` row — `provisionEphemeral` is the
        // in-memory variant and no other APW-07 method was reached.
        expect(h.rowWrites).toEqual([]);
    });

    it('resolves env ephemerally, and never through the stored path (R-10, ACC-06-48)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        expect(h.envCalls.map((call) => call.method)).toEqual(['resolveEphemeral']);
        expect(h.envCalls[0].ctx).toEqual({
            target: 'cluster',
            primaryUrl: null,
            primaryHost: null,
            buildCommitSha: 'c0ffee1',
            internalUrls: {
                web: `http://web.${LIVE_NAMESPACE}-v4f3a2b-1.svc.cluster.local`,
            },
        });
        expect(h.order).not.toContain('env:resolve');
    });

    it('passes `buildCommitSha: null` under `build.strategy: image` (§5.8)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp({ buildId: null }));

        expect((h.envCalls[0].ctx as { buildCommitSha: string | null }).buildCommitSha).toBeNull();
    });

    it('reports once per phase through the sink, and the last report carries the outcome (APW06-G09)', async () => {
        const h = harness();
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(h.reports.map((update) => `${update.state}:${update.phase}`)).toEqual([
            'running:prepare',
            'running:prepare',
            'running:rollout',
            'running:in-cluster-smoke',
            'running:done',
            'green:done',
        ]);
        expect(result.state).toBe('green');
    });

    it('carries components, jobs and smoke ONLY — no cron, no ingress address (§4.12:660)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        for (const update of h.reports) {
            expect(Object.keys(update).sort()).toEqual([
                'attempt',
                'components',
                'expiresAt',
                'jobs',
                'namespace',
                'phase',
                'provisioningId',
                'smoke',
                'state',
            ]);
            expect(update.namespace).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
            expect(update.provisioningId).toBe(PROVISIONING_ID);
            expect(update.attempt).toBe(1);
            expect(update.expiresAt).toBe(verificationExpiresAt(90, NOW));
            expect(update.smoke?.public ?? []).toEqual([]);
        }

        const last = h.reports[h.reports.length - 1];
        expect(last.components).toEqual(COMPONENTS);
        expect(last.jobs).toEqual(JOBS);
        expect(last.smoke).toEqual(SMOKE);
    });

    it('writes no row of its own: the sink is the only output (ACC-06-48)', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());

        expect(h.rowWrites).toEqual([]);
        // The only journal entries are the five collaborators' own reads and calls.
        expect(
            h.order.every((entry) =>
                /^(facade:|checkAppCluster:|spec:|env:resolveEphemeral|sink:report:|prepare:|dependencies:provisionEphemeral:|deployApp:|getAppStatus|readNamespaceExpiry:)/.test(
                    entry,
                ),
            ),
        ).toBe(true);
    });
});

/* -------------------------------------------------------------------------- *
 * Fail-closed answers
 * -------------------------------------------------------------------------- */

describe('fail-closed (plan §4.12:664-666, §9.8)', () => {
    it('refuses with verification_sink_unavailable before anything is resolved', async () => {
        const h = harness({ withSink: false });

        await expect(h.service.handleVerificationDeploy(deployOp())).rejects.toBeInstanceOf(
            AppPortUnavailableError,
        );
        // Nothing was even asked: no facade, no cluster check, no namespace.
        expect(h.order).toEqual([]);
    });

    it('refuses with facade_unavailable when no cluster access can be assembled', async () => {
        const h = harness({ withFacade: false });

        const error = await h.service
            .handleVerificationDeploy(deployOp())
            .catch((thrown: Error) => thrown);
        expect(error).toBeInstanceOf(AppVerificationUnavailableError);
        expect((error as AppVerificationUnavailableError).code).toBe('facade_unavailable');
        expect(h.order).toEqual([]);
    });

    it('refuses a target that is not your-cluster before any namespace is derived (§4.12:638)', async () => {
        const h = harness({ target: 'ever-works-apps' });

        const error = await h.service
            .handleVerificationDeploy(deployOp())
            .catch((thrown: Error) => thrown);
        expect((error as AppVerificationUnavailableError).code).toBe('target_not_your_cluster');
        expect(h.reports).toEqual([]);
    });

    it('reports unavailable when the cluster check fails, and never touches the cluster (§9.2:1283)', async () => {
        const h = harness({
            clusterCheck: { ok: false, error: { code: 'forbidden', message: 'no' } },
        });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('unavailable');
        expect(h.order).toContain('checkAppCluster:ew-helpdesk-0f8e2c1a-v4f3a2b-1:true');
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
        expect(h.order.some((entry) => entry.startsWith('deployApp:'))).toBe(false);
        expect(h.reports[0].failure?.code).toBe('forbidden');
    });

    it('reports unavailable when the cluster check throws', async () => {
        const h = harness({ clusterCheck: 'throws' });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('unavailable');
        expect(result.components).toEqual([]);
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    });

    it('bounds the cluster check with §9.2’s 10 s budget', async () => {
        jest.useFakeTimers();
        try {
            const h = harness({ clusterCheck: 'hangs' });
            const pending = h.service.handleVerificationDeploy(deployOp());
            await jest.advanceTimersByTimeAsync(APP_VERIFICATION_CLUSTER_CHECK_TIMEOUT_MS + 1);

            const result = await pending;
            expect(result.state).toBe('unavailable');
            expect(result.components).toEqual([]);
        } finally {
            jest.useRealTimers();
        }
    });

    it('reports blocked — not red — when required env values are unset, and creates nothing', async () => {
        const h = harness({ unsetRequired: ['DATABASE_URL'] });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('blocked');
        expect(h.reports[0].failure?.code).toBe('env_required_unset');
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    });

    it('refuses before any write when a declared dependency has no provider', async () => {
        const h = harness({ withDependencies: false, kinds: ['postgres'] });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('unavailable');
        expect(h.reports[0].failure?.code).toBe('dependencies_unavailable');
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    });

    it('reports unavailable without writing when no spec can be read', async () => {
        const h = harness({ withSpecs: false });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('unavailable');
        expect(h.reports[0].failure?.code).toBe('spec_unavailable');
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    });

    it('reports unavailable without writing when no env source is bound', async () => {
        const h = harness({ withEnv: false });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('unavailable');
        expect(h.reports[0].failure?.code).toBe('env_source_unavailable');
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
    });

    it('reports infra — not red — when the cluster throws during the workloads', async () => {
        const h = harness({ deployThrows: new Error('connect ECONNREFUSED 127.0.0.1:6443') });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('infra');
        expect(h.reports[h.reports.length - 1].state).toBe('infra');
        expect(result.components).toEqual([]);
    });

    it('reports red when the candidate Build fails its own rollout', async () => {
        const h = harness({
            deployOutcome: 'rolled-back',
            phases: ['prepare', 'rollout', 'rollback', 'done'],
        });
        const result = await h.service.handleVerificationDeploy(deployOp());

        expect(result.state).toBe('red');
        expect(verificationStateForOutcome('rolled-back')).toBe('red');
        expect(verificationStateForOutcome('succeeded-with-warnings')).toBe('green');
        expect(verificationStateForOutcome('cancelled')).toBe('blocked');
    });

    it('bounds a nonsense ttl into §4.12’s 1…240 on the way in', async () => {
        expect(verificationExpiresAt(10_080, NOW)).toBe(
            verificationExpiresAt(APP_VERIFICATION_TTL_MAX_MINUTES, NOW),
        );
        expect(verificationExpiresAt(0, NOW)).toBe(verificationExpiresAt(1, NOW));

        const h = harness();
        const result = await h.service.handleVerificationDeploy(deployOp({ ttlMinutes: 100_000 }));
        expect(result.expiresAt).toBe(
            new Date(NOW + APP_VERIFICATION_TTL_MAX_MINUTES * 60_000).toISOString(),
        );
    });
});

/* -------------------------------------------------------------------------- *
 * §9.2 — verification-status and verification-destroy
 * -------------------------------------------------------------------------- */

describe('verification-status (plan §4.12:660)', () => {
    it('observes the handle it was given and answers components, jobs and smoke only', async () => {
        const h = harness();
        const op: AppVerificationStatusOp = {
            op: APP_VERIFICATION_STATUS_OP,
            workId: WORK_ID,
            provisioningId: PROVISIONING_ID,
            attempt: 1,
            namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`,
        };

        const result = await h.service.handleVerificationStatus(op);

        expect(result.namespace).toBe(`${LIVE_NAMESPACE}-v4f3a2b-1`);
        expect(result.state).toBe('green');
        expect(result.components).toEqual(COMPONENTS);
        expect(result.jobs).toEqual(JOBS);
        expect(result.smoke).toEqual(SMOKE);
        // The status spec asks for no CronJob: §4.12 renders none.
        expect(
            statusSpecForSpec({ input: renderInput(op.namespace), dependencyKinds: [] }).cron,
        ).toEqual([]);
        // The expiry is read off the namespace's own annotation, never recomputed.
        expect(result.expiresAt).toBe('2026-09-18T11:30:00.000Z');
    });

    it('reports through the sink, and never renders or deploys anything', async () => {
        const h = harness();
        await h.service.handleVerificationStatus({
            op: APP_VERIFICATION_STATUS_OP,
            workId: WORK_ID,
            provisioningId: PROVISIONING_ID,
            attempt: 1,
            namespace: 'ew-helpdesk-0f8e2c1a-v4f3a2b-1',
        });

        expect(h.reports).toHaveLength(1);
        expect(h.order.some((entry) => entry.startsWith('prepare:'))).toBe(false);
        expect(h.order.some((entry) => entry.startsWith('deployApp:'))).toBe(false);
        expect(h.rowWrites).toEqual([]);
    });

    it('refuses without the handle, and reports nothing for it', async () => {
        const h = harness();
        const error = await h.service
            .handleVerificationStatus({
                op: APP_VERIFICATION_STATUS_OP,
                workId: WORK_ID,
                provisioningId: PROVISIONING_ID,
                attempt: 1,
                namespace: '',
            })
            .catch((thrown: Error) => thrown);

        expect((error as AppVerificationUnavailableError).code).toBe('namespace_missing');
        expect(h.reports).toEqual([]);
    });

    it('maps an observation to a state without ever guessing red', () => {
        expect(verificationStateForSnapshot(null)).toBe('unavailable');
        expect(
            verificationStateForSnapshot({ components: [] } as unknown as AppStatusSnapshot),
        ).toBe('unavailable');
        expect(
            verificationStateForSnapshot({
                components: [{ name: 'web', role: 'web', desired: 1, ready: 1, restarts: 0 }],
            } as unknown as AppStatusSnapshot),
        ).toBe('green');
        expect(
            verificationStateForSnapshot({
                components: [{ name: 'web', role: 'web', desired: 1, ready: 0, restarts: 0 }],
            } as unknown as AppStatusSnapshot),
        ).toBe('running');
        expect(
            verificationStateForSnapshot({
                components: [{ name: 'web', role: 'web', desired: 0, ready: 0, restarts: 0 }],
            } as unknown as AppStatusSnapshot),
        ).toBe('unavailable');
    });
});

describe('verification-destroy (plan §4.12:659-660)', () => {
    it('deletes the whole namespace, whatever deleteVolumes says, and reports destroyed', async () => {
        const h = harness();
        const op: AppVerificationDestroyOp = {
            op: APP_VERIFICATION_DESTROY_OP,
            workId: WORK_ID,
            provisioningId: PROVISIONING_ID,
            attempt: 1,
            namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`,
            reason: 'attempt-ended',
        };

        const result = await h.service.handleVerificationDestroy(op);

        expect(h.destroyCalls).toEqual([
            { namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`, deleteVolumes: false },
        ]);
        expect(result).toEqual({
            state: 'destroyed',
            namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`,
            namespaceDeleted: true,
        });
        expect(h.reports).toHaveLength(1);
        expect(h.reports[0].state).toBe('destroyed');
        expect(h.reports[0].phase).toBe('destroy');
        expect(h.reports[0].components).toEqual([]);
        expect(h.reports[0].jobs).toEqual([]);
        expect(h.reports[0].smoke).toBeNull();
    });

    it('is idempotent: a namespace that is already gone is still destroyed', async () => {
        const h = harness({ destroyResult: { deleted: [], kept: [], namespaceDeleted: false } });
        const result = await h.service.handleVerificationDestroy({
            op: APP_VERIFICATION_DESTROY_OP,
            workId: WORK_ID,
            provisioningId: null,
            attempt: null,
            namespace: 'ew-helpdesk-0f8e2c1a-v4f3a2b-1',
            reason: 'expired',
        });

        expect(result.state).toBe('destroyed');
        expect(result.namespaceDeleted).toBe(false);
        expect(h.reports).toHaveLength(1);
    });

    it('surfaces a cluster that will not delete the namespace, and reports nothing as destroyed', async () => {
        const h = harness({ destroyThrows: new Error('namespace still exists after 300 s') });

        const error = await h.service
            .handleVerificationDestroy({
                op: APP_VERIFICATION_DESTROY_OP,
                workId: WORK_ID,
                provisioningId: PROVISIONING_ID,
                attempt: 1,
                namespace: 'ew-helpdesk-0f8e2c1a-v4f3a2b-1',
                reason: 'cancelled',
            })
            .catch((thrown: Error) => thrown);

        expect((error as AppVerificationUnavailableError).code).toBe('cluster_unavailable');
        expect(h.reports).toEqual([]);
    });

    it('refuses without the handle, before any cluster call', async () => {
        const h = harness();
        const error = await h.service
            .handleVerificationDestroy({
                op: APP_VERIFICATION_DESTROY_OP,
                workId: WORK_ID,
                provisioningId: PROVISIONING_ID,
                attempt: 1,
                namespace: '',
                reason: 'expired',
            })
            .catch((thrown: Error) => thrown);

        expect((error as AppVerificationUnavailableError).code).toBe('namespace_missing');
        expect(h.destroyCalls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * ACC-06-48 — the rows a verification must never write
 * -------------------------------------------------------------------------- */

describe('no work_deployments insert and no runtime-state write (ACC-06-48)', () => {
    const serviceFile = path.resolve(__dirname, '..', 'app-verification-target.service.ts');
    const source = readFileSync(serviceFile, 'utf8');
    /**
     * The same file with its comments removed, so the scan reads **code**: this service's own doc
     * explains at length which rows it must not write, and naming them there is the point of the doc.
     * The `(?<!:)` keeps `//` inside a URL (`http://…`) from being mistaken for a comment.
     */
    const code = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/(?<!:)\/\/.*$/gm, '');

    it('never names a WorkDeployment writer or a runtime-state store', () => {
        for (const forbidden of [
            'WorkDeployment',
            'work_deployments',
            'WorkAppRuntimeState',
            'WORK_APP_RUNTIME_STATES',
            'claimDeletion',
            'recordDeletionAttempt',
        ]) {
            expect(code).not.toContain(forbidden);
        }

        // A known-good control: the scan reads real content, so the zeros above are not a broken read.
        expect(code).toContain('AppVerificationSink');
        expect(code).toContain('APP_VERIFICATION_SINK');
        expect(source).toContain('work_deployments');
    });

    it('declares exactly five collaborators, and none of them is a store', () => {
        // An arity pin in the house style (`job-runtime.providers.spec.ts`): the facade, the spec
        // source, the env source, APW-07's ephemeral provisioner and the sink. A sixth — a
        // `WorkDeployment` repository, a runtime-state store — turns this red.
        expect(AppVerificationTargetService.length).toBe(5);
        expect(code).toContain('APP_DEPENDENCIES_SERVICE');
        expect(code).toContain('APP_RUNTIME_ENV_SOURCE');
        expect(code).toContain('APP_VERIFICATION_SINK');
    });

    it('reuses the three port tokens instead of declaring parallel ones (R-26)', () => {
        // A second `Symbol('APP_VERIFICATION_SINK')` would be a *different* token and the binding
        // APW-04 lands would then reach only one of the two consumers.
        expect(APP_VERIFICATION_SINK).toBeDefined();
        expect(APP_RUNTIME_ENV_SOURCE).toBeDefined();

        const declared = code.match(/export const \w+ = Symbol\('([^']+)'\)/g) ?? [];
        expect(declared).toEqual([
            "export const APP_RUNTIME_VERIFICATION_FACADE = Symbol('APP_RUNTIME_VERIFICATION_FACADE')",
            "export const APP_VERIFICATION_SPEC_SOURCE = Symbol('APP_VERIFICATION_SPEC_SOURCE')",
        ]);
    });

    it('every op answers through the sink and nothing else', async () => {
        const h = harness();
        await h.service.handleVerificationDeploy(deployOp());
        await h.service.handleVerificationStatus({
            op: APP_VERIFICATION_STATUS_OP,
            workId: WORK_ID,
            provisioningId: PROVISIONING_ID,
            attempt: 1,
            namespace: 'ew-helpdesk-0f8e2c1a-v4f3a2b-1',
        });
        await h.service.handleVerificationDestroy({
            op: APP_VERIFICATION_DESTROY_OP,
            workId: WORK_ID,
            provisioningId: PROVISIONING_ID,
            attempt: 1,
            namespace: 'ew-helpdesk-0f8e2c1a-v4f3a2b-1',
            reason: 'attempt-ended',
        });

        expect(h.rowWrites).toEqual([]);
        expect(h.reports.length).toBeGreaterThan(1);
    });
});
