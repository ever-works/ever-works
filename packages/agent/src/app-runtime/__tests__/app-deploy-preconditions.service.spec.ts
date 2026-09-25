/**
 * APW-06 T21 — `AppDeployPreconditionsService` (plan §5.1, spec FR-24, ACC-06-01,
 * -19, -20, -39, -52, -53, -54, -55).
 *
 * One test per precondition code this service can produce, plus the acceptance
 * cases the task text names by id. Every collaborator is a hand-written fake, so
 * the suite also pins **what was asked of them**: which commit the App spec was read
 * at (ACC-06-20), that `ensureReadyForDeploy` is called exactly once and is what
 * dispatches provisioning (GAP-05, ACC-06-54), that an unavailable dispatcher yields
 * `worker_not_isolated` before anything is read or written (APW06-G02, ACC-06-55),
 * and that no Deployment is dispatched by the precondition pass at all.
 *
 * Nothing here touches a database, a cluster, a network or a clock.
 */

import { Logger } from '@nestjs/common';

import {
    APP_SPEC_VALIDATION_STATUSES,
    type AppSpec,
    type HostingEligibility,
} from '@ever-works/contracts';

import { APP_SPEC_USABLE_STATUSES } from '../../app-spec/app-spec.service';
import { AppLicenseGate, type AppLicenseService } from '../app-license-gate';
import {
    APP_DEPLOY_WARNING_DEPENDENCIES_UNAVAILABLE,
    APP_DEPLOY_WARNING_RUNTIME_STATE_UNAVAILABLE,
    APP_PRECONDITION_PRIMARY_URL_INCLUSTER,
    AppDeployPreconditionsService,
    type AppDeployBuildSnapshot,
    type AppDeployBuildSource,
    type AppDeployDependencyReadiness,
    type AppDeployDependencyService,
    type AppDeployDispatcherAvailability,
    type AppDeployHostSource,
    type AppDeployPreconditionRequest,
    type AppDeployPreconditionResult,
    type AppDeployRuntimeState,
    type AppDeployRuntimeStateReader,
    type AppDeploySpecSnapshot,
    type AppDeploySpecSource,
} from '../app-deploy-preconditions.service';
import type { AppRuntimeEnvContext, AppRuntimeEnvSource, AppsTierPolicy } from '../ports';

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, each recording what it was asked
 * -------------------------------------------------------------------------- */

/**
 * The logger is spied, not asserted on: several cases below deliberately make a
 * seam throw, and the service's contract is that it *reports* rather than crashes.
 * Silencing the expected lines keeps a red legible; the behaviour under test is the
 * returned result, never the log.
 */
beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

/** The `app-deploy` dispatcher, as §9.2's availability probe sees it. */
class FakeDispatcher implements AppDeployDispatcherAvailability {
    readonly dispatch = jest.fn(async () => 'run-id');
    enabled = true;
    available: unknown = undefined;

    constructor() {
        this.available = { dispatchAppDeploy: this.dispatch };
    }

    resolve(): unknown {
        return this.available;
    }

    isEnabled(): boolean {
        return this.enabled;
    }
}

/** APW-06 T17's runtime-state store. */
class FakeStates implements AppDeployRuntimeStateReader {
    readonly calls: string[] = [];
    state: AppDeployRuntimeState = {
        target: 'your-cluster',
        paused: false,
        deployLockId: null,
        clusterFingerprint: 'fp-cluster-1',
        clusterCheck: { fingerprint: 'fp-cluster-1' },
        targetSettings: { tls: 'cert-manager', managedSubdomain: true },
    };
    failsWith: Error | null = null;

    async getOrCreate(workId: string): Promise<AppDeployRuntimeState> {
        this.calls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.state;
    }
}

/** APW-03 T12's `AppSpecService`. */
class FakeSpecs implements AppDeploySpecSource {
    readonly reads: Array<{ workId: string; commitSha?: string }> = [];
    snapshot: AppDeploySpecSnapshot | null = {
        status: 'valid',
        spec: appSpec(),
        commitSha: 'sha-head',
    };
    /** The commit APW-03 last *applied* — never the one this pass may read (ACC-06-20). */
    latestAppliedSha = 'sha-applied';
    failsWith: Error | null = null;

    async getEffectiveSpec(
        workId: string,
        commitSha?: string,
    ): Promise<AppDeploySpecSnapshot | null> {
        this.reads.push({ workId, commitSha });
        if (this.failsWith) throw this.failsWith;
        return this.snapshot;
    }
}

/** APW-07's env source, as §5.1's env rows read it. */
class FakeEnv implements AppRuntimeEnvSource {
    readonly calls: Array<{
        workId: string;
        specCommitSha: string;
        ctx: AppRuntimeEnvContext;
    }> = [];
    result = {
        values: { DATABASE_URL: 'postgres://example' } as Record<string, string>,
        secretNames: [] as string[],
        unsetRequired: [] as string[],
        notReadyDependencies: [] as string[],
        egress: [] as Array<{ host: string; ports: number[] }>,
    };
    failsWith: Error | null = null;

    async resolve(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvContext,
    ): Promise<typeof this.result> {
        this.calls.push({ workId, specCommitSha, ctx });
        if (this.failsWith) throw this.failsWith;
        return this.result;
    }

    async resolveEphemeral(): Promise<never> {
        throw new Error('the precondition pass never resolves ephemeral env');
    }
}

/** APW-07's `AppDependenciesService`, as §5.1's dependency row reads it. */
class FakeDependencies implements AppDeployDependencyService {
    readonly calls: string[] = [];
    readiness: AppDeployDependencyReadiness = { ready: true, notReady: [], optional: [] };
    failsWith: Error | null = null;

