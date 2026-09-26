/**
 * APW-06 T22 — `AppRenderInputBuilder` (plan §5.6 step 2, §5.8; spec ACC-06-16, ACC-06-20,
 * ACC-06-52).
 *
 * Every collaborator is a hand-written fake, so the suite also pins **what was asked of them**: which
 * commit the App spec was read at (ACC-06-20), which commit the image came from (the same Build),
 * what `target` and `buildCommitSha` the env source received (APW06-G08, §5.8), and how many times
 * the pull-credential port was called — **zero** under `build.strategy: image` (ACC-06-52).
 *
 * Nothing here touches a database, a cluster, a network or a clock: `resolveHostAddresses` — the one
 * method that would resolve a dependency host — is overridden by {@link PinnedBuilder}, which is the
 * seam the production class documents.
 *
 * ## "`DeployService.collectServerSideRuntimeEnv` and `resolveGhcrReadToken` are never called" (T22)
 *
 * Those two methods live in `apps/api/src/plugins-capabilities/deploy/deploy.service.ts:1289,1408`.
 * This package **cannot** import `apps/api` — that is T22's own Done-when ("the builder has no
 * dependency on `apps/api`"), and importing it here to install a spy would be the very boundary
 * violation the assertion exists to prevent. So the assertion is made two ways, both executable:
 *
 * 1. **The source scan below** reads `app-render-input.builder.ts` and fails if either name — or
 *    `DeployService`, or the string `apps/api` — appears at all, with a known-good control proving
 *    the reader works (the same idiom as `__tests__/default-ports.spec.ts:272-307`).
 * 2. **The call journal** (`Harness.journal`) records every call that reaches any collaborator the
 *    class *can* reach, and the tests assert the journal holds exactly the expected entries — so a
 *    wiring that reached a seventh collaborator could not pass unnoticed either.
 */

import * as fs from 'node:fs';
import { isIP } from 'node:net';
import * as path from 'node:path';

import { Logger } from '@nestjs/common';
import { APP_SPEC_VALIDATION_STATUSES, type AppSpec } from '@ever-works/contracts';
import type { AppRenderInput, AppTargetRef } from '@ever-works/plugin';

import { APP_SPEC_USABLE_STATUSES } from '../../app-spec/app-spec.service';
import {
    APP_RENDER_WARNING_EGRESS_UNRESOLVED,
    APP_RENDER_WARNING_HOSTS_INCOMPLETE,
    APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE,
    APP_RENDER_WEB_STARTUP_PROBE,
    AppRenderInputBuilder,
    declaredDependencyKinds,
    deploymentShortFor,
    internalUrlsFor,
    primaryComponentName,
    urlForHost,
    workSlugFromNamespace,
    type AppRenderHosts,
    type AppRenderInputRequest,
    type AppRenderInputResult,
} from '../app-render-input.builder';
import type {
    AppDeployBuildSnapshot,
    AppDeployBuildSource,
    AppDeploySpecSnapshot,
    AppDeploySpecSource,
} from '../app-deploy-preconditions.service';
import type { AppVerificationSpecRequest } from '../app-verification-target.service';
import type {
    AppImagePullCredentialSource,
    AppRuntimeEnvContext,
    AppRuntimeEnvSource,
    AppsTierPolicy,
} from '../ports';

/* -------------------------------------------------------------------------- *
 * Sentinels — values that must never appear in the built input
 * -------------------------------------------------------------------------- */

const WORK_ID = '0f8e2c1a-1111-4a2b-9c3d-4e5f60718293';
const LIVE_NAMESPACE = 'ew-helpdesk-0f8e2c1a';

/** The owner's Git token, as the website deploy path would inject it (plan §1.2:68-70). */
const GIT_TOKEN_SENTINEL = 'gho_OWNER_GIT_TOKEN_SENTINEL';

/** The three platform names the platform's own assemblers mint (T22, ACC-06-16). */
const FORBIDDEN_ENV_NAMES = [
    'GH_TOKEN',
    'PLATFORM_API_SECRET_TOKEN',
    'PLATFORM_SYNC_SECRET',
] as const;

const REF: AppTargetRef = {
    workId: WORK_ID,
    namespace: LIVE_NAMESPACE,
    target: 'your-cluster',
    kubeContext: 'kind-app-runtime',
    clusterFingerprint: 'sha256:fixture-cluster-fingerprint',
};

/** The logger is silenced: several cases deliberately make a seam throw, and the contract is a report. */
beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
});

afterEach(() => {
    jest.restoreAllMocks();
});

/* -------------------------------------------------------------------------- *
 * Fakes — one per seam, every call recorded in one journal
 * -------------------------------------------------------------------------- */

class FakeSpecs implements AppDeploySpecSource {
    readonly reads: Array<{ workId: string; commitSha?: string | null }> = [];
    snapshot: AppDeploySpecSnapshot | null = {
        status: 'valid',
        spec: appSpec(),
        commitSha: 'sha-head',
    };
    /** The commit APW-03 last *applied* — never the one this builder may read (ACC-06-20). */
    latestAppliedSha = 'sha-applied';
    failsWith: Error | null = null;

    constructor(private readonly journal: string[]) {}

    async getEffectiveSpec(
        workId: string,
        commitSha?: string | null,
    ): Promise<AppDeploySpecSnapshot | null> {
        this.journal.push(`specs.getEffectiveSpec:${commitSha ?? 'head'}`);
        this.reads.push({ workId, commitSha });
        if (this.failsWith) throw this.failsWith;
        return this.snapshot;
    }
}

class FakeBuilds implements AppDeployBuildSource {
    readonly getCalls: Array<{ workId: string; buildId: string }> = [];
    byId: Record<string, AppDeployBuildSnapshot> = { 'build-1': greenBuild() };
    failsWith: Error | null = null;

    constructor(private readonly journal: string[]) {}

    async getBuild(workId: string, buildId: string): Promise<AppDeployBuildSnapshot | null> {
        this.journal.push(`builds.getBuild:${buildId}`);
        this.getCalls.push({ workId, buildId });
        if (this.failsWith) throw this.failsWith;
        return this.byId[buildId] ?? null;
    }

    async listDeployableBuilds(): Promise<readonly AppDeployBuildSnapshot[]> {
        this.journal.push('builds.listDeployableBuilds');

        return Object.values(this.byId);
    }
}

class FakeEnv implements AppRuntimeEnvSource {
    readonly calls: Array<{ workId: string; specCommitSha: string; ctx: AppRuntimeEnvContext }> =
        [];
    result = {
        values: { DATABASE_URL: 'postgres://example', DISABLE_TELEMETRY: '1' } as Record<
            string,
            string
        >,
        secretNames: ['DATABASE_URL'] as string[],
        unsetRequired: [] as string[],
        notReadyDependencies: [] as string[],
        egress: [] as Array<{ host: string; ports: number[] }>,
    };
    failsWith: Error | null = null;

    constructor(private readonly journal: string[]) {}

