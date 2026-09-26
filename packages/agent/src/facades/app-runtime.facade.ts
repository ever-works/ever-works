/**
 * APW-06 T20 — **`AppRuntimeFacadeService`**: the single place a Deployment plugin and its
 * credential are assembled (R-5).
 *
 * Spec: `docs/specs/features/app-works/APW-06-app-runtime/spec.md` FR-3…FR-5 (the API never dials a
 * cluster; the member's own cluster is dialled only with their own kubeconfig), ACC-06-04,
 * ACC-06-49. Plan: §2.1 (`plan.md:132-137`, "plugin-first … never by id"), §5.6 step 3
 * (`plan.md:814-822`, the credential per target), §6.2 (`plan.md:940-949`, the isolated worker),
 * §9.7 (`plan.md:1500-1503`, the deletion path), §9.9 (`plan.md:1545-1568`, the runtime target
 * resolver T69 owns), §9.10 (`plan.md:1570-1582`, "Every handler resolves the plugin and credential
 * through `AppRuntimeFacadeService` (R-5)").
 *
 * ## Why it exists as a facade at all
 *
 * Two epics need "the plugin for this App Work's target, and the credential it is dialled with":
 * T58's `delete-app-work` op (`app-runtime-deletion.service.ts:457-464`) and T60's three
 * verification ops (`app-verification-target.service.ts:523-527`). Each declared that need as a
 * narrow **provisional seam** — one method, one success shape, one typed refusal — precisely so it
 * could be written before this file existed. Those two seams are the contract; this class is their
 * implementation, and it implements both **without either file changing** (the compile-time pin is
 * in `__tests__/app-runtime.facade.spec.ts`, declared at module scope).
 *
 * ## Resolution is by capability, never by plugin id (R-5)
 *
 * The plan names two different rules for two different targets, and the difference is the whole of
 * §2.1:
 *
 * | Target | The plugin | Why |
 * | --- | --- | --- |
 * | `your-cluster` | the plugin the Work's persisted `deployProvider` names, **loaded**, declaring `deployment`, for which `isAppDeploymentPlugin` holds, and which does **not** declare `apps-tier` | it is the member's own cluster and their own choice of provider; the managed tier's plugin is refused here because it serves `ever-works-apps` and nothing else (`plan.md:126-129`) |
 * | `ever-works-apps` | the **enabled** plugin declaring `deployment` **and** `apps-tier`, for which `isAppDeploymentPlugin` holds, and only while `AppsTierPolicy.isOpen()` | `plan.md:135-137`: "the enabled deployment plugin with `supportsApps === true` **and** the `apps-tier` capability, only while `AppsTierPolicy.isOpen()`" |
 *
 * No plugin id is ever compared against a literal to *choose* a plugin — the only id comparison in
 * this file is the check that the credential the deploy facade resolved belongs to the very plugin
 * we are about to dial with it.
 *
 * ## Presence is checked on the MATERIALISED plugin
 *
 * `PluginRegistryService.registerLazy` wraps every plugin in a proxy (`createLazyPluginProxy`,
 * `lazy-plugin-proxy.ts`) that, **while the plugin is cold** (not yet materialised), answers a
 * forwarding function for **any** property it does not itself define (the cold branch of its `get`
 * trap) and `true` from its `has` trap for any such property. So on a cold stub,
 * `typeof plugin.destroyApp === 'function'` is `true` even when the real plugin never declared
 * `destroyApp` — and calling it throws `TypeError: Plugin "…" has no method "…"` *mid-removal*.
 * Once materialised the proxy answers the real instance's members, but this facade does not rely on
 * the stub having been materialised by someone else: every member it hands to a caller is read off
 * the plugin that `__materialize()` returned, and every capability test is made after
 * materialisation.
 *
 * ## Worker-only, per call, never at construction (APW06-G02)
 *
 * The service is constructed in every process that imports `FacadesModule`, so its constructor may
 * not refuse anything: **every method call** throws `APP_CLUSTER_IO_IN_API`
 * (`AppClusterIoInApiError`, `./worker-context`) unless `isAppClusterWorkerContext()` is true
 * (`plan.md:943-949`). The flag is a process-level binding, not an env var, and only T71's
 * bootstrap provider arms it.
 *
 * ## The credential rule, per target (plan §5.6 step 3)
 *
 * - **`your-cluster`** — the Work-scoped `k8s` settings through
 *   `DeployFacadeService.getPluginAndTokenAndSettings`. `clusterSource` must be
 *   `custom-kubeconfig`: **any** other value is refused with `target_not_checked`, so the
 *   platform-managed cluster sources can never be reached from an App Work — their kubeconfigs
 *   live in the platform's environment and belong to the site deploy path. The credential is then
 *   checked against `validateClusterSourceForOwner(<data repository owner>, …)`, the same
 *   authoritative gate the deploy service uses (`deployment-context.resolver.ts:83-124`), and the
 *   `k8s-works` / `k8s-works-shared` env kubeconfigs are never read — not by this file, and not by
 *   `resolveKubeconfigForClusterSource`, which it never calls.
 * - **`ever-works-apps`** — `AppsTierPolicy.resolveClusterCredential(workId)`, the
 *   control-namespace-only credential, handed to the `apps-tier` plugin and **never** to `k8s`
 *   (ACC-06-49). This path does not touch the deploy facade at all: a Work-scoped kubeconfig must
 *   not reach the tier, and the tier credential must not reach the member's cluster.
 *
 * ## Fail-closed, and always a named refusal
 *
 * Every failure is a **value**, never a throw and never a silent success: {@link
 * AppRuntimeFacadeRefusal} is mapped onto the seam owner's own closed union by
 * {@link deletionCodeFor} / {@link verificationCodeFor}. A missing collaborator therefore produces
 * a port-unavailable code the caller already knows how to report:
 *
 * | Absent collaborator | The answer |
 * | --- | --- |
 * | `WorkRepository` | `not_found` — a Work nobody can read is a Work nobody may act on (T58's own rule) |
 * | `DeployFacadeService` | `cluster_unreachable` — the plugin is servable, the credential is not |
 * | `APPS_TIER_POLICY` | `tier_closed` — the fail-closed default, exactly as an unbound port behaves |
 * | `WORK_APP_RUNTIME_STATES` (T17) | the §4.1 namespace is derived instead of read; the target is derived from the Work's `deployProvider` |
 * | a plugin that is absent, unloaded, not App-capable, or not enabled | `target_unavailable` |
 * | a **throwing** runtime-state read | `runtime_state_unreadable` — the truth is unknown, so nothing is dialled |
 *
 * ## The provisional parts, and what replaces them
 *
 * Three things in this file wait on another task, and each is marked at its definition:
 *
 * 1. **`WORK_APP_RUNTIME_STATES` (T17)** — the row is the authority for the Work's target and for
 *    the frozen namespace (`plan.md:387`, §9.9). T17 has not landed, so the row is injected
 *    `@Optional()` through the token APW-11 T5 already declares, and both facts are derived when it
 *    is absent. The **token is not redeclared**: a second `Symbol('WORK_APP_RUNTIME_STATES')` is a
 *    different token, and T17's single binding would then reach only one of its consumers.
 * 2. **`AppRuntimeTargetResolver` (T69)** — §9.9 makes *that* file "the single place cluster access
 *    for an App Work is assembled", including `prepareAppNamespace` before a `your-cluster` target
 *    is returned. T69 has not landed; when it does, its `resolve` and this facade's
 *    {@link AppRuntimeFacadeService.resolveClusterAccess} must be reconciled into one — this file
 *    deliberately does **not** call `prepareAppNamespace`, because §5.6 step 3's credential
 *    assembly is a read, and preparing a namespace is cluster I/O with side effects that belongs to
 *    the deploy path (T22/T23) and to T69.
 * 3. **`readNamespaceExpiry`** — `AppVerificationAccess` declares it (the namespace's
 *    `ever-works.io/expires-at` annotation, `plan.md:512-519`). This file originally left the
 *    optional member unbound because no member of `IDeploymentPlugin` exposed such a read;
 *    the contract gained `readNamespaceExpiry?` on 2026-09-18 and the facade now binds it,
 *    with `bindAppMember` keeping the "the plugin really implements it" discipline. A plugin
 *    that cannot answer still leaves the member `undefined`, which is T60's documented
 *    "no expiry known" path (a warning and an empty value), never a thrown status call.
 */