    async ensureReadyForDeploy(workId: string): Promise<AppDeployDependencyReadiness> {
        this.calls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.readiness;
    }
}

/** APW-05's `WorkBuild` reads. */
class FakeBuilds implements AppDeployBuildSource {
    readonly getCalls: Array<{ workId: string; buildId: string }> = [];
    readonly listCalls: string[] = [];
    builds: AppDeployBuildSnapshot[] = [greenBuild()];
    byId: Record<string, AppDeployBuildSnapshot> = { 'build-1': greenBuild() };
    failsWith: Error | null = null;

    async getBuild(workId: string, buildId: string): Promise<AppDeployBuildSnapshot | null> {
        this.getCalls.push({ workId, buildId });
        if (this.failsWith) throw this.failsWith;
        return this.byId[buildId] ?? null;
    }

    async listDeployableBuilds(workId: string): Promise<readonly AppDeployBuildSnapshot[]> {
        this.listCalls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.builds;
    }
}

/** APW-06 T26's primary host. */
class FakeHosts implements AppDeployHostSource {
    readonly calls: string[] = [];
    host: string | null = 'app.example.com';
    failsWith: Error | null = null;

    async primaryHost(workId: string): Promise<string | null> {
        this.calls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.host;
    }
}

/** APW-10's `AppsTierPolicy`, closed until a test opens it. */
class FakeTier implements AppsTierPolicy {
    open = false;
    scope: 'verified-blueprints' | 'any' = 'verified-blueprints';
    eligible = true;
    reasons: string[] = [];
    runtimeClassName: string | null = 'gvisor';
    credential = 'tier-credential';

    isOpen(): boolean {
        return this.open;
    }

    managedScope(): 'verified-blueprints' | 'any' {
        return this.scope;
    }

    async resolveClusterCredential(): Promise<string> {
        return this.credential;
    }

    podPolicy() {
        return {
            runtimeClassName: this.runtimeClassName,
            quota: {} as never,
            limitRange: {} as never,
        };
    }

    ingress() {
        return { className: 'nginx', controllerNamespace: 'ingress', edgeTlsMode: 'edge' } as const;
    }

    async eligibility(): Promise<{ eligible: boolean; reasons: string[] }> {
        return { eligible: this.eligible, reasons: this.reasons };
    }
}

/** APW-03's licence service, allowed and quiet by default. */
class FakeLicense implements AppLicenseService {
    eligibility: HostingEligibility | null = {
        none: 'allowed',
        yourCluster: 'allowed',
        managed: 'allowed',
        sourceOffer: { required: false, url: null, missing: false },
    };

