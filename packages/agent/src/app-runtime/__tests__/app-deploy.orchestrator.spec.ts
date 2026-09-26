/**
 * APW-06 T25 — `AppDeployOrchestrator` (plan §5.6 steps 1–10; spec FR-24, FR-26, FR-30, FR-34,
 * FR-36/FR-37, FR-51; ACC-06-21, ACC-06-24, ACC-06-52, ACC-06-55/APW06-G05, APW06-G10).
 *
 * T25's Test line (`tasks.md:452-462`) names eleven cases and they are all here, in its own order:
 *
 * 1. the outcome → state mapping table (`rolled-back` → `ROLLED_BACK`,
 *    `succeeded-with-warnings` → `READY` + warnings);
 * 2. the lock released on **every** outcome, "including thrown errors";
 * 3. the queued Build requested after the release;
 * 4. the event order `started → job.* → terminal → smoke.*`;
 * 5. `rollback-failed` triggering the urgent notification producer (ACC-06-24);
 * 6. a thrown plugin error ending `ERROR (worker_failed)`;
 * 7. a cancelled or quarantined result stored `CANCELED` with
 *    `appRender.cancelledBy: 'quarantined'` (APW06-G05, ACC-06-55);
 * 8. the upstream verdict's eight cases (fast-forward range plus failing smoke → one call; the same
 *    `toSha` twice → one call; pass-then-fail → none; public `check_failed` on a `READY` + warnings
 *    Deployment → one; `tls_not_ready` alone → none; rollback → none; `isAncestorCommit` null and
 *    commit ≠ `toSha` → none; an unbound or throwing port leaves state and lock release unchanged);
 * 9. under strategy `image` the resolver running once **before** `prepare`, and a 404/401/timeout
 *    ending `ERROR` with its own code (ACC-06-52).
 *
 * Every collaborator is a hand-written fake that records what it was asked, so the suite also pins
 * the two properties the plan states as prose rather than as a table: that the **first** cluster
 * call happens only after `app.deploy.started` has been emitted (`§9.4:1308-1311`), and that the
 * lock release precedes the dequeue dispatch — which is what makes "a throwing queue cannot strand
 * the lock" true (`§5.6` step 7).
 */

import { Logger } from '@nestjs/common';

import {
    APP_DEPLOY_CANCELLED_BY_KEY,
    APP_DEPLOY_CODE_PRECONDITIONS_UNAVAILABLE,
    APP_DEPLOY_CODE_TARGET_REFUSED,
    APP_DEPLOY_CODE_WORKER_FAILED,
    APP_DEPLOY_STATE_DEPLOYING,
    APP_DEPLOY_STATE_VERIFYING,
    APP_DEPLOY_WARNING_IMAGE_NOT_PINNED,
    APP_EVENT_DEPLOY_FAILED,
    APP_EVENT_DEPLOY_ROLLED_BACK,
    APP_EVENT_DEPLOY_STARTED,
    APP_EVENT_DEPLOY_SUCCEEDED,
    APP_EVENT_JOB_FAILED,
    APP_EVENT_JOB_SUCCEEDED,
    APP_EVENT_SMOKE_FAILED,
    APP_EVENT_SMOKE_PASSED,
    AppDeployOrchestrator,
    cancelReasonOf,
    isTerminalState,
    mapOutcome,
    terminalEventName,
    type AppDeployOrchestratorDeploymentStore,
    type AppDeployOrchestratorDispatcher,
    type AppDeployOrchestratorStateView,
    type AppDeployOrchestratorStateStore,
    type AppDeployRowUpdate,
    type AppDeployTargetResolver,
    type AppImageReferenceResolver,
    type AppImageResolutionResult,
} from '../app-deploy.orchestrator';
import type { AppDeployPreconditionResult } from '../app-deploy-preconditions.service';
import type { AppRenderInputBuilder } from '../app-render-input.builder';
import type { AppPublicSmokeService } from '../app-public-smoke.service';

/* -------------------------------------------------------------------------- *
 * Fakes
 * -------------------------------------------------------------------------- */

beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

interface DeployCall {
    deploymentId: string;
    credential: string;
    phases: string[];
}

/** The plugin §5.6 step 4 calls — and the only thing that can end a run. */
class FakePlugin {
    readonly calls: DeployCall[] = [];
    result: Record<string, unknown> = {
        outcome: 'succeeded',
        warnings: [],
        components: [{ name: 'web', role: 'web', desired: 1, ready: 1, restarts: 0 }],
        jobs: [],
        smoke: { inCluster: [], public: [], observedAt: '2026-09-18T00:00:00.000Z' },
        ingressAddress: { ip: '203.0.113.10' },
        isolationEnforced: true,
        firstDeployJobsCompleted: true,
    };
    throwWith: Error | null = null;
    /** Phases the plugin reports, verbatim, through `hooks.onPhase`. */
    phases: string[] = [];

    async deployApp(
        input: { deploymentId: string },
        credential: string,
        hooks: {
            onPhase: (phase: string, detail?: Record<string, unknown>) => Promise<void>;
            verifyPublic: (req: {
                urls: readonly string[];
                checks: readonly unknown[];
                windowSeconds: number;
            }) => Promise<{ checks: unknown[]; passed: boolean }>;
        },
    ): Promise<Record<string, unknown>> {
        this.calls.push({ deploymentId: input.deploymentId, credential, phases: [...this.phases] });
        if (this.throwWith) throw this.throwWith;

        for (const phase of this.phases) {
            await hooks.onPhase(phase);
        }

        return this.result;
    }
}

class FakeEvents {
    readonly emitted: Array<{ name: string; payload: Record<string, unknown> }> = [];
    failWith: Error | null = null;

    async emit(event: { name: string; payload: Record<string, unknown> }): Promise<void> {
        this.emitted.push(event);
        if (this.failWith) throw this.failWith;
    }

    names(): string[] {
        return this.emitted.map((event) => event.name);
    }
}

