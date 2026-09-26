/**
 * APW-06 T20 — `AppRuntimeFacadeService`: the ONE place cluster access is assembled (R-5).
 *
 * Every assertion is one line of the contract:
 *
 * - **R-5 / plan §2.1:132-137** — resolution is **by capability**, never by plugin id: for
 *   `your-cluster` the deployment plugin the Work's `deployProvider` names, with
 *   `isAppDeploymentPlugin` and **without** `apps-tier`; for `ever-works-apps` the **enabled**
 *   deployment plugin with `isAppDeploymentPlugin` **and** `apps-tier`, only while
 *   `AppsTierPolicy.isOpen()`.
 * - **plan §5.6 step 3:814-822** — the credential per target: `custom-kubeconfig` Work-scoped
 *   `k8s` settings for `your-cluster`, `AppsTierPolicy.resolveClusterCredential` for
 *   `ever-works-apps`, and never the other way round (ACC-06-49).
 * - **APW06-G02 / plan §6.2:943-949** — the service is constructed in every process that imports
 *   `FacadesModule`, so it cannot refuse at construction; **every method call** throws
 *   `APP_CLUSTER_IO_IN_API` unless `isAppClusterWorkerContext()` is true.
 * - **T58 and T60's seams** (`app-runtime-deletion.service.ts:457-464`,
 *   `app-verification-target.service.ts:523-527`) — this class **is** both, asserted at compile
 *   time (the two `const`s below) and at runtime (a call through each seam).
 *
 * Two things about this file are deliberate and worth knowing before editing it:
 *
 * 1. **The worker flag is process-level**, so the file arms it once in a `beforeAll`, and block A —
 *    whose subject is the UNMARKED process — builds its services inside `jest.isolateModules`, a
 *    private module registry. No assertion therefore depends on the order Jest runs the blocks in.
 * 2. **The registry is the real `PluginRegistryService`**, fed real plugins and real manifests.
 *    Faking it would test the fake's ordering rather than the capability index the facade
 *    actually resolves through, and it could not exercise the lazy-proxy trap at all.
 */

import { EventEmitter2 } from '@nestjs/event-emitter';
import type { PluginManifest, PluginState } from '@ever-works/plugin';
import {
    isAppDeploymentPlugin,
    type AppClusterCheck,
    type AppClusterCheckRequest,
    type AppDeployHooks,
    type AppDeployResult,
    type AppDestroyResult,
    type AppJobResult,
    type AppJobRunRequest,
    type AppLimitRangeInput,
    type AppLogRequest,
    type AppLogTail,
    type AppRenderInput,
    type AppScaleResult,
    type AppSmokeResult,
    type AppStatusSnapshot,
    type AppStatusSpec,
    type AppTargetRef,
    type IDeploymentPlugin,
} from '@ever-works/plugin';

import { AppRuntimeFacadeService } from '../app-runtime.facade';
import {
    APP_CUSTOM_KUBECONFIG_CLUSTER_SOURCE,
    APP_MANAGED_DEPLOY_PROVIDER_ID,
    APP_NAMESPACE_MAX_LENGTH,
    APP_TIER_CAPABILITY,
    appNamespaceName,
    bindAppMember,
    deletionCodeFor,
    verificationCodeFor,
    type AppRuntimeStateTargetStore,
    type AppRuntimeStateTargetView,
} from '../app-runtime.facade';
import { DeployFacadeService } from '../deploy.facade';
import { PLATFORM_MANAGED_KUBECONFIG_SENTINEL } from '../deploy.facade';
import { PluginRegistryService } from '../../plugins/services/plugin-registry.service';
import { APPS_TIER_POLICY, type AppsTierPolicy } from '../../app-runtime/ports';
import {
    AppClusterIoInApiError,
    APP_CLUSTER_IO_IN_API,
    isAppClusterWorkerContext,
    markAppClusterWorkerContext,
} from '../../app-runtime/worker-context';
import type {
    AppRuntimeDeletionAccess,
    AppRuntimeDeletionFacade,
    AppWorkDeletionCode,
} from '../../app-runtime/app-runtime-deletion.service';
import type {
    AppRuntimeVerificationFacade,
    AppVerificationAccess,
    AppVerificationRefusalCode,
} from '../../app-runtime/app-verification-target.service';
import { Work } from '../../entities/work.entity';
import { WorkRepository } from '../../database/repositories/work.repository';

import * as fs from 'node:fs';
import * as path from 'node:path';

/* -------------------------------------------------------------------------- *
 * Fixtures
 * -------------------------------------------------------------------------- */

const WORK_ID = '1a2b3c4d-5e6f-4a8b-9c0d-1e2f3a4b5c6d';
const OTHER_WORK_ID = '9f8e7d6c-5b4a-4938-8271-6f5e4d3c2b1a';
const USER_ID = 'user-1';
const SLUG = 'hello-world';
const NAMESPACE = 'ew-hello-world-1a2b3c4d';
const KUBECONFIG = 'apiVersion: v1\nkind: Config\nclusters: []\n';
const TIER_CREDENTIAL = 'tier-control-namespace-credential';

/** The App members of `IDeploymentPlugin` this task reads, in one list so the fakes agree. */
const APP_MEMBERS = [
    'deployApp',
    'getAppStatus',
    'runAppJob',
    'destroyApp',
    'scaleApp',
    'getAppLogs',
    'checkAppCluster',
    'prepareAppNamespace',
    'publishAppHosts',
] as const;

type AppMember = (typeof APP_MEMBERS)[number];

/* -------------------------------------------------------------------------- *
 * A deployment plugin with a journal, and the manifest that registers it
 * -------------------------------------------------------------------------- */

interface FakePluginInput {
    id: string;
    /** `supportsApps` — absent models a plugin that is not an App deployment provider. */
    supportsApps?: boolean;
    capabilities?: readonly string[];
    /** Members to REMOVE, modelling a plugin that does not implement them. */
    omit?: readonly AppMember[];
    journal?: string[];
}

interface FakePlugin {
    id: string;
    name: string;
    version: string;
    category: 'deployment';
    capabilities: string[];
    settingsSchema: Record<string, never>;
    supportsApps?: boolean;
    onLoad(): Promise<void>;
    onUnload(): Promise<void>;
    calls: string[];
    [member: string]: unknown;
}

/**
 * A plugin whose every App member journals its call and answers a plausible result.
 *
 * `omit` deletes a member **after** the literal was built, which is how a real plugin that never
 * declared `destroyApp` looks from the outside — and the only way to tell the lazy proxy's
 * over-reporting apart from a genuine implementation.
 */