    async resolve(
        workId: string,
        specCommitSha: string,
        ctx: AppRuntimeEnvContext,
    ): Promise<typeof this.result> {
        this.journal.push('env.resolve');
        this.calls.push({ workId, specCommitSha, ctx });
        if (this.failsWith) throw this.failsWith;
        return this.result;
    }

    async resolveEphemeral(): Promise<never> {
        throw new Error('the builder never resolves ephemeral env (that is T60, R-10)');
    }
}

class FakePull implements AppImagePullCredentialSource {
    readonly calls: Array<{ workId: string; buildId: string }> = [];
    credential: { server: string; username: string; password: string } | null = {
        server: 'ghcr.io',
        username: 'evereq',
        password: 'pull-credential-SENTINEL',
    };
    failsWith: Error | null = null;

    constructor(private readonly journal: string[]) {}

    async resolve(
        workId: string,
        buildId: string,
    ): Promise<{ server: string; username: string; password: string } | null> {
        this.journal.push('pull.resolve');
        this.calls.push({ workId, buildId });
        if (this.failsWith) throw this.failsWith;
        return this.credential;
    }
}

class FakeHosts {
    readonly calls: string[] = [];
    hosts: AppRenderHosts | null = {
        primary: 'helpdesk.example.com',
        extra: ['alt.example.com'],
        previous: [],
    };
    primary: string | null = 'helpdesk.example.com';
    withResolveHosts = true;
    failsWith: Error | null = null;

    constructor(private readonly journal: string[]) {}

    async resolveHosts(workId: string): Promise<AppRenderHosts | null> {
        this.journal.push('hosts.resolveHosts');
        this.calls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.hosts;
    }

    async primaryHost(workId: string): Promise<string | null> {
        this.journal.push('hosts.primaryHost');
        this.calls.push(workId);
        if (this.failsWith) throw this.failsWith;
        return this.primary;
    }
}

class FakeTier implements AppsTierPolicy {
    open = true;
    scope: 'verified-blueprints' | 'any' = 'verified-blueprints';
    runtimeClassName: string | null = 'gvisor';
    quota = {
        'requests.cpu': '2',
        'limits.cpu': '4',
        'requests.memory': '4Gi',
        'limits.memory': '6Gi',
        pods: 20,
        persistentvolumeclaims: 5,
        'requests.storage': '20Gi',
        'services.loadbalancers': 0,
        'services.nodeports': 0,
        'count/jobs.batch': 20,
        'count/cronjobs.batch': 20,
        secrets: 30,
        configmaps: 30,
    };
    limitRange = {
        defaultRequest: { cpu: '100m', memory: '128Mi' },
        defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
        max: { cpu: '2', memory: '4Gi' },
    };
    throwsPodPolicy = false;

    constructor(private readonly journal: string[]) {}

    isOpen(): boolean {
        this.journal.push('tier.isOpen');

        return this.open;
    }

    managedScope(): 'verified-blueprints' | 'any' {
        return this.scope;
    }

    async resolveClusterCredential(): Promise<string> {
        return 'tier-credential';
    }

    podPolicy(): { runtimeClassName: string | null; quota: never; limitRange: never } {
        this.journal.push('tier.podPolicy');
        if (this.throwsPodPolicy) throw new Error('pod policy unavailable');

        return {
            runtimeClassName: this.runtimeClassName,
            quota: this.quota as never,
            limitRange: this.limitRange as never,
        };
    }

    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' } {
        this.journal.push('tier.ingress');

        return { className: 'nginx', controllerNamespace: 'ingress-nginx', edgeTlsMode: 'edge' };
    }

    async eligibility(): Promise<{ eligible: boolean; reasons: string[] }> {
        return { eligible: true, reasons: [] };
    }
}

/** The builder with DNS pinned — the one method that would otherwise reach the network. */
class PinnedBuilder extends AppRenderInputBuilder {
    /** The host **names** the resolver was asked for; a literal never reaches it (the base rule). */
    readonly resolved: string[] = [];
    addresses: Record<string, string[]> = {};

    protected async resolveHostAddresses(host: string): Promise<string[]> {
        if (isIP(host) !== 0) return super.resolveHostAddresses(host);

        this.resolved.push(host);

        const found = this.addresses[host];
        if (!found) throw new Error(`ENOTFOUND ${host}`);

        return found;
    }
}

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

/** A plain `dockerfile` App spec: one web component, one worker, one job, one smoke check. */
function appSpec(overrides: Partial<AppSpec> = {}): AppSpec {
    return {
        kind: 'app',
        build: { strategy: 'dockerfile' },
        components: [
            { name: 'web', role: 'web', port: 3000 },
            { name: 'worker', role: 'worker' },
        ],
        jobs: [
            {
                name: 'migrate',
                when: 'pre-deploy',
                component: 'web',
                command: ['node', 'migrate.js'],
            },
        ],
        smoke: [{ name: 'health', component: 'web', http: { path: '/api/health' } }],
        ...overrides,
    } as AppSpec;
}

/** A published-image App spec (APW06-G04). */
function imageSpec(image = 'ghcr.io/acme/helpdesk:1.2.3'): AppSpec {
    return appSpec({ build: { strategy: 'image', image } });
}

/** A green Build of one commit, with the image that commit produced. */
function greenBuild(overrides: Partial<AppDeployBuildSnapshot> = {}): AppDeployBuildSnapshot {
    return {
        id: 'build-1',
        commitSha: 'sha-b1',
        status: 'succeeded',
        trigger: 'push',
        imageReference: `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`,
        ...overrides,
    };
}

interface Harness {
    builder: PinnedBuilder;
    specs: FakeSpecs;
    builds: FakeBuilds;
    env: FakeEnv;
    pull: FakePull;
    hosts: FakeHosts;
    tier: FakeTier;
    /** Every call that reached a collaborator, in order. */
    journal: string[];
    /** A binding object with **no** host seam, to prove the optional-collaborator answer. */
    withoutHosts: AppRenderInputBuilder;
}

function makeHarness(): Harness {
    const journal: string[] = [];
    const specs = new FakeSpecs(journal);
    const builds = new FakeBuilds(journal);
    const env = new FakeEnv(journal);
    const pull = new FakePull(journal);
    const hosts = new FakeHosts(journal);
    const tier = new FakeTier(journal);

    const builder = new PinnedBuilder(specs, builds, env, pull, hosts, tier);
    const withoutHosts = new AppRenderInputBuilder(specs, builds, env, pull, undefined, tier);

    return { builder, specs, builds, env, pull, hosts, tier, journal, withoutHosts };
}

/** The ordinary request: a manual Deploy of build-1 in a resolved your-cluster ref. */
function request(overrides: Partial<AppRenderInputRequest> = {}): AppRenderInputRequest {
    return {
        workId: WORK_ID,
        workSlug: 'helpdesk',
        ref: REF,
        deploymentId: '3f2b1c4d-2222-4b3c-8d4e-5f6071829304',
        buildId: 'build-1',
        isFirstDeploymentOnCluster: true,
        skipPreDeployJobs: false,
        targetSettings: {
            tls: 'cert-manager',
            issuer: 'letsencrypt',
            ingressClass: 'nginx',
            controllerNamespace: 'ingress-nginx',
            networkIsolation: true,
        },
        ...overrides,
    };
}