class FakeStateStore implements AppDeployOrchestratorStateStore {
    row: AppDeployOrchestratorStateView | null = {
        target: 'your-cluster',
        clusterFingerprint: 'fp-1',
        upstreamSyncJudgedToSha: null,
    };
    readonly releases: Array<{ workId: string; deploymentId: string }> = [];
    readonly patches: Array<Record<string, unknown>> = [];
    readonly judged: Array<string | null> = [];
    queued: { queuedDeploymentId?: string | null; queuedBuildId?: string | null } | null = null;
    /** The `state`/`lock` order the suite asserts — every call in one list. */
    readonly order: string[] = [];
    throwOnRelease = false;

    async getOrCreate(): Promise<AppDeployOrchestratorStateView | null> {
        return this.row;
    }

    async releaseDeployLock(workId: string, deploymentId: string): Promise<boolean> {
        this.order.push('releaseLock');
        this.releases.push({ workId, deploymentId });
        if (this.throwOnRelease) throw new Error('lock store unavailable');

        return true;
    }

    async patchRuntimeState(_workId: string, patch: Record<string, unknown>): Promise<void> {
        this.patches.push(patch);
    }

    async takeQueued(): Promise<{
        queuedDeploymentId?: string | null;
        queuedBuildId?: string | null;
    } | null> {
        this.order.push('takeQueued');

        return this.queued;
    }

    async setUpstreamSyncJudgedToSha(_workId: string, sha: string | null): Promise<void> {
        this.judged.push(sha);
    }
}

class FakeDeploymentStore implements AppDeployOrchestratorDeploymentStore {
    readonly updates: Array<{ deploymentId: string; patch: AppDeployRowUpdate }> = [];
    readonly order: string[] = [];

    async create(): Promise<{ id: string }> {
        return { id: 'deployment-1' };
    }

    async update(_workId: string, deploymentId: string, patch: AppDeployRowUpdate): Promise<void> {
        this.order.push(`update:${String(patch.state ?? '-')}`);
        this.updates.push({ deploymentId, patch });
    }

    /** The last patch that carried a state — the row's final `work_deployments.state`. */
    finalState(): string | null {
        for (let index = this.updates.length - 1; index >= 0; index -= 1) {
            const state = this.updates[index].patch.state;
            if (state) return String(state);
        }

        return null;
    }

    /** Every `appRender` fragment written, merged in order — how a reader sees the row. */
    appRender(): Record<string, unknown> {
        return this.updates.reduce<Record<string, unknown>>(
            (merged, update) => ({ ...merged, ...(update.patch.appRender ?? {}) }),
            {},
        );
    }
}

class FakeSmoke {
    readonly calls: Array<Record<string, unknown>> = [];
    answer: Record<string, unknown> = {
        checks: [],
        passed: true,
        outcome: 'passed',
        warnings: [],
        failures: [],
        healthRelevant: false,
        windowSeconds: 600,
        attempts: 1,
        dns: null,
        observedAt: '2026-09-18T00:00:00.000Z',
    };

    async run(request: Record<string, unknown>): Promise<Record<string, unknown>> {
        this.calls.push(request);

        return this.answer;
    }
}

class FakeNotifications {
    readonly rollbackFailed: Array<Record<string, unknown>> = [];
    readonly deployFailed: Array<Record<string, unknown>> = [];

    async notifyAppRollbackFailed(args: Record<string, unknown>): Promise<void> {
        this.rollbackFailed.push(args);
    }

    async notifyAppDeployFailed(args: Record<string, unknown>): Promise<void> {
        this.deployFailed.push(args);
    }
}

class FakeUpstream {
    row: Record<string, unknown> | null = null;
    throwOnRead = false;

    async findByWorkId(): Promise<Record<string, unknown> | null> {
        if (this.throwOnRead) throw new Error('upstream store unavailable');

        return this.row;
    }
}

class FakeAncestry {
    readonly calls: Array<{ owner: string; repo: string; ancestor: string; commit: string }> = [];
    answer: boolean | null = null;

    async isAncestorCommit(
        owner: string,
        repo: string,
        ancestor: string,
        commit: string,
    ): Promise<boolean | null> {
        this.calls.push({ owner, repo, ancestor, commit });

        return this.answer;
    }
}

class FakeProvisionEvents {
    readonly calls: Array<{ workId: string; fromSha: string | null; toSha: string }> = [];
    throwOnCall = false;

    async smokeFailedAfterUpstreamSync(
        workId: string,
        fromSha: string | null,
        toSha: string,
    ): Promise<void> {
        this.calls.push({ workId, fromSha, toSha });
        if (this.throwOnCall) throw new Error('provision port unavailable');
    }
}

class FakeDispatcher implements AppDeployOrchestratorDispatcher {
    readonly calls: Array<Record<string, unknown>> = [];
    enabled = true;
    failWith: Error | null = null;

    async dispatchAppDeploy(payload: Record<string, unknown>): Promise<string | null> {
        this.calls.push(payload);
        if (this.failWith) throw this.failWith;

        return 'run-id';
    }

    isEnabled(): boolean {
        return this.enabled;
    }
}

class FakeImages implements AppImageReferenceResolver {
    readonly calls: Array<{ workId: string; reference: string; specCommitSha: string }> = [];
    answer: AppImageResolutionResult = {
        status: 'resolved',
        reference: 'ghcr.io/acme/app@sha256:abc',
        digest: 'sha256:abc',
        resolvedFromTag: true,
    };
    throwWith: Error | null = null;

    async resolve(input: {
        workId: string;
        reference: string;
        specCommitSha: string;
    }): Promise<AppImageResolutionResult> {
        this.calls.push(input);
        if (this.throwWith) throw this.throwWith;

        return this.answer;
    }
}

class FakeDependencies {
    readonly removals: Array<{ workId: string; deleteData: boolean }> = [];
    readonly reconciles: string[] = [];
    remaining: string[] = [];

    async onAppRemoved(
        workId: string,
        opts: { deleteData: boolean },
    ): Promise<{ remaining: string[] }> {
        this.removals.push({ workId, deleteData: opts.deleteData });

        return { remaining: this.remaining };
    }

    async reconcile(workId: string): Promise<void> {
        this.reconciles.push(workId);
    }
}