function fakePlugin(input: FakePluginInput): FakePlugin {
    const calls = input.journal ?? [];
    const plugin: FakePlugin = {
        id: input.id,
        name: input.id,
        version: '1.0.0',
        category: 'deployment',
        capabilities: [...(input.capabilities ?? ['deployment'])],
        settingsSchema: {},
        supportsApps: input.supportsApps,
        async onLoad(): Promise<void> {
            calls.push(`${input.id}:onLoad`);
        },
        async onUnload(): Promise<void> {
            calls.push(`${input.id}:onUnload`);
        },
        calls,
        async deployApp(
            _input: AppRenderInput,
            credential: string,
            _hooks: AppDeployHooks,
        ): Promise<AppDeployResult> {
            calls.push(`${input.id}:deployApp:${credential}`);
            return deployResult();
        },
        async getAppStatus(
            _ref: AppTargetRef,
            credential: string,
            _spec: AppStatusSpec,
        ): Promise<AppStatusSnapshot> {
            calls.push(`${input.id}:getAppStatus:${credential}`);
            return {
                observedAt: new Date(0).toISOString(),
                components: [],
                jobs: [],
                cron: [],
                isolationEnforced: null,
            };
        },
        async runAppJob(
            _ref: AppTargetRef,
            credential: string,
            job: AppJobRunRequest,
        ): Promise<AppJobResult> {
            calls.push(`${input.id}:runAppJob:${credential}:${job?.name}`);
            return {
                name: job?.name ?? 'job',
                when: 'post-deploy',
                runName: 'run-1',
                status: 'succeeded',
                startedAt: new Date(0).toISOString(),
            };
        },
        async destroyApp(
            ref: AppTargetRef,
            credential: string,
            opts: { deleteVolumes: boolean },
        ): Promise<AppDestroyResult> {
            calls.push(
                `${input.id}:destroyApp:${credential}:${ref?.namespace}:volumes=${opts?.deleteVolumes}`,
            );
            return {
                deleted: [{ kind: 'Deployment', name: 'web' }],
                kept: [],
                namespaceDeleted: true,
            };
        },
        async scaleApp(
            _ref: AppTargetRef,
            credential: string,
            mode: 'pause' | 'resume',
        ): Promise<AppScaleResult> {
            calls.push(`${input.id}:scaleApp:${credential}:${mode}`);
            return { components: [], smoke: null };
        },
        async getAppLogs(
            _ref: AppTargetRef,
            credential: string,
            _req: AppLogRequest,
        ): Promise<AppLogTail> {
            calls.push(`${input.id}:getAppLogs:${credential}`);
            return { containers: [], redactedNames: [], fetchedAt: new Date(0).toISOString() };
        },
        async checkAppCluster(
            credential: string,
            _req: AppClusterCheckRequest,
        ): Promise<AppClusterCheck> {
            calls.push(`${input.id}:checkAppCluster:${credential}`);
            return {
                ok: true,
                fingerprint: 'fingerprint-1',
                missingPermissions: [],
                optionalMissing: [],
                ingressClasses: [],
                controllerNamespace: null,
                clusterIssuers: [],
                storageClasses: [],
            };
        },
        async prepareAppNamespace(
            ref: AppTargetRef,
            credential: string,
            _opts: { isolation: boolean; limitRange: AppLimitRangeInput },
        ): Promise<{ warnings: Array<{ code: string; message: string }> }> {
            calls.push(`${input.id}:prepareAppNamespace:${credential}:${ref?.namespace}`);
            return { warnings: [] };
        },
        async publishAppHosts(
            ref: AppTargetRef,
            credential: string,
            hosts: { primary: string | null },
        ): Promise<{ ingressAddress: { ip?: string; hostname?: string } | null }> {
            calls.push(`${input.id}:publishAppHosts:${credential}:${hosts?.primary}`);
            return { ingressAddress: null };
        },
    };

    for (const member of input.omit ?? []) {
        delete plugin[member];
    }

    return plugin;
}

function deployResult(): AppDeployResult {
    const smoke: AppSmokeResult = {
        inCluster: [],
        public: [],
        observedAt: new Date(0).toISOString(),
    };
    return {
        outcome: 'succeeded',
        warnings: [],
        components: [],
        jobs: [],
        smoke,
        ingressAddress: null,
        isolationEnforced: null,
        firstDeployJobsCompleted: true,
    };
}

function manifestFor(
    id: string,
    capabilities: readonly string[],
    extra: Partial<PluginManifest> = {},
): PluginManifest {
    return {
        id,
        name: id,
        version: '1.0.0',
        description: `${id} (test)`,
        category: 'deployment',
        capabilities: [...capabilities],
        // Every real deployment plugin is a system plugin, so a work-context scope check answers
        // "enabled" for it (`resolvePluginEnabled`, `plugin-registry.service.ts:42-56`).
        systemPlugin: true,
        ...extra,
    };
}

interface Registration {
    plugin: FakePlugin;
    manifest?: PluginManifest;
    state?: PluginState;
}

function registryWith(registrations: readonly Registration[]): PluginRegistryService {
    const registry = new PluginRegistryService(new EventEmitter2());
    for (const registration of registrations) {
        registry.register(
            registration.plugin as unknown as IDeploymentPlugin,
            registration.manifest ??
                manifestFor(registration.plugin.id, registration.plugin.capabilities),
            { state: registration.state ?? 'loaded' },
        );
    }
    return registry;
}

/* -------------------------------------------------------------------------- *
 * The Work, the deploy facade, the tier policy and the runtime-state row
 * -------------------------------------------------------------------------- */

/**
 * A REAL `Work` entity instance, so `getRepoOwner` is the production method rather than a fake —
 * which is what lets the `validateClusterSourceForOwner` test tell the **data** repository owner
 * apart from the website owner (`work.entity.ts:867-873`).
 */
function appWork(input: {
    id?: string;
    deployProvider?: string | null;
    slug?: string;
    kind?: string;
    dataOwner?: string;
    websiteOwner?: string;
}): Work {
    return Object.assign(new Work(), {
        id: input.id ?? WORK_ID,
        slug: input.slug ?? SLUG,
        kind: input.kind ?? 'app',
        userId: USER_ID,
        owner: input.dataOwner ?? 'acme',
        deployProvider: input.deployProvider === undefined ? 'k8s' : (input.deployProvider ?? null),
        sourceRepository: {
            relatedRepositories: {
                data: { owner: input.dataOwner ?? 'acme', repo: `${SLUG}-data` },
                website: { owner: input.websiteOwner ?? 'acme', repo: `${SLUG}-website` },
                work: { owner: input.dataOwner ?? 'acme', repo: SLUG },
            },
        },
    });
}

interface DeploySettingsInput {
    token?: string | null;
    clusterSource?: string | null;
    kubeContext?: string | null;
    pluginId?: string;
    throws?: Error;
}

/** `DeployFacadeService` as this facade consumes it — two members, journalled. */
class FakeDeployFacade {
    readonly calls: Array<{ workId: string; userId: string }> = [];
    readonly providerIdCalls: string[] = [];

    constructor(private readonly input: DeploySettingsInput = {}) {}

    /**
     * The REAL alias rule, borrowed from the production class rather than restated here
     * (`deploy.facade.ts:128-130`): the facade under test must not be able to pass this test
     * against a fake that spells the alias differently from the code that will run.
     */
    resolveProviderId(providerId: string): string {
        this.providerIdCalls.push(providerId);
        return DeployFacadeService.prototype.resolveProviderId.call(this, providerId);
    }