/** The input of a ready result, asserted to exist. */
function inputOf(result: AppRenderInputResult): AppRenderInput {
    expect(result.status).toBe('ready');
    expect(result.code).toBeNull();
    expect(result.input).toBeTruthy();

    return result.input as AppRenderInput;
}

/** Every warning code, in order. */
function warningCodes(result: AppRenderInputResult): string[] {
    return result.warnings.map((entry) => entry.code);
}

/** The whole input as text — what a leak assertion greps. */
function serialize(input: AppRenderInput): string {
    return JSON.stringify(input);
}

/* -------------------------------------------------------------------------- *
 * The ordinary path first — a suite of refusals cannot show that green
 * -------------------------------------------------------------------------- */

describe('AppRenderInputBuilder — the ordinary green path (§5.6 step 2)', () => {
    it('builds the §3 input from the Build, the spec at its commit and the ports', async () => {
        const { builder, specs, pull } = makeHarness();

        const result = await builder.build(request());
        const input = inputOf(result);

        expect(result.warnings).toEqual([]);
        expect(input.ref).toEqual(REF);
        expect(input.purpose).toBe('deploy');
        expect(input.workSlug).toBe('helpdesk');
        expect(input.deploymentId).toBe('3f2b1c4d-2222-4b3c-8d4e-5f6071829304');
        expect(input.deploymentShort).toBe('3f2b1c4d');
        expect(input.specCommitSha).toBe('sha-b1');
        expect(input.isFirstDeploymentOnCluster).toBe(true);
        expect(input.skipPreDeployJobs).toBe(false);
        expect(input.image.reference).toBe(`ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`);
        expect(input.hosts).toEqual({
            primary: 'helpdesk.example.com',
            extra: ['alt.example.com'],
            previous: [],
        });
        expect(input.ingress).toEqual({
            className: 'nginx',
            controllerNamespace: 'ingress-nginx',
            tls: 'cert-manager',
            issuer: 'letsencrypt',
        });
        expect(input.network).toEqual({ isolation: true, extraEgress: [], needsHairpin: false });
        expect(input.policy.podSecurity).toBe('baseline');
        expect(input.policy.quota).toBeNull();
        expect(input.policy.limitRange.max).toEqual({ cpu: '8', memory: '64Gi' });

        // The spec is read at the Build's commit, never at the last applied one (ACC-06-20).
        expect(specs.reads).toEqual([{ workId: WORK_ID, commitSha: 'sha-b1' }]);
        expect(specs.latestAppliedSha).toBe('sha-applied');
        expect(pull.calls).toEqual([{ workId: WORK_ID, buildId: 'build-1' }]);
    });

    it('resolves the components of §3.1 — defaults, primary, deadlineSeconds and internalUrl', async () => {
        const harness = makeHarness();
        const spec = appSpec({
            domains: { primaryComponent: 'web' },
            components: [
                { name: 'web', role: 'web', port: 3000, runAsUser: 1001 },
                { name: 'worker', role: 'worker', replicas: 2 },
            ],
        });
        harness.specs.snapshot = { status: 'valid', spec, commitSha: 'sha-b1' };

        const input = inputOf(await harness.builder.build(request()));

        expect(input.components).toEqual([
            {
                name: 'web',
                role: 'web',
                port: 3000,
                replicas: 1,
                writableRootFilesystem: false,
                runAsUser: 1001,
                probes: {},
                resources: { cpu: '250m', memory: '512Mi', memoryLimit: '1024Mi' },
                volumes: [],
                primary: true,
                // §5.3 with §4.5's web probes: 10 × 60 + 10 × 3 + 120.
                deadlineSeconds: 750,
                internalUrl: `http://web.${LIVE_NAMESPACE}.svc.cluster.local`,
            },
            {
                name: 'worker',
                role: 'worker',
                replicas: 2,
                writableRootFilesystem: false,
                probes: {},
                resources: { cpu: '250m', memory: '512Mi', memoryLimit: '1024Mi' },
                volumes: [],
                primary: false,
                // A worker declares no probe by default, so only §5.3's `+ 120`, clamped to 300.
                deadlineSeconds: 300,
                internalUrl: `http://worker.${LIVE_NAMESPACE}.svc.cluster.local`,
            },
        ]);

        // Nothing was invented and nothing was mutated on the caller's spec.
        expect(spec.components?.[0]?.replicas).toBeUndefined();
    });

    it('resolves a declared probe from the schema defaults and clamps the deadline', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                components: [
                    {
                        name: 'web',
                        role: 'web',
                        port: 3000,
                        probes: {
                            startup: { tcp: true },
                            readiness: { http: '/ready', periodSeconds: 30 },
                        },
                    },
                ],
            }),
            commitSha: 'sha-b1',
        };

        const input = inputOf(await harness.builder.build(request()));

        expect(input.components[0].probes).toEqual({
            startup: {
                tcp: true,
                periodSeconds: 10,
                timeoutSeconds: 5,
                initialDelaySeconds: 0,
                // APW-03 schema §10's documented default for a **declared** startup probe.
                failureThreshold: 30,
            },
            readiness: {
                http: '/ready',
                periodSeconds: 30,
                timeoutSeconds: 5,
                initialDelaySeconds: 0,
                failureThreshold: 3,
            },
        });
        // 10 × 30 + 30 × 3 + 120 = 510.
        expect(input.components[0].deadlineSeconds).toBe(510);
    });

    it('resolves the jobs, cron and smoke of §3.1 against domains.primaryComponent', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec({
                components: [
                    { name: 'api', role: 'web', port: 8080 },
                    { name: 'admin', role: 'web', port: 8081 },
                ],
                domains: { primaryComponent: 'api', needsHairpin: true },
                jobs: [
                    { name: 'migrate', when: 'pre-deploy', command: ['node', 'migrate.js'] },
                    {
                        name: 'seed',
                        when: 'first-deploy',
                        component: 'admin',
                        http: { path: '/seed', body: { password: '{{env.ADMIN_PASSWORD}}' } },
                    },
                ],
                cron: [{ name: 'sync', schedule: '*/5 * * * *', http: { path: '/sync' } }],
                smoke: [{ name: 'health', http: { path: '/health' } }],
            }),
            commitSha: 'sha-b1',
        };

        const input = inputOf(await harness.builder.build(request()));

        expect(input.components.map((component) => component.primary)).toEqual([true, false]);
        expect(input.jobs).toEqual([
            {
                name: 'migrate',
                when: 'pre-deploy',
                component: 'api',
                command: ['node', 'migrate.js'],
            },
            {
                name: 'seed',
                when: 'first-deploy',
                component: 'admin',
                http: { path: '/seed', body: { password: '{{env.ADMIN_PASSWORD}}' } },
            },
        ]);
        expect(input.cron).toEqual([
            { name: 'sync', schedule: '*/5 * * * *', component: 'api', http: { path: '/sync' } },
        ]);
        expect(input.smoke).toEqual([
            { name: 'health', component: 'api', http: { path: '/health' } },
        ]);
        // §4.11: FR-37's hairpin check is the spec's own declaration.
        expect(input.network.needsHairpin).toBe(true);
    });

    it('is deterministic: the same request twice yields deeply equal inputs', async () => {
        const first = inputOf(await makeHarness().builder.build(request()));
        const second = inputOf(await makeHarness().builder.build(request()));

        expect(second).toEqual(first);
    });

    it('passes the deployment id short form through when the caller already has one', async () => {
        const input = inputOf(
            await makeHarness().builder.build(request({ deploymentShort: '5e6f7a8b' })),
        );

        expect(input.deploymentShort).toBe('5e6f7a8b');
    });
});