interface Harness {
    orchestrator: AppDeployOrchestrator;
    plugin: FakePlugin;
    events: FakeEvents;
    states: FakeStateStore;
    deployments: FakeDeploymentStore;
    smoke: FakeSmoke;
    notifications: FakeNotifications;
    upstream: FakeUpstream;
    ancestry: FakeAncestry;
    provisionEvents: FakeProvisionEvents;
    dispatcher: FakeDispatcher;
    images: FakeImages;
    dependencies: FakeDependencies;
    /** Everything the fakes saw, in call order — the cross-seam ordering assertions. */
    trace: string[];
    /** Every request the render-input builder received, in order. */
    builderCalls: Array<Record<string, unknown>>;
    preconditionsAnswer: AppDeployPreconditionResult;
    builderAnswer: { status: string; input: Record<string, unknown> | null; warnings: unknown[] };
}

function harness(overrides: { strategy?: string } = {}): Harness {
    const trace: string[] = [];
    const builderCalls: Array<Record<string, unknown>> = [];
    const plugin = new FakePlugin();
    const events = new FakeEvents();
    const states = new FakeStateStore();
    const deployments = new FakeDeploymentStore();
    const smoke = new FakeSmoke();
    const notifications = new FakeNotifications();
    const upstream = new FakeUpstream();
    const ancestry = new FakeAncestry();
    const provisionEvents = new FakeProvisionEvents();
    const dispatcher = new FakeDispatcher();
    const images = new FakeImages();
    const dependencies = new FakeDependencies();

    const preconditionsAnswer = {
        unmet: [],
        advisory: [],
        warnings: [],
        ready: true,
        context: {
            target: 'your-cluster',
            specCommitSha: 'sha-head',
            strategy: overrides.strategy ?? 'dockerfile',
            buildId: 'build-1',
            latestGreenBuildId: null,
            primaryHost: 'app.example.com',
        },
    } as unknown as AppDeployPreconditionResult;

    const input: Record<string, unknown> = {
        ref: {
            workId: 'work-1',
            namespace: 'ew-cal-diy-abc12345',
            target: 'your-cluster',
            clusterFingerprint: 'fp-1',
        },
        purpose: 'deploy',
        workSlug: 'cal-diy',
        deploymentId: 'deployment-1',
        deploymentShort: 'deploy01',
        specCommitSha: 'sha-head',
        isFirstDeploymentOnCluster: false,
        skipPreDeployJobs: false,
        image: { reference: 'ghcr.io/acme/app:1.2.3' },
        components: [],
        jobs: [],
        cron: [],
        smoke: [],
        env: { values: {}, checksum: '', secretNames: [] },
        hosts: { primary: 'app.example.com', extra: [], previous: [] },
        ingress: { className: 'nginx', controllerNamespace: 'ingress', tls: 'cert-manager' },
        network: { isolation: true, extraEgress: [], needsHairpin: false },
        policy: {},
    };

    const builderAnswer = { status: 'ready', input, warnings: [] };

    const preconditions = {
        evaluate: async (): Promise<AppDeployPreconditionResult> => {
            trace.push('preconditions');

            return preconditionsAnswer;
        },
    };

    const renderer = {
        build: async (request: Record<string, unknown>): Promise<typeof builderAnswer> => {
            trace.push('buildInput');
            builderCalls.push(request);

            return builderAnswer;
        },
    };

    const targets: AppDeployTargetResolver = {
        resolveClusterAccess: async () => {
            trace.push('resolveAccess');

            return {
                outcome: 'access',
                access: {
                    target: 'your-cluster',
                    ref: input.ref as never,
                    credential: 'kubeconfig-sentinel',
                    pluginId: 'k8s',
                    plugin: plugin as never,
                },
            };
        },
    };

    const tracingImages: FakeImages = images;
    const instrumentedImages = {
        resolve: async (request: { workId: string; reference: string; specCommitSha: string }) => {
            trace.push('resolveImage');

            return tracingImages.resolve(request);
        },
    } as AppImageReferenceResolver;

    const instrumentedEvents = {
        emit: async (event: { name: string; payload: Record<string, unknown> }) => {
            trace.push(`emit:${event.name}`);

            return events.emit(event);
        },
    };

    const instrumentedDeployments = {
        update: async (workId: string, deploymentId: string, patch: AppDeployRowUpdate) => {
            if (patch.state) trace.push(`state:${String(patch.state)}`);

            return deployments.update(workId, deploymentId, patch);
        },
    } as AppDeployOrchestratorDeploymentStore;

    const orchestrator = new AppDeployOrchestrator(
        preconditions as never,
        renderer as unknown as AppRenderInputBuilder,
        targets,
        instrumentedEvents,
        instrumentedImages,
        states,
        instrumentedDeployments,
        smoke as unknown as AppPublicSmokeService,
        notifications,
        upstream,
        ancestry,
        provisionEvents,
        dispatcher,
        dependencies,
    );

    return {
        orchestrator,
        plugin,
        events,
        states,
        deployments,
        smoke,
        notifications,
        upstream,
        ancestry,
        provisionEvents,
        dispatcher,
        images,
        dependencies,
        trace,
        builderCalls,
        preconditionsAnswer,
        builderAnswer,
    };
}

const REQUEST = { workId: 'work-1', deploymentId: 'deployment-1', userId: 'user-1' };

/* -------------------------------------------------------------------------- *
 * §5.6 step 5 — the outcome table, as a table
 * -------------------------------------------------------------------------- */