    async getPluginAndTokenAndSettings(options: { workId: string; userId: string }): Promise<{
        plugin: IDeploymentPlugin;
        token: string;
        work: Work;
        settings: Record<string, unknown>;
        settingSources: Record<string, undefined>;
    }> {
        this.calls.push({ workId: options.workId, userId: options.userId });
        if (this.input.throws) {
            throw this.input.throws;
        }
        return {
            plugin: { id: this.input.pluginId ?? 'k8s' } as unknown as IDeploymentPlugin,
            token: this.input.token === undefined ? KUBECONFIG : (this.input.token as string),
            work: appWork({}),
            settings: {
                clusterSource:
                    this.input.clusterSource === undefined
                        ? APP_CUSTOM_KUBECONFIG_CLUSTER_SOURCE
                        : this.input.clusterSource,
                kubeContext: this.input.kubeContext ?? null,
                namespace: 'ever-works',
            },
            settingSources: {},
        };
    }
}

/** APW-10's `AppsTierPolicy` as this facade consumes it. */
class FakeTierPolicy implements AppsTierPolicy {
    readonly credentialCalls: string[] = [];

    constructor(
        private readonly open: boolean = true,
        private readonly credential: string = TIER_CREDENTIAL,
        private readonly throwsOnCredential: Error | null = null,
    ) {}

    isOpen(): boolean {
        return this.open;
    }

    managedScope(): 'verified-blueprints' | 'any' {
        return 'verified-blueprints';
    }

    async resolveClusterCredential(workId: string): Promise<string> {
        this.credentialCalls.push(workId);
        if (this.throwsOnCredential) {
            throw this.throwsOnCredential;
        }
        return this.credential;
    }

    podPolicy(): {
        runtimeClassName: string | null;
        quota: never;
        limitRange: never;
    } {
        return {
            runtimeClassName: null,
            quota: undefined as never,
            limitRange: undefined as never,
        };
    }

    ingress(): { className: string; controllerNamespace: string; edgeTlsMode: 'edge' } {
        return { className: 'nginx', controllerNamespace: 'ingress-nginx', edgeTlsMode: 'edge' };
    }

    async eligibility(): Promise<{ eligible: boolean; reasons: string[] }> {
        return { eligible: this.open, reasons: [] };
    }
}

/** A `work_app_runtime_states` row, as far as this facade reads it (T17). */
function runtimeStateRow(input: {
    target?: AppRuntimeStateTargetView['target'];
    namespace?: string | null;
    clusterFingerprint?: string | null;
}): AppRuntimeStateTargetStore {
    return {
        async getOrCreate() {
            return {
                target: input.target ?? null,
                namespace: input.namespace ?? null,
                clusterFingerprint: input.clusterFingerprint ?? null,
            };
        },
    };
}

function workRepositoryFor(works: ReadonlyArray<Work | null>): WorkRepository {
    return {
        async findById(id: string) {
            return works.find((work) => work && work.id === id) ?? null;
        },
    } as unknown as WorkRepository;
}

/* -------------------------------------------------------------------------- *
 * The harness
 * -------------------------------------------------------------------------- */

interface HarnessInput {
    work?: Work | null;
    registrations?: readonly Registration[];
    deploy?: FakeDeployFacade;
    policy?: AppsTierPolicy | null;
    runtimeStates?: AppRuntimeStateTargetStore | null;
    works?: WorkRepository | null;
    /** A journal shared with the fakes this harness builds (and their plugins). */
    journal?: string[];
}

interface Harness {
    service: AppRuntimeFacadeService;
    registry: PluginRegistryService;
    deploy: FakeDeployFacade;
    policy: AppsTierPolicy | null;
    journal: string[];
}

function harness(input: HarnessInput = {}): Harness {
    const journal: string[] = input.journal ?? [];
    const work = input.work === undefined ? appWork({}) : input.work;
    const registrations = input.registrations ?? [
        {
            plugin: fakePlugin({
                id: 'k8s',
                supportsApps: true,
                capabilities: ['deployment'],
                journal,
            }),
        },
    ];
    const registry = registryWith(registrations);
    const deploy = input.deploy ?? new FakeDeployFacade();
    const policy = input.policy === undefined ? new FakeTierPolicy(true) : input.policy;

    const service = new AppRuntimeFacadeService(
        registry,
        input.works === undefined
            ? workRepositoryFor(work ? [work] : [])
            : (input.works as WorkRepository),
        deploy as unknown as DeployFacadeService,
        policy ?? undefined,
        input.runtimeStates ? input.runtimeStates : undefined,
    );

    return { service, registry, deploy, policy, journal };
}

/** The App plugin of a harness, so a test can assert on its own journal. */
function pluginOf(h: Harness, id: string): FakePlugin {
    return h.registry.get(id)?.plugin as unknown as FakePlugin;
}

/* -------------------------------------------------------------------------- *
 * THE TWO DECLARED SEAMS — a COMPILE-TIME assertion, declared at module scope
 * -------------------------------------------------------------------------- *
 *
 * `AppRuntimeDeletionService` (T58) injects `APP_RUNTIME_DELETION_FACADE` and calls
 * `resolveDeletionTarget(workId)`; `AppVerificationTargetService` (T60) injects
 * `APP_RUNTIME_VERIFICATION_FACADE` and calls `resolveVerificationTarget(workId)`. Each declared its
 * own narrow reading of this facade in a provisional block, and this class must slot into both
 * **without either file changing**. The two assignments below are that assertion: if a signature
 * drifts, this file stops compiling, which is a louder failure than any runtime test.
 */

const deletionSeamOf = (service: AppRuntimeFacadeService): AppRuntimeDeletionFacade => service;
const verificationSeamOf = (service: AppRuntimeFacadeService): AppRuntimeVerificationFacade =>
    service;

/* -------------------------------------------------------------------------- *
 * A · the worker-context guard (APW06-G02, ACC-06-04)
 * -------------------------------------------------------------------------- */

/**
 * Every assertion in this file except block A's runs as **the worker**, because that is the only
 * process in which this facade does anything but refuse. The flag is process-level, so it is armed
 * once, here — and block A, whose whole subject is the UNMARKED process, builds its services inside
 * `jest.isolateModules` instead of relying on running before this hook.
 */
beforeAll(() => {
    markAppClusterWorkerContext();
    expect(isAppClusterWorkerContext()).toBe(true);
});