import { Inject, Injectable, Logger, Optional } from '@nestjs/common';
import { createHash } from 'node:crypto';
import { isAppWorkKind, type AppDeployTarget } from '@ever-works/contracts';
import {
    isAppDeploymentPlugin,
    PLUGIN_CAPABILITIES,
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
    type AppStatusSnapshot,
    type AppStatusSpec,
    type AppTargetRef,
    type IDeploymentPlugin,
} from '@ever-works/plugin';

import type { Work } from '../entities/work.entity';
import { WorkRepository } from '../database/repositories/work.repository';
import { WORK_APP_RUNTIME_STATES } from '../app-launcher/app-launcher.service';
import { APPS_TIER_POLICY, type AppsTierPolicy } from '../app-runtime/ports';
import { requireAppClusterWorkerContext } from '../app-runtime/worker-context';
import type {
    AppRuntimeDeletionAccess,
    AppRuntimeDeletionFacade,
    AppWorkDeletionCode,
} from '../app-runtime/app-runtime-deletion.service';
import type {
    AppRuntimeVerificationFacade,
    AppVerificationAccess,
    AppVerificationRefusalCode,
} from '../app-runtime/app-verification-target.service';
import {
    PluginRegistryService,
    type RegisteredPlugin,
} from '../plugins/services/plugin-registry.service';
import { DeployFacadeService, PLATFORM_MANAGED_KUBECONFIG_SENTINEL } from './deploy.facade';
import { validateClusterSourceForOwner, type ClusterSource } from './deployment-context.resolver';

/* -------------------------------------------------------------------------- *
 * Names this file fixes, and the reasons each one is a constant
 * -------------------------------------------------------------------------- */

/**
 * The capability APW-10's tier plugin declares **in addition to** `deployment`
 * (`plan.md:135-137`, `plan.md:412`). It is not in `PLUGIN_CAPABILITIES` — that enum is the SDK's
 * closed list, and this capability is APW-10's own declaration — so it is named once here.
 */
export const APP_TIER_CAPABILITY = 'apps-tier' as const;

/** The `deployProvider` value that means the managed target (APW-06 T17's FR-63 rule). */
export const APP_MANAGED_DEPLOY_PROVIDER_ID = 'ever-works-apps' as const;

/**
 * The **only** `clusterSource` an App Work on `your-cluster` may use (plan §5.6 step 3:815-816).
 * The other two sources resolve a platform-held kubeconfig from the environment and are the site
 * deploy path's, not an App Work's.
 */
export const APP_CUSTOM_KUBECONFIG_CLUSTER_SOURCE: ClusterSource = 'custom-kubeconfig';

/** `ew-` + a ≤ 30-character slug + `-` + 8 hex (plan §4.1:387). */
export const APP_NAMESPACE_PREFIX = 'ew-';
export const APP_SLUG_MAX_LENGTH = 30;
export const APP_NAMESPACE_MAX_LENGTH = 42;
/** The fallback slug when a Work's own slug sanitises away to nothing (`app-names.ts:143`). */
export const APP_NAMESPACE_FALLBACK_SLUG = 'app';

/* -------------------------------------------------------------------------- *
 * Shapes
 * -------------------------------------------------------------------------- */

/**
 * Why this facade could not assemble cluster access. Never a value, a host, a namespace or a token
 * — and every member maps onto a code the seam owner's own union already carries
 * ({@link deletionCodeFor}, {@link verificationCodeFor}).
 */
export type AppRuntimeFacadeRefusal =
    /** The Work does not exist, is not an App Work, or no repository can read it. */
    | 'not_found'
    /** The Work has chosen no target ("None — don't deploy yet", R-12). */
    | 'target_none'
    /** No loaded, App-capable plugin serves the target. */
    | 'target_unavailable'
    /** `ever-works-apps`, while `AppsTierPolicy.isOpen()` is false (or no policy is bound). */
    | 'tier_closed'
    /** `your-cluster` whose `clusterSource` is not `custom-kubeconfig`, or whose owner fails the matrix. */
    | 'target_not_checked'
    /** The credential itself could not be assembled. */
    | 'cluster_unreachable'
    /** The runtime-state row exists but could not be read, so the target is unknown. */
    | 'runtime_state_unreadable';