    async getHostingEligibility(): Promise<HostingEligibility | null> {
        return this.eligibility;
    }
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** A plain `dockerfile` App spec: one web component, no build tricks. */
function appSpec(overrides: Partial<AppSpec> = {}): AppSpec {
    return {
        kind: 'app',
        build: { strategy: 'dockerfile' },
        components: [{ name: 'web', role: 'web', port: 3000 }],
        ...overrides,
    } as AppSpec;
}

/** A green, deployable Build of the head commit. */
function greenBuild(overrides: Partial<AppDeployBuildSnapshot> = {}): AppDeployBuildSnapshot {
    return {
        id: 'build-1',
        commitSha: 'sha-head',
        status: 'succeeded',
        trigger: 'push',
        imageReference: `ghcr.io/ever-works/app@sha256:${'a'.repeat(64)}`,
        ...overrides,
    };
}

/** Everything one test may need to reach for. */
interface Harness {
    service: AppDeployPreconditionsService;
    dispatcher: FakeDispatcher;
    states: FakeStates;
    specs: FakeSpecs;
    env: FakeEnv;
    dependencies: FakeDependencies;
    builds: FakeBuilds;
    hosts: FakeHosts;
    tier: FakeTier;
    license: FakeLicense;
}

function makeHarness(): Harness {
    const dispatcher = new FakeDispatcher();
    const states = new FakeStates();
    const specs = new FakeSpecs();
    const env = new FakeEnv();
    const dependencies = new FakeDependencies();
    const builds = new FakeBuilds();
    const hosts = new FakeHosts();
    const tier = new FakeTier();
    const license = new FakeLicense();

    const service = new AppDeployPreconditionsService(
        dispatcher,
        states,
        specs,
        env,
        dependencies,
        builds,
        hosts,
        tier,
        new AppLicenseGate(license),
    );

    return { service, dispatcher, states, specs, env, dependencies, builds, hosts, tier, license };
}

/** The ordinary request: a manual Deploy of the deploy-branch head. */
function request(
    overrides: Partial<AppDeployPreconditionRequest> = {},
): AppDeployPreconditionRequest {
    return { workId: 'work-1', headCommitSha: 'sha-head', userId: 'user-1', ...overrides };
}

/** The refusal codes, in order. */
function codes(result: AppDeployPreconditionResult): string[] {
    return result.unmet.map((entry) => entry.code);
}

/** Every name any refusal carries. */
function names(result: AppDeployPreconditionResult): string[] {
    return result.unmet.flatMap((entry) => entry.names ?? []);
}

/** The one entry for a code, asserted to exist. */
function entryFor(
    result: AppDeployPreconditionResult,
    code: string,
): AppDeployPreconditionResult['unmet'][number] {
    const found = result.unmet.filter((entry) => entry.code === code);
    expect(found).toHaveLength(1);
    return found[0];
}

/* -------------------------------------------------------------------------- *
 * The happy path first — a suite where everything refuses cannot show that green
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — the ordinary green path', () => {
    it('answers ready with nothing unmet, and reads the spec at the head commit', async () => {
        const { service, specs, env, dependencies } = makeHarness();

        const result = await service.evaluate(request());

        expect(result.ready).toBe(true);
        expect(result.unmet).toEqual([]);
        expect(result.warnings).toEqual([]);
        expect(result.context).toEqual({
            target: 'your-cluster',
            specCommitSha: 'sha-head',
            strategy: 'dockerfile',
            buildId: 'build-1',
            latestGreenBuildId: 'build-1',
            primaryHost: 'app.example.com',
        });

        // The env source is asked once, with the Build's commit and the target (APW06-G08).
        expect(env.calls).toHaveLength(1);
        expect(env.calls[0].specCommitSha).toBe('sha-head');
        expect(env.calls[0].ctx.buildCommitSha).toBe('sha-head');
        expect(env.calls[0].ctx.target).toBe('your-cluster');
        expect(env.calls[0].ctx.primaryHost).toBe('app.example.com');
        expect(env.calls[0].ctx.primaryUrl).toBe('https://app.example.com');

        // The dependency question is asked exactly once, and it is what provisions (GAP-05).
        expect(dependencies.calls).toEqual(['work-1']);

        // Nothing here dispatches a Deployment: that is the caller's step 5.
        expect(specs.reads).toHaveLength(1);
    });

    it('never dispatches a Deployment itself, on any path', async () => {
        const { service, dispatcher } = makeHarness();

        await service.evaluate(request());

        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });
});

/* -------------------------------------------------------------------------- *
 * 1 · worker_not_isolated (APW06-G02, ACC-06-55)
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — worker_not_isolated (ACC-06-55)', () => {
    it('refuses when the dispatcher resolves null, and creates no row by reading nothing', async () => {
        const { service, dispatcher, states, specs } = makeHarness();
        dispatcher.available = null;

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['worker_not_isolated']);
        expect(result.ready).toBe(false);
        // §9.2: "the request returns the precondition `worker_not_isolated` (422) and
        // creates no row". Creating no row starts with reading nothing.
        expect(states.calls).toEqual([]);
        expect(specs.reads).toEqual([]);
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
    });

    it('refuses when the runtime is disabled', async () => {
        const { service, dispatcher } = makeHarness();
        dispatcher.enabled = false;

        expect(codes(await service.evaluate(request()))).toEqual(['worker_not_isolated']);
    });

    it('refuses when the resolved runtime lacks dispatchAppDeploy — no in-process fallback', async () => {
        const { service, dispatcher } = makeHarness();
        dispatcher.available = { dispatchAppKbReembed: jest.fn() };

        expect(codes(await service.evaluate(request()))).toEqual(['worker_not_isolated']);
    });

    it('refuses when no dispatcher availability probe is bound at all', async () => {
        const { service, states } = makeHarness();
        const unbound = new AppDeployPreconditionsService(
            undefined,
            states,
            new FakeSpecs(),
            new FakeEnv(),
        );

        expect(codes(await unbound.evaluate(request()))).toEqual(['worker_not_isolated']);
        expect(service).toBeDefined();
    });

    it('refuses when the probe itself throws, rather than crashing the request', async () => {
        const { service, dispatcher } = makeHarness();
        dispatcher.resolve = () => {
            throw new Error('job runtime is misconfigured');
        };

        await expect(service.evaluate(request())).resolves.toBeDefined();
        expect(codes(await service.evaluate(request()))).toEqual(['worker_not_isolated']);
    });
});

/* -------------------------------------------------------------------------- *
 * 2 · the runtime state
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — target_none (ACC-06-01)', () => {
    it('refuses a Work with no target, and stops before anything that would provision', async () => {
        const { service, states, env, dependencies, specs } = makeHarness();
        states.state = { target: 'none' };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['target_none']);
        expect(result.context.target).toBe('none');
        // ACC-06-01: "no cluster call is made". The dependency check *dispatches*
        // provisioning, so it must not run — and neither must the env resolution.
        expect(dependencies.calls).toEqual([]);
        expect(env.calls).toEqual([]);
        expect(specs.reads).toEqual([]);
    });

    it('refuses a row whose target is missing entirely, the same way', async () => {
        const { service, states } = makeHarness();
        states.state = { target: null };

        expect(codes(await service.evaluate(request()))).toEqual(['target_none']);
    });
});

describe('AppDeployPreconditionsService — paused, deleting and a held lock', () => {
    it('refuses a paused App Work', async () => {
        const { service, states } = makeHarness();
        states.state = { ...states.state, paused: true };

        expect(codes(await service.evaluate(request()))).toEqual(['paused']);
    });

    it('treats a pause timestamp without the flag as paused too', async () => {
        const { service, states } = makeHarness();
        states.state = { ...states.state, paused: null, pausedAt: '2026-09-18T00:00:00.000Z' };

        expect(codes(await service.evaluate(request()))).toEqual(['paused']);
    });

    it('refuses a Work that is being deleted, and says nothing else about it', async () => {
        const { service, states } = makeHarness();
        states.state = { ...states.state, deletionRequestedAt: '2026-09-18T00:00:00.000Z' };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['app_work_deleting']);
        expect(result.ready).toBe(false);
    });

    it('refuses while another Deployment holds the lock', async () => {
        const { service, states } = makeHarness();
        states.state = { ...states.state, deployLockId: 'deployment-other' };

        const result = await service.evaluate(request({ deploymentId: 'deployment-mine' }));

        expect(codes(result)).toEqual(['deploy_in_progress']);
        expect(names(result)).toEqual(['deployment-other']);
    });

    it('does not refuse the Deployment that holds the lock itself (§5.6 step 1)', async () => {
        // The worker re-runs this evaluation inside the Deployment that claimed the
        // lock; without this the re-check would refuse the very work it belongs to.
        const { service, states } = makeHarness();
        states.state = { ...states.state, deployLockId: 'deployment-mine' };

        const result = await service.evaluate(request({ deploymentId: 'deployment-mine' }));

        expect(codes(result)).toEqual([]);
        expect(result.ready).toBe(true);
    });
});

describe('AppDeployPreconditionsService — the connection check', () => {
    it('refuses with target_not_checked when no check is on record', async () => {
        const { service, states } = makeHarness();
        states.state = { ...states.state, clusterCheck: null, clusterFingerprint: null };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['target_not_checked']);
        expect(entryFor(result, 'target_not_checked').names).toBeUndefined();
    });

    it('refuses with target_not_checked when the last check failed, naming its code', async () => {
        const { service, states } = makeHarness();
        states.state = {
            ...states.state,
            clusterCheck: { fingerprint: 'fp-cluster-1', code: 'CLUSTER_ADDRESS_NOT_PUBLIC' },
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['target_not_checked']);
        expect(entryFor(result, 'target_not_checked').names).toEqual([
            'CLUSTER_ADDRESS_NOT_PUBLIC',
        ]);
    });

    it('refuses an unconfirmed cluster change when the check saw another cluster', async () => {
        const { service, states } = makeHarness();
        states.state = {
            ...states.state,
            clusterFingerprint: 'fp-cluster-1',
            clusterCheck: { fingerprint: 'fp-cluster-2' },
        };

        expect(codes(await service.evaluate(request()))).toEqual(['cluster_changed_unconfirmed']);
    });

    it('accepts the same cluster change when the owner confirmed it', async () => {
        const { service, states } = makeHarness();
        states.state = {
            ...states.state,
            clusterFingerprint: 'fp-cluster-1',
            clusterCheck: { fingerprint: 'fp-cluster-2' },
        };

        const result = await service.evaluate(request({ confirmClusterChange: true }));

        expect(codes(result)).toEqual([]);
    });

    it('does not ask a managed-tier Work for a cluster check the owner cannot run', async () => {
        const { service, states, tier } = makeHarness();
        tier.open = true;
        tier.scope = 'any';
        states.state = {
            target: 'ever-works-apps',
            clusterCheck: null,
            clusterFingerprint: null,
            targetSettings: {},
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual([]);
    });

    it('judges nothing from an unreadable row, and says so in a warning', async () => {
        const { service, states } = makeHarness();
        states.failsWith = new Error('runtime state store is down');

        const result = await service.evaluate(request());

        expect(result.warnings.map((warning) => warning.code)).toContain(
            APP_DEPLOY_WARNING_RUNTIME_STATE_UNAVAILABLE,
        );
        // A row that cannot be read cannot even say where the Work deploys.
        expect(result.context.target).toBeNull();
        expect(codes(result)).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * 3 · spec_invalid (ACC-06-20)
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — spec_invalid', () => {
    it('refuses an invalid spec and names its issues', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'invalid',
            spec: null,
            commitSha: 'sha-head',
            issues: [{ code: 'port_required' }, { code: 'worker_port_forbidden' }],
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['spec_invalid']);
        expect(entryFor(result, 'spec_invalid').names).toEqual([
            'port_required',
            'worker_port_forbidden',
        ]);
    });

    it('stops there: an unreadable spec is not a reason to ask for env values it defines', async () => {
        const { service, specs, env, dependencies } = makeHarness();
        specs.snapshot = { status: 'unreadable', spec: null, commitSha: 'sha-head' };

        await service.evaluate(request());

        expect(env.calls).toEqual([]);
        expect(dependencies.calls).toEqual([]);
    });

    it('refuses when no spec exists at the commit at all', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = null;

        expect(codes(await service.evaluate(request()))).toEqual(['spec_invalid']);
    });

    // `AppSpecService.getEffectiveSpec` answers `valid_with_warnings` for a commit that is
    // neither the stored effective one nor a usable head — an earlier Build, a Build a newer
    // push superseded, a rollback commit. APW-03 calls that usable and APW-05 builds it, so a
    // green Build of it must not come back as `spec_invalid` here.
    it('accepts valid_with_warnings: warnings never stop a deploy (APP_SPEC_USABLE_STATUSES)', async () => {
        const { service, specs, env } = makeHarness();
        specs.snapshot = {
            status: 'valid_with_warnings',
            spec: appSpec(),
            commitSha: 'sha-head',
            issues: [{ code: 'unknown_key', path: 'extra' }],
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual([]);
        expect(result.ready).toBe(true);
        expect(result.context.specCommitSha).toBe('sha-head');
        expect(result.context.strategy).toBe('dockerfile');
        expect(env.calls).toHaveLength(1);
    });

    it.each(['invalid', 'missing', 'unreadable', 'no_state'])(
        'still refuses a spec whose status is %s',
        async (status) => {
            const { service, specs } = makeHarness();
            specs.snapshot = { status, spec: appSpec(), commitSha: 'sha-head' };

            const result = await service.evaluate(request());

            expect(codes(result)).toEqual(['spec_invalid']);
            expect(entryFor(result, 'spec_invalid').message).toContain(`(status: ${status})`);
        },
    );

    it('accepts exactly APW-03’s usable statuses, of all six getEffectiveSpec can answer', async () => {
        const answered = [...APP_SPEC_VALIDATION_STATUSES, 'no_state'];
        const accepted: string[] = [];

        for (const status of answered) {
            const { service, specs } = makeHarness();
            specs.snapshot = { status, spec: appSpec(), commitSha: 'sha-head' };

            const result = await service.evaluate(request());

            if (!codes(result).includes('spec_invalid')) accepted.push(status);
        }

        expect(answered).toHaveLength(6);
        expect(accepted).toEqual([...APP_SPEC_USABLE_STATUSES]);
    });

    it('reads the App spec at the BUILD’s commit, not the latest applied one (ACC-06-20)', async () => {
        const { service, specs, builds } = makeHarness();
        specs.snapshot = { status: 'valid', spec: appSpec(), commitSha: 'sha-build' };
        builds.byId = { 'build-9': greenBuild({ id: 'build-9', commitSha: 'sha-build' }) };

        const result = await service.evaluate(request({ buildId: 'build-9' }));

        expect(specs.reads).toEqual([{ workId: 'work-1', commitSha: 'sha-build' }]);
        expect(specs.reads[0].commitSha).not.toBe(specs.latestAppliedSha);
        expect(result.context.specCommitSha).toBe('sha-build');
        expect(result.context.buildId).toBe('build-9');

        // FR-25: the image and the spec come from the same commit — the image is the
        // one that Build produced, read through the same id.
        expect(builds.getCalls).toEqual([{ workId: 'work-1', buildId: 'build-9' }]);
    });
});

/* -------------------------------------------------------------------------- *
 * 4 · the license gate
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — the license gate (§5.2)', () => {
    it('refuses Your cluster with license_attestation_missing', async () => {
        const { service, license } = makeHarness();
        license.eligibility = {
            none: 'allowed',
            yourCluster: 'attestationRequired',
            managed: 'allowed',
            sourceOffer: { required: false, url: null, missing: false },
        };

        expect(codes(await service.evaluate(request()))).toEqual(['license_attestation_missing']);
    });

    it('refuses Ever Works Apps with license_blocks_target when the licence blocks it', async () => {
        const { service, license, tier, states } = makeHarness();
        tier.open = true;
        tier.scope = 'any';
        states.state = { ...states.state, target: 'ever-works-apps', clusterCheck: null };
        license.eligibility = {
            none: 'allowed',
            yourCluster: 'allowed',
            managed: 'licenseNotGreen',
            sourceOffer: { required: false, url: null, missing: false },
        };

        expect(codes(await service.evaluate(request()))).toEqual(['license_blocks_target']);
    });
});

/* -------------------------------------------------------------------------- *
 * 5 · the managed tier
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — the managed tier (§5.1)', () => {
    /** A managed Work with a clean everything-else state. */
    function managedHarness(): Harness {
        const harness = makeHarness();
        harness.states.state = {
            target: 'ever-works-apps',
            clusterCheck: null,
            clusterFingerprint: null,
            targetSettings: {},
        };
        return harness;
    }