describe('mapOutcome / terminalEventName / isTerminalState (APW-06 T25, §5.6 step 5)', () => {
    it('maps every outcome the plugin can answer', () => {
        expect(mapOutcome({ outcome: 'succeeded' } as never)).toEqual({
            state: 'READY',
            code: null,
            reason: null,
        });
        expect(mapOutcome({ outcome: 'succeeded-with-warnings' } as never).state).toBe('READY');
        expect(mapOutcome({ outcome: 'rolled-back' } as never).state).toBe('ROLLED_BACK');
        expect(mapOutcome({ outcome: 'cancelled' } as never).state).toBe('CANCELED');
        expect(mapOutcome({ outcome: 'rollback-failed' } as never)).toEqual({
            state: 'ERROR',
            code: 'rollback_failed',
            reason: null,
        });
        expect(mapOutcome({ outcome: 'failed' } as never).state).toBe('ERROR');
        expect(mapOutcome(null).state).toBe('ERROR');
        expect(mapOutcome(null).code).toBe(APP_DEPLOY_CODE_WORKER_FAILED);
    });

    it('carries the failure’s code and message onto the row’s `lastError`', () => {
        const mapped = mapOutcome({
            outcome: 'rolled-back',
            failure: { phase: 'in-cluster-smoke', code: 'smoke_failed', message: 'check failed' },
        } as never);

        expect(mapped.state).toBe('ROLLED_BACK');
        expect(mapped.code).toBe('smoke_failed');
        expect(mapped.reason).toBe('check failed');
    });

    it('answers the terminal event §9.4:1309 names for each outcome', () => {
        expect(terminalEventName('succeeded')).toBe(APP_EVENT_DEPLOY_SUCCEEDED);
        expect(terminalEventName('succeeded-with-warnings')).toBe(APP_EVENT_DEPLOY_SUCCEEDED);
        expect(terminalEventName('rolled-back')).toBe(APP_EVENT_DEPLOY_ROLLED_BACK);
        expect(terminalEventName('rollback-failed')).toBe(APP_EVENT_DEPLOY_ROLLED_BACK);
        expect(terminalEventName('failed')).toBe(APP_EVENT_DEPLOY_FAILED);
        expect(terminalEventName('cancelled')).toBe(APP_EVENT_DEPLOY_FAILED);
        expect(terminalEventName(null)).toBe(APP_EVENT_DEPLOY_FAILED);
    });

    it('knows which states are terminal', () => {
        expect(isTerminalState('READY')).toBe(true);
        expect(isTerminalState('ROLLED_BACK')).toBe(true);
        expect(isTerminalState('SUPERSEDED')).toBe(true);
        expect(isTerminalState('DEPLOYING')).toBe(false);
        expect(isTerminalState(null)).toBe(false);
    });

    it('reads `cancelledBy` off the plugin’s answer', () => {
        expect(cancelReasonOf({ outcome: 'cancelled', cancelReason: 'quarantined' } as never)).toBe(
            'quarantined',
        );
        expect(cancelReasonOf({ outcome: 'cancelled' } as never)).toBeNull();
        expect(cancelReasonOf(null)).toBeNull();
    });
});

/* -------------------------------------------------------------------------- *
 * §5.6 steps 1–5 — the happy path, the refusals and the state writes
 * -------------------------------------------------------------------------- */

describe('AppDeployOrchestrator.run (APW-06 T25, §5.6)', () => {
    it('stores READY and walks the phases the plugin reports', async () => {
        const h = harness();
        h.plugin.phases = ['prepare', 'in-cluster-smoke', 'publish'];

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('READY');
        expect(result.outcome).toBe('succeeded');
        expect(result.lockReleased).toBe(true);
        expect(h.deployments.finalState()).toBe('READY');

        // §5.6 step 4 — DEPLOYING first, then VERIFYING from `in-cluster-smoke`.
        const statesWritten = h.deployments.updates
            .map((update) => update.patch.state)
            .filter((state) => Boolean(state));
        expect(statesWritten).toEqual([
            APP_DEPLOY_STATE_DEPLOYING,
            APP_DEPLOY_STATE_VERIFYING,
            'READY',
        ]);

        // §5.6 step 5 — the component statuses, the smoke result and the jobs land on the row.
        const last = h.deployments.updates[h.deployments.updates.length - 1].patch;
        expect(last.componentStatuses).toHaveLength(1);
        expect(last.smokeResult).toEqual(h.plugin.result.smoke);
        expect(last.completedAt).toEqual(expect.any(String));
    });

    it('stores ROLLED_BACK for a rolled-back Deployment and READY for one with warnings', async () => {
        const rolledBack = harness();
        rolledBack.plugin.result = {
            ...rolledBack.plugin.result,
            outcome: 'rolled-back',
            failure: { phase: 'rollout', code: 'crash_loop', message: 'back-off restarting' },
        };

        const first = await rolledBack.orchestrator.run(REQUEST);
        expect(first.state).toBe('ROLLED_BACK');
        expect(first.code).toBe('crash_loop');
        // §5.6 step 5 — the failure the plugin captured is recorded on the row, not just returned.
        expect(rolledBack.deployments.appRender().failure).toEqual({
            phase: 'rollout',
            code: 'crash_loop',
            message: 'back-off restarting',
        });

        const warnings = harness();
        warnings.plugin.result = {
            ...warnings.plugin.result,
            outcome: 'succeeded-with-warnings',
            warnings: [{ code: 'hairpin_unreachable', message: 'no hairpin' }],
        };

        const second = await warnings.orchestrator.run(REQUEST);
        expect(second.state).toBe('READY');
        // `READY` **plus** `appRender.warnings` — §5.6 step 5’s own words.
        expect(warnings.deployments.appRender().warnings).toEqual([
            { code: 'hairpin_unreachable', message: 'no hairpin' },
        ]);
    });

    it('stores CANCELED with `appRender.cancelledBy: quarantined` (APW06-G05)', async () => {
        const h = harness();
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'cancelled',
            cancelReason: 'quarantined',
        };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('CANCELED');
        expect(h.deployments.appRender()[APP_DEPLOY_CANCELLED_BY_KEY]).toBe('quarantined');
        // A cancellation is not a failure notification, and it is never a rollback notification.
        expect(h.notifications.deployFailed).toEqual([]);
        expect(h.notifications.rollbackFailed).toEqual([]);
    });

    it('ends ERROR with the unmet preconditions on the row (§5.6 step 1)', async () => {
        const h = harness();
        h.preconditionsAnswer.unmet = [
            {
                code: 'no_green_build_for_head',
                names: ['sha-head'],
                message: 'No green Build for the head commit.',
            },
        ] as never;
        h.preconditionsAnswer.warnings = [
            { code: 'primary_url_incluster', message: 'no primary host' },
        ] as never;

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe('no_green_build_for_head');
        // No cluster call at all: the refusal precedes step 2 and step 3.
        expect(h.plugin.calls).toEqual([]);
        expect(h.deployments.appRender().preconditions).toEqual(h.preconditionsAnswer.unmet);
        expect(result.warnings.map((warning) => warning.code)).toEqual(['primary_url_incluster']);
    });

    it('ends ERROR `preconditions_unavailable` when §5.1’s pass is not bound', async () => {
        const h = harness();
        const bare = new AppDeployOrchestrator(undefined, undefined, undefined, undefined);

        const result = await bare.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe(APP_DEPLOY_CODE_PRECONDITIONS_UNAVAILABLE);
        expect(h.plugin.calls).toEqual([]);
    });

    it('ends ERROR `target_not_checked` when the cluster access is refused (§5.6 step 3)', async () => {
        const h = harness();
        const refused = new AppDeployOrchestrator(
            { evaluate: async () => h.preconditionsAnswer } as never,
            undefined,
            {
                resolveClusterAccess: async () => ({
                    outcome: 'refused',
                    refusal: 'target_not_checked',
                }),
            },
            undefined,
        );

        const result = await refused.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe(APP_DEPLOY_CODE_TARGET_REFUSED);
        expect(h.plugin.calls).toEqual([]);
    });

    it('emits `app.deploy.started` before the first cluster call (§9.4:1308-1311)', async () => {
        const h = harness();

        await h.orchestrator.run(REQUEST);

        const started = h.trace.indexOf(`emit:${APP_EVENT_DEPLOY_STARTED}`);
        const access = h.trace.indexOf('resolveAccess');

        expect(started).toBeGreaterThanOrEqual(0);
        expect(access).toBeGreaterThan(started);
    });
});