describe('A · every method refuses outside the isolated worker (APW06-G02)', () => {
    it('is constructed outside the worker without refusing at construction', () => {
        // The whole point of APW06-G02: `FacadesModule` is imported by the API, so construction
        // must succeed and only a CALL may refuse. (Construction is process-independent, so this
        // needs no private registry.)
        expect(() => harness()).not.toThrow();
        expect(harness().service).toBeInstanceOf(AppRuntimeFacadeService);
    });

    it('refuses every entry point with APP_CLUSTER_IO_IN_API before it touches anything', async () => {
        const observed = await inUnmarkedProcess(async (facade) => {
            const local = harnessWith(facade);
            const results: string[] = [];

            for (const call of [
                () => local.service.resolveDeletionTarget(WORK_ID),
                () => local.service.resolveVerificationTarget(WORK_ID),
                () => local.service.resolveClusterAccess(WORK_ID),
            ]) {
                try {
                    await call();
                    results.push('resolved');
                } catch (error) {
                    results.push(
                        `${(error as Error).name}:${
                            (error as Partial<AppClusterIoInApiError>).code ?? 'no-code'
                        }`,
                    );
                }
            }

            return { results, deployCalls: local.deploy.calls.length, journal: local.journal };
        });

        expect(observed.results).toEqual([
            `AppClusterIoInApiError:${APP_CLUSTER_IO_IN_API}`,
            `AppClusterIoInApiError:${APP_CLUSTER_IO_IN_API}`,
            `AppClusterIoInApiError:${APP_CLUSTER_IO_IN_API}`,
        ]);
        // Nothing was resolved: no plugin was asked, no credential was assembled.
        expect(observed.deployCalls).toBe(0);
        expect(observed.journal).toEqual([]);
    });

    it('names the code and the reason, and never a credential', async () => {
        const message = await inUnmarkedProcess(async (facade) => {
            const local = harnessWith(facade);
            try {
                await local.service.resolveDeletionTarget(WORK_ID);
            } catch (error) {
                return (error as Error).message;
            }
            return '';
        });

        expect(APP_CLUSTER_IO_IN_API).toBe('APP_CLUSTER_IO_IN_API');
        expect(message).toContain('APP_CLUSTER_IO_IN_API');
        expect(message).toContain('resolveDeletionTarget');
        expect(message).not.toContain(KUBECONFIG);
    });

    it('allows the SAME call once the worker flag is set', async () => {
        const observed = await inUnmarkedProcess(async (facade) => {
            const local = harnessWith(facade);

            // Still refused before the marker runs…
            let refused = '';
            try {
                await local.service.resolveDeletionTarget(WORK_ID);
            } catch (error) {
                refused = (error as Partial<AppClusterIoInApiError>).code ?? 'no-code';
            }

            markAppClusterWorkerContextInThisProcess();
            const access = await local.service.resolveDeletionTarget(WORK_ID);
            return { refused, access, marked: isMarkedInThisProcess() };
        });

        expect(observed.refused).toBe(APP_CLUSTER_IO_IN_API);
        expect(observed.marked).toBe(true);
        expect(observed.access).not.toHaveProperty('unavailable');
        expect(observed.access).toMatchObject({ target: 'your-cluster', credential: KUBECONFIG });
    });
});

/**
 * Run `fn` against a facade loaded in a **private module registry**, so this file can observe the
 * unmarked process without either depending on declaration order or leaking a mark into the tests
 * that legitimately need the worker.
 */
function inUnmarkedProcess<T>(
    fn: (facade: typeof AppRuntimeFacadeService) => Promise<T>,
): Promise<T> {
    let started: Promise<T> | null = null;
    jest.isolateModules(() => {
        const workerContext = require('../../app-runtime/worker-context') as {
            markAppClusterWorkerContext(): void;
            isAppClusterWorkerContext(): boolean;
        };
        // The premise of every block-A assertion, asserted here rather than assumed.
        expect(workerContext.isAppClusterWorkerContext()).toBe(false);

        markAppClusterWorkerContextInThisProcess = workerContext.markAppClusterWorkerContext;
        isMarkedInThisProcess = workerContext.isAppClusterWorkerContext;

        const mod = require('../app-runtime.facade') as {
            AppRuntimeFacadeService: typeof AppRuntimeFacadeService;
        };
        started = fn(mod.AppRuntimeFacadeService);
    });
    return started as unknown as Promise<T>;
}

/** The private registry's own marker, captured by {@link inUnmarkedProcess}. */
let markAppClusterWorkerContextInThisProcess: () => void = () => undefined;
/** The private registry's own read, captured by {@link inUnmarkedProcess}. */
let isMarkedInThisProcess: () => boolean = () => false;

/** The harness, built around a class from another module registry. */
function harnessWith(facadeClass: typeof AppRuntimeFacadeService): Harness {
    const journal: string[] = [];
    const work = appWork({});
    const registry = registryWith([
        {
            plugin: fakePlugin({
                id: 'k8s',
                supportsApps: true,
                capabilities: ['deployment'],
                journal,
            }),
        },
    ]);
    const deploy = new FakeDeployFacade();
    return {
        service: new facadeClass(
            registry,
            workRepositoryFor([work]),
            deploy as unknown as DeployFacadeService,
        ),
        registry,
        deploy,
        policy: null,
        journal,
    };
}

/* -------------------------------------------------------------------------- *
 * B · resolution by capability (R-5, plan §2.1:132-137)
 * -------------------------------------------------------------------------- */