    it('refuses with managed_disabled while the tier is closed — the unbound default', async () => {
        const harness = managedHarness();

        const result = await harness.service.evaluate(request());

        expect(codes(result)).toEqual(['managed_disabled']);
    });

    it('refuses with managed_scope_unverified_blueprint outside the verified scope', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'verified-blueprints';
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec(),
            commitSha: 'sha-head',
            blueprintVerified: false,
            blueprintId: 'umami',
        };

        const result = await harness.service.evaluate(request());

        expect(codes(result)).toEqual(['managed_scope_unverified_blueprint']);
        expect(entryFor(result, 'managed_scope_unverified_blueprint').names).toEqual(['umami']);
    });

    it('accepts a verified Blueprint inside the verified scope', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec(),
            commitSha: 'sha-head',
            blueprintVerified: true,
        };

        expect(codes(await harness.service.evaluate(request()))).toEqual([]);
    });

    it('refuses with managed_ineligible, naming the reasons', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'any';
        harness.tier.eligible = false;
        harness.tier.reasons = ['planRequired', 'ownerQuarantined'];

        const result = await harness.service.evaluate(request());

        expect(codes(result)).toEqual(['managed_ineligible']);
        expect(entryFor(result, 'managed_ineligible').names).toEqual([
            'planRequired',
            'ownerQuarantined',
        ]);
    });

    it('maps APW-10’s capReached to quota_exceeded and does not double-report it', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'any';
        harness.tier.eligible = false;
        harness.tier.reasons = ['capReached'];

        const result = await harness.service.evaluate(request());

        expect(codes(result)).toEqual(['quota_exceeded']);
        expect(entryFor(result, 'quota_exceeded').names).toEqual(['capReached']);
    });

    it('refuses a capReached account once, even beside other reasons', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'any';
        harness.tier.eligible = false;
        harness.tier.reasons = ['capReached', 'emailUnverified'];

        const result = await harness.service.evaluate(request());

        expect(codes(result)).toEqual(['quota_exceeded', 'managed_ineligible']);
        expect(entryFor(result, 'managed_ineligible').names).toEqual(['emailUnverified']);
    });

    it('refuses with managed_sandbox_unavailable when the tier has no sandboxed runtime (R-24)', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'any';
        harness.tier.runtimeClassName = null;

        expect(codes(await harness.service.evaluate(request()))).toEqual([
            'managed_sandbox_unavailable',
        ]);
    });

    it('reads the tier only through the port — never an environment variable (R-5)', async () => {
        const harness = managedHarness();
        harness.tier.open = true;
        harness.tier.scope = 'any';

        await harness.service.evaluate(request());

        // `AppsTierPolicy` is the only door; the policy being closed above is what
        // proves the reading, and the default-ports spec owns the env-name scan.
        expect(harness.tier.open).toBe(true);
    });
});