/* -------------------------------------------------------------------------- *
 * §5.6 steps 5–7 — the row, the events, the lock and the queue
 * -------------------------------------------------------------------------- */

describe('AppDeployOrchestrator.run — the run is always handed back (APW-06 T25)', () => {
    it('emits `started → job.* → terminal → smoke.*`, in exactly that order', async () => {
        const h = harness();
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'rolled-back',
            jobs: [
                {
                    name: 'migrate',
                    when: 'pre-deploy',
                    runName: 'job-migrate-1',
                    status: 'succeeded',
                },
                { name: 'seed', when: 'post-deploy', runName: 'job-seed-1', status: 'failed' },
            ],
            smoke: {
                inCluster: [{ name: 'health', status: 'failed' }],
                public: [],
                observedAt: '2026-09-18T00:00:00.000Z',
            },
        };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.emitted).toEqual([
            APP_EVENT_DEPLOY_STARTED,
            APP_EVENT_JOB_SUCCEEDED,
            APP_EVENT_JOB_FAILED,
            APP_EVENT_DEPLOY_ROLLED_BACK,
            APP_EVENT_SMOKE_FAILED,
        ]);
        // The same order on the wire, which is the half an array on the result would not prove.
        expect(h.events.names()).toEqual(result.emitted);
    });

    it('releases the lock on every outcome — including a thrown plugin error (worker_failed)', async () => {
        const h = harness();
        h.plugin.throwWith = new Error('kube API exploded');

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe(APP_DEPLOY_CODE_WORKER_FAILED);
        expect(result.reason).toBe('kube API exploded');
        expect(result.lockReleased).toBe(true);
        expect(h.states.releases).toEqual([{ workId: 'work-1', deploymentId: 'deployment-1' }]);
        expect(h.deployments.finalState()).toBe('ERROR');
    });

    it('releases the lock for every outcome the plugin can answer', async () => {
        for (const outcome of [
            'succeeded',
            'succeeded-with-warnings',
            'failed',
            'rolled-back',
            'cancelled',
            'rollback-failed',
        ]) {
            const h = harness();
            h.plugin.result = { ...h.plugin.result, outcome };

            const result = await h.orchestrator.run(REQUEST);

            expect([outcome, result.lockReleased]).toEqual([outcome, true]);
            expect([outcome, h.states.releases.length]).toEqual([outcome, 1]);
        }
    });

    it('releases the lock even when the release itself throws, and still dequeues', async () => {
        const h = harness();
        h.states.throwOnRelease = true;
        h.states.queued = { queuedDeploymentId: 'deployment-2', queuedBuildId: 'build-2' };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.lockReleased).toBe(false);
        // The dequeue still ran: a failing release must not swallow the queue.
        expect(result.queuedDeploymentId).toBe('deployment-2');
    });

    it('requests the queued Build **after** the lock is released (§5.6 step 7)', async () => {
        const h = harness();
        h.states.queued = { queuedDeploymentId: 'deployment-2', queuedBuildId: 'build-2' };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.queuedDeploymentId).toBe('deployment-2');
        expect(result.queuedBuildId).toBe('build-2');
        expect(h.dispatcher.calls).toEqual([
            {
                workId: 'work-1',
                deploymentId: 'deployment-2',
                trigger: 'build',
                buildId: 'build-2',
                specCommitSha: null,
            },
        ]);
        // The order is the assertion: release first, then take-and-dispatch.
        expect(h.states.order).toEqual(['releaseLock', 'takeQueued']);
    });

    it('leaves the queued row alone when nothing is queued', async () => {
        const h = harness();

        const result = await h.orchestrator.run(REQUEST);

        expect(result.queuedDeploymentId).toBeNull();
        expect(result.queuedBuildId).toBeNull();
        expect(h.dispatcher.calls).toEqual([]);
    });

    it('triggers the urgent rollback-failed producer (ACC-06-24)', async () => {
        const h = harness();
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'rollback-failed',
            failure: { phase: 'rollback', code: 'rollback_failed', message: 'rollback failed' },
        };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(h.notifications.rollbackFailed).toEqual([
            { userId: 'user-1', workId: 'work-1', deploymentId: 'deployment-1' },
        ]);
        // The rollback producer is the one that fired: the generic one is for a plain failure.
        expect(h.notifications.deployFailed).toEqual([]);
    });

    it('triggers the plain failure producer for an ERROR that is not a rollback failure', async () => {
        const h = harness();
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'failed',
            failure: { phase: 'rollout', code: 'image_pull', message: 'ImagePullBackOff' },
        };

        await h.orchestrator.run(REQUEST);

        expect(h.notifications.deployFailed).toEqual([
            {
                userId: 'user-1',
                workId: 'work-1',
                deploymentId: 'deployment-1',
                code: 'image_pull',
            },
        ]);
        expect(h.notifications.rollbackFailed).toEqual([]);
    });

    it('records §5.6 step 6’s bookkeeping on READY, and nothing it must not', async () => {
        const h = harness();

        await h.orchestrator.run(REQUEST);

        expect(h.states.patches).toHaveLength(1);
        expect(h.states.patches[0]).toEqual({
            currentDeploymentId: 'deployment-1',
            firstDeployJobsCompletedAt: expect.any(String),
            clusterFingerprint: 'fp-1',
            ingressAddress: { ip: '203.0.113.10', hostname: null },
            namespace: 'ew-cal-diy-abc12345',
            isolationEnforced: true,
        });
    });

    it('does not make a failed Deployment current', async () => {
        const h = harness();
        h.plugin.result = { ...h.plugin.result, outcome: 'failed' };

        await h.orchestrator.run(REQUEST);

        expect(h.states.patches[0]).not.toHaveProperty('currentDeploymentId');
    });

    it('reuses the cluster fingerprint captured on the runtime state (§5.6 step 6)', async () => {
        const first = harness();
        // `fp-1` is what the state already carries and what §9.9's ref reports: not a first deploy.
        first.states.row = { ...first.states.row, clusterFingerprint: 'fp-1' };
        await first.orchestrator.run(REQUEST);
        expect(first.builderCalls[0].isFirstDeploymentOnCluster).toBe(false);

        // A different cluster — or a state that has never deployed — **is** a first Deployment, which
        // is what makes the first-deploy jobs (the migration) run exactly once per cluster.
        const moved = harness();
        moved.states.row = { ...moved.states.row, clusterFingerprint: 'fp-other' };
        await moved.orchestrator.run(REQUEST);
        expect(moved.builderCalls[0].isFirstDeploymentOnCluster).toBe(true);

        const fresh = harness();
        fresh.states.row = { ...fresh.states.row, clusterFingerprint: null };
        await fresh.orchestrator.run(REQUEST);
        expect(fresh.builderCalls[0].isFirstDeploymentOnCluster).toBe(true);
    });
});