/**
 * The materialised, App-capable plugin — T2's narrowed type
 * (`deployment.interface.ts:414-419`). Holding this type is itself the proof that
 * {@link isAppDeploymentPlugin} was applied to a **real** plugin instance and not to a lazy stub.
 */
export type AppDeploymentPlugin = IDeploymentPlugin & {
    readonly supportsApps: true;
    deployApp: NonNullable<IDeploymentPlugin['deployApp']>;
};

/**
 * Everything a caller needs to dial a Work's cluster: which target, the ref to dial, the credential
 * to dial with, and the plugin itself.
 *
 * The two seam methods below are **narrow readings** of this shape — T58 wants `destroyApp`, T60
 * wants the five members a verification calls. §9.10's op handlers, which also resolve through this
 * facade, take the plugin and check the optional member they need (refusing
 * `op_unsupported_on_target` when it is absent).
 */
export interface AppRuntimeClusterAccess {
    target: 'your-cluster' | 'ever-works-apps';
    ref: AppTargetRef;
    credential: string;
    pluginId: string;
    plugin: AppDeploymentPlugin;
    /** `your-cluster` only; `null` on the managed tier, where no member kubeconfig exists. */
    clusterSource: ClusterSource | null;
}

/**
 * {@link AppRuntimeFacadeService.resolveClusterAccess}'s answer: either access, or a named refusal.
 *
 * **The discriminant is a string literal on purpose.** This package compiles with
 * `strictNullChecks: false` (`tsconfig.json:23`), under which a `{ ok: true } | { ok: false }` union
 * **stops narrowing** — the reason `packages/agent-plugins` had to be excluded from ts-jest's
 * type-check (`jest.config.js:11-22`). A string discriminant narrows exactly as
 * `AppWorkDeletionOpResult.state` does (`app-runtime-deletion.service.ts:252`).
 */
export type AppRuntimeAccessResult =
    | { outcome: 'access'; access: AppRuntimeClusterAccess }
    | { outcome: 'refused'; refusal: AppRuntimeFacadeRefusal };

/**
 * One `work_app_runtime_states` row as far as this facade reads it (plan §7.2; APW-06 T17).
 *
 * Three fields: the target the owner chose (`PUT :id/app-target`), the namespace frozen at the first
 * `prepare-namespace`, and the cluster fingerprint the last Deployment was written against.
 */
export interface AppRuntimeStateTargetView {
    target?: AppDeployTarget | null;
    namespace?: string | null;
    clusterFingerprint?: string | null;
}

/**
 * APW-06 T17's `WorkAppRuntimeStateRepository`, as this facade consumes it.
 *
 * `getOrCreate` is T17's own read (`tasks.md:296`): it is what derives `target` from the Work's
 * creation-time choice when the column is still at its default (FR-63), which is exactly the read
 * this facade needs. The **token is not declared here** — it is `WORK_APP_RUNTIME_STATES`
 * (`app-launcher.service.ts:223`), already declared and already bound by T17; a second `Symbol` of
 * the same name would be a different token and T17's single binding would reach only one consumer.
 */
export interface AppRuntimeStateTargetStore {
    getOrCreate(workId: string): Promise<AppRuntimeStateTargetView | null | undefined>;
}

/* -------------------------------------------------------------------------- *
 * The refusal mapping — a contract of its own
 * -------------------------------------------------------------------------- */

/**
 * {@link AppRuntimeFacadeRefusal} → `AppWorkDeletionCode` (T58's closed union,
 * `app-runtime-deletion.service.ts:179-203`).
 *
 * `not_found` is already T58's (a Work it cannot read is a Work it will not delete), so it passes
 * through unchanged. `runtime_state_unreadable` likewise: T58 keeps the Work row rather than
 * guessing. The rest collapse onto that union's own members — `target_not_checked` and
 * `target_none` are both "there is no usable target", which is what `target_unavailable` says, and
 * a closed tier is `tier_unavailable`.
 */
export function deletionCodeFor(refusal: AppRuntimeFacadeRefusal): AppWorkDeletionCode {
    switch (refusal) {
        case 'not_found':
            return 'not_found';
        case 'tier_closed':
            return 'tier_unavailable';
        case 'cluster_unreachable':
            return 'cluster_unreachable';
        case 'runtime_state_unreadable':
            return 'runtime_state_unreadable';
        default:
            return 'target_unavailable';
    }
}

/**
 * {@link AppRuntimeFacadeRefusal} → `AppVerificationRefusalCode` (T60's closed union,
 * `app-verification-target.service.ts:283-292`).
 *
 * A verification runs on **your** cluster only (§4.12:638), so "there is no your-cluster here"
 * — `target_none`, a closed tier — is `target_not_your_cluster`: the exact code T60's own
 * `requireYourCluster` uses (`:980-989`). Everything else is `cluster_unavailable`, which T60
 * reports through the sink and APW-04 turns into its runner-lane fallback.
 */
export function verificationCodeFor(refusal: AppRuntimeFacadeRefusal): AppVerificationRefusalCode {
    switch (refusal) {
        case 'target_none':
        case 'tier_closed':
            return 'target_not_your_cluster';
        default:
            return 'cluster_unavailable';
    }
}

/* -------------------------------------------------------------------------- *
 * Pure helpers
 * -------------------------------------------------------------------------- */

/**
 * `deployProvider` → the plugin id the registry knows it by.
 *
 * **The mapping is the deploy facade's own** (`DeployFacadeService.resolveProviderId`,
 * `deploy.facade.ts:128-130`, over the module-private `resolvePluginProviderId` at `:44-48`), and
 * asking it rather than restating the rule is the point: the legacy `'ever-works'` → `'k8s'` alias
 * then has exactly one spelling in this package, and this file adds no plugin-id literal of its own
 * — which is what T20's "no `'k8s'` string literal outside `packages/plugins/k8s/`" asks for. With
 * no facade bound the persisted value is used verbatim, so a Work that already names a plugin id
 * still resolves; an alias that cannot be normalised is refused downstream, never guessed.
 */