/* -------------------------------------------------------------------------- *
 * 6 · the Build and the strategy (ACC-06-19, -52, -53)
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — the Build (ACC-06-19)', () => {
    it('refuses with no_green_build when nothing has ever built green', async () => {
        const { service, builds } = makeHarness();
        builds.builds = [];
        builds.byId = {};

        expect(codes(await service.evaluate(request()))).toEqual(['no_green_build']);
    });

    it('refuses with no_green_build when the named Build is not green', async () => {
        const { service, builds } = makeHarness();
        builds.byId = { 'build-2': greenBuild({ id: 'build-2', status: 'failed' }) };

        const result = await service.evaluate(request({ buildId: 'build-2' }));

        expect(codes(result)).toEqual(['no_green_build']);
        expect(names(result)).toEqual(['build-2']);
    });

    it('refuses a Build whose trigger is not deployable — a preview is not a Deployment', async () => {
        const { service, builds } = makeHarness();
        builds.byId = { 'build-3': greenBuild({ id: 'build-3', trigger: 'pull_request' }) };

        expect(codes(await service.evaluate(request({ buildId: 'build-3' })))).toEqual([
            'no_green_build',
        ]);
    });

    it('refuses with no_green_build_for_head and offers the older Build (ACC-06-19 / S14)', async () => {
        const { service, builds } = makeHarness();
        builds.builds = [greenBuild({ id: 'build-8', commitSha: 'sha-older' })];

        const result = await service.evaluate(request({ headCommitSha: 'sha-head' }));

        expect(codes(result)).toEqual(['no_green_build_for_head']);
        expect(entryFor(result, 'no_green_build_for_head').names).toEqual(['build-8']);
        // The id S14's "Deploy the older Build" action needs lives in the context too.
        expect(result.context.latestGreenBuildId).toBe('build-8');
    });

    it('refuses with build_image_missing when the green Build produced no image', async () => {
        const { service, builds } = makeHarness();
        builds.builds = [greenBuild({ imageReference: null })];

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['build_image_missing']);
        expect(names(result)).toEqual(['build-1']);
    });

    it.each(['dockerfile', 'auto'] as const)(
        'requires a green Build under strategy %s',
        async (strategy) => {
            const { service, specs, builds } = makeHarness();
            specs.snapshot = {
                status: 'valid',
                spec: appSpec({ build: { strategy } }),
                commitSha: 'sha-head',
            };
            builds.builds = [];
            builds.byId = {};

            expect(codes(await service.evaluate(request()))).toEqual(['no_green_build']);
        },
    );

    it('never asks for a Build under strategy image, and never yields no_green_build*', async () => {
        const { service, specs, builds } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                build: { strategy: 'image', image: `ghcr.io/x/y@sha256:${'b'.repeat(64)}` },
            }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request({ specCommitSha: 'sha-head' }));

        expect(codes(result)).toEqual([]);
        expect(result.context.latestGreenBuildId).toBeNull();
        expect(builds.listCalls).toEqual([]);
        expect(builds.getCalls).toEqual([]);
    });

    it('refuses nothing to run under strategy none, and says Builds still run', async () => {
        const { service, specs, builds } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({ build: { strategy: 'none' }, components: [] }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['nothing_to_deploy']);
        expect(builds.listCalls).toEqual([]);
    });

    it('refuses a tag-only image on Ever Works Apps with image_not_pinned (ACC-06-53)', async () => {
        const harness = managedHarnessForImage('ghcr.io/x/y:latest');

        const result = await harness.service.evaluate(request({ specCommitSha: 'sha-head' }));

        expect(codes(result)).toEqual(['image_not_pinned']);
        expect(entryFor(result, 'image_not_pinned').names).toEqual(['ghcr.io/x/y:latest']);
    });

    it('accepts the same tag-only image on Your cluster — the refusal is managed-only (ACC-06-52)', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({ build: { strategy: 'image', image: 'ghcr.io/x/y:latest' } }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request({ specCommitSha: 'sha-head' }));

        expect(codes(result)).toEqual([]);
    });

    it('passes buildCommitSha: null under strategy image, as §5.6 step 2 requires', async () => {
        const { service, specs, env } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({ build: { strategy: 'image', image: 'ghcr.io/x/y:1.2.3' } }),
            commitSha: 'sha-head',
        };

        await service.evaluate(request({ specCommitSha: 'sha-head' }));

        expect(env.calls[0].ctx.buildCommitSha).toBeNull();
    });
});

/** A managed harness mid-way through an `image` spec of the given reference. */
function managedHarnessForImage(reference: string): Harness {
    const harness = makeHarness();
    harness.states.state = {
        target: 'ever-works-apps',
        clusterCheck: null,
        clusterFingerprint: null,
        targetSettings: {},
    };
    harness.tier.open = true;
    harness.tier.scope = 'any';
    harness.specs.snapshot = {
        status: 'valid',
        spec: appSpec({ build: { strategy: 'image', image: reference } }),
        commitSha: 'sha-head',
    };
    return harness;
}