describe('B · resolution is by capability, never by plugin id (R-5)', () => {
    it('chooses the Work’s deployProvider plugin for your-cluster', async () => {
        const h = harness({
            registrations: [
                // An apps-tier plugin is also registered and also loaded: it must NOT be chosen.
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
                { plugin: fakePlugin({ id: 'k8s', supportsApps: true }) },
            ],
            work: appWork({ deployProvider: 'k8s' }),
        });

        const access = await h.service.resolveClusterAccess(WORK_ID);

        expect(access).toMatchObject({ outcome: 'access' });
        if (access.outcome === 'access') {
            expect(access.access.target).toBe('your-cluster');
            expect(access.access.pluginId).toBe('k8s');
            expect(access.access.credential).toBe(KUBECONFIG);
        }
    });

    it('does NOT choose an apps-tier plugin for your-cluster, even when the Work names it', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
            ],
            work: appWork({ deployProvider: 'apps-tier' }),
            // The credential is deliberately the tier plugin's OWN id, so the refusal cannot come
            // from the credential/plugin identity check further down: the apps-tier exclusion is
            // the only rule left that can refuse this.
            deploy: new FakeDeployFacade({ pluginId: 'apps-tier' }),
        });

        const access = await h.service.resolveDeletionTarget(WORK_ID);

        expect(access).toEqual({ unavailable: 'target_unavailable' });
        // …and it never got as far as reading a credential for it.
        expect(h.deploy.calls).toEqual([]);
        expect(pluginOf(h, 'apps-tier').calls).toEqual([]);
    });

    it('does NOT choose a plugin without apps-tier for ever-works-apps', async () => {
        const h = harness({
            registrations: [{ plugin: fakePlugin({ id: 'k8s', supportsApps: true }) }],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(true),
        });

        const access = await h.service.resolveDeletionTarget(WORK_ID);

        expect(access).toEqual({ unavailable: 'target_unavailable' });
        // The k8s plugin is loaded and App-capable — and still receives nothing.
        expect(pluginOf(h, 'k8s').calls).toEqual([]);
        expect(h.deploy.calls).toEqual([]);
    });

    it('chooses the ENABLED apps-tier plugin for ever-works-apps', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
                { plugin: fakePlugin({ id: 'k8s', supportsApps: true }) },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(true),
        });

        const access = await h.service.resolveClusterAccess(WORK_ID);

        expect(access).toMatchObject({ outcome: 'access' });
        if (access.outcome === 'access') {
            expect(access.access.target).toBe('ever-works-apps');
            expect(access.access.pluginId).toBe('apps-tier');
            expect(access.access.credential).toBe(TIER_CREDENTIAL);
        }
    });

    it('refuses a plugin that declares apps-tier but is not enabled for the scope', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                    // Not a system plugin and not auto-enabled: `resolvePluginEnabled` answers
                    // false in a work context, so the tier must not be reached through it.
                    manifest: manifestFor('apps-tier', ['deployment', APP_TIER_CAPABILITY], {
                        systemPlugin: false,
                        autoEnable: false,
                    }),
                },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(true),
        });

        const access = await h.service.resolveDeletionTarget(WORK_ID);

        expect(access).toEqual({ unavailable: 'target_unavailable' });
        expect(h.policy?.isOpen()).toBe(true);
        expect((h.policy as FakeTierPolicy).credentialCalls).toEqual([]);
    });

    it('refuses a loaded, App-capable plugin that is a plugin only the registry thinks is App-capable', async () => {
        // `supportsApps` absent: the plugin is a plain deployment plugin. `isAppDeploymentPlugin`
        // is the guard, and the facade must apply it rather than trusting the capability index.
        const h = harness({
            registrations: [{ plugin: fakePlugin({ id: 'k8s', capabilities: ['deployment'] }) }],
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(isAppDeploymentPlugin(pluginOf(h, 'k8s') as unknown as IDeploymentPlugin)).toBe(
            false,
        );
        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
        expect(h.deploy.calls).toEqual([]);
    });

    it('materialises a lazy plugin before asking it anything (the proxy over-reports)', async () => {
        const journal: string[] = [];
        const real = fakePlugin({ id: 'k8s', supportsApps: true, journal });
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(manifestFor('k8s', ['deployment']), async () => {
            journal.push('k8s:materialised');
            return real as unknown as IDeploymentPlugin;
        });

        const service = new AppRuntimeFacadeService(
            registry,
            workRepositoryFor([appWork({})]),
            new FakeDeployFacade() as unknown as DeployFacadeService,
        );
        const access = await service.resolveClusterAccess(WORK_ID);

        expect(access).toMatchObject({ outcome: 'access' });
        if (access.outcome === 'access') {
            expect(access.access.pluginId).toBe('k8s');
        }
        // The proof: the cold stub answers `typeof plugin.deployApp === 'function'` for EVERY
        // member (the cold branch of the `get` trap in `createLazyPluginProxy`), so a resolution
        // that never materialised could still "find" a plugin — and the real import never happened.
        expect(journal).toContain('k8s:materialised');
    });

    it('refuses a lazy plugin whose REAL instance is not App-capable', async () => {
        const real = fakePlugin({ id: 'k8s', capabilities: ['deployment'] });
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(manifestFor('k8s', ['deployment']), async () => {
            return real as unknown as IDeploymentPlugin;
        });

        const service = new AppRuntimeFacadeService(
            registry,
            workRepositoryFor([appWork({})]),
            new FakeDeployFacade() as unknown as DeployFacadeService,
        );

        // The registry's index says `deployment`, and the proxy over-reports every member; the real
        // plugin is not an App provider, so nothing may be resolved for it.
        expect(await service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('omits a member the real plugin behind a lazy loader does not implement', async () => {
        // The discriminating half of the materialisation rule: against the COLD proxy,
        // `typeof plugin.destroyApp === 'function'` is TRUE for a member the real plugin never
        // declared, and calling it throws mid-removal. Only the materialised plugin tells the
        // truth, so `destroyApp` must come back `undefined` here.
        const real = fakePlugin({ id: 'k8s', supportsApps: true, omit: ['destroyApp'] });
        const registry = new PluginRegistryService(new EventEmitter2());
        registry.registerLazy(manifestFor('k8s', ['deployment']), async () => {
            return real as unknown as IDeploymentPlugin;
        });

        const service = new AppRuntimeFacadeService(
            registry,
            workRepositoryFor([appWork({})]),
            new FakeDeployFacade() as unknown as DeployFacadeService,
        );

        const access = (await service.resolveDeletionTarget(WORK_ID)) as
            | AppRuntimeDeletionAccess
            | { unavailable: AppWorkDeletionCode };
        expect('unavailable' in access).toBe(false);
        expect((access as AppRuntimeDeletionAccess).destroyApp).toBeUndefined();
    });

    it('routes by the Work’s persisted target when the runtime-state row carries one', async () => {
        const h = harness({
            // The Work still names the k8s provider; the owner switched the target afterwards.
            work: appWork({ deployProvider: 'k8s' }),
            runtimeStates: runtimeStateRow({ target: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
                { plugin: fakePlugin({ id: 'k8s', supportsApps: true }) },
            ],
            policy: new FakeTierPolicy(true),
        });

        const access = await h.service.resolveClusterAccess(WORK_ID);

        expect(access).toMatchObject({ outcome: 'access' });
        if (access.outcome === 'access') {
            expect(access.access.target).toBe('ever-works-apps');
        }
        expect(h.deploy.calls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * C · the tier gate (AppsTierPolicy.isOpen())
 * -------------------------------------------------------------------------- */

describe('C · ever-works-apps resolves only while the tier is open (R-5)', () => {
    it('refuses while the policy is closed, without resolving a plugin or a credential', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(false),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'tier_unavailable',
        });
        expect((h.policy as FakeTierPolicy).credentialCalls).toEqual([]);
        expect(pluginOf(h, 'apps-tier').calls).toEqual([]);
        expect(h.deploy.calls).toEqual([]);
    });

    it('refuses while no policy is bound at all (the fail-closed default)', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: null,
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'tier_unavailable',
        });
    });

    it('refuses a tier Work on the verification path before any credential is minted', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(true),
        });

        // §4.12:638 — a verification runs on your own cluster only.
        expect(await h.service.resolveVerificationTarget(WORK_ID)).toEqual({
            unavailable: 'target_not_your_cluster',
        });
        expect((h.policy as FakeTierPolicy).credentialCalls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * D · the credential rule per target (plan §5.6 step 3:814-822, ACC-06-49)
 * -------------------------------------------------------------------------- */

describe('D · the credential is the target’s, and only the target’s (ACC-06-49)', () => {
    it('hands the Work-scoped kubeconfig to your-cluster, and never the tier credential', async () => {
        const policy = new FakeTierPolicy(true);
        const h = harness({ policy, work: appWork({ deployProvider: 'k8s' }) });

        const access = await h.service.resolveDeletionTarget(WORK_ID);

        expect(access).toMatchObject({
            target: 'your-cluster',
            credential: KUBECONFIG,
        });
        expect(policy.credentialCalls).toEqual([]);
        expect(h.deploy.calls).toEqual([{ workId: WORK_ID, userId: USER_ID }]);
    });

    it('hands the tier credential to the apps-tier plugin and NOTHING to the k8s plugin', async () => {
        const journal: string[] = [];
        const policy = new FakeTierPolicy(true);
        const h = harness({
            journal,
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                        journal,
                    }),
                },
                { plugin: fakePlugin({ id: 'k8s', supportsApps: true, journal }) },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy,
        });

        const resolved = await h.service.resolveClusterAccess(WORK_ID);

        expect(resolved).toMatchObject({ outcome: 'access' });
        if (resolved.outcome !== 'access') {
            throw new Error('the tier target did not resolve');
        }
        expect(resolved.access.credential).toBe(TIER_CREDENTIAL);
        expect(resolved.access.pluginId).toBe('apps-tier');
        expect(resolved.access.clusterSource).toBeNull();

        // ACC-06-49, both halves: the tier credential reached the tier plugin, and the `k8s`
        // plugin — and the Work-scoped settings read that holds its kubeconfig — were untouched.
        const tierDestroy = bindAppMember<
            (ref: AppTargetRef, credential: string) => Promise<AppDestroyResult>
        >(resolved.access.plugin, 'destroyApp');
        await tierDestroy?.(
            { workId: WORK_ID, namespace: NAMESPACE, target: 'ever-works-apps' },
            resolved.access.credential,
        );
        expect(journal).toContain(
            `apps-tier:destroyApp:${TIER_CREDENTIAL}:${NAMESPACE}:volumes=undefined`,
        );
        expect(journal.filter((line) => line.startsWith('k8s:'))).toEqual([]);
        expect(h.deploy.calls).toEqual([]);
        expect(policy.credentialCalls).toEqual([WORK_ID]);
    });

    it('refuses your-cluster for EVERY cluster source that is not custom-kubeconfig', async () => {
        for (const clusterSource of ['k8s-works', 'k8s-works-shared', 'k8s-gauzy', null]) {
            const h = harness({
                deploy: new FakeDeployFacade({ clusterSource }),
                work: appWork({ deployProvider: 'k8s' }),
            });

            expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
                unavailable: 'target_unavailable',
            });
            expect(await h.service.resolveVerificationTarget(WORK_ID)).toEqual({
                unavailable: 'cluster_unavailable',
            });
        }
    });

    it('never dials with the platform-managed kubeconfig sentinel', async () => {
        const h = harness({
            deploy: new FakeDeployFacade({ token: PLATFORM_MANAGED_KUBECONFIG_SENTINEL }),
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unreachable',
        });
        // …and the verification path's own code for the same refusal.
        expect(await h.service.resolveVerificationTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unavailable',
        });
    });

    it('refuses an empty token rather than dialling anonymously', async () => {
        const h = harness({
            deploy: new FakeDeployFacade({ token: '   ' }),
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unreachable',
        });
    });

    it('validates the cluster source against the DATA repository owner', async () => {
        // `acme` owns the website repo; the DATA repo lives in `ever-works`, and
        // `validateClusterSourceForOwner` refuses `custom-kubeconfig` for a shared org
        // (`deployment-context.resolver.ts:102-112`). Passing the website owner would pass.
        const work = appWork({
            deployProvider: 'k8s',
            dataOwner: 'ever-works',
            websiteOwner: 'acme',
        });
        expect(work.getRepoOwner('data')).toBe('ever-works');
        expect(work.getRepoOwner('website')).toBe('acme');

        const h = harness({ work });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('refuses when the settings read throws, instead of dialling with nothing', async () => {
        const h = harness({
            deploy: new FakeDeployFacade({ throws: new Error('No k8s credentials configured.') }),
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unreachable',
        });
    });

    it('refuses when the credential belongs to a different plugin than the one resolved', async () => {
        const h = harness({
            deploy: new FakeDeployFacade({ pluginId: 'vercel' }),
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('refuses when the tier policy cannot mint a credential', async () => {
        const h = harness({
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'apps-tier',
                        supportsApps: true,
                        capabilities: ['deployment', APP_TIER_CAPABILITY],
                    }),
                },
            ],
            work: appWork({ deployProvider: APP_MANAGED_DEPLOY_PROVIDER_ID }),
            policy: new FakeTierPolicy(true, '', new Error('cluster_credential_unavailable')),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unreachable',
        });
    });
});

/* -------------------------------------------------------------------------- *
 * E · the port-unavailable answers (never a generic throw)
 * -------------------------------------------------------------------------- */

describe('E · a missing seam answers a named refusal rather than throwing', () => {
    it('answers not_found when no Work repository is bound — it never silently succeeds', async () => {
        const h = harness({ works: null });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'not_found',
        });
        expect(await h.service.resolveVerificationTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unavailable',
        });
    });

    it('answers not_found for an unknown id, a non-App Work, and a blank id', async () => {
        const h = harness({});

        expect(await h.service.resolveDeletionTarget(OTHER_WORK_ID)).toEqual({
            unavailable: 'not_found',
        });
        expect(await h.service.resolveDeletionTarget('')).toEqual({ unavailable: 'not_found' });

        const nonApp = harness({ work: appWork({ kind: 'default' }) });
        expect(await nonApp.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'not_found',
        });
    });

    it('answers target_unavailable when nothing App-capable is registered', async () => {
        const h = harness({ registrations: [], work: appWork({ deployProvider: 'k8s' }) });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('answers target_unavailable when the plugin is registered but not loaded', async () => {
        const h = harness({
            registrations: [
                { plugin: fakePlugin({ id: 'k8s', supportsApps: true }), state: 'unloaded' },
            ],
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('answers target_unavailable when the Work has never chosen a provider', async () => {
        const h = harness({ work: appWork({ deployProvider: null }) });

        // FR-63: a Work whose provider names no App plugin has target `none`, and nothing may be
        // dialled for it — but the answer is still a port code, never an exception.
        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('answers cluster_unreachable when the deploy facade is not bound', async () => {
        const registry = registryWith([{ plugin: fakePlugin({ id: 'k8s', supportsApps: true }) }]);
        const service = new AppRuntimeFacadeService(registry, workRepositoryFor([appWork({})]));

        // The plugin is servable; the credential is not. Either way it is a port code, not a throw.
        expect(await service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'cluster_unreachable',
        });
    });

    it('maps every refusal through the two published mappers', () => {
        // The mapping is a contract of its own: `AppWorkDeletionCode` and
        // `AppVerificationRefusalCode` are closed unions, and an unmapped refusal would silently
        // become "target_unavailable"-flavoured noise at the call site.
        const deletion: Array<[Parameters<typeof deletionCodeFor>[0], AppWorkDeletionCode]> = [
            ['not_found', 'not_found'],
            ['target_none', 'target_unavailable'],
            ['target_unavailable', 'target_unavailable'],
            ['tier_closed', 'tier_unavailable'],
            ['target_not_checked', 'target_unavailable'],
            ['cluster_unreachable', 'cluster_unreachable'],
            ['runtime_state_unreadable', 'runtime_state_unreadable'],
        ];
        for (const [refusal, code] of deletion) {
            expect(deletionCodeFor(refusal)).toBe(code);
        }

        const verification: Array<
            [Parameters<typeof verificationCodeFor>[0], AppVerificationRefusalCode]
        > = [
            ['not_found', 'cluster_unavailable'],
            ['target_none', 'target_not_your_cluster'],
            ['target_unavailable', 'cluster_unavailable'],
            ['tier_closed', 'target_not_your_cluster'],
            ['target_not_checked', 'cluster_unavailable'],
            ['cluster_unreachable', 'cluster_unavailable'],
            ['runtime_state_unreadable', 'cluster_unavailable'],
        ];
        for (const [refusal, code] of verification) {
            expect(verificationCodeFor(refusal)).toBe(code);
        }
    });

    it('refuses an unreadable runtime-state row rather than guessing the target', async () => {
        const h = harness({
            runtimeStates: {
                async getOrCreate() {
                    throw new Error('connection terminated');
                },
            },
            work: appWork({ deployProvider: 'k8s' }),
        });

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'runtime_state_unreadable',
        });
        expect(h.deploy.calls).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * F · the two declared seams (compile time above, runtime here)
 * -------------------------------------------------------------------------- */

describe('F · the seams T58 and T60 declared', () => {
    it('satisfies AppRuntimeDeletionFacade and is callable through it', async () => {
        const h = harness({ work: appWork({ deployProvider: 'k8s' }) });
        const seam: AppRuntimeDeletionFacade = deletionSeamOf(h.service);

        const resolved = await seam.resolveDeletionTarget(WORK_ID);
        expect('unavailable' in resolved).toBe(false);

        const access = resolved as AppRuntimeDeletionAccess;
        expect(access.target).toBe('your-cluster');
        expect(access.ref).toEqual({
            workId: WORK_ID,
            namespace: NAMESPACE,
            target: 'your-cluster',
            kubeContext: null,
        });
        expect(access.credential).toBe(KUBECONFIG);

        // The bound member is what T58's op calls, exactly as it calls it.
        await expect(
            access.destroyApp?.(access.ref, access.credential as string, { deleteVolumes: true }),
        ).resolves.toMatchObject({ namespaceDeleted: true });
        expect(h.journal).toContain(`k8s:destroyApp:${KUBECONFIG}:${NAMESPACE}:volumes=true`);
    });

    it('satisfies AppRuntimeVerificationFacade and is callable through it', async () => {
        const h = harness({ work: appWork({ deployProvider: 'k8s' }) });
        const seam: AppRuntimeVerificationFacade = verificationSeamOf(h.service);

        const resolved = await seam.resolveVerificationTarget(WORK_ID);
        expect('unavailable' in resolved).toBe(false);

        const access = resolved as AppVerificationAccess;
        expect(access.target).toBe('your-cluster');
        expect(access.credential).toBe(KUBECONFIG);

        // The five App members a verification calls, each really bound to the plugin.
        const check = await access.checkAppCluster?.(access.credential, {
            namespace: access.ref.namespace,
            needsCreateNamespace: true,
        });
        expect(check?.ok).toBe(true);
        await access.prepareAppNamespace?.(access.ref, access.credential, {
            isolation: true,
            limitRange: {
                defaultRequest: { cpu: '100m', memory: '128Mi' },
                defaultLimit: { cpu: '1', memory: '512Mi', ephemeralStorage: '1Gi' },
                max: { cpu: '2', memory: '4Gi' },
            },
        });
        await access.getAppStatus?.(access.ref, access.credential, {
            components: [],
            jobs: [],
            cron: [],
        });
        await access.destroyApp?.(access.ref, access.credential, { deleteVolumes: true });
        expect(h.journal).toEqual([
            `k8s:checkAppCluster:${KUBECONFIG}`,
            `k8s:prepareAppNamespace:${KUBECONFIG}:${NAMESPACE}`,
            `k8s:getAppStatus:${KUBECONFIG}`,
            `k8s:destroyApp:${KUBECONFIG}:${NAMESPACE}:volumes=true`,
        ]);
    });

    it('omits a member the resolved plugin does not implement, rather than forwarding into a throw', async () => {
        // A cold lazy proxy turns a missing member into `TypeError: Plugin "k8s" has no method
        // "destroyApp"` (its forwarding wrapper, in `createLazyPluginProxy`) — so a facade that
        // bound it blindly would hand T58's op a member that throws mid-removal.
        const journal: string[] = [];
        const h = harness({
            journal,
            registrations: [
                {
                    plugin: fakePlugin({
                        id: 'k8s',
                        supportsApps: true,
                        omit: ['destroyApp', 'getAppStatus'],
                        journal,
                    }),
                },
            ],
            work: appWork({ deployProvider: 'k8s' }),
        });

        const deletion = (await h.service.resolveDeletionTarget(WORK_ID)) as
            | AppRuntimeDeletionAccess
            | { unavailable: AppWorkDeletionCode };
        expect('unavailable' in deletion).toBe(false);
        expect((deletion as AppRuntimeDeletionAccess).destroyApp).toBeUndefined();

        const verification = (await h.service.resolveVerificationTarget(WORK_ID)) as
            | AppVerificationAccess
            | { unavailable: AppVerificationRefusalCode };
        expect('unavailable' in verification).toBe(false);
        expect((verification as AppVerificationAccess).getAppStatus).toBeUndefined();
        expect((verification as AppVerificationAccess).checkAppCluster).toBeDefined();
    });

    it('resolves the namespace the plugin names, and the §4.1 name when nothing stores one', async () => {
        const stored = harness({
            runtimeStates: runtimeStateRow({
                target: 'your-cluster',
                namespace: 'ew-stored-namespace',
                clusterFingerprint: 'fp-1',
            }),
            work: appWork({}),
        });
        const withRow = await stored.service.resolveClusterAccess(WORK_ID);
        expect(withRow).toMatchObject({ outcome: 'access' });
        if (withRow.outcome === 'access') {
            expect(withRow.access.ref.namespace).toBe('ew-stored-namespace');
            expect(withRow.access.ref.clusterFingerprint).toBe('fp-1');
        }

        const derived = harness({ work: appWork({}) });
        const without = await derived.service.resolveClusterAccess(WORK_ID);
        expect(without).toMatchObject({ outcome: 'access' });
        if (without.outcome === 'access') {
            expect(without.access.ref.namespace).toBe(NAMESPACE);
            expect(without.access.ref.namespace).toBe(appNamespaceName(SLUG, WORK_ID));
        }
    });

    it('derives §4.1’s namespace by the plugin’s own rule (ew-<slug ≤ 30>-<first 8 hex>)', () => {
        expect(appNamespaceName('hello-world', WORK_ID)).toBe('ew-hello-world-1a2b3c4d');
        // Truncated to 30 characters, non-DNS characters collapsed, and never longer than 42.
        expect(appNamespaceName('a'.repeat(40), WORK_ID)).toBe(`ew-${'a'.repeat(30)}-1a2b3c4d`);
        expect(appNamespaceName('Hello World!', WORK_ID)).toBe('ew-hello-world-1a2b3c4d');
        expect(appNamespaceName('', WORK_ID)).toBe('ew-app-1a2b3c4d');
        expect(appNamespaceName(SLUG, WORK_ID).length).toBeLessThanOrEqual(
            APP_NAMESPACE_MAX_LENGTH,
        );
    });

    it('normalises the `ever-works` deploy-provider alias through the deploy facade’s own rule', async () => {
        // T20's "Done when": no `'k8s'` string literal is added outside `packages/plugins/k8s/`.
        // The alias rule therefore stays where it already lives, and this pins BOTH halves: the
        // production rule really maps the alias, and the facade really asks for it.
        expect(DeployFacadeService.prototype.resolveProviderId.call({}, 'ever-works')).toBe('k8s');
        expect(DeployFacadeService.prototype.resolveProviderId.call({}, 'k8s')).toBe('k8s');

        const deploy = new FakeDeployFacade();
        const h = harness({ deploy, work: appWork({ deployProvider: 'ever-works' }) });

        const access = await h.service.resolveClusterAccess(WORK_ID);

        expect(access).toMatchObject({ outcome: 'access' });
        if (access.outcome === 'access') {
            expect(access.access.pluginId).toBe('k8s');
        }
        // Asked once while deriving the target and once while resolving the plugin — both are the
        // Work's own persisted value, normalised.
        expect(deploy.providerIdCalls.length).toBeGreaterThan(0);
        expect(new Set(deploy.providerIdCalls)).toEqual(new Set(['ever-works']));
    });

    it('refuses a Work whose provider cannot be normalised, rather than guessing one', async () => {
        // No deploy facade bound, so the persisted value is used verbatim — and an alias nobody can
        // resolve is `none`, not a plugin picked for it.
        const h = harness({
            works: workRepositoryFor([appWork({ deployProvider: 'ever-works' })]),
        });
        delete (h.service as unknown as { deployFacade?: unknown }).deployFacade;

        expect(await h.service.resolveDeletionTarget(WORK_ID)).toEqual({
            unavailable: 'target_unavailable',
        });
    });

    it('binds a member so a detached call still reaches the plugin', async () => {
        const journal: string[] = [];
        const plugin = fakePlugin({ id: 'k8s', supportsApps: true, journal });

        const detached = bindAppMember<(ref: AppTargetRef) => Promise<AppDestroyResult>>(
            plugin as unknown as IDeploymentPlugin,
            'destroyApp',
        );
        expect(typeof detached).toBe('function');
        await detached?.({ workId: WORK_ID, namespace: NAMESPACE, target: 'your-cluster' });
        expect(journal).toEqual([`k8s:destroyApp:undefined:${NAMESPACE}:volumes=undefined`]);

        const missing = bindAppMember(plugin as unknown as IDeploymentPlugin, 'nope' as never);
        expect(missing).toBeUndefined();
    });
});

/* -------------------------------------------------------------------------- *
 * G · the plan's own assertions (tasks.md:360-366)
 * -------------------------------------------------------------------------- */

describe('G · the API process cannot reach the marker, and reads no cluster env var', () => {
    const repoRoot = path.resolve(__dirname, '../../../../..');

    it('the API module graph never imports the marker provider', () => {
        const apiSrc = path.join(repoRoot, 'apps', 'api', 'src');
        const files = walk(apiSrc);
        expect(files.length).toBeGreaterThan(50);

        const contents = files.map((file) => fs.readFileSync(file, 'utf8'));
        // Known-good control: the scan really reads the API's sources.
        expect(contents.some((text) => text.includes('@Controller('))).toBe(true);

        const offenders = files.filter(
            (file, index) =>
                contents[index].includes('markAppClusterWorkerContext') ||
                contents[index].includes('worker-context'),
        );
        expect(offenders).toEqual([]);
    });

    it('the facade never names a cluster kubeconfig env var or the tier ceiling', () => {
        const source = fs.readFileSync(
            path.resolve(__dirname, '..', 'app-runtime.facade.ts'),
            'utf8',
        );
        const forbidden = [
            ['EVER', 'WORKS', 'K8S', 'WORKS', 'KUBECONFIG'].join('_'),
            ['EVER', 'WORKS', 'K8S', 'WORKS', 'SHARED', 'KUBECONFIG'].join('_'),
            ['EVER', 'WORKS', 'APPS', 'MANAGED', 'ENABLED'].join('_'),
        ];
        for (const name of forbidden) {
            expect(source.includes(name)).toBe(false);
        }
        // Control: the read is real.
        expect(source).toContain('AppRuntimeFacadeService');
    });

    it('reads no cluster env var while resolving a target', async () => {
        const h = harness({ work: appWork({ deployProvider: 'k8s' }) });
        const reads: string[] = [];
        const real = process.env;

        process.env = new Proxy(real, {
            get(target, prop, receiver) {
                if (typeof prop === 'string') {
                    reads.push(prop);
                }
                return Reflect.get(target, prop, receiver);
            },
        }) as NodeJS.ProcessEnv;

        try {
            // Control: the recorder observes a read, so a zero below is not a broken proxy.
            void process.env.PATH;
            expect(reads).toContain('PATH');

            await h.service.resolveDeletionTarget(WORK_ID);
            await h.service.resolveVerificationTarget(WORK_ID);
            await h.service.resolveClusterAccess(WORK_ID);
        } finally {
            process.env = real;
        }

        const forbidden = [
            ['EVER', 'WORKS', 'K8S', 'WORKS', 'KUBECONFIG'].join('_'),
            ['EVER', 'WORKS', 'K8S', 'WORKS', 'SHARED', 'KUBECONFIG'].join('_'),
            ['EVER', 'WORKS', 'APPS', 'MANAGED', 'ENABLED'].join('_'),
        ];
        expect(reads.filter((name) => forbidden.includes(name))).toEqual([]);
    });

    it('registers the facade in FacadesModule (constructed everywhere, called nowhere)', () => {
        // APW06-G02's other half: the provider really is in the module every API process imports.
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        const { FacadesModule } = require('../facades.module') as {
            FacadesModule: new (...args: never[]) => unknown;
        };
        const providers = (Reflect.getMetadata('providers', FacadesModule) ?? []) as unknown[];
        expect(providers).toContain(AppRuntimeFacadeService);

        const exported = (Reflect.getMetadata('exports', FacadesModule) ?? []) as unknown[];
        expect(exported).toContain(AppRuntimeFacadeService);
    });

    it('exposes exactly one token per declared port, never a second Symbol of the same name', () => {
        // A second `Symbol('APPS_TIER_POLICY')` would be a DIFFERENT token, and the single binding
        // would then reach only one of its two consumers (the reasoning `ports.ts:9-17` records).
        expect(typeof APPS_TIER_POLICY).toBe('symbol');
        expect(APPS_TIER_POLICY.toString()).toBe('Symbol(APPS_TIER_POLICY)');
    });
});

/** Every `.ts` file under `dir`, recursively. */
function walk(dir: string): string[] {
    return fs.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
            return entry.name === 'node_modules' ? [] : walk(full);
        }
        return entry.isFile() && full.endsWith('.ts') ? [full] : [];
    });
}