/* -------------------------------------------------------------------------- *
 * ACC-06-16 — the credential and the secrets
 * -------------------------------------------------------------------------- */

describe('ACC-06-16 — the pull credential is the port’s, and no platform secret is added', () => {
    it('sets image.pull to exactly the port’s credential and nothing else', async () => {
        const { builder, pull } = makeHarness();

        const input = inputOf(await builder.build(request()));

        expect(pull.calls).toHaveLength(1);
        expect(input.image.pull).toEqual({
            server: 'ghcr.io',
            username: 'evereq',
            password: 'pull-credential-SENTINEL',
        });
        expect(Object.keys(input.image.pull ?? {}).sort()).toEqual([
            'password',
            'server',
            'username',
        ]);
    });

    it('omits image.pull when the port answers null — never an invented credential', async () => {
        const harness = makeHarness();
        harness.pull.credential = null;

        const input = inputOf(await harness.builder.build(request()));

        expect(harness.pull.calls).toHaveLength(1);
        expect(input.image.pull).toBeUndefined();
        expect(Object.keys(input.image).sort()).toEqual(['reference']);
    });

    it('never adds an env key the env source did not return', async () => {
        const { builder, env } = makeHarness();

        const input = inputOf(await builder.build(request()));

        expect(env.calls).toHaveLength(1);
        expect(Object.keys(input.env.values).sort()).toEqual(['DATABASE_URL', 'DISABLE_TELEMETRY']);
        expect(input.env.values).toEqual(env.result.values);
        expect(input.env.secretNames).toEqual(['DATABASE_URL']);
        // The checksum is the renderer's to derive over both maps (§4.7), so it is never guessed here.
        expect(input.env.checksum).toBe('');
    });

    it('carries no GH_TOKEN, PLATFORM_API_SECRET_TOKEN, PLATFORM_SYNC_SECRET or Git token anywhere', async () => {
        const { builder, env } = makeHarness();
        // A hostile-looking answer is **not** injected: the point is that nothing outside the port
        // could add one. The port's own answer is the only env input the builder has.
        env.result.values = { DATABASE_URL: 'postgres://example', EXTRA_KEY: 'x' };

        const input = inputOf(await builder.build(request()));
        const serialized = serialize(input);

        for (const name of FORBIDDEN_ENV_NAMES) {
            expect(serialized).not.toContain(name);
        }

        expect(serialized).not.toContain(GIT_TOKEN_SENTINEL);
        expect(serialized).not.toContain('gho_');
        expect(serialized).not.toContain('PLATFORM_');
    });
});

/* -------------------------------------------------------------------------- *
 * ACC-06-20 — one Build, one commit
 * -------------------------------------------------------------------------- */

describe('ACC-06-20 — image and App spec come from the same Build', () => {
    it('takes image, spec commit and the spec read from the named Build alone', async () => {
        const harness = makeHarness();
        harness.builds.byId = {
            'build-1': greenBuild({
                id: 'build-1',
                commitSha: 'sha-b1',
                imageReference: `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`,
            }),
            'build-2': greenBuild({
                id: 'build-2',
                commitSha: 'sha-b2',
                imageReference: `ghcr.io/ever-works/helpdesk@sha256:${'b'.repeat(64)}`,
            }),
        };
        harness.specs.snapshot = { status: 'valid', spec: appSpec(), commitSha: 'sha-b2' };

        const input = inputOf(await harness.builder.build(request({ buildId: 'build-2' })));

        expect(harness.builds.getCalls).toEqual([{ workId: WORK_ID, buildId: 'build-2' }]);
        expect(input.specCommitSha).toBe('sha-b2');
        expect(input.image.reference).toBe(`ghcr.io/ever-works/helpdesk@sha256:${'b'.repeat(64)}`);
        expect(harness.specs.reads).toEqual([{ workId: WORK_ID, commitSha: 'sha-b2' }]);
    });

    it('reads the spec at the Build’s commit even when the head moved on', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = { status: 'valid', spec: appSpec(), commitSha: 'sha-b1' };
        harness.specs.latestAppliedSha = 'sha-head-newer';

        await harness.builder.build(request());

        expect(harness.specs.reads[0].commitSha).toBe('sha-b1');
        expect(harness.specs.reads[0].commitSha).not.toBe(harness.specs.latestAppliedSha);
    });
});

/* -------------------------------------------------------------------------- *
 * APW06-G08 — the target reaches the env source
 * -------------------------------------------------------------------------- */

describe('APW06-G08 — target, buildCommitSha and internalUrls reach AppRuntimeEnvSource', () => {
    it('passes the target verbatim for every value of AppDeployTarget', async () => {
        for (const target of ['none', 'your-cluster', 'ever-works-apps'] as const) {
            const harness = makeHarness();
            const ref: AppTargetRef = { ...REF, target };

            const result = await harness.builder.build(request({ ref }));
            const input = inputOf(result);

            expect(harness.env.calls).toHaveLength(1);
            expect(harness.env.calls[0].ctx.target).toBe(target);
            expect(input.ref.target).toBe(target);
        }
    });

    it('passes the spec commit, the primary URL/host and every internalUrl', async () => {
        const { builder, env } = makeHarness();

        await builder.build(request());
        const ctx = env.calls[0].ctx;

        expect(env.calls[0].specCommitSha).toBe('sha-b1');
        expect(ctx.buildCommitSha).toBe('sha-b1');
        expect(ctx.primaryHost).toBe('helpdesk.example.com');
        expect(ctx.primaryUrl).toBe('https://helpdesk.example.com');
        expect(ctx.internalUrls).toEqual({
            web: `http://web.${LIVE_NAMESPACE}.svc.cluster.local`,
            worker: `http://worker.${LIVE_NAMESPACE}.svc.cluster.local`,
        });
    });

    it('derives an http primary URL when the owner chose no TLS', async () => {
        const { builder, env } = makeHarness();

        await builder.build(request({ targetSettings: { tls: 'none' } }));

        expect(env.calls[0].ctx.primaryUrl).toBe('http://helpdesk.example.com');
    });

    it('prefers T26’s own URL scheme when the host seam provides one', async () => {
        const harness = makeHarness();
        harness.hosts.hosts = {
            primary: 'helpdesk.example.com',
            extra: [],
            previous: [],
            // §4.11: `external` + a managed subdomain is http, which only T26 can decide.
            primaryUrl: 'http://helpdesk.example.com',
        };

        await harness.builder.build(request({ targetSettings: { tls: 'external' } }));

        expect(harness.env.calls[0].ctx.primaryUrl).toBe('http://helpdesk.example.com');
    });

    it('forwards a preview and reports the env gaps APW-07 names', async () => {
        const harness = makeHarness();
        harness.env.result.unsetRequired = ['ADMIN_EMAIL'];
        harness.env.result.notReadyDependencies = ['postgres'];

        const result = await harness.builder.build(request({ preview: { prNumber: 52 } }));
        const input = inputOf(result);

        expect(harness.env.calls[0].ctx.preview).toEqual({ prNumber: 52 });
        expect(input.preview).toEqual({ prNumber: 52 });
        expect(warningCodes(result)).toEqual(['env_required_unset', 'dependency_not_ready']);
    });
});