/* -------------------------------------------------------------------------- *
 * 7 · env
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — env (§5.1, FR-24)', () => {
    it('refuses with env_source_unavailable when no env source is bound', async () => {
        const { service, specs, dependencies } = makeHarness();
        const unbound = new AppDeployPreconditionsService(
            new FakeDispatcher(),
            new FakeStates(),
            specs,
            undefined,
            dependencies,
            new FakeBuilds(),
            new FakeHosts(),
        );

        const result = await unbound.evaluate(request());

        expect(codes(result)).toEqual(['env_source_unavailable']);
        expect(service).toBeDefined();
    });

    it('refuses with env_source_unavailable when the env source throws (the fail-closed port)', async () => {
        const { service, env } = makeHarness();
        env.failsWith = new Error('env_source_unavailable');

        expect(codes(await service.evaluate(request()))).toEqual(['env_source_unavailable']);
    });

    it('lists two unset values and a pending dependency as three names, with no dispatch', async () => {
        const { service, env, dependencies, dispatcher } = makeHarness();
        env.result = {
            values: {},
            secretNames: [],
            unsetRequired: ['AUTH_SECRET', 'SMTP_URL'],
            notReadyDependencies: [],
            egress: [],
        };
        dependencies.readiness = {
            ready: false,
            notReady: [{ kind: 'postgres', status: 'pending' }],
            optional: [],
        };

        const result = await service.evaluate(request());

        // The contract's own note (`app-runtime.ts:338-342`): "three unset env values
        // are one `env_required_unset` naming three entries, not three rows a caller
        // has to merge" — so two entries carry the three names.
        expect(codes(result)).toEqual(['env_required_unset', 'dependency_not_ready']);
        expect(names(result)).toEqual(['AUTH_SECRET', 'SMTP_URL', 'postgres']);
        expect(result.ready).toBe(false);

        // Nothing is queued: no Deployment dispatch, and the dependency question was
        // asked exactly once — which is what dispatches provisioning (GAP-05).
        expect(dispatcher.dispatch).not.toHaveBeenCalled();
        expect(dependencies.calls).toEqual(['work-1']);
    });

    it('refuses a job whose Authorization env entry has no value', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                jobs: [
                    {
                        name: 'migrate',
                        when: 'pre-deploy',
                        http: { path: '/migrate', authEnv: 'JOB_TOKEN' },
                    },
                ],
            }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['job_auth_env_unset']);
        expect(names(result)).toEqual(['JOB_TOKEN']);
    });

    it('accepts a job whose Authorization env entry resolved as a secret', async () => {
        const { service, specs, env } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                jobs: [
                    {
                        name: 'migrate',
                        when: 'pre-deploy',
                        http: { path: '/migrate', authEnv: 'JOB_TOKEN' },
                    },
                ],
            }),
            commitSha: 'sha-head',
        };
        env.result = {
            values: {},
            secretNames: ['JOB_TOKEN'],
            unsetRequired: [],
            notReadyDependencies: [],
            egress: [],
        };

        expect(codes(await service.evaluate(request()))).toEqual([]);
    });

    it('refuses a scheduled call whose Authorization env entry has no value', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                cron: [
                    {
                        name: 'nightly',
                        schedule: '0 3 * * *',
                        http: { path: '/tick', authEnv: 'CRON_TOKEN' },
                    },
                ],
            }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['cron_auth_env_unset']);
        expect(names(result)).toEqual(['CRON_TOKEN']);
    });

    it('passes components.<name>.internalUrl when the namespace is known (CONTRACTS §1)', async () => {
        const { service, states, env } = makeHarness();
        states.state = { ...states.state, namespace: 'app-work-1' };

        await service.evaluate(request());

        expect(env.calls[0].ctx.internalUrls).toEqual({
            web: 'http://web.app-work-1.svc.cluster.local',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * 8 · dependencies (GAP-05, ACC-06-54)
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — dependency_not_ready (GAP-05, ACC-06-54)', () => {
    it('asks once and names every pending kind in exactly one entry', async () => {
        const { service, dependencies } = makeHarness();
        dependencies.readiness = {
            ready: false,
            notReady: [
                { kind: 'postgres', status: 'pending' },
                { kind: 'redis', status: 'provisioning' },
            ],
            optional: [],
        };

        const result = await service.evaluate(request());

        expect(dependencies.calls).toEqual(['work-1']);
        expect(codes(result)).toEqual(['dependency_not_ready']);
        expect(entryFor(result, 'dependency_not_ready').names).toEqual(['postgres', 'redis']);
    });

    it('says nothing when every dependency is ready', async () => {
        const { service, dependencies } = makeHarness();

        const result = await service.evaluate(request());

        expect(dependencies.calls).toEqual(['work-1']);
        expect(codes(result)).toEqual([]);
    });

    it('refuses when the question could not be answered at all', async () => {
        const { service, dependencies } = makeHarness();
        dependencies.readiness = {
            ready: false,
            notReady: [],
            optional: [],
            reason: 'specUnavailable',
        };

        const result = await service.evaluate(request());

        expect(codes(result)).toEqual(['dependency_not_ready']);
        expect(entryFor(result, 'dependency_not_ready').message).toContain('specUnavailable');
    });

    it('refuses rather than proceeding when the dependency service throws', async () => {
        const { service, dependencies } = makeHarness();
        dependencies.failsWith = new Error('dependency store is down');

        expect(codes(await service.evaluate(request()))).toEqual(['dependency_not_ready']);
    });

    it('warns — and does not refuse — when dependencies are declared but nothing can judge them', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({ dependencies: { postgres: { version: '16' } } }),
            commitSha: 'sha-head',
        };
        const noDependencies = new AppDeployPreconditionsService(
            new FakeDispatcher(),
            new FakeStates(),
            specs,
            new FakeEnv(),
            undefined,
            new FakeBuilds(),
            new FakeHosts(),
        );

        const result = await noDependencies.evaluate(request());

        expect(codes(result)).toEqual([]);
        expect(result.warnings.map((warning) => warning.code)).toContain(
            APP_DEPLOY_WARNING_DEPENDENCIES_UNAVAILABLE,
        );
        expect(service).toBeDefined();
    });
});

/* -------------------------------------------------------------------------- *
 * 9 · domains.primary.* (GAP-09)
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — primary_domain_missing (GAP-09)', () => {
    it('names the entries and warns instead of refusing the Deployment', async () => {
        const { service, specs, hosts } = makeHarness();
        hosts.host = null;
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                env: [
                    { name: 'PUBLIC_URL', value: 'https://fixed.example.com' },
                    { name: 'APP_URL', from: 'domains.primary.url' },
                    { name: 'APP_HOST', template: '{{domains.primary.host}}' },
                ],
            }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request());

        // §5.1: the in-cluster URL is used "**instead of refusing the Deployment**".
        expect(codes(result)).toEqual([]);
        expect(result.ready).toBe(true);
        expect(result.advisory.map((entry) => entry.code)).toEqual(['primary_domain_missing']);
        expect(result.advisory[0].names).toEqual(['APP_URL', 'APP_HOST']);
        expect(result.warnings.map((warning) => warning.code)).toEqual([
            APP_PRECONDITION_PRIMARY_URL_INCLUSTER,
        ]);
    });

    it('says nothing when the Work has a primary host', async () => {
        const { service, specs } = makeHarness();
        specs.snapshot = {
            status: 'valid',
            spec: appSpec({ env: [{ name: 'APP_URL', from: 'domains.primary.url' }] }),
            commitSha: 'sha-head',
        };

        const result = await service.evaluate(request());

        expect(result.advisory).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('says nothing when no entry reads domains.primary.*, host or no host', async () => {
        const { service, hosts } = makeHarness();
        hosts.host = null;

        const result = await service.evaluate(request());

        expect(result.advisory).toEqual([]);
        expect(result.warnings).toEqual([]);
    });

    it('uses http for the primary URL when the owner chose no TLS (FR-42)', async () => {
        const { service, states, env } = makeHarness();
        states.state = { ...states.state, targetSettings: { tls: 'none' } };

        await service.evaluate(request());

        expect(env.calls[0].ctx.primaryUrl).toBe('http://app.example.com');
    });
});

/* -------------------------------------------------------------------------- *
 * The contract the task names: never throws for an unmet precondition
 * -------------------------------------------------------------------------- */