function deployProviderPluginId(
    providerId: string | null | undefined,
    deployFacade?: DeployFacadeService,
): string {
    const value = typeof providerId === 'string' ? providerId.trim() : '';
    if (!value) {
        return '';
    }
    const resolve = (deployFacade as { resolveProviderId?: (id: string) => string } | undefined)
        ?.resolveProviderId;
    return typeof resolve === 'function' ? resolve.call(deployFacade, value) : value;
}

/**
 * `ew-<slug ≤ 30>-<first 8 hex of workId>` — plan §4.1:387.
 *
 * **This is a deliberate second implementation of the k8s plugin's `appNamespaceName`
 * (`packages/plugins/k8s/src/app/app-names.ts:142-145`), and it is load-bearing rather than
 * tidy.** The agent must not import `@ever-works/k8s-plugin` (R-5: "the agent never imports
 * `@ever-works/k8s-plugin`", `plan.md:929-934`), and `@ever-works/contracts` carries no namespace
 * helper, so the rule is written here exactly as T60 already wrote the verification half of it
 * (`app-verification-target.service.ts:89-95`). The two agree on every input: the renderer takes
 * `ref.namespace` verbatim, and a namespace re-derived into a *different* name would destroy the
 * wrong namespace.
 *
 * It is the **fallback**: the authority is `work_app_runtime_states.namespace`, frozen at the first
 * `prepare-namespace` (plan §4.1, §9.9). This derivation is what answers while T17/T69 have not
 * landed, and it is what a Work that has never been prepared resolves to.
 */
export function appNamespaceName(workSlug: string, workId: string): string {
    const slug = sanitiseLabel(workSlug, APP_SLUG_MAX_LENGTH) || APP_NAMESPACE_FALLBACK_SLUG;
    const suffix = `-${hexSuffix(workId, 8)}`;
    const room = Math.max(1, APP_NAMESPACE_MAX_LENGTH - suffix.length);
    const head = sanitiseLabel(`${APP_NAMESPACE_PREFIX}${slug}`, room);
    return `${head || APP_NAMESPACE_FALLBACK_SLUG}${suffix}`;
}

/**
 * The first `length` hex characters of an identifier, falling back to the first `length` hex of its
 * SHA-256 digest when the id carries fewer (`app-names.ts:125-135`) — still pure, so a namespace is
 * never re-derived into a different name.
 */
export function hexSuffix(value: string, length: number): string {
    const size = Math.max(1, Math.floor(length));
    const raw = String(value ?? '');
    const hex = raw.toLowerCase().replace(/[^0-9a-f]/g, '');
    if (hex.length >= size) {
        return hex.slice(0, size);
    }
    return createHash('sha256').update(raw).digest('hex').slice(0, size);
}

/** The DNS-1123 label reduction of plan §4.1's names, with no trailing hyphen after truncation. */
function sanitiseLabel(value: unknown, maxLength: number): string {
    const limit = Math.max(1, Math.floor(maxLength));
    const sanitised = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-z0-9-]+/g, '-')
        .replace(/-+/g, '-')
        .replace(/^-+|-+$/g, '');
    return sanitised.slice(0, limit).replace(/-+$/, '');
}

/**
 * An optional App member, bound to the plugin, or `undefined` when the **materialised** plugin does
 * not really implement it.
 *
 * The binding matters as much as the check: the seams call the member detached
 * (`access.destroyApp(ref, credential, …)`), so an unbound method would lose `this` and fail inside
 * the plugin. And the check must be made here rather than at the call site, because a cold
 * `lazy-plugin-proxy.ts` stub answers `typeof plugin.anything === 'function'` for a member that does
 * not exist and only throws when it is called.
 */
export function bindAppMember<T>(
    plugin: IDeploymentPlugin | undefined,
    name: string,
): T | undefined {
    const member = (plugin as unknown as Record<string, unknown> | undefined)?.[name];
    if (typeof member !== 'function') {
        return undefined;
    }
    return (member as (...args: unknown[]) => unknown).bind(plugin) as unknown as T;
}

/* -------------------------------------------------------------------------- *
 * The service
 * -------------------------------------------------------------------------- */

/**
 * The plugin-and-credential facade of §2.1, and the implementation of both seams T58 and T60
 * declared. Constructed everywhere `FacadesModule` is imported; callable only in the worker.
 */