/* -------------------------------------------------------------------------- *
 * ACC-06-52 — `build.strategy: image`
 * -------------------------------------------------------------------------- */

describe('ACC-06-52 — a published-image Deployment has no Build', () => {
    it('takes the image from the spec at specCommitSha and never calls the pull credential', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: imageSpec('ghcr.io/acme/helpdesk:1.2.3'),
            // APW-03's `getEffectiveSpec` answers with the stored spec, whose `commitSha` is the
            // **head** — deliberately different from the commit asked for, so the input's
            // `specCommitSha` can only be the one the spec was read at (ACC-06-20/-52).
            commitSha: 'sha-head',
        };
        // A green Build of another commit exists and must not be borrowed by this Deployment.
        harness.builds.byId = { 'build-1': greenBuild({ commitSha: 'sha-b1' }) };

        const result = await harness.builder.build(
            request({ buildId: null, specCommitSha: 'sha-spec' }),
        );
        const input = inputOf(result);

        expect(result.warnings).toEqual([]);
        // The spec's own reference, from the spec at the requested commit.
        expect(input.image.reference).toBe('ghcr.io/acme/helpdesk:1.2.3');
        expect(harness.specs.reads).toEqual([{ workId: WORK_ID, commitSha: 'sha-spec' }]);
        expect(input.specCommitSha).toBe('sha-spec');
        // §5.8: no Build is read at all, and no pull credential is resolved.
        expect(harness.builds.getCalls).toEqual([]);
        expect(harness.pull.calls).toEqual([]);
        expect(input.image.pull).toBeUndefined();
        // §5.8: "the env-source context carries buildCommitSha: null".
        expect(harness.env.calls[0].ctx.buildCommitSha).toBeNull();
    });

    it('records the journal of the image path exactly — no Build and no credential', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: imageSpec(),
            commitSha: 'sha-head',
        };

        await harness.builder.build(request({ buildId: null, specCommitSha: 'sha-spec' }));

        expect(harness.journal).toEqual([
            'specs.getEffectiveSpec:sha-spec',
            'hosts.resolveHosts',
            'env.resolve',
        ]);
    });

    it('pins the spec’s own reference to the digest T72 recorded', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: imageSpec('ghcr.io/acme/helpdesk:1.2.3'),
            commitSha: 'sha-spec',
        };

        const input = inputOf(
            await harness.builder.build(
                request({
                    buildId: null,
                    specCommitSha: 'sha-spec',
                    imageDigest: `sha256:${'c'.repeat(64)}`,
                }),
            ),
        );

        expect(input.image.reference).toBe(`ghcr.io/acme/helpdesk@sha256:${'c'.repeat(64)}`);
    });

    it('never mistakes a registry port for a tag when it pins a digest', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: imageSpec('registry.internal:5000/acme/helpdesk:1.2.3'),
            commitSha: 'sha-spec',
        };

        const input = inputOf(
            await harness.builder.build(
                request({ buildId: null, specCommitSha: 'sha-spec', imageDigest: 'sha256:abc' }),
            ),
        );

        expect(input.image.reference).toBe('registry.internal:5000/acme/helpdesk@sha256:abc');
    });

    it('refuses a request that names a Build for a published-image App spec', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = { status: 'valid', spec: imageSpec(), commitSha: 'sha-b1' };

        const result = await harness.builder.build(request({ buildId: 'build-1' }));

        expect(result.status).toBe('unavailable');
        expect(result.code).toBe('build_not_applicable');
        expect(harness.pull.calls).toEqual([]);
    });

    it('refuses when the published-image spec declares no build.image', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec({ build: { strategy: 'image' } }),
            commitSha: 'sha-spec',
        };

        const result = await harness.builder.build(
            request({ buildId: null, specCommitSha: 'sha-spec' }),
        );

        expect(result.code).toBe('build_image_missing');
        expect(harness.pull.calls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * §4.10 — dependency egress resolved to /32 and /128
 * -------------------------------------------------------------------------- */

describe('§4.10 — dependency egress becomes exact CIDRs', () => {
    it('resolves hosting to /32 and /128 CIDRs with their ports', async () => {
        const harness = makeHarness();
        harness.builder.addresses = {
            'smtp.example.com': ['203.0.113.9', '2001:db8::5'],
        };
        harness.env.result.egress = [{ host: 'smtp.example.com', ports: [587, 465] }];

        const result = await harness.builder.build(request());
        const input = inputOf(result);

        expect(input.network.extraEgress).toEqual([
            { cidr: '203.0.113.9/32', ports: [587, 465] },
            { cidr: '2001:db8::5/128', ports: [587, 465] },
        ]);
        expect(result.warnings).toEqual([]);
        expect(harness.builder.resolved).toEqual(['smtp.example.com']);
    });

    it('passes a literal address through without asking a resolver', async () => {
        const harness = makeHarness();
        harness.env.result.egress = [{ host: '198.51.100.7', ports: [443] }];

        const input = inputOf(await harness.builder.build(request()));

        expect(input.network.extraEgress).toEqual([{ cidr: '198.51.100.7/32', ports: [443] }]);
        expect(harness.builder.resolved).toEqual([]);
    });

    it('deduplicates an address that two dependency entries resolve to', async () => {
        const harness = makeHarness();
        harness.builder.addresses = {
            'a.example.com': ['203.0.113.9'],
            'b.example.com': ['203.0.113.9'],
        };
        harness.env.result.egress = [
            { host: 'a.example.com', ports: [5432] },
            { host: 'b.example.com', ports: [5432] },
        ];

        const input = inputOf(await harness.builder.build(request()));

        expect(input.network.extraEgress).toEqual([{ cidr: '203.0.113.9/32', ports: [5432] }]);
    });

    it('reports an unresolvable host as a warning and opens nothing for it', async () => {
        const harness = makeHarness();
        harness.builder.addresses = { 'ok.example.com': ['203.0.113.9'] };
        harness.env.result.egress = [
            { host: 'missing.example.com', ports: [5432] },
            { host: 'ok.example.com', ports: [5432] },
        ];

        const result = await harness.builder.build(request());
        const input = inputOf(result);

        expect(warningCodes(result)).toEqual([APP_RENDER_WARNING_EGRESS_UNRESOLVED]);
        expect(input.network.extraEgress).toEqual([{ cidr: '203.0.113.9/32', ports: [5432] }]);
    });
});

/* -------------------------------------------------------------------------- *
 * Hosts — T26's seam, present and absent
 * -------------------------------------------------------------------------- */

describe('hosts (§8.1) — the T26 seam answers what it can, and says so', () => {
    it('falls back to the primary host and warns when the seam has no host set yet', async () => {
        const harness = makeHarness();
        const builder = new AppRenderInputBuilder(
            harness.specs,
            harness.builds,
            harness.env,
            harness.pull,
            { primaryHost: async () => 'only.example.com' },
            harness.tier,
        );

        const result = await builder.build(request());
        const input = inputOf(result);

        expect(input.hosts).toEqual({ primary: 'only.example.com', extra: [], previous: [] });
        expect(warningCodes(result)).toEqual([APP_RENDER_WARNING_HOSTS_INCOMPLETE]);
        expect(harness.env.calls[0].ctx.primaryHost).toBe('only.example.com');
    });

    it('publishes no host and warns when no host source is bound', async () => {
        const harness = makeHarness();

        const result = await harness.withoutHosts.build(request());
        const input = inputOf(result);

        expect(input.hosts).toEqual({ primary: null, extra: [], previous: [] });
        expect(warningCodes(result)).toEqual([APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE]);
        expect(harness.env.calls[0].ctx.primaryUrl).toBeNull();
        expect(harness.env.calls[0].ctx.primaryHost).toBeNull();
    });

    it('never refuses a Deployment because the host read failed', async () => {
        const harness = makeHarness();
        harness.hosts.failsWith = new Error('dns exploded');

        const result = await harness.builder.build(request());

        expect(result.status).toBe('ready');
        expect(inputOf(result).hosts.primary).toBeNull();
        expect(warningCodes(result)).toEqual([APP_RENDER_WARNING_HOST_SOURCE_UNAVAILABLE]);
    });
});

/* -------------------------------------------------------------------------- *
 * Policy per target (§4.2, §4.4, §4.5, §5.6 step 2)
 * -------------------------------------------------------------------------- */

describe('policy — AppsTierPolicy for ever-works-apps, the your-cluster defaults otherwise', () => {
    it('reads the managed tier’s sandbox, quota, limit range and edge ingress', async () => {
        const harness = makeHarness();
        const ref: AppTargetRef = { ...REF, target: 'ever-works-apps' };

        const input = inputOf(await harness.builder.build(request({ ref })));

        expect(input.policy).toEqual({
            podSecurity: 'restricted',
            allowRoot: false,
            runtimeClassName: 'gvisor',
            quota: harness.tier.quota,
            limitRange: harness.tier.limitRange,
            cronMinIntervalMinutes: 5,
            scaleFailedFirstDeployToZero: true,
            requireIsolationEnforced: true,
        });
        expect(input.ingress).toEqual({
            className: 'nginx',
            controllerNamespace: 'ingress-nginx',
            tls: 'edge',
            issuer: null,
        });
        expect(input.network.isolation).toBe(true);
        expect(harness.journal).toContain('tier.podPolicy');
    });

    it('refuses a managed Deployment while the tier is closed', async () => {
        const harness = makeHarness();
        harness.tier.open = false;

        const result = await harness.builder.build(
            request({ ref: { ...REF, target: 'ever-works-apps' } }),
        );

        expect(result.status).toBe('unavailable');
        expect(result.code).toBe('managed_disabled');
        expect(harness.env.calls).toEqual([]);
    });

    it('refuses a managed Deployment with no sandbox runtime class (R-24)', async () => {
        const harness = makeHarness();
        harness.tier.runtimeClassName = null;

        const result = await harness.builder.build(
            request({ ref: { ...REF, target: 'ever-works-apps' } }),
        );

        expect(result.code).toBe('managed_sandbox_unavailable');
        expect(harness.env.calls).toEqual([]);
    });

    it('uses the your-cluster defaults, including the owner’s allowRoot choice', async () => {
        const harness = makeHarness();

        const result = await harness.builder.build(
            request({
                targetSettings: { tls: 'external', allowRoot: true, networkIsolation: false },
            }),
        );
        const input = inputOf(result);

        expect(input.policy.podSecurity).toBe('baseline');
        expect(input.policy.allowRoot).toBe(true);
        expect(input.policy.runtimeClassName).toBeNull();
        expect(input.policy.quota).toBeNull();
        expect(input.policy.requireIsolationEnforced).toBe(false);
        expect(input.policy.limitRange).toEqual({
            defaultRequest: { cpu: '100m', memory: '128Mi' },
            defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
            max: { cpu: '8', memory: '64Gi' },
        });
        expect(input.ingress.tls).toBe('external');
        expect(input.network.isolation).toBe(false);
    });

    it('takes the ingress class and controller namespace the cluster check observed', async () => {
        const harness = makeHarness();

        const input = inputOf(
            await harness.builder.build(
                request({
                    targetSettings: { tls: 'cert-manager' },
                    clusterCheck: {
                        controllerNamespace: 'ingress-nginx',
                        ingressClasses: [
                            { name: 'traefik', isDefault: false },
                            { name: 'nginx', isDefault: true },
                        ],
                    },
                }),
            ),
        );

        expect(input.ingress.className).toBe('nginx');
        expect(input.ingress.controllerNamespace).toBe('ingress-nginx');
    });
});

/* -------------------------------------------------------------------------- *
 * Refusals — one per platform state §5.1/§5.8 names
 * -------------------------------------------------------------------------- */

describe('refusals — a named code, never an exception', () => {
    it('refuses a request with no resolved target', async () => {
        const result = await makeHarness().builder.build(request({ ref: null as never }));

        expect(result.status).toBe('unavailable');
        expect(result.code).toBe('target_not_checked');
        expect(result.input).toBeNull();
    });

    it('refuses strategy none with nothing_to_deploy', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec({ build: { strategy: 'none' }, components: [] }),
            commitSha: 'sha-b1',
        };

        const result = await harness.builder.build(request());

        expect(result.code).toBe('nothing_to_deploy');
        expect(harness.env.calls).toEqual([]);
    });

    it('refuses a dockerfile Deployment that names no Build', async () => {
        const result = await makeHarness().builder.build(request({ buildId: null }));

        expect(result.code).toBe('no_green_build');
    });

    it('refuses a Build that is not green', async () => {
        const harness = makeHarness();
        harness.builds.byId = { 'build-1': greenBuild({ status: 'failed' }) };

        const result = await harness.builder.build(request());

        expect(result.code).toBe('no_green_build');
        expect(result.reason).toContain('failed');
    });

    it('refuses a Build this Work does not have', async () => {
        const result = await makeHarness().builder.build(request({ buildId: 'build-other' }));

        expect(result.code).toBe('no_green_build');
        expect(result.reason).toContain('does not belong');
    });

    it('refuses a green Build with no image reference', async () => {
        const harness = makeHarness();
        harness.builds.byId = { 'build-1': greenBuild({ imageReference: null }) };

        const result = await harness.builder.build(request());

        expect(result.code).toBe('build_image_missing');
    });

    it('refuses an invalid App spec at the Build’s commit', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = { status: 'invalid', spec: appSpec(), commitSha: 'sha-b1' };

        const result = await harness.builder.build(request());

        expect(result.code).toBe('spec_invalid');
        expect(result.reason).toContain('sha-b1');
    });

    // The same read the preconditions make: `getEffectiveSpec` answers `valid_with_warnings`
    // for a Build of an earlier or superseded commit, and APW-03 calls that usable. A Build
    // the preconditions let through must not be refused here as `spec_invalid`.
    it('builds from a valid_with_warnings spec at the Build’s commit (APP_SPEC_USABLE_STATUSES)', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid_with_warnings',
            spec: appSpec(),
            commitSha: 'sha-b1',
            issues: [{ code: 'unknown_key', path: 'extra' }],
        };

        const input = inputOf(await harness.builder.build(request()));

        expect(input.specCommitSha).toBe('sha-b1');
        expect(harness.specs.reads).toEqual([{ workId: WORK_ID, commitSha: 'sha-b1' }]);
    });

    it.each(['invalid', 'missing', 'unreadable', 'no_state'])(
        'still refuses a spec whose status is %s',
        async (status) => {
            const harness = makeHarness();
            harness.specs.snapshot = { status, spec: appSpec(), commitSha: 'sha-b1' };

            const result = await harness.builder.build(request());

            expect(result.status).toBe('unavailable');
            expect(result.code).toBe('spec_invalid');
            expect(result.reason).toContain(status);
            expect(result.input).toBeNull();
        },
    );

    it('accepts exactly APW-03’s usable statuses, of all six getEffectiveSpec can answer', async () => {
        const answered = [...APP_SPEC_VALIDATION_STATUSES, 'no_state'];
        const accepted: string[] = [];

        for (const status of answered) {
            const harness = makeHarness();
            harness.specs.snapshot = { status, spec: appSpec(), commitSha: 'sha-b1' };

            const result = await harness.builder.build(request());

            if (result.code !== 'spec_invalid') accepted.push(status);
        }

        expect(answered).toHaveLength(6);
        expect(accepted).toEqual([...APP_SPEC_USABLE_STATUSES]);
    });

    it('refuses when the spec cannot be read at all', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = null;

        const result = await harness.builder.build(request());

        expect(result.code).toBe('spec_unavailable');
    });

    it('refuses when no spec source is bound', async () => {
        const journal: string[] = [];
        const result = await new AppRenderInputBuilder(
            undefined,
            new FakeBuilds(journal),
            new FakeEnv(journal),
        ).build(request());

        expect(result.code).toBe('spec_unavailable');
    });

    it('refuses when the env source is unbound or throws', async () => {
        const journal: string[] = [];
        const unbound = await new AppRenderInputBuilder(
            new FakeSpecs(journal),
            new FakeBuilds(journal),
            undefined,
            new FakePull(journal),
        ).build(request());

        expect(unbound.code).toBe('env_source_unavailable');

        const harness = makeHarness();
        harness.env.failsWith = new Error('sealed store unreachable');
        const thrown = await harness.builder.build(request());

        expect(thrown.code).toBe('env_source_unavailable');
        expect(thrown.reason).toBe('sealed store unreachable');
    });

    it('refuses when the pull credential is unbound or throws', async () => {
        const harness = makeHarness();
        const unbound = await new AppRenderInputBuilder(
            harness.specs,
            harness.builds,
            harness.env,
            undefined,
        ).build(request());

        expect(unbound.code).toBe('pull_credential_unavailable');

        harness.pull.failsWith = new Error('registry credential unavailable');
        const thrown = await harness.builder.build(request());

        expect(thrown.code).toBe('pull_credential_unavailable');
    });
});