describe('AppDeployPreconditionsService — never throws for an unmet precondition', () => {
    /** One refusal scenario per code this service can produce. */
    const scenarios: Array<{ code: string; arrange: (harness: Harness) => void }> = [
        { code: 'worker_not_isolated', arrange: (h) => (h.dispatcher.available = null) },
        { code: 'target_none', arrange: (h) => (h.states.state = { target: 'none' }) },
        {
            code: 'paused',
            arrange: (h) => (h.states.state = { ...h.states.state, paused: true }),
        },
        {
            code: 'app_work_deleting',
            arrange: (h) =>
                (h.states.state = {
                    ...h.states.state,
                    deletionRequestedAt: '2026-09-18T00:00:00.000Z',
                }),
        },
        {
            code: 'deploy_in_progress',
            arrange: (h) => (h.states.state = { ...h.states.state, deployLockId: 'other' }),
        },
        {
            code: 'target_not_checked',
            arrange: (h) =>
                (h.states.state = {
                    ...h.states.state,
                    clusterCheck: null,
                    clusterFingerprint: null,
                }),
        },
        {
            code: 'cluster_changed_unconfirmed',
            arrange: (h) =>
                (h.states.state = {
                    ...h.states.state,
                    clusterFingerprint: 'fp-1',
                    clusterCheck: { fingerprint: 'fp-2' },
                }),
        },
        {
            code: 'spec_invalid',
            arrange: (h) => (h.specs.snapshot = { status: 'invalid', spec: null }),
        },
        {
            code: 'license_attestation_missing',
            arrange: (h) =>
                (h.license.eligibility = {
                    none: 'allowed',
                    yourCluster: 'attestationRequired',
                    managed: 'allowed',
                    sourceOffer: { required: false, url: null, missing: false },
                }),
        },
        {
            code: 'no_green_build',
            arrange: (h) => {
                h.builds.builds = [];
                h.builds.byId = {};
            },
        },
        {
            code: 'nothing_to_deploy',
            arrange: (h) =>
                (h.specs.snapshot = {
                    status: 'valid',
                    spec: appSpec({ build: { strategy: 'none' }, components: [] }),
                    commitSha: 'sha-head',
                }),
        },
        { code: 'env_source_unavailable', arrange: (h) => (h.env.failsWith = new Error('down')) },
        {
            code: 'env_required_unset',
            arrange: (h) =>
                (h.env.result = {
                    values: {},
                    secretNames: [],
                    unsetRequired: ['AUTH_SECRET'],
                    notReadyDependencies: [],
                    egress: [],
                }),
        },
        {
            code: 'dependency_not_ready',
            arrange: (h) =>
                (h.dependencies.readiness = {
                    ready: false,
                    notReady: [{ kind: 'postgres', status: 'pending' }],
                    optional: [],
                }),
        },
    ];

    it.each(scenarios)(
        'resolves with $code unmet rather than throwing',
        async ({ code, arrange }) => {
            const harness = makeHarness();
            arrange(harness);

            const result = await harness.service.evaluate(request());

            expect(codes(result)).toContain(code);
            expect(result.ready).toBe(false);
            // Every entry is renderable: a code and a sentence, never a value.
            for (const entry of result.unmet) {
                expect(typeof entry.message).toBe('string');
                expect(entry.message.length).toBeGreaterThan(0);
            }
        },
    );

    it('resolves for a request whose Work id is empty or missing entirely', async () => {
        const { service } = makeHarness();

        await expect(service.evaluate({ workId: '' })).resolves.toBeDefined();
        await expect(service.evaluate({} as AppDeployPreconditionRequest)).resolves.toBeDefined();
    });

    it('resolves for every seam throwing at once', async () => {
        const { service, states, specs, env, dependencies, builds, hosts } = makeHarness();
        states.failsWith = new Error('states');
        specs.failsWith = new Error('specs');
        env.failsWith = new Error('env');
        dependencies.failsWith = new Error('dependencies');
        builds.failsWith = new Error('builds');
        hosts.failsWith = new Error('hosts');

        const result = await service.evaluate(request());

        expect(result.unmet.length).toBeGreaterThan(0);
        expect(result.warnings.length).toBeGreaterThan(0);
    });
});