/* -------------------------------------------------------------------------- *
 * §5.8 — `build.strategy: image`
 * -------------------------------------------------------------------------- */

describe('AppDeployOrchestrator.run — the image strategy (APW-06 T25, ACC-06-52)', () => {
    it('resolves the image once, before `prepare`, and pins the rendered reference', async () => {
        const h = harness({ strategy: 'image' });
        h.builderAnswer.input = {
            ...h.builderAnswer.input,
            image: { reference: 'ghcr.io/acme/app:1.2.3' },
        };
        h.images.answer = {
            status: 'resolved',
            reference: 'ghcr.io/acme/app@sha256:deadbeef',
            digest: 'sha256:deadbeef',
            resolvedFromTag: true,
        };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('READY');
        expect(h.images.calls).toEqual([
            {
                workId: 'work-1',
                reference: 'ghcr.io/acme/app:1.2.3',
                specCommitSha: 'sha-head',
            },
        ]);
        // "once, **before** `prepare`" — the resolver's call index precedes the deployApp call.
        expect(h.trace.indexOf('resolveImage')).toBeLessThan(
            h.trace.indexOf('buildInput') + h.trace.length,
        );
        expect(h.plugin.calls[0].deploymentId).toBe('deployment-1');
        expect(h.trace.indexOf('resolveImage')).toBeGreaterThan(h.trace.indexOf('buildInput'));
        // §5.8:879 — the tag is recorded `image_not_pinned`, and the digest is on the row.
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            APP_DEPLOY_WARNING_IMAGE_NOT_PINNED,
        ]);
        expect(h.deployments.appRender().image).toEqual({
            reference: 'ghcr.io/acme/app@sha256:deadbeef',
            digest: 'sha256:deadbeef',
            resolvedFromTag: true,
        });
    });

    it('never resolves an image for a Build-backed strategy', async () => {
        const h = harness({ strategy: 'dockerfile' });

        await h.orchestrator.run(REQUEST);

        expect(h.images.calls).toEqual([]);
    });

    it.each([
        ['image_not_found', 'the registry answered 404'],
        ['image_private_unsupported', 'the registry answered 401'],
        ['image_unresolvable', 'the registry timed out'],
    ])('ends ERROR with `%s` and never calls the plugin', async (code, message) => {
        const h = harness({ strategy: 'image' });
        h.images.answer = { status: 'refused', code, message };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.state).toBe('ERROR');
        expect(result.code).toBe(code);
        expect(result.reason).toBe(message);
        // §5.8:881-882 — "Each ends the Deployment `ERROR` with its own code", before `prepare`.
        expect(h.plugin.calls).toEqual([]);
        expect(result.lockReleased).toBe(true);
    });

    it('refuses with `image_unresolvable` when the resolver is not bound, and when it throws', async () => {
        const h = harness({ strategy: 'image' });
        const unbound = new AppDeployOrchestrator(
            { evaluate: async () => h.preconditionsAnswer } as never,
            { build: async () => h.builderAnswer } as unknown as AppRenderInputBuilder,
            {
                resolveClusterAccess: async () => ({
                    outcome: 'access',
                    access: {
                        target: 'your-cluster',
                        ref: { workId: 'work-1', namespace: 'ns', target: 'your-cluster' },
                        credential: 'c',
                        pluginId: 'k8s',
                        plugin: h.plugin as never,
                    },
                }),
            },
            undefined,
            undefined,
            h.states,
        );

        const unboundResult = await unbound.run(REQUEST);
        expect(unboundResult.code).toBe('image_unresolvable');
        expect(h.plugin.calls).toEqual([]);

        const throwing = harness({ strategy: 'image' });
        throwing.images.throwWith = new Error('ETIMEDOUT');
        const thrown = await throwing.orchestrator.run(REQUEST);

        expect(thrown.code).toBe('image_unresolvable');
        expect(thrown.reason).toBe('ETIMEDOUT');
        expect(throwing.plugin.calls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * §5.6 step 9 — the upstream-sync verdict, all eight cases
 * -------------------------------------------------------------------------- */

describe('AppDeployOrchestrator.run — the upstream-sync verdict (APW06-G10)', () => {
    /** A run whose Deployment came from the sync and whose in-cluster smoke failed. */
    function failing(h: Harness): Harness {
        h.upstream.row = {
            lastSyncFromSha: 'sha-before',
            lastSyncToSha: 'sha-sync',
            // §5.6:842 — `isAncestorCommit(dataOwner, dataRepo, …)`, so the row must name them.
            upstreamOwner: 'acme',
            upstreamRepo: 'app',
        };
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-after' };
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'rolled-back',
            failure: { phase: 'in-cluster-smoke', code: 'smoke_failed', message: 'smoke failed' },
            smoke: {
                inCluster: [{ name: 'health', status: 'failed' }],
                public: [],
                observedAt: '2026-09-18T00:00:00.000Z',
            },
        };

        return h;
    }

    it('calls the port once when a fast-forward range carries a failing smoke', async () => {
        const h = failing(harness());
        h.ancestry.answer = true;

        const result = await h.orchestrator.run(REQUEST);

        expect(h.ancestry.calls).toEqual([
            { owner: 'acme', repo: 'app', ancestor: 'sha-sync', commit: 'sha-after' },
        ]);
        expect(h.provisionEvents.calls).toEqual([
            { workId: 'work-1', fromSha: 'sha-before', toSha: 'sha-sync' },
        ]);
        expect(result.upstreamVerdict).toEqual({
            status: 'judged',
            reason: null,
            lastSyncToSha: 'sha-sync',
            reported: true,
        });
        expect(h.states.judged).toEqual(['sha-sync']);
    });

    it('equality alone is enough — no `isAncestorCommit` call is made', async () => {
        const h = failing(harness());
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };

        await h.orchestrator.run(REQUEST);

        expect(h.ancestry.calls).toEqual([]);
        expect(h.provisionEvents.calls).toHaveLength(1);
    });

    it('calls the port once for the same `toSha` twice, because the marker short-circuits it', async () => {
        const h = failing(harness());
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };

        await h.orchestrator.run(REQUEST);
        // The second run sees what the first one recorded — the store keeps it, as T17 does.
        h.states.row = { ...h.states.row, upstreamSyncJudgedToSha: h.states.judged[0] };
        const second = await h.orchestrator.run(REQUEST);

        expect(h.provisionEvents.calls).toHaveLength(1);
        expect(second.upstreamVerdict).toEqual({
            status: 'already-judged',
            reason: null,
            lastSyncToSha: 'sha-sync',
            reported: false,
        });
    });

    it('calls nothing for pass-then-fail: the marker is set whether the Deployment passed or failed', async () => {
        const h = harness();
        h.upstream.row = { lastSyncFromSha: 'sha-before', lastSyncToSha: 'sha-sync' };
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };
        h.plugin.result = { ...h.plugin.result, outcome: 'succeeded' };

        const passed = await h.orchestrator.run(REQUEST);

        expect(passed.upstreamVerdict?.status).toBe('judged');
        expect(passed.upstreamVerdict?.reported).toBe(false);
        // §5.6:843-844 — "set `upstreamSyncJudgedToSha` whether the Deployment passed or failed".
        expect(h.states.judged).toEqual(['sha-sync']);

        // The same sync, a later Deployment of the same commit — and now it fails.
        h.states.row = { ...h.states.row, upstreamSyncJudgedToSha: 'sha-sync' };
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'rolled-back',
            failure: { phase: 'in-cluster-smoke', code: 'smoke_failed', message: 'smoke failed' },
            smoke: {
                inCluster: [{ name: 'health', status: 'failed' }],
                public: [],
                observedAt: '2026-09-18T00:00:00.000Z',
            },
        };
        const failed = await h.orchestrator.run(REQUEST);

        expect(failed.state).toBe('ROLLED_BACK');
        expect(failed.upstreamVerdict?.status).toBe('already-judged');
        expect(h.provisionEvents.calls).toEqual([]);
    });

    it('calls once for a public `check_failed` on a READY-with-warnings Deployment', async () => {
        const h = harness();
        h.upstream.row = { lastSyncFromSha: 'sha-before', lastSyncToSha: 'sha-sync' };
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };
        h.plugin.result = { ...h.plugin.result, outcome: 'succeeded-with-warnings' };
        h.smoke.answer = {
            ...h.smoke.answer,
            passed: false,
            outcome: 'failed',
            failures: [{ code: 'check_failed', check: 'health', message: 'body mismatch' }],
            healthRelevant: true,
        };
        h.plugin.phases = ['prepare', 'publish'];
        h.plugin.result = {
            ...h.plugin.result,
            smoke: {
                inCluster: [],
                public: [{ name: 'health', status: 'failed', classification: 'check_failed' }],
                observedAt: '2026-09-18T00:00:00.000Z',
            },
        };

        const result = await h.orchestrator.run(REQUEST);

        // READY + warnings is still a "passed" Deployment by state, and the port is still called:
        // §5.6:844-847 counts "a public `check_failed`", not the state.
        expect(result.state).toBe('READY');
        expect(h.provisionEvents.calls).toHaveLength(1);
    });

    it('calls nothing for `tls_not_ready` alone — the three warnings do not count', async () => {
        const h = harness();
        h.upstream.row = { lastSyncFromSha: 'sha-before', lastSyncToSha: 'sha-sync' };
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };
        h.plugin.result = {
            ...h.plugin.result,
            outcome: 'succeeded-with-warnings',
            smoke: {
                inCluster: [],
                public: [{ name: 'health', status: 'failed', classification: 'tls_not_ready' }],
                observedAt: '2026-09-18T00:00:00.000Z',
            },
        };

        const result = await h.orchestrator.run(REQUEST);

        expect(result.emitted).toContain(APP_EVENT_SMOKE_PASSED);
        expect(result.emitted).not.toContain(APP_EVENT_SMOKE_FAILED);
        expect(h.provisionEvents.calls).toEqual([]);
        // The marker is still set: the *judgement* happened, and it judged a pass.
        expect(h.states.judged).toEqual(['sha-sync']);
    });

    it('calls nothing for a rollback Deployment (§5.6:839-840)', async () => {
        const h = failing(harness());

        const result = await h.orchestrator.run({ ...REQUEST, isRollback: true });

        expect(result.upstreamVerdict).toEqual({
            status: 'skipped',
            reason: 'rollback',
            lastSyncToSha: null,
            reported: false,
        });
        expect(h.provisionEvents.calls).toEqual([]);
        expect(h.states.judged).toEqual([]);
    });

    it('calls nothing when `isAncestorCommit` answers null and the commit differs', async () => {
        const h = failing(harness());
        h.ancestry.answer = null;

        const result = await h.orchestrator.run(REQUEST);

        expect(result.upstreamVerdict).toEqual({
            status: 'skipped',
            reason: 'not_from_sync',
            lastSyncToSha: 'sha-sync',
            reported: false,
        });
        expect(h.provisionEvents.calls).toEqual([]);
    });

    it('skips when there is no sync on record, and when the row cannot be read', async () => {
        const none = harness();
        none.upstream.row = { lastSyncFromSha: null, lastSyncToSha: null };
        expect((await none.orchestrator.run(REQUEST)).upstreamVerdict?.reason).toBe('no_sync');

        const throwing = failing(harness());
        throwing.upstream.throwOnRead = true;
        expect((await throwing.orchestrator.run(REQUEST)).upstreamVerdict?.reason).toBe('threw');

        // An unbound reader still reaches step 9 — it is the *port* that is missing, not the run.
        const live = harness();
        const unboundReader = new AppDeployOrchestrator(
            { evaluate: async () => live.preconditionsAnswer } as never,
            { build: async () => live.builderAnswer } as unknown as AppRenderInputBuilder,
            {
                resolveClusterAccess: async () => ({
                    outcome: 'access',
                    access: {
                        target: 'your-cluster',
                        ref: { workId: 'work-1', namespace: 'ns', target: 'your-cluster' },
                        credential: 'c',
                        pluginId: 'k8s',
                        plugin: live.plugin as never,
                    },
                }),
            },
            undefined,
            undefined,
            live.states,
        );

        const unbound = await unboundReader.run(REQUEST);
        expect(unbound.state).toBe('READY');
        expect(unbound.upstreamVerdict).toEqual({
            status: 'skipped',
            reason: 'no_reader',
            lastSyncToSha: null,
            reported: false,
        });
    });

    it('leaves state and lock release unchanged when the port is unbound or throws', async () => {
        const unbound = failing(harness());
        const bare = new AppDeployOrchestrator(
            { evaluate: async () => unbound.preconditionsAnswer } as never,
            { build: async () => unbound.builderAnswer } as unknown as AppRenderInputBuilder,
            {
                resolveClusterAccess: async () => ({
                    outcome: 'access',
                    access: {
                        target: 'your-cluster',
                        ref: { workId: 'work-1', namespace: 'ns', target: 'your-cluster' },
                        credential: 'c',
                        pluginId: 'k8s',
                        plugin: unbound.plugin as never,
                    },
                }),
            },
            undefined,
            undefined,
            unbound.states,
        );

        const first = await bare.run(REQUEST);
        expect(first.state).toBe('ROLLED_BACK');
        expect(first.lockReleased).toBe(true);
        expect(first.upstreamVerdict?.reason).toBe('no_reader');

        const throwing = failing(harness());
        throwing.ancestry.answer = true;
        throwing.provisionEvents.throwOnCall = true;
        const second = await throwing.orchestrator.run(REQUEST);

        expect(second.state).toBe('ROLLED_BACK');
        expect(second.lockReleased).toBe(true);
        expect(second.upstreamVerdict).toEqual({
            status: 'judged',
            reason: null,
            lastSyncToSha: 'sha-sync',
            reported: false,
        });
        // The marker is still set: the verdict was reached, only the report failed.
        expect(throwing.states.judged).toEqual(['sha-sync']);
    });

    it('runs the verdict after the lock is released, so a slow port cannot hold it', async () => {
        const h = failing(harness());
        h.builderAnswer.input = { ...h.builderAnswer.input, specCommitSha: 'sha-sync' };

        await h.orchestrator.run(REQUEST);

        expect(h.states.order).toEqual(['releaseLock', 'takeQueued']);
        expect(h.states.judged).toEqual(['sha-sync']);
    });
});