/* -------------------------------------------------------------------------- *
 * T60's seam — the verification spec, without the ephemeral env
 * -------------------------------------------------------------------------- */

describe('readVerificationSpec (§4.12, R-10) — the spec side T60 consumes', () => {
    const verificationRequest = (
        overrides: Partial<AppVerificationSpecRequest> = {},
    ): AppVerificationSpecRequest =>
        ({
            workId: WORK_ID,
            namespace: `${LIVE_NAMESPACE}-v4f3a2b-1`,
            provisioningId: '4f3a2b90-1111-4222-8333-444444444444',
            attempt: 1,
            specCommitSha: 'sha-b1',
            buildId: 'build-1',
            imageDigest: null,
            ttlMinutes: 90,
            ...overrides,
        }) as AppVerificationSpecRequest;

    it('returns the input without env, plus the declared dependency kinds', async () => {
        const harness = makeHarness();
        const namespace = `${LIVE_NAMESPACE}-v4f3a2b-1`;
        harness.specs.snapshot = {
            status: 'valid',
            spec: appSpec({ dependencies: { postgres: { version: '16' }, redis: {} } }),
            commitSha: 'sha-b1',
        };

        const spec = await harness.builder.readVerificationSpec(verificationRequest());

        expect(spec).toBeTruthy();
        expect(spec?.dependencyKinds).toEqual(['postgres', 'redis']);
        expect((spec?.input as Record<string, unknown>).env).toBeUndefined();
        expect(spec?.input.purpose).toBe('verification');
        expect(spec?.input.ttlMinutes).toBe(90);
        expect(spec?.input.ref).toEqual({ workId: WORK_ID, namespace, target: 'your-cluster' });
        // §4.12: no Ingress, no TLS, no published host.
        expect(spec?.input.hosts).toEqual({ primary: null, extra: [], previous: [] });
        expect(spec?.input.ingress).toEqual({
            className: null,
            controllerNamespace: null,
            tls: 'none',
            issuer: null,
        });
        expect(spec?.input.specCommitSha).toBe('sha-b1');
        expect(spec?.input.image.reference).toBe(
            `ghcr.io/ever-works/helpdesk@sha256:${'a'.repeat(64)}`,
        );
        expect(spec?.input.components[0].internalUrl).toBe(
            `http://web.${namespace}.svc.cluster.local`,
        );
        // R-10: the **stored** env path is never used — T60 resolves the ephemeral env instead, and
        // T26's live host set is never read for a throwaway namespace.
        expect(harness.env.calls).toEqual([]);
        expect(harness.hosts.calls).toEqual([]);
        expect(spec?.input.network.extraEgress).toEqual([]);
        expect(harness.journal).toEqual([
            'builds.getBuild:build-1',
            'specs.getEffectiveSpec:sha-b1',
            'pull.resolve',
        ]);
    });

    it('derives the slug from §4.1’s namespace shape when the request carries none', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = { status: 'valid', spec: appSpec(), commitSha: 'sha-b1' };

        const spec = await harness.builder.readVerificationSpec(
            verificationRequest({ namespace: LIVE_NAMESPACE }),
        );

        expect(spec?.input.workSlug).toBe('helpdesk');
        // The §4.12 namespace (`<ns>-v<6 hex>-<attempt>`) does not carry the slug, so it is empty
        // rather than invented — which is why T60's request may name one additively.
        const derived = await harness.builder.readVerificationSpec(verificationRequest());

        expect(derived?.input.workSlug).toBe('');
    });

    it('uses a slug the request adds, when it has one', async () => {
        const spec = await makeHarness().builder.readVerificationSpec({
            ...verificationRequest(),
            workSlug: 'helpdesk',
        } as AppVerificationSpecRequest);

        expect(spec?.input.workSlug).toBe('helpdesk');
    });

    it('never calls the pull credential for a published-image verification (ACC-06-52)', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = {
            status: 'valid',
            spec: imageSpec('ghcr.io/acme/helpdesk@sha256:' + 'd'.repeat(64)),
            commitSha: 'sha-spec',
        };

        const spec = await harness.builder.readVerificationSpec(
            verificationRequest({ buildId: null, specCommitSha: 'sha-spec' }),
        );

        expect(spec?.input.image.reference).toBe(`ghcr.io/acme/helpdesk@sha256:${'d'.repeat(64)}`);
        expect(harness.pull.calls).toEqual([]);
        // No stored env resolution at all, so no `buildCommitSha` is asked for either.
        expect(harness.env.calls).toEqual([]);
    });

    it('answers undefined — never a half-built input — when the spec cannot be read', async () => {
        const harness = makeHarness();
        harness.specs.snapshot = null;

        expect(await harness.builder.readVerificationSpec(verificationRequest())).toBeUndefined();
    });

    it('answers undefined without reading anything when the request is not a verification', async () => {
        const harness = makeHarness();

        expect(
            await harness.builder.readVerificationSpec(verificationRequest({ ttlMinutes: null })),
        ).toBeUndefined();
        expect(harness.journal).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * The Done-when: no dependency on apps/api (T22)
 * -------------------------------------------------------------------------- */

describe('the builder cannot reach the website deploy path’s credential assemblers', () => {
    const source = path.resolve(__dirname, '..', 'app-render-input.builder.ts');

    /**
     * The file's **code**, with its comments removed.
     *
     * The doc header *quotes* plan §1.2:68-70 — which names both assemblers, to state that neither
     * may be called — so a scan over the raw text could never be the assertion. What must hold is
     * that no line of **code** (an import, a member access, a call) can reach them, and that is what
     * the stripped body is asked. The control below proves the stripper leaves code intact.
     */
    function codeOf(content: string): string {
        return content
            .replace(/\/\*[\s\S]*?\*\//g, '')
            .split('\n')
            .map((line) => line.replace(/(^|[^:])\/\/.*$/, '$1'))
            .join('\n');
    }

    it('has no code path to collectServerSideRuntimeEnv, resolveGhcrReadToken or apps/api', () => {
        const code = codeOf(fs.readFileSync(source, 'utf8'));

        // Known-good control: the scan reads real code, so a zero below is not a broken stripper.
        expect(code).toContain('AppImagePullCredentialSource');
        expect(code).toContain('resolveEgress');
        expect(code).toContain('AppRuntimeEnvSource');

        expect(code).not.toContain('collectServerSideRuntimeEnv');
        expect(code).not.toContain('resolveGhcrReadToken');
        expect(code).not.toContain('DeployService');
        expect(code).not.toContain('apps/api');
    });

    it('imports no module outside packages/agent and the contract packages (the Done-when)', () => {
        const code = codeOf(fs.readFileSync(source, 'utf8'));
        const specifiers = [...code.matchAll(/from '([^']+)'/g)].map((match) => match[1]);
        const allowed = ['.', '@ever-works/', 'node:', '@nestjs/'];

        // Known-good control: the import list is really being read.
        expect(specifiers).toContain('@ever-works/plugin');
        expect(specifiers).toContain('./ports.js');

        for (const specifier of specifiers) {
            expect(allowed.some((prefix) => specifier.startsWith(prefix))).toBe(true);
        }

        // No path out of the package, and never the k8s plugin (plan §6.1:933).
        expect(specifiers.some((specifier) => specifier.includes('apps/'))).toBe(false);
        expect(specifiers.some((specifier) => specifier.includes('k8s'))).toBe(false);
        expect(specifiers.some((specifier) => specifier.includes('..'))).toBe(false);
    });

    it('asks exactly its five collaborators, and nothing else — the call journal', async () => {
        const harness = makeHarness();

        await harness.builder.build(request());

        expect(harness.journal).toEqual([
            'builds.getBuild:build-1',
            'specs.getEffectiveSpec:sha-b1',
            'pull.resolve',
            'hosts.resolveHosts',
            'env.resolve',
        ]);
    });
});

/* -------------------------------------------------------------------------- *
 * The published constants the renderer and T26 read
 * -------------------------------------------------------------------------- */

describe('the constants and pure helpers this file publishes', () => {
    it('pins the web startup default §5.3’s worked example is computed from', () => {
        expect(APP_RENDER_WEB_STARTUP_PROBE).toEqual({ periodSeconds: 10, failureThreshold: 60 });
    });

    it('derives deploymentShort the way the golden harness does', () => {
        expect(deploymentShortFor('3f2b1c4d-2222-4b3c-8d4e-5f6071829304')).toBe('3f2b1c4d');
        expect(deploymentShortFor('')).toBe('');
    });

    it('maps every component’s internalUrl, and none for an unknown namespace', () => {
        expect(internalUrlsFor(appSpec(), LIVE_NAMESPACE)).toEqual({
            web: `http://web.${LIVE_NAMESPACE}.svc.cluster.local`,
            worker: `http://worker.${LIVE_NAMESPACE}.svc.cluster.local`,
        });
        expect(internalUrlsFor(appSpec(), '')).toEqual({});
        expect(internalUrlsFor(null, LIVE_NAMESPACE)).toEqual({});
    });

    it('resolves domains.primaryComponent, else the only web component', () => {
        expect(primaryComponentName(appSpec())).toBe('web');
        expect(primaryComponentName(appSpec({ domains: { primaryComponent: 'worker' } }))).toBe(
            'worker',
        );
        expect(
            primaryComponentName(
                appSpec({
                    components: [
                        { name: 'a', role: 'web', port: 1 },
                        { name: 'b', role: 'web', port: 2 },
                    ],
                }),
            ),
        ).toBeNull();
    });

    it('names the dependency kinds an App spec declares', () => {
        expect(declaredDependencyKinds(appSpec())).toEqual([]);
        expect(
            declaredDependencyKinds(
                appSpec({
                    dependencies: { postgres: { version: '16' }, smtp: { required: false } },
                }),
            ),
        ).toEqual(['postgres', 'smtp']);
    });

    it('builds the URL scheme of §4.11 from the TLS mode', () => {
        expect(urlForHost('a.example.com', 'cert-manager')).toBe('https://a.example.com');
        expect(urlForHost('a.example.com', 'none')).toBe('http://a.example.com');
        expect(urlForHost(null, 'cert-manager')).toBeNull();
    });

    it('reverses §4.1’s namespace rule', () => {
        expect(workSlugFromNamespace('ew-helpdesk-0f8e2c1a')).toBe('helpdesk');
        expect(workSlugFromNamespace('ew-helpdesk-0f8e2c1a-v4f3a2b-1')).toBe('');
    });
});