@Injectable()
export class AppRuntimeFacadeService
    implements AppRuntimeDeletionFacade, AppRuntimeVerificationFacade
{
    private readonly logger = new Logger(AppRuntimeFacadeService.name);

    constructor(
        private readonly registry: PluginRegistryService,
        // The Work is the first read of every path: it carries `deployProvider`, the slug the
        // namespace derives from, the data-repository owner the cluster matrix is keyed on, and the
        // user whose Work-scoped plugin settings the credential comes from.
        @Optional() private readonly works?: WorkRepository,
        @Optional() private readonly deployFacade?: DeployFacadeService,
        @Optional()
        @Inject(APPS_TIER_POLICY)
        private readonly tierPolicy?: AppsTierPolicy,
        @Optional()
        @Inject(WORK_APP_RUNTIME_STATES)
        private readonly runtimeStates?: AppRuntimeStateTargetStore,
    ) {}

    /* ---------------------------------------------------------------------- *
     * The two seams T58 and T60 declared
     * ---------------------------------------------------------------------- */

    /**
     * `AppRuntimeDeletionFacade.resolveDeletionTarget` — everything T58's `delete-app-work` op
     * needs to remove one Work's runtime (`app-runtime-deletion.service.ts:442-461`).
     *
     * The `destroyApp` it hands back is the resolved plugin's own method **on both targets**: on
     * `ever-works-apps` that method is the apps-tier plugin's, which maps to APW-10's
     * `removeWork(workId, { deleteData })` (R-5, `plan.md:1500-1503`). Nothing here branches on the
     * target to pick a different seam — there is only ever one plugin for a target.
     */
    async resolveDeletionTarget(
        workId: string,
    ): Promise<AppRuntimeDeletionAccess | { unavailable: AppWorkDeletionCode }> {
        requireAppClusterWorkerContext('resolveDeletionTarget');

        const resolved = await this.resolveClusterAccess(workId);
        if (resolved.outcome === 'refused') {
            return { unavailable: deletionCodeFor(resolved.refusal) };
        }

        const { access } = resolved;
        return {
            target: access.target,
            ref: access.ref,
            credential: access.credential,
            destroyApp: bindAppMember<
                (
                    ref: AppTargetRef,
                    credential: string,
                    opts: { deleteVolumes: boolean },
                ) => Promise<AppDestroyResult>
            >(access.plugin, 'destroyApp'),
        };
    }

    /**
     * `AppRuntimeVerificationFacade.resolveVerificationTarget` — everything T60's three verification
     * ops need (`app-verification-target.service.ts:483-527`).
     *
     * The **target is decided before any credential exists**, and that ordering is the point: a
     * verification runs on your own cluster only (§4.12:638), so a Work on the managed tier is
     * refused without `AppsTierPolicy.resolveClusterCredential` ever being called. Minting a
     * control-namespace credential for a path that must not use it is exactly what R-5 forbids.
     */
    async resolveVerificationTarget(
        workId: string,
    ): Promise<AppVerificationAccess | { unavailable: AppVerificationRefusalCode }> {
        requireAppClusterWorkerContext('resolveVerificationTarget');

        const target = await this.resolveWorkTarget(workId);
        if (target.outcome === 'refused') {
            return { unavailable: verificationCodeFor(target.refusal) };
        }
        if (target.target !== 'your-cluster') {
            return { unavailable: 'target_not_your_cluster' };
        }

        const resolved = await this.resolveYourCluster(target.work);
        if (resolved.outcome === 'refused') {
            return { unavailable: verificationCodeFor(resolved.refusal) };
        }

        const { access } = resolved;
        return {
            target: access.target,
            ref: access.ref,
            credential: access.credential,
            checkAppCluster: bindAppMember<
                (credential: string, req: AppClusterCheckRequest) => Promise<AppClusterCheck>
            >(access.plugin, 'checkAppCluster'),
            prepareAppNamespace: bindAppMember<
                (
                    ref: AppTargetRef,
                    credential: string,
                    opts: { isolation: boolean; limitRange: AppLimitRangeInput },
                ) => Promise<{ warnings: Array<{ code: string; message: string }> }>
            >(access.plugin, 'prepareAppNamespace'),
            deployApp: bindAppMember<
                (
                    input: AppRenderInput,
                    credential: string,
                    hooks: AppDeployHooks,
                ) => Promise<AppDeployResult>
            >(access.plugin, 'deployApp'),
            getAppStatus: bindAppMember<
                (
                    ref: AppTargetRef,
                    credential: string,
                    spec: AppStatusSpec,
                ) => Promise<AppStatusSnapshot>
            >(access.plugin, 'getAppStatus'),
            destroyApp: bindAppMember<
                (
                    ref: AppTargetRef,
                    credential: string,
                    opts: { deleteVolumes: boolean },
                ) => Promise<AppDestroyResult>
            >(access.plugin, 'destroyApp'),
            // §4.12:646-647's expiry annotation, read back from the namespace. The seam's shape is
            // `(namespace) => …` while the plugin's member is `(ref, credential) => …`, so the
            // binding closes over this Work's ref and credential — the caller supplies only the
            // handle it was given, and can never point the read at another namespace or another
            // credential. `bindAppMember` still decides presence on the MATERIALISED plugin, so a
            // plugin that does not implement the member leaves this `undefined`, which is T60's
            // documented "no expiry known" path (a warning and an empty value).
            readNamespaceExpiry: (() => {
                const read = bindAppMember<
                    (ref: AppTargetRef, credential: string) => Promise<string | null>
                >(access.plugin, 'readNamespaceExpiry');
                if (!read) return undefined;
                return (namespace: string): Promise<string | null> =>
                    read({ ...access.ref, namespace }, access.credential);
            })(),
        };
    }

    /* ---------------------------------------------------------------------- *
     * The general form the two seams are narrow readings of (§9.10)
     * ---------------------------------------------------------------------- */

    /**
     * The plugin, the ref and the credential for a Work's target — what §9.10's op handlers,
     * §5.6's orchestrator and T22's render-input builder are written against.
     *
     * The caller keeps the presence checks for the optional member it needs (refusing
     * `op_unsupported_on_target` when it is missing), which is why this returns the plugin rather
     * than a pre-bound member per capability.
     */
    async resolveClusterAccess(workId: string): Promise<AppRuntimeAccessResult> {
        requireAppClusterWorkerContext('resolveClusterAccess');

        const target = await this.resolveWorkTarget(workId);
        if (target.outcome === 'refused') {
            return { outcome: 'refused', refusal: target.refusal };
        }
        if (target.target === 'none') {
            return { outcome: 'refused', refusal: 'target_none' };
        }
        if (target.target === 'ever-works-apps') {
            return this.resolveTier(target.work);
        }
        return this.resolveYourCluster(target.work);
    }

    /* ---------------------------------------------------------------------- *
     * The target
     * ---------------------------------------------------------------------- */

    /**
     * Which target this Work is on, and the Work itself.
     *
     * The runtime-state row is the authority when it carries a target (the owner may have changed
     * it with `PUT :id/app-target`, and `plan.md:1163-1169` keeps that column as the deployed
     * choice). Absent a row, the target is derived from the Work's persisted `deployProvider` by
     * APW-06 T17's FR-63 rule (`tasks.md:306-311`): the managed id means the managed target, a
     * provider that is a loaded App-capable plugin means `your-cluster`, anything else means `none`.
     *
     * A **throwing** row is not the same thing as an absent one, and it is never read as "nothing
     * was deployed": the truth is unknown, so the answer is `runtime_state_unreadable` and nothing
     * is dialled.
     */
    private async resolveWorkTarget(
        workId: string,
    ): Promise<
        | { outcome: 'work'; work: Work; target: AppDeployTarget }
        | { outcome: 'refused'; refusal: AppRuntimeFacadeRefusal }
    > {
        const work = await this.loadAppWork(workId);
        if (!work) {
            return { outcome: 'refused', refusal: 'not_found' };
        }

        if (this.runtimeStates && typeof this.runtimeStates.getOrCreate === 'function') {
            let row: AppRuntimeStateTargetView | null | undefined;
            try {
                row = await this.runtimeStates.getOrCreate(work.id);
            } catch (error) {
                this.logger.warn(
                    `App runtime state could not be read for work ${work.id}, so its target is ` +
                        `unknown: ${errorText(error)}`,
                );
                return { outcome: 'refused', refusal: 'runtime_state_unreadable' };
            }

            const stored = normaliseTarget(row?.target);
            if (stored) {
                return { outcome: 'work', work, target: stored };
            }
        }

        return { outcome: 'work', work, target: await this.deriveTargetFromProvider(work) };
    }

    /** APW-06 T17's FR-63 rule, applied to the Work's own persisted choice. */
    private async deriveTargetFromProvider(work: Work): Promise<AppDeployTarget> {
        const pluginId = this.providerPluginId(work);
        if (!pluginId) {
            return 'none';
        }
        if (pluginId === APP_MANAGED_DEPLOY_PROVIDER_ID) {
            return 'ever-works-apps';
        }

        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            return 'none';
        }

        const plugin = await this.materialise(registered);
        return plugin && this.isAppDeploymentTarget(registered, plugin, 'your-cluster')
            ? 'your-cluster'
            : 'none';
    }

    /**
     * The plugin id the Work's `deployProvider` names, normalised by the deploy facade's own alias
     * rule (see {@link deployProviderPluginId}).
     */
    private providerPluginId(work: Work): string {
        return deployProviderPluginId(work?.deployProvider, this.deployFacade);
    }

    /* ---------------------------------------------------------------------- *
     * `your-cluster` — the member's own cluster and their own kubeconfig
     * ---------------------------------------------------------------------- */

    private async resolveYourCluster(work: Work): Promise<AppRuntimeAccessResult> {
        const pluginId = this.providerPluginId(work);
        if (!pluginId) {
            return { outcome: 'refused', refusal: 'target_unavailable' };
        }

        const registered = this.registry.get(pluginId);
        if (!registered || registered.state !== 'loaded') {
            this.logger.warn(
                `No loaded deployment plugin named '${pluginId}' for work ${work.id}'s target.`,
            );
            return { outcome: 'refused', refusal: 'target_unavailable' };
        }

        const plugin = await this.materialise(registered);
        if (!plugin || !this.isAppDeploymentTarget(registered, plugin, 'your-cluster')) {
            this.logger.warn(
                `The plugin '${pluginId}' does not serve an App Work on 'your-cluster' ` +
                    `(work ${work.id}).`,
            );
            return { outcome: 'refused', refusal: 'target_unavailable' };
        }

        if (
            !this.deployFacade ||
            typeof this.deployFacade.getPluginAndTokenAndSettings !== 'function'
        ) {
            this.logger.warn(
                `No deploy facade is bound, so work ${work.id}'s Work-scoped kubeconfig cannot be read.`,
            );
            return { outcome: 'refused', refusal: 'cluster_unreachable' };
        }

        let resolved: Awaited<ReturnType<DeployFacadeService['getPluginAndTokenAndSettings']>>;
        try {
            resolved = await this.deployFacade.getPluginAndTokenAndSettings({
                workId: work.id,
                userId: work.userId,
            });
        } catch (error) {
            // `NoDeployCredentialsError` / `DeployProviderNotFoundError` / a settings read that
            // failed: all of them mean the same thing here — no credential could be assembled.
            this.logger.warn(
                `App runtime credential unavailable for work ${work.id}: ${errorText(error)}`,
            );
            return { outcome: 'refused', refusal: 'cluster_unreachable' };
        }

        // The credential must belong to the plugin we are about to dial with it: handing one
        // plugin's kubeconfig to another is the failure this check exists to make impossible.
        const credentialPluginId =
            typeof resolved?.plugin?.id === 'string' ? resolved.plugin.id : '';
        if (credentialPluginId !== pluginId) {
            this.logger.warn(
                `Work ${work.id}'s credential belongs to '${credentialPluginId || 'nothing'}', ` +
                    `not to the resolved plugin '${pluginId}'.`,
            );
            return { outcome: 'refused', refusal: 'target_unavailable' };
        }

        const settings = (resolved?.settings ?? {}) as Record<string, unknown>;
        const clusterSource = normaliseClusterSource(settings.clusterSource);
        if (clusterSource !== APP_CUSTOM_KUBECONFIG_CLUSTER_SOURCE) {
            // §5.6 step 3: "`clusterSource` must be `custom-kubeconfig` (any other value →
            // `target_not_checked`)". A platform-managed source resolves a kubeconfig held in the
            // platform's ENVIRONMENT, and an App Work never uses one: this facade refuses before
            // any such resolution could happen, which is also why it never reads those variables.
            this.logger.warn(
                `App Work ${work.id} may not use cluster source ` +
                    `'${clusterSource ?? 'none'}'; 'custom-kubeconfig' is required.`,
            );
            return { outcome: 'refused', refusal: 'target_not_checked' };
        }

        // The credential is passed through **verbatim**: it is a kubeconfig document, and the value
        // the plugin loads must be the value the member saved. Only emptiness is judged — and the
        // sentinel, which means "a platform-managed kubeconfig will be substituted downstream":
        // there is no such substitution on the App path (the source check above already refused
        // it), so dialling with the sentinel would be dialling with a non-credential.
        const credential = typeof resolved?.token === 'string' ? resolved.token : '';
        if (!credential.trim() || credential === PLATFORM_MANAGED_KUBECONFIG_SENTINEL) {
            this.logger.warn(`App Work ${work.id} has no usable Work-scoped kubeconfig.`);
            return { outcome: 'refused', refusal: 'cluster_unreachable' };
        }

        const failure = validateClusterSourceForOwner(work.getRepoOwner('data'), clusterSource, {
            hasKubeconfig: true,
        });
        if (failure) {
            this.logger.warn(
                `App Work ${work.id} refused by the cluster-source matrix (${failure.code}).`,
            );
            return { outcome: 'refused', refusal: 'target_not_checked' };
        }

        const ref = await this.buildRef(work, 'your-cluster', {
            kubeContext: firstNonEmpty(settings.kubeContext),
        });

        return {
            outcome: 'access',
            access: {
                target: 'your-cluster',
                ref,
                credential,
                pluginId,
                plugin,
                clusterSource,
            },
        };
    }

    /* ---------------------------------------------------------------------- *
     * `ever-works-apps` — the managed tier, and only while it is open
     * ---------------------------------------------------------------------- */

    private async resolveTier(work: Work): Promise<AppRuntimeAccessResult> {
        // R-5: `isOpen()` is the ONLY way App Works code learns whether the tier is open, and a
        // policy that is unbound or throwing is a closed tier. Nothing is resolved before this.
        let open = false;
        if (this.tierPolicy && typeof this.tierPolicy.isOpen === 'function') {
            try {
                open = this.tierPolicy.isOpen() === true;
            } catch (error) {
                this.logger.warn(`AppsTierPolicy.isOpen() threw: ${errorText(error)}`);
                open = false;
            }
        }
        if (!open) {
            this.logger.warn(
                `Ever Works Apps is closed, so work ${work.id} cannot be resolved on that target.`,
            );
            return { outcome: 'refused', refusal: 'tier_closed' };
        }

        const chosen = await this.resolveTierPlugin(work);
        if (!chosen) {
            return { outcome: 'refused', refusal: 'target_unavailable' };
        }

        let credential: unknown;
        try {
            credential = await this.tierPolicy.resolveClusterCredential(work.id);
        } catch (error) {
            // `DisabledAppsTierPolicy` throws `cluster_credential_unavailable`; any other failure
            // means the same thing here — there is no control-namespace credential to hand out.
            this.logger.warn(
                `The tier credential could not be resolved for work ${work.id}: ${errorText(error)}`,
            );
            return { outcome: 'refused', refusal: 'cluster_unreachable' };
        }

        // Verbatim, like the Work-scoped kubeconfig: the tier's control-namespace credential is
        // APW-10's own document and this facade only judges whether it is empty.
        const token = typeof credential === 'string' ? credential : '';
        if (!token.trim()) {
            this.logger.warn(`The tier credential for work ${work.id} is empty.`);
            return { outcome: 'refused', refusal: 'cluster_unreachable' };
        }

        const ref = await this.buildRef(work, 'ever-works-apps', { kubeContext: null });

        return {
            outcome: 'access',
            access: {
                target: 'ever-works-apps',
                ref,
                credential: token,
                pluginId: chosen.pluginId,
                plugin: chosen.plugin,
                clusterSource: null,
            },
        };
    }

    /**
     * The enabled deployment plugin that also declares `apps-tier` (`plan.md:135-137`).
     *
     * "Enabled" is the registry's own scoped answer — loaded **and**
     * `isPluginEnabledForScope(pluginId, workId, userId)`
     * (`plugin-registry.service.ts:448-470`) — rather than a bare `state === 'loaded'`, because the
     * plan's word for this path is "enabled" while the `your-cluster` path's word is the provider
     * the Work named.
     *
     * The tie-break, when more than one plugin qualifies, is the registry's own convention: a
     * plugin whose manifest names `apps-tier` in `defaultForCapabilities` wins
     * (`plugin-registry.service.ts:299-305`), and otherwise the first in registration order.
     */
    private async resolveTierPlugin(
        work: Work,
    ): Promise<{ pluginId: string; plugin: AppDeploymentPlugin } | null> {
        let enabled: RegisteredPlugin[] = [];
        try {
            enabled = await this.registry.getEnabledPluginsScoped(
                APP_TIER_CAPABILITY,
                work.id,
                work.userId,
            );
        } catch (error) {
            this.logger.warn(
                `The plugin registry could not list tier plugins: ${errorText(error)}`,
            );
            return null;
        }

        const candidates: Array<{
            pluginId: string;
            plugin: AppDeploymentPlugin;
            registered: RegisteredPlugin;
        }> = [];
        for (const registered of enabled) {
            if (registered.state !== 'loaded') {
                continue;
            }
            const plugin = await this.materialise(registered);
            if (!plugin || !this.isAppDeploymentTarget(registered, plugin, 'ever-works-apps')) {
                continue;
            }
            candidates.push({
                pluginId: registered.plugin.id,
                plugin,
                registered,
            });
        }

        if (!candidates.length) {
            this.logger.warn(
                `No enabled deployment plugin declares the '${APP_TIER_CAPABILITY}' capability ` +
                    `for work ${work.id}.`,
            );
            return null;
        }

        const preferred = candidates.find((candidate) =>
            (candidate.registered.manifest.defaultForCapabilities ?? []).includes(
                APP_TIER_CAPABILITY,
            ),
        );
        const chosen = preferred ?? candidates[0];
        return { pluginId: chosen.pluginId, plugin: chosen.plugin };
    }

    /* ---------------------------------------------------------------------- *
     * Plugin shape, materialisation and the ref
     * ---------------------------------------------------------------------- */

    /**
     * Whether `plugin` really serves `target`, asked of the **materialised** plugin:
     *
     * 1. it declares `deployment` — the class's own declaration or its manifest's, both of which are
     *    capability declarations the registry indexes (`plugin-registry.service.ts:175-180`);
     * 2. `isAppDeploymentPlugin` holds (`supportsApps === true` **and** a real `deployApp`);
     * 3. `apps-tier` is present **iff** the target is the managed one (`plan.md:134-136`: the
     *    `your-cluster` plugin "does **not** declare `apps-tier`").
     *
     * It is a type predicate as well as a check: clause 2 is `isAppDeploymentPlugin`, so a `true`
     * answer means this really is an {@link AppDeploymentPlugin} — which is what lets the callers
     * hand `plugin` to {@link AppRuntimeClusterAccess} without a cast.
     */
    private isAppDeploymentTarget(
        registered: RegisteredPlugin,
        plugin: IDeploymentPlugin,
        target: 'your-cluster' | 'ever-works-apps',
    ): plugin is AppDeploymentPlugin {
        if (!declaresCapability(registered, plugin, PLUGIN_CAPABILITIES.DEPLOYMENT)) {
            return false;
        }
        if (!isAppDeploymentPlugin(plugin)) {
            return false;
        }
        const tier = declaresCapability(registered, plugin, APP_TIER_CAPABILITY);
        return target === 'ever-works-apps' ? tier : !tier;
    }

    /**
     * The real plugin behind a possibly-lazy registry entry, or `null` when materialisation failed.
     *
     * This is the only way to see a plugin's true shape: while cold, the lazy proxy answers a
     * forwarding function for every property it does not define, so `isAppDeploymentPlugin` or a
     * `typeof` probe against a cold stub tells you about the proxy, never about the plugin.
     */
    private async materialise(registered: RegisteredPlugin): Promise<IDeploymentPlugin | null> {
        const plugin = registered?.plugin as
            | (IDeploymentPlugin & { __materialize?: () => Promise<IDeploymentPlugin> })
            | undefined;
        if (!plugin) {
            return null;
        }
        if (typeof plugin.__materialize !== 'function') {
            return plugin;
        }
        try {
            return (await plugin.__materialize()) ?? plugin;
        } catch (error) {
            this.logger.warn(
                `Plugin '${registered.plugin.id}' could not be materialised: ${errorText(error)}`,
            );
            return null;
        }
    }

    /**
     * The ref every plugin call is made with: the Work id, the namespace, the target, and — for
     * `your-cluster` — the kube context the Work's own settings select.
     *
     * The namespace is the runtime-state row's when it has one, because that row is the value
     * frozen at the first `prepare-namespace` (plan §4.1, §9.9); otherwise it is §4.1's derived
     * name. `clusterFingerprint` is passed through untouched — it is what the last Deployment was
     * written against, never something this read recomputes (`plan.md:1005-1007`).
     */
    private async buildRef(
        work: Work,
        target: 'your-cluster' | 'ever-works-apps',
        opts: { kubeContext: string | null },
    ): Promise<AppTargetRef> {
        let row: AppRuntimeStateTargetView | null = null;
        if (this.runtimeStates && typeof this.runtimeStates.getOrCreate === 'function') {
            try {
                row = (await this.runtimeStates.getOrCreate(work.id)) ?? null;
            } catch (error) {
                // Already refused by the target read when it mattered; a second failed read only
                // costs the namespace override, and §4.1's derivation still answers.
                this.logger.warn(
                    `App runtime state could not be re-read for work ${work.id}: ${errorText(error)}`,
                );
            }
        }

        const namespace = firstNonEmpty(row?.namespace) ?? appNamespaceName(work.slug, work.id);
        const fingerprint = firstNonEmpty(row?.clusterFingerprint);

        return {
            workId: work.id,
            namespace,
            target,
            kubeContext: opts.kubeContext,
            ...(fingerprint ? { clusterFingerprint: fingerprint } : {}),
        };
    }

    /**
     * The Work, or `null`.
     *
     * A non-App Work and an unknown id answer the same way, which is T58's own rule for its port
     * ("a Work nobody can read is a Work nobody may delete",
     * `app-runtime-deletion.service.ts:1269-1287`): this facade is reached from an op that was
     * dispatched for a Work id, so distinguishing them would only tell a stranger that a Work
     * exists.
     */
    private async loadAppWork(workId: string): Promise<Work | null> {
        if (!this.works || typeof this.works.findById !== 'function') {
            this.logger.warn('No Work repository is bound, so no App target can be resolved.');
            return null;
        }

        const id = typeof workId === 'string' ? workId.trim() : '';
        if (!id) {
            return null;
        }

        try {
            const work = await this.works.findById(id);
            return work && isAppWorkKind(work.kind) ? work : null;
        } catch (error) {
            this.logger.warn(`Work ${id} could not be read: ${errorText(error)}`);
            return null;
        }
    }
}