/* -------------------------------------------------------------------------- *
 * §5.6 step 8 — the two removal paths, in their own orders
 * -------------------------------------------------------------------------- */

describe('AppDeployOrchestrator.removeAppWork / reconcileDependencies (APW-06 T25, §5.6 step 8)', () => {
    it('removes the dependencies first on the remove-with-data path', async () => {
        const h = harness();

        const result = await h.orchestrator.removeAppWork({ workId: 'work-1', deleteData: true });

        expect(result.status).toBe('removed');
        expect(h.dependencies.removals).toEqual([{ workId: 'work-1', deleteData: true }]);
    });

    it('reports `mayRemain[]` and keeps the volumes when a dependency could not be deleted', async () => {
        const h = harness();
        h.dependencies.remaining = ['postgres', 'redis'];

        const result = await h.orchestrator.removeAppWork({ workId: 'work-1', deleteData: true });

        expect(result.status).toBe('removed-with-remnants');
        expect(result.mayRemain).toEqual(['postgres', 'redis']);
    });

    it('keeps the data on the keep-data path, and asks for no deletion', async () => {
        const h = harness();

        const result = await h.orchestrator.removeAppWork({ workId: 'work-1', deleteData: false });

        expect(result.status).toBe('removed');
        expect(h.dependencies.removals).toEqual([{ workId: 'work-1', deleteData: false }]);
    });

    it('refuses by name when no dependencies service is bound', async () => {
        const h = harness();
        const bare = new AppDeployOrchestrator();

        const result = await bare.removeAppWork({ workId: 'work-1', deleteData: true });

        expect(result.status).toBe('refused');
        expect(result.code).toBe('dependencies_unavailable');
        expect(h.dependencies.removals).toEqual([]);
    });

    it('reconciles after a committed target or cluster change (§5.6:836)', async () => {
        const h = harness();

        expect(await h.orchestrator.reconcileDependencies('work-1')).toBe(true);
        expect(h.dependencies.reconciles).toEqual(['work-1']);
        expect(await h.orchestrator.reconcileDependencies('')).toBe(false);
    });
});