/* -------------------------------------------------------------------------- *
 * Internals
 * -------------------------------------------------------------------------- */

/** A plugin capability from the materialised instance or from the manifest that registered it. */
function declaresCapability(
    registered: RegisteredPlugin | undefined,
    plugin: IDeploymentPlugin | undefined,
    capability: string,
): boolean {
    const fromInstance = Array.isArray(plugin?.capabilities) ? plugin.capabilities : [];
    const fromManifest = Array.isArray(registered?.manifest?.capabilities)
        ? registered.manifest.capabilities
        : [];
    return fromInstance.includes(capability) || fromManifest.includes(capability);
}

/**
 * A stored cluster source, normalised to the three `ClusterSource` values.
 *
 * The legacy `k8s-gauzy` alias normalises to `k8s-works` (`deployment-context.resolver.ts:60-65`),
 * which keeps it out of the `custom-kubeconfig` branch — the only branch an App Work may use.
 */
function normaliseClusterSource(value: unknown): ClusterSource | null {
    if (typeof value !== 'string') {
        return null;
    }
    if (value === 'k8s-works' || value === 'k8s-works-shared' || value === 'custom-kubeconfig') {
        return value;
    }
    return value === 'k8s-gauzy' ? 'k8s-works' : null;
}

/** A stored target, when it is one of the three the shared contract defines (R-12). */
function normaliseTarget(value: unknown): AppDeployTarget | null {
    return value === 'none' || value === 'your-cluster' || value === 'ever-works-apps'
        ? value
        : null;
}

/** A trimmed non-empty string, or `null` — never `undefined`, so `??` chains read plainly. */
function firstNonEmpty(value: unknown): string | null {
    if (typeof value !== 'string') {
        return null;
    }
    const trimmed = value.trim();
    return trimmed ? trimmed : null;
}

/**
 * An error as a short, log-safe string. Never a payload, a credential or a kubeconfig: the callers
 * of this helper log provider failures, and a provider message can carry a URL.
 */
function errorText(error: unknown): string {
    if (error instanceof Error) {
        return `${error.name}: ${error.message}`.slice(0, 300);
    }
    return typeof error === 'string' ? error.slice(0, 300) : 'unknown error';
}
