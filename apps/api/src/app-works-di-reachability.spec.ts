import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, relative, sep } from 'node:path';
import {
    Global,
    Inject,
    Injectable,
    Module,
    Optional,
    forwardRef,
    type DynamicModule,
    type Type,
} from '@nestjs/common';
import {
    EXCEPTION_FILTERS_METADATA,
    GLOBAL_MODULE_METADATA,
    GUARDS_METADATA,
    INTERCEPTORS_METADATA,
    MODULE_METADATA,
    OPTIONAL_DEPS_METADATA,
    OPTIONAL_PROPERTY_DEPS_METADATA,
    PARAMTYPES_METADATA,
    PIPES_METADATA,
    PROPERTY_DEPS_METADATA,
    ROUTE_ARGS_METADATA,
    SELF_DECLARED_DEPS_METADATA,
} from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';

/**
 * # Can Nest actually hand every App Works class what it asks for — in the API that ships?
 *
 * ## Why this exists
 *
 * Every App Works collaborator is `@Optional()`, so a token nobody can reach does not crash
 * anything: the class gets `undefined`, takes its "unavailable" branch, and the feature
 * behind it silently never runs. Commit e23c2f844 found the sharpest case of it: NO module
 * of the API imported `AppEnvModule`, so `AppBuildsService`, the prepare runner and the
 * watch runner were built with `undefined` collaborators and every Build failed closed —
 * while every unit spec passed (each constructs its subject by hand) and the dormancy
 * register (`packages/agent/src/app-runtime/__tests__/app-works-port-dormancy.spec.ts`)
 * counted the tokens as BOUND, because it only asks whether SOME module's `providers`
 * metadata names a token, never whether the module that DECLARES the consumer can reach it.
 *
 * This spec asks that second question, for the real graph, and is exact about the answer.
 *
 * ## What it does, and why a child process
 *
 * It does not instantiate anything. It imports the API's root module (`ApiModule`) and
 * walks Nest's module graph through decorator metadata the way Nest's own scanner does
 * (class modules, `forRoot`/`forFeature`/`register` dynamic modules, `forwardRef` and
 * `Promise` imports, `@Global()` and `global: true`), then applies Nest's own resolution
 * rule (`Injector.lookupComponentInImports`) to every constructor and property dependency:
 * a token resolves from the module that DECLARES the provider when that module provides it,
 * when one of its imports provides AND exports it (following re-exported modules), or when
 * a `@Global()` module provides AND exports it.
 *
 * The walk runs in a child `node` process, because importing `ApiModule` under this app's
 * jest does not work and could not be trusted if it did: ts-jest type-checks the whole API
 * program (it ran out of an 8 GB heap), and api jest's `^@src/(.*)$` mapper hands AGENT files
 * the API's `@src/notifications`, `@src/activity-log/activity-log.module` and five other
 * same-named files, which builds a different graph from the one the API boots (and closes an
 * import cycle that leaves `CurrentUser` undefined). The child compiles `.ts` with
 * `@swc/core` and the exact options `nest build -b swc` uses — so decorator metadata is the
 * metadata the running API has — resolves each package's `paths` alias against THAT
 * package's tsconfig, as the per-package SWC build does, and maps `@ever-works/*` with api
 * jest's own `moduleNameMapper`, so `@ever-works/agent` is its source here too.
 *
 * That compiler choice is load-bearing: `BuildFacadeService`'s
 * `registry: PluginRegistryService | undefined` is `PluginRegistryService` to tsc (the agent
 * sets `strictNullChecks: false`) and `Object` to SWC — and SWC is what ships
 * (`packages/agent/dist/app-builds/build-facade.service.js`). Every ts-jest spec sees a
 * registry; the API never gets one.
 *
 * ## Who is a subject
 *
 * Every provider, controller, enhancer, middleware and module class of the walked graph. One
 * declared in the App Works surface (below), or in an App Works module, has EVERY dependency
 * checked. Any other class is checked only for the App Works tokens it asks for (a token the
 * surface declares) — the defect does not stop at the surface's edge: `DeployFacadeService`,
 * `WorkLifecycleService` and `TriggerInternalController` all hold App Works collaborators
 * `@Optional()`, and a gap there is exactly as silent.
 *
 * ## The five checks, each exact in both directions
 *
 *   1. Every unresolved `@Optional()` dependency of a subject is in {@link EXPECTED_UNBOUND}
 *      or {@link OPEN_API_GAPS}, and every entry there is still unresolved. A REQUIRED one
 *      would stop the API booting, so none is allowed at all (if one appears, suspect this
 *      walker first).
 *   2. Every App Works module class is in the API graph, or in
 *      {@link EXPECTED_UNREACHABLE_MODULES}.
 *   3. Every LIVE `ModuleRef` lookup in the App Works sources (`getOptionalProvider(ref, X)`,
 *      `ref.get(X)`) finds its target in the graph, or is in {@link EXPECTED_LAZY_MISSES}.
 *   4. The same as (1) for the Trigger worker contexts the App Works tasks boot
 *      (`packages/tasks/src/tasks/trigger/app-*.ts`), against
 *      {@link EXPECTED_WORKER_UNBOUND} and {@link OPEN_WORKER_GAPS}. `packages/tasks` is
 *      compiled the way its bundle compiles it (`@trigger.dev/build`'s
 *      `emitDecoratorMetadata`: `ts.transpileModule` with the tasks tsconfig). The bundle reads
 *      the agent's SWC-built `dist`; this spec reads the agent's source through the same SWC
 *      options, so the metadata is the same and the tokens are the same objects as in the API
 *      walk — with no dependency on a fresh build.
 *   5. Every `createRemoteProxy(api, 'Name')` a worker context of (4) is built from lands on
 *      something: `TriggerInternalController`'s `remoteMap` has `Name`, and the constructor
 *      parameter behind it resolves in the API graph — or the worker's call answers
 *      "Unknown remote target" — else it is in {@link EXPECTED_REMOTE_MISSES}. The lean RPC
 *      roots (`AppBuildPrepareWorkerModule`, …) have no App Works subject at all; this is the
 *      check that covers them.
 *
 * The walker itself is checked first, against a control graph that exercises every rule it
 * models and that a REAL Nest container compiles: what the walker calls unresolved is
 * exactly what the container leaves `undefined`.
 *
 * An `EXPECTED_*` entry carries a line that says the token is unbound ON PURPOSE today and
 * which task binds it — a line that predates the measurement, not one written to justify it.
 * A gap with no such line is not an allow-list entry: it is the thing this spec exists to turn
 * red. When it cannot be closed where it was found (another lane's file, an owner decision), it
 * goes in an `OPEN_*` list with where it is routed — kept exact both ways, and never counted as
 * intended.
 *
 * ## Reading a red row
 *
 * `Module | subject | TOKEN  [constructor[i] of file]  — why`. The module is the one that
 * DECLARES the subject, because that is where Nest resolves it; "why" names every module
 * that does provide the token and the reason the declaring module cannot see it (not
 * imported, provided but not exported, reached only through a module that does not re-export
 * it, `@Global()` without the export, or provided only by a module nothing imports). An
 * allow-listed token that starts resolving fails the "stale" case on purpose: delete the
 * entry and say in the commit what now works.
 *
 * ## What the walker does not see
 *
 *   - It answers "can Nest resolve it", not "WHICH instance": when two modules provide the
 *     same class, the one Nest picks depends on import order, which this does not model.
 *   - Only third-party enhancers are skipped (Nest's own pipes resolve their own options);
 *     an enhancer given as an instance has no dependencies to resolve.
 *   - Middleware is read by calling each module's `configure()` on an uninstantiated prototype
 *     with a recording consumer (one that throws there is a limitation, and fails the run).
 *   - A lazy lookup is seen only when its token is a bare identifier, and liveness is judged
 *     per FILE (a file that registers anything in the graph counts as live).
 *     `ModuleRef.resolve()`/`create()` and `LazyModuleLoader` are not scanned.
 *   - Env-dependent module lists are read with this process's env (`E2eSeedController` is
 *     in `AppLauncherModule` only when its flag is set).
 *   - A tsconfig `extends` is not followed for `paths` (no package uses it today).
 *   - `@ever-works/tasks` is read from its BUILT `dist` in the API walk, as the API itself and
 *     api jest read it; a stale local `dist` can skew what `TriggerModule` exports here.
 *   - Check 5 sees a remote proxy only when its name is a string literal in a task file that
 *     boots the context or in a `packages/tasks` file declaring one of its modules, and reads
 *     `remoteMap` as `Name: <expression mentioning this.<constructor parameter>>`.
 *   - A class outside the surface is a subject only through a token the surface DECLARES; an
 *     App Works collaborator asked for by a type-erased `Object` there (a type-only import) is
 *     invisible to check 1 — a real container spec for that class is what catches it.
 */

/* -------------------------------------------------------------------------- *
 * The allow-lists
 * -------------------------------------------------------------------------- */

interface Expected {
    /** The key the walker prints: `Module | subject | TOKEN`. */
    readonly key: string;
    /** Why it is unbound today, in one line. */
    readonly reason: string;
    /** The line that says so, and the task that binds it. */
    readonly source: string;
}

/**
 * A gap this spec FOUND and could not close where it was found — a defect or an undecided
 * classification, never a deliberate absence. Kept exact both ways like every list here, so
 * the suite stays green without calling the gap intended, and the entry has to be deleted
 * (or moved to an `EXPECTED_*` list with a real source) the day it changes.
 */
interface OpenGap extends Expected {
    /** Who closes it: the lane, task or owner decision it is waiting on. */
    readonly routedTo: string;
}

/**
 * The `@Optional()` dependencies the API graph deliberately leaves `undefined` today.
 *
 * Sorted by key. Shrinking it is the job; growing it needs a line in a plan, a task or a
 * module docstring that says the token is unbound on purpose until a named task.
 */
const EXPECTED_UNBOUND: readonly Expected[] = [
    {
        key: 'AppBuildsModule[agent] | AppBuildPullTokenService | APP_BUILD_PLATFORM_SETTINGS_WRITER',
        reason: '`PluginSettingsService.writePlatformManagedWorkSettings` does not exist yet; the port waits for it.',
        source: 'packages/agent/src/app-builds/app-build-pull-token.service.ts:43-52 (APW-05 T17; plan §4.12:1116-1119)',
    },
    {
        key: 'AppBuildsModule[agent] | AppBuildsService | APP_BUILD_EDIT_ACCESS',
        reason: 'Provisional port for the Builds controller ownership read; unbound ⇒ `canEdit: false`.',
        source: 'packages/agent/src/app-builds/app-builds.service.ts:316-321; APW-05 T23 (tasks.md:548-556)',
    },
    {
        key: 'AppBuildsModule[agent] | AppBuildsService | APP_PROVISION_EVENTS_PORT',
        reason: "APW-04's provisioner events port; the provisioner is not in this tree.",
        source: 'docs/specs/features/app-works/CONTRACTS.md:366 (added by APW-04); APW-04 T19 (tasks.md:307,326)',
    },
    {
        key: 'AppDependenciesModule | AppDependenciesService | APP_DEPENDENCY_CLUSTER_ACCESS',
        reason: 'Worker-only by design: its swap, `AppRuntimeFacadeService`, refuses outside the isolated worker and no dependency provider is dialled from the API (FR-5); unbound, a cluster call reports `mayRemain`.',
        source: 'packages/agent/src/app-dependencies/app-dependencies.service.ts:308-329; packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:22-30',
    },
    {
        key: 'AppDependenciesModule | AppDependenciesService | APP_DEPENDENCY_SPEC_SOURCE',
        reason: "APW-07's module owner binds the dependency spec source (T25); unwritten, so `reconcile` fails closed `specUnavailable` and nothing is created or dispatched.",
        source: 'packages/agent/src/app-dependencies/app-dependencies.service.ts:230-265 (APW-07 T25, tasks.md:380)',
    },
    {
        key: 'AppDependenciesModule | AppDependenciesService | APP_RUNTIME_EVENT_SINK',
        reason: "§9.8's ports module binds it (to the API's EventEmitter2) and is unwritten.",
        source: 'packages/agent/src/app-runtime/ports.ts:278-287; APW-06 T73 (APW-06/tasks.md:1271-1276)',
    },
    {
        key: 'AppDependenciesModule | AppDependenciesService | APP_RUNTIME_TARGET',
        reason: "§9.8's ports module is its single provider and is unwritten; the worker binds the fail-closed default meanwhile.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:107-125 (APW-06 T73, APW-06/tasks.md:1271-1276)',
    },
    {
        key: 'AppDeployRequestModule | AppDeployPreconditionsService | APPS_TIER_POLICY',
        reason: "APW-10's tier policy is unwritten in this tree.",
        source: 'packages/agent/src/app-runtime/app-deploy-request.module.ts:73; APW-10 T27 (tasks.md:466,475)',
    },
    {
        key: 'AppDeployRequestModule | AppDeployPreconditionsService | APP_DEPLOY_HOST_SOURCE',
        reason: '`AppHostsService` exists but its eight stores are unbound, so binding it would answer null; the check is advisory.',
        source: 'packages/agent/src/app-runtime/app-deploy-request.module.ts:69-72; app-deploy-preconditions.service.ts:249 (APW-06 T26)',
    },
    {
        key: 'AppDeployRequestModule | AppLicenseGate | APP_LICENSE_SERVICE',
        reason: "APW-03's licence service is unwritten; the gate answers its documented unreadable verdict (managed target refused, your cluster warned).",
        source: 'packages/agent/src/app-runtime/app-license-gate.ts:78-109 (APW-03 T42, tasks.md:728)',
    },
    {
        key: 'AppEnvModule | AppEnvService | APP_ENV_ACTIVITY',
        reason: 'Provisional: T26 owns `app-env.activity.ts` and the `ActivityActionType.APP_ENV` member it writes with.',
        source: 'packages/agent/src/app-env/app-env.service.ts:331-341,373 (APW-07 T26)',
    },
    {
        key: 'AppEnvModule | AppEnvService | APP_ENV_ACTOR_NAMES',
        reason: 'Provisional: the swap is `useExisting: WorkMemberService`, which has no `nameOf` yet.',
        source: 'packages/agent/src/app-env/app-env.service.ts:246-260 (owned by APW-01)',
    },
    {
        key: 'AppEnvModule | AppEnvService | APP_ENV_BUILD_FINGERPRINTS',
        reason: 'Provisional: the swap target (`WorkBuildService`) does not exist; FR-24 build flag reads the resolver meanwhile.',
        source: 'packages/agent/src/app-env/app-env.service.ts:283-296 (APW-05)',
    },
    {
        key: 'AppEnvModule | AppEnvService | APP_ENV_DEPLOY_FINGERPRINTS',
        reason: 'Provisional: the swap is `AppRuntimeFacadeService`, which is worker-only by design.',
        source: 'packages/agent/src/app-env/app-env.service.ts:299-311 (APW-06); app-works-port-dormancy.spec.ts:59-60',
    },
    {
        key: 'AppLauncherModule[agent] | AppLauncherService | APPS_TIER_POLICY',
        reason: "APW-10's tier policy is unwritten in this tree.",
        source: 'docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md:466,475 (APW-10 T27)',
    },
    {
        key: 'AppLauncherModule[agent] | AppLauncherService | APP_PUBLISHED_HOSTS',
        reason: "APW-06's `AppHostsService` binds it and its stores are unbound; unbound, the FR-16 order applies.",
        source: 'packages/agent/src/app-launcher/managed-host-root.resolver.ts:117-130 (APW-06 T26)',
    },
    {
        key: 'AppLauncherModule[agent] | AppLauncherService | APP_SPEC_DISPLAY_NAMES',
        reason: "APW-03's display-name reader; unbound, the launcher shows the Work's own name.",
        source: 'packages/agent/src/app-launcher/app-launcher.service.ts:238 (bound by APW-03)',
    },
    {
        key: 'AppLauncherModule[api] | LauncherDelegatedCorsMiddleware (middleware) | Object',
        reason: 'A test seam (`origins?: readonly string[]`), never a DI token; `@Optional()` is what lets the API boot.',
        source: 'apps/api/src/app-launcher/launcher-delegated-cors.middleware.ts:142-146; apps/api/src/__tests__/nest-injectable-constructor.spec.ts:4-20',
    },
    {
        key: 'AppLauncherModule[api] | PlatformCatalogService | PLATFORM_CATALOG_FETCH',
        reason: 'Unbound in production on purpose: the service uses `globalThis.fetch`; specs bind it.',
        source: 'apps/api/src/app-launcher/platform-catalog.service.ts:127-132',
    },
    {
        key: 'AppWorksModule[agent] | APP_SOURCE_CATALOG_PORT (useClass AppSourceCatalogAdapter) | APP_BLUEPRINT_APPLY_SERVICE',
        reason: 'A Blueprint match stays behind the apply gate until T28 binds the apply service.',
        source: 'docs/specs/features/app-works/APW-03-app-spec-and-catalog/tasks.md:496 (APW-03 T28)',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInitializerService | APP_BLUEPRINT_APPLY_SERVICE',
        reason: "The ready handler's apply step; owned by APW-03 T28.",
        source: 'packages/agent/src/app-works/app-source-initializer.service.ts:235; apps/api/src/app-works/app-works.module.ts:69-79',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInitializerService | APP_LICENSE_SERVICE',
        reason: "APW-03's licence service is unwritten in this tree.",
        source: 'packages/agent/src/app-runtime/app-license-gate.ts:108 (APW-03 T42, tasks.md:728)',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInitializerService | APP_PROVISIONING_SERVICE',
        reason: "APW-04's provisioner is not in this tree.",
        source: 'packages/agent/src/app-works/app-source-initializer.service.ts:267; apps/api/src/app-works/app-works.module.ts:69-79 (APW-04)',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInitializerService | AppSpecService',
        reason: "The agent module's COPY, which deliberately imports neither AppSpecModule nor WorkModule; the wired copy is the API module's.",
        source: 'apps/api/src/app-works/app-works.module.ts:138-144 (APW-01 T15)',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInitializerService | WorksConfigService',
        reason: "The agent module's COPY (see the entry above); `WorksConfigService` is provided beside the wired copy.",
        source: 'apps/api/src/app-works/app-works.module.ts:133-144 (APW-01 T15)',
    },
    {
        key: 'AppWorksModule[agent] | AppSourceInspectorService | APPS_TIER_POLICY',
        reason: "APW-10's tier policy is unwritten in this tree.",
        source: 'docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md:466,475 (APW-10 T27)',
    },
    {
        key: 'AppWorksModule[agent] | AppUpstreamStateService | APP_UPSTREAM_SYNC_DISPATCHER',
        reason: "The sync dispatcher's runtime binding belongs to APW-02 T31.",
        source: 'packages/agent/src/app-works/app-upstream-state.service.ts:434; apps/api/src/app-works/app-works.module.ts:69-79',
    },
    {
        key: 'AppWorksModule[agent] | AppUpstreamStateService | APP_WORK_AGENT_RESOLVER',
        reason: "APW-08's agent-resolution rule is unwritten in this tree.",
        source: 'packages/agent/src/app-works/app-upstream-state.service.ts:392; APW-08 T25 (tasks.md:578-586)',
    },
    {
        key: 'AppWorksModule[agent] | AppUpstreamSyncDispatcherService | APP_UPSTREAM_SYNC_DISPATCHER',
        reason: "The sync dispatcher's runtime binding belongs to APW-02 T31.",
        source: 'packages/agent/src/app-works/app-upstream-state.service.ts:434 (APW-02 T31, tasks.md:469)',
    },
    {
        key: 'AppWorksModule[agent] | AppWorkCreateService | APPS_TIER_POLICY',
        reason: "APW-10's tier policy is unwritten in this tree.",
        source: 'docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md:466,475 (APW-10 T27)',
    },
    {
        key: 'AppWorksModule[agent] | AppWorkCreateService | APP_PROMPTED_VALUES_PORT',
        reason: 'Unbound on purpose: binding it means inventing the actor and ordering APW-07 T24/T25 own.',
        source: 'packages/agent/src/app-runtime/__tests__/app-works-port-dormancy.spec.ts:373-379; app-works/app-prompted-values.port.ts:46-53',
    },
    {
        key: 'AppWorksModule[api] | AppForkReadinessService | APP_PROVISION_EVENTS_PORT',
        reason: "APW-04's provisioner events port; the provisioner is not in this tree.",
        source: 'docs/specs/features/app-works/APW-02-fork-lifecycle/tasks.md:354; APW-04 T19 (tasks.md:307,326)',
    },
    {
        key: 'AppWorksModule[api] | AppSourceInitializerService | APP_BLUEPRINT_APPLY_SERVICE',
        reason: "The ready handler's apply step; owned by APW-03 T28.",
        source: 'apps/api/src/app-works/app-works.module.ts:69-79; APW-03 T28 (tasks.md:530)',
    },
    {
        key: 'AppWorksModule[api] | AppSourceInitializerService | APP_LICENSE_SERVICE',
        reason: "APW-03's licence service is unwritten in this tree.",
        source: 'packages/agent/src/app-runtime/app-license-gate.ts:108 (APW-03 T42, tasks.md:728)',
    },
    {
        key: 'AppWorksModule[api] | AppSourceInitializerService | APP_PROVISIONING_SERVICE',
        reason: "APW-04's provisioner is not in this tree.",
        source: 'apps/api/src/app-works/app-works.module.ts:69-79 (APW-04)',
    },
    {
        key: 'FacadesModule | AppRuntimeFacadeService | APPS_TIER_POLICY',
        reason: "APW-10's tier policy is unwritten; absent, the facade answers `tier_closed`, the fail-closed default. In the API every method refuses (`APP_CLUSTER_IO_IN_API`) before this is read anyway.",
        source: 'packages/agent/src/facades/app-runtime.facade.ts:50-56,85; docs/specs/features/app-works/APW-10-apps-hosting-tier/tasks.md:466 (APW-10 T27)',
    },
    {
        key: 'FacadesModule | AppRuntimeFacadeService | WORK_APP_RUNTIME_STATES',
        reason: 'Worker-only facade: in the API every method throws `APP_CLUSTER_IO_IN_API` before any read, so the row is never read here. Its worker binding is T71 status item (b) (see EXPECTED_WORKER_UNBOUND).',
        source: 'packages/agent/src/facades/app-runtime.facade.ts:50-56,86; docs/specs/features/app-works/APW-06-app-runtime/tasks.md:1220-1234 (APW-06 T71)',
    },
    {
        key: 'WorkModule | WorkLifecycleService | APP_WORK_DELETION_PORT',
        reason: "APW-06 T33 binds `AppRuntimeDeletionService` to it in the API's ports module; unbound, `deleteWork` reads 'no App runtime exists' and deletes the row as before.",
        source: 'packages/agent/src/services/work-lifecycle.service.ts:204-209; packages/agent/src/app-runtime/app-runtime-deletion.service.ts:24-27 (APW-06 T33, APW-06/tasks.md:577)',
    },
];

/**
 * API-graph gaps this spec found that are NOT deliberate, routed to the lane that owns the
 * file (see {@link OpenGap}). Shrinking it is owed, not optional.
 */
const OPEN_API_GAPS: readonly OpenGap[] = [
    {
        key: 'FacadesModule | DeployFacadeService | AppDomainsService',
        reason: "APW-06 T26's App branch of `getDomains`/`addDomain`/`removeDomain`/`verifyDomain` is dead in the API: no API module provides `AppDomainsService` (only the worker's `TriggerAppRuntimeModule` does), so an App Work's custom-domain click takes the website path. The facade's docstring says the opposite ('The module binds `AppDomainsService`', 'In production the module binds it').",
        source: 'packages/agent/src/facades/deploy.facade.ts:137-142,506-507 (found 2026-09-26)',
        routedTo:
            "facades lane (deploy.facade.ts is under another agent's edit) + APW-06 T26 owner: bind `AppDomainsService` where `FacadesModule`'s `DeployFacadeService` can see it (FacadesModule cannot import AppRuntimeStateModule without a cycle, so likely a lazy ModuleRef lookup), or correct the docstring and record the gap in the dormancy register.",
    },
];

/** App Works module classes the API graph deliberately does not import. None today. */
const EXPECTED_UNREACHABLE_MODULES: readonly Expected[] = [];

/** Live `ModuleRef` lookups that deliberately find nothing in the API graph. None today. */
const EXPECTED_LAZY_MISSES: readonly Expected[] = [];

/**
 * Remote proxies of an App Works worker context whose name deliberately lands on nothing in
 * the API (`Root :: remote 'Name'`). None today.
 */
const EXPECTED_REMOTE_MISSES: readonly Expected[] = [];

/**
 * The worker contexts' deliberate gaps, keyed `Root :: TOKEN` — per TOKEN rather than per
 * consumer, because a worker context is one decision about what a process can reach, and a
 * token unbound there is unbound for every class in it (the RED row lists the consumers).
 *
 * Only tokens whose worker binding belongs to an OPEN task or an open decision, named by a line
 * that predates this spec, are here: a class or adapter that does not exist yet, a binding a task
 * text says is owed, or APW-06 T71's own status line (`APW-06/tasks.md:1220-1234`, items (a) and
 * (b)). A worker gap whose only justification was written by the pass that measured it is not an
 * entry — it is in {@link OPEN_WORKER_GAPS}.
 */
const EXPECTED_WORKER_UNBOUND: readonly Expected[] = [
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_DEPENDENCY_SPEC_SOURCE',
        reason: "APW-07's module owner binds the dependency spec source (T25); unwritten.",
        source: 'packages/agent/src/app-dependencies/app-dependencies.service.ts:264 (APW-07 T25, tasks.md:380)',
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_RUNTIME_EVENT_SINK',
        reason: 'The relay (`AppRuntimeEventRelayService`) is APW-06 T28 and is not in this tree.',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:132-133 (APW-06 T28)',
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_RUNTIME_TARGET',
        reason: 'Only a fail-closed default exists until T73 publishes the port; unbound answers the same refusal.',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:107-125 (APW-06 T73)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APPS_DOMAIN_DNS_SERVICE',
        reason: "APW-06's managed-subdomain task is unwritten.",
        source: 'packages/agent/src/app-runtime/app-runtime-deletion.service.ts:525',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_CLUSTER_OP_DISPATCHER',
        reason: 'No cluster-op dispatcher exists in any process yet (unbound in the API too).',
        source: 'packages/agent/src/app-runtime/app-runtime-deletion.service.ts:507 (APW-06 T31/T32); app-works-port-dormancy.spec.ts:349',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_COMMIT_ANCESTRY',
        reason: "APW-02's commit-ancestry reader is unwritten.",
        source: 'packages/agent/src/app-runtime/app-deploy.orchestrator.ts:170 (owned by APW-02)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_DEPLOY_DISPATCHER',
        reason: "The orchestrator's dequeue dispatch: T24 declares the token and T31 binds it; inside the worker it is also the open §5.1/§5.6 dispatcher-gate decision (T71 status item (a)).",
        source: 'packages/agent/src/app-runtime/app-deploy.orchestrator.ts:98-100 (APW-06 T31); APW-06/tasks.md:1228-1232',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_DEPLOY_DISPATCHER_AVAILABILITY',
        reason: 'What "an isolated dispatcher is available" means inside the worker is an open §5.1/§5.6 decision (T71 status item (a)); every dequeued Deployment answers `worker_not_isolated` meanwhile.',
        source: 'docs/specs/features/app-works/APW-06-app-runtime/tasks.md:1228-1232 (APW-06 T71 status (a))',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HEALTH_EGRESS_SOURCE',
        reason: "The narrow adapter over APW-07's source is unwritten (the port is marked provisional where it is declared).",
        source: 'packages/agent/src/app-runtime/app-health.service.ts:722-736',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HOSTS_REBUILD_REQUESTER',
        reason: "APW-05's rebuild requester is unwritten.",
        source: 'packages/agent/src/app-runtime/app-hosts.service.ts:142 (owned by APW-05)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_IMAGE_REFERENCE_RESOLVER',
        reason: '`AppImageReferenceResolver` does not exist yet.',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:131 (APW-06 T72)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_LICENSE_SERVICE',
        reason: "APW-03's `AppLicenseService` does not exist yet.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:134-135 (APW-03 T42)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_PROVISION_EVENTS_PORT',
        reason: "APW-04's provisioner events port; the provisioner is not in this tree.",
        source: 'docs/specs/features/app-works/CONTRACTS.md:366; APW-04 T19 (tasks.md:307,326)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_RUNTIME_EVENT_SINK',
        reason: 'The relay (`AppRuntimeEventRelayService`) is APW-06 T28 and is not in this tree.',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:132-133 (APW-06 T28)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_RUNTIME_NOTIFICATIONS',
        reason: "APW-06 T29's notification producers are unwritten.",
        source: 'packages/agent/src/app-runtime/app-deploy.orchestrator.ts:173 (APW-06 T29)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_TARGET_UPDATED_PORT',
        reason: "APW-04's port; the provisioner is not in this tree.",
        source: 'packages/agent/src/app-runtime/app-lifecycle-ops.service.ts:359 (owned by APW-04)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_UPSTREAM_STATE_READER',
        reason: "APW-02's upstream-state reader adapter is unwritten.",
        source: 'packages/agent/src/app-runtime/app-deploy.orchestrator.ts:167 (owned by APW-02)',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_WORK_DELETION_COMPLETION',
        reason: 'Deletes the Work row; its binding is owed by T33/T58 and, unbound, a finished removal keeps the row (the fail-closed answer).',
        source: 'packages/agent/src/app-runtime/app-runtime-deletion.service.ts:320-331 (APW-06 T33/T58)',
    },
    {
        key: 'TriggerAppRuntimeModule :: WORK_APP_RUNTIME_STATES',
        reason: "§6.4's `WorkAppRuntimeStateRepository` proxy is T71 status item (b); it needs a `remoteMap` name and turns on the health, op, smoke and deletion paths at once.",
        source: 'docs/specs/features/app-works/APW-06-app-runtime/tasks.md:1232 (APW-06 T71 status (b))',
    },
];

/**
 * Worker gaps measured RED on 2026-09-26 and NOT wired by the pass that wired the API graph,
 * whose classification is the OWNER's to make (see {@link OpenGap}). Each names what a binding
 * would need; the per-token detail is in `trigger-app-runtime.module.ts` ("Still open under
 * T71") and `app-dependency-provision.task.ts`. Those docstrings were written by the same pass,
 * so they are evidence, not authority: until the owner either adds these to T71's status line
 * (then they move to {@link EXPECTED_WORKER_UNBOUND}, citing it) or cuts a T71 slice that binds
 * them (then they leave), they stay here, visibly provisional.
 */
const OPEN_WORKER_GAPS: readonly OpenGap[] = [
    {
        key: "AppDependencyProvisionWorkerModule :: 'WorkAppDependencyRepository'",
        reason: "The entity's TypeORM repository (row creation): a remote proxy cannot carry it, so the dependency worker composition needs repository methods first.",
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_DEPENDENCY_CLUSTER_ACCESS',
        reason: "Its swap is `AppRuntimeFacadeService`, which lives in T71's module; this task's lean module is not that one.",
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_DEPENDENCY_CONFIG_CIPHER',
        reason: '`AppEnvCrypto` and its key inside the isolated worker are part of the open dependency worker composition.',
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: APP_DEPENDENCY_PROVISION_DISPATCHER',
        reason: "The runner's re-dispatch; this context imports no job-runtime binding (reported `dispatcherUnavailable`).",
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: AppDependencyFacadeService',
        reason: 'The provider selection lives in the facades graph this lean context does not import.',
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'AppDependencyProvisionWorkerModule :: WorkAppDependencyRepository',
        reason: 'Needs a `remoteMap` name and the row-write redesign above; unbound, every run answers `storeUnavailable` and dials nothing.',
        source: 'packages/tasks/src/tasks/trigger/app-dependency-provision.task.ts:77-88',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_CUSTOM_DOMAIN_STORE',
        reason: "The swap is the proxied `WorkCustomDomainRepository`; bound without the runtime-state row, hosts would ignore the owner's settings.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:155-161',
        routedTo:
            "Owner decision: APW-06 T71 slice (lands with WORK_APP_RUNTIME_STATES) vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_DEPENDENCIES_SERVICE',
        reason: "APW-07's service must run in the worker, and its `@InjectRepository(WorkAppDependency)` writes cannot cross the internal channel.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:170-172',
        routedTo:
            "Owner decision: APW-06 T71 slice (with APW-07 T17) vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_DEPLOY_DEPLOYMENT_STORE',
        reason: "The API's adapter has no `update`, which the orchestrator's view of the token needs; which class carries it is undecided.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:162-164',
        routedTo: "Owner decision: APW-06 T71 slice vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HOSTS_APPS_DOMAIN',
        reason: 'The swap is `config.everWorks.apps`; it lands with the runtime-state row (see APP_CUSTOM_DOMAIN_STORE).',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:155-161',
        routedTo:
            "Owner decision: APW-06 T71 slice (lands with WORK_APP_RUNTIME_STATES) vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HOSTS_DEPLOYMENT_STORE',
        reason: 'The swap is the proxied `WorkDeploymentRepository`; it lands with the runtime-state row (see APP_CUSTOM_DOMAIN_STORE).',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:155-161',
        routedTo:
            "Owner decision: APW-06 T71 slice (lands with WORK_APP_RUNTIME_STATES) vs. an entry in T71's status line.",
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HOSTS_DEPLOY_REQUESTER',
        reason: "Bound to the API's `AppDeployRequestService`; §6.4 lists no proxy, so whether the worker may request a Deployment is undecided.",
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:165-166; docs/specs/features/app-works/APW-06-app-runtime/plan.md:982-989',
        routedTo:
            'Owner decision: may the isolated worker create Deployments (a §6.4 proxy), or is this unbound by design?',
    },
    {
        key: 'TriggerAppRuntimeModule :: APP_HOSTS_WORK_STORE',
        reason: 'The swap is the proxied `WorkRepository`; it lands with the runtime-state row (see APP_CUSTOM_DOMAIN_STORE).',
        source: 'packages/tasks/src/trigger/worker/modules/trigger-app-runtime.module.ts:155-161',
        routedTo:
            "Owner decision: APW-06 T71 slice (lands with WORK_APP_RUNTIME_STATES) vs. an entry in T71's status line.",
    },
];

/* -------------------------------------------------------------------------- *
 * Where things are
 * -------------------------------------------------------------------------- */

const API_ROOT = join(__dirname, '..');
const REPO = join(API_ROOT, '..', '..');
const AGENT_SRC = join(REPO, 'packages', 'agent', 'src');
const API_SRC = __dirname;
const TASKS_SRC = join(REPO, 'packages', 'tasks', 'src');

/** The controller behind `POST /internal/trigger/remote/call`, relative to `API_SRC`. */
const TRIGGER_INTERNAL_CONTROLLER_FILE = 'trigger/trigger-internal.controller.ts';

/**
 * The App Works surface: the directories whose module docstrings carry an `APW-` id
 * (`grep -rl "APW-" --include=*.module.ts`), the API's telemetry binding, and the internal
 * RPC controller with its module — every App Works worker call lands on that controller's
 * `@Optional()` App Works collaborators, so its whole constructor is checked, not only the
 * App Works asks every other class outside the surface is checked for.
 */
const APP_WORKS_AGENT_DIRS = [
    'app-builds',
    'app-dependencies',
    'app-env',
    'app-launcher',
    'app-license',
    'app-runtime',
    'app-spec',
    'app-works',
    'apps-catalog',
    'upstream-pull-requests',
];
const APP_WORKS_API_DIRS = ['app-builds', 'app-launcher', 'app-works'];
const APP_WORKS_API_FILES = [
    'telemetry/app-works-telemetry-binding.module.ts',
    TRIGGER_INTERNAL_CONTROLLER_FILE,
    'trigger/trigger-internal.module.ts',
];

/** The App Works Trigger tasks whose `withWorkerContext` roots the worker check walks. */
const APP_WORKS_TASK_FILE = /^app-.*\.ts$/;

const CHILD_FLAG = 'EW_APP_WORKS_DI_REACHABILITY_CHILD';

/* -------------------------------------------------------------------------- *
 * The report the child writes and the spec reads
 * -------------------------------------------------------------------------- */

interface UnresolvedDependency {
    /** `Module | subject | TOKEN` (prefixed `Root :: ` in a worker context). */
    readonly key: string;
    readonly module: string;
    readonly subject: string;
    readonly subjectFile: string;
    /** Every place the subject asks for the token (`constructor[3]`, a property name, …). */
    at: string;
    readonly token: string;
    /** `false` as soon as ONE of those places is required. */
    optional: boolean;
    readonly providedBy: string[];
    readonly why: string;
}

interface GraphAnalysis {
    readonly modules: number;
    readonly moduleLabels: string[];
    readonly appWorksModules: string[];
    readonly subjects: number;
    readonly dependencies: number;
    readonly unresolved: UnresolvedDependency[];
    readonly missingMetadata: string[];
}

interface UnreachableModule {
    /** The module class name, the allow-list key. */
    readonly key: string;
    readonly file: string;
    readonly provides: string[];
}

interface LazyLookup {
    /** `site | TOKEN (strict|non-strict)`, the allow-list key. */
    readonly key: string;
    readonly live: boolean;
    readonly found: boolean;
    readonly providedBy: string[];
}

interface WorkerContext {
    readonly root: string;
    readonly bootedBy: string[];
    readonly analysis: GraphAnalysis;
    /** Every `createRemoteProxy(api, 'Name')` name this context's files ask for. */
    readonly remoteProxies: string[];
}

/** One `createRemoteProxy(api, 'Name')` of a worker context, judged against the API side. */
interface RemoteTarget {
    /** `Root :: remote 'Name'`, the allow-list key. */
    readonly key: string;
    /** The files that ask for it. */
    readonly askedIn: string[];
    /** `remoteMap.Name` exists and the collaborator behind it resolves in the API graph. */
    readonly resolved: boolean;
    readonly why: string;
}

interface ReachabilityReport {
    readonly api: GraphAnalysis;
    readonly unreachableModules: UnreachableModule[];
    readonly lazy: LazyLookup[];
    readonly workers: WorkerContext[];
    readonly remote: RemoteTarget[];
    readonly limitations: string[];
}

interface ChildRequest {
    readonly repo: string;
    readonly apiRoot: string;
    readonly tasksRoot: string;
    readonly spec: string;
    readonly out: string;
    /** api jest's `moduleNameMapper`, minus its `@src/` rules, `<rootDir>` made absolute. */
    readonly mapper: [string, string[]][];
}

/* -------------------------------------------------------------------------- *
 * The child's loader
 * -------------------------------------------------------------------------- */

/**
 * The child's loader, as plain CommonJS so nothing has to be compiled to start it.
 *
 * `.ts` under `packages/tasks` is compiled as the Trigger bundle compiles it
 * (`ts.transpileModule` with the tasks tsconfig — `@trigger.dev/build`'s
 * `emitDecoratorMetadata`); every other `.ts` by `@swc/core` with `nest build -b swc`'s
 * options (`@nestjs/cli/lib/compiler/defaults/swc-defaults.js`). A `paths` alias
 * (`@src/*`, `@/*`) resolves against the tsconfig of the package that WRITES the import;
 * anything else goes through api jest's own mapper.
 */
const CHILD_BOOTSTRAP = [
    "'use strict';",
    "const Module = require('node:module');",
    "const fs = require('node:fs');",
    "const path = require('node:path');",
    `const request = JSON.parse(process.env.${CHILD_FLAG});`,
    "const fromApi = Module.createRequire(path.join(request.apiRoot, 'package.json'));",
    "const swc = fromApi('@swc/core');",
    "const ts = fromApi('typescript');",
    'const swcOptions = {',
    "    module: { type: 'commonjs' },",
    '    jsc: {',
    "        target: 'es2021',",
    "        parser: { syntax: 'typescript', decorators: true, dynamicImport: true },",
    '        transform: { legacyDecorator: true, decoratorMetadata: true, useDefineForClassFields: false },',
    '        keepClassNames: true,',
    '    },',
    '    minify: false,',
    '    swcrc: false,',
    '};',
    'const tsconfigs = new Map();',
    'function compilerOptionsOf(root) {',
    '    if (!tsconfigs.has(root)) {',
    "        const read = ts.readConfigFile(path.join(root, 'tsconfig.json'), ts.sys.readFile);",
    '        tsconfigs.set(root, ts.convertCompilerOptionsFromJson((read.config && read.config.compilerOptions) || {}, root).options);',
    '    }',
    '    return tsconfigs.get(root);',
    '}',
    "Module._extensions['.ts'] = function (module, filename) {",
    "    const source = fs.readFileSync(filename, 'utf8');",
    '    if (filename.startsWith(request.tasksRoot + path.sep)) {',
    '        const options = { ...compilerOptionsOf(request.tasksRoot), module: ts.ModuleKind.CommonJS, sourceMap: false, inlineSourceMap: false, declaration: false };',
    '        module._compile(ts.transpileModule(source, { fileName: filename, compilerOptions: options }).outputText, filename);',
    '        return;',
    '    }',
    '    module._compile(swc.transformSync(source, { ...swcOptions, filename }).code, filename);',
    '};',
    'function packageRootOf(file) {',
    '    let dir = path.dirname(file);',
    '    while (dir.startsWith(request.repo) && dir !== request.repo) {',
    "        if (fs.existsSync(path.join(dir, 'package.json')) && fs.existsSync(path.join(dir, 'tsconfig.json'))) return dir;",
    '        dir = path.dirname(dir);',
    '    }',
    '    return null;',
    '}',
    'function candidates(spec, parent) {',
    '    const from = parent && parent.filename;',
    "    if (from && !from.includes(path.sep + 'node_modules' + path.sep)) {",
    '        const root = packageRootOf(from);',
    '        if (root) {',
    '            const options = compilerOptionsOf(root);',
    '            const baseUrl = options.baseUrl || root;',
    '            for (const [pattern, targets] of Object.entries(options.paths || {})) {',
    "                const star = pattern.indexOf('*');",
    '                const prefix = star < 0 ? pattern : pattern.slice(0, star);',
    "                const suffix = star < 0 ? '' : pattern.slice(star + 1);",
    '                const hit = star < 0 ? spec === pattern : spec.startsWith(prefix) && spec.endsWith(suffix) && spec.length >= prefix.length + suffix.length;',
    '                if (!hit) continue;',
    "                const middle = star < 0 ? '' : spec.slice(prefix.length, spec.length - suffix.length);",
    "                return targets.map((target) => path.resolve(baseUrl, target.replace('*', middle)));",
    '            }',
    '        }',
    '    }',
    '    for (const [source, targets] of request.mapper) {',
    '        const match = new RegExp(source).exec(spec);',
    "        if (match) return targets.map((target) => target.replace(/\\$(\\d+)/g, (_, i) => match[Number(i)] || ''));",
    '    }',
    '    return null;',
    '}',
    'const resolveFilename = Module._resolveFilename;',
    'Module._resolveFilename = function (spec, parent, isMain, options) {',
    '    const mapped = candidates(spec, parent);',
    '    if (mapped) {',
    '        for (const candidate of mapped) {',
    '            try { return resolveFilename.call(this, candidate, parent, isMain, options); } catch (error) { /* next */ }',
    '        }',
    '    }',
    '    try {',
    '        return resolveFilename.call(this, spec, parent, isMain, options);',
    '    } catch (error) {',
    "        if (spec.startsWith('.') && spec.endsWith('.js')) return resolveFilename.call(this, spec.slice(0, -3), parent, isMain, options);",
    '        throw error;',
    '    }',
    '};',
    'require(request.spec).runReachabilityChild().then(',
    '    () => process.exit(0),',
    '    (error) => { console.error((error && error.stack) || error); process.exit(1); },',
    ');',
].join('\n');

/* -------------------------------------------------------------------------- *
 * The walker — Nest's scanner and injector, reduced to metadata reads
 * -------------------------------------------------------------------------- */

type AnyClass = Type<unknown> & { name: string };

interface ModuleNode {
    /** The class name; `Name[api]` / `Name[agent]` when two classes share one. */
    label: string;
    readonly metatype: AnyClass;
    readonly global: boolean;
    readonly imports: ModuleNode[];
    readonly providerEntries: unknown[];
    readonly providers: Set<unknown>;
    readonly exports: Set<unknown>;
    readonly controllers: AnyClass[];
}

interface Dependency {
    readonly token: unknown;
    readonly optional: boolean;
    readonly at: string;
}

interface Subject {
    readonly module: ModuleNode;
    readonly label: string;
    readonly owner: unknown;
    /**
     * Every dependency for an App Works class; for a class OUTSIDE the surface, only the
     * dependencies whose token the surface declares (it is a subject because it asks for one).
     */
    readonly dependencies: Dependency[];
}

function isForwardReference(value: unknown): value is { forwardRef: () => unknown } {
    return typeof value === 'object' && value !== null && 'forwardRef' in value;
}

function isDynamicModule(value: unknown): value is DynamicModule {
    return typeof value === 'object' && value !== null && 'module' in value;
}

function isCustomProvider(value: unknown): value is { provide: unknown } & Record<string, unknown> {
    return typeof value === 'object' && value !== null && 'provide' in value;
}

function metadataList(key: string, target: object, property?: string | symbol): unknown[] {
    const value: unknown =
        property === undefined
            ? Reflect.getMetadata(key, target)
            : Reflect.getMetadata(key, target, property);
    return Array.isArray(value) ? (value as unknown[]) : [];
}

function tokenLabel(token: unknown): string {
    if (typeof token === 'symbol') return token.description ?? token.toString();
    if (typeof token === 'function') return (token as { name: string }).name || '<anonymous>';
    if (typeof token === 'string') return `'${token}'`;
    return String(token);
}

function unwrap(token: unknown): unknown {
    return isForwardReference(token) ? token.forwardRef() : token;
}

/**
 * `DependenciesScanner.scanForModules`, reduced to what reachability needs: a class module
 * is ONE node; a dynamic module is one node per object (Nest 11's default by-reference
 * module key); `forwardRef` and `Promise` imports resolve as the scanner resolves them; a
 * module's imports, providers, controllers and exports are its class metadata plus its
 * dynamic metadata (`reflectImports` / `reflectProviders` / `reflectExports`); and every
 * module gets `Module.addCoreProviders`' three (itself, `ModuleRef`, `ApplicationConfig`).
 */
async function walkModuleGraph(roots: unknown[]): Promise<ModuleNode[]> {
    const byRef = new Map<unknown, ModuleNode>();
    const nodes: ModuleNode[] = [];
    const dynamicCount = new Map<string, number>();
    const { ModuleRef } = await import('@nestjs/core');
    const { ApplicationConfig } = await import('@nestjs/core/application-config');

    const visit = async (definition: unknown, via: string): Promise<ModuleNode> => {
        let resolved: unknown = definition instanceof Promise ? await definition : definition;
        if (isForwardReference(resolved)) resolved = resolved.forwardRef();
        // `UndefinedModuleException` / `InvalidModuleException` in the real scanner.
        if (!resolved) throw new Error(`An import of ${via} is ${String(resolved)}`);
        const known = byRef.get(resolved);
        if (known) return known;

        const dynamic = isDynamicModule(resolved) ? resolved : undefined;
        const metatype = (dynamic ? dynamic.module : resolved) as AnyClass;
        let label = metatype.name;
        if (dynamic) {
            const count = (dynamicCount.get(label) ?? 0) + 1;
            dynamicCount.set(label, count);
            label = `${label}(dynamic #${count})`;
        }
        const node: ModuleNode = {
            label,
            metatype,
            global:
                dynamic?.global === true ||
                Reflect.getMetadata(GLOBAL_MODULE_METADATA, metatype) === true,
            imports: [],
            providerEntries: [
                ...metadataList(MODULE_METADATA.PROVIDERS, metatype),
                ...(dynamic?.providers ?? []),
            ],
            providers: new Set<unknown>([metatype, ModuleRef, ApplicationConfig]),
            exports: new Set<unknown>(),
            controllers: [
                ...metadataList(MODULE_METADATA.CONTROLLERS, metatype),
                ...(dynamic?.controllers ?? []),
            ] as AnyClass[],
        };
        byRef.set(resolved, node);
        nodes.push(node);
        for (const entry of node.providerEntries) {
            node.providers.add(isCustomProvider(entry) ? entry.provide : entry);
        }
        // `Module.addExportedProviderOrModule`.
        for (const entry of [
            ...metadataList(MODULE_METADATA.EXPORTS, metatype),
            ...(dynamic?.exports ?? []),
        ]) {
            if (isCustomProvider(entry)) node.exports.add(entry.provide);
            else if (isDynamicModule(entry)) node.exports.add(entry.module);
            else node.exports.add(entry);
        }
        for (const entry of [
            ...metadataList(MODULE_METADATA.IMPORTS, metatype),
            ...(dynamic?.imports ?? []),
        ]) {
            node.imports.push(await visit(entry, label));
        }
        return node;
    };

    for (const root of roots) await visit(root, 'root');
    return nodes;
}

/** `Injector.reflectConstructorParams` + `reflectOptionalParams` + `reflectProperties`. */
function classDependencies(cls: AnyClass): Dependency[] {
    const paramtypes = [...metadataList(PARAMTYPES_METADATA, cls)];
    for (const { index, param } of metadataList(SELF_DECLARED_DEPS_METADATA, cls) as {
        index: number;
        param: unknown;
    }[]) {
        paramtypes[index] = param;
    }
    const optional = metadataList(OPTIONAL_DEPS_METADATA, cls) as number[];
    const dependencies: Dependency[] = paramtypes.map((param, index) => ({
        token: unwrap(param),
        optional: optional.includes(index),
        at: `constructor[${index}]`,
    }));
    const optionalKeys = metadataList(OPTIONAL_PROPERTY_DEPS_METADATA, cls) as string[];
    for (const { key, type } of metadataList(PROPERTY_DEPS_METADATA, cls) as {
        key: string;
        type: unknown;
    }[]) {
        dependencies.push({ token: unwrap(type), optional: optionalKeys.includes(key), at: key });
    }
    return dependencies;
}

/** What Nest resolves for one `providers` entry, and the class that implements it. */
function providerDependencies(entry: unknown): { impl?: AnyClass; dependencies: Dependency[] } {
    if (typeof entry === 'function') {
        return { impl: entry as AnyClass, dependencies: classDependencies(entry as AnyClass) };
    }
    if (!isCustomProvider(entry)) return { dependencies: [] };
    if (typeof entry.useClass === 'function') {
        const impl = entry.useClass as AnyClass;
        return { impl, dependencies: classDependencies(impl) };
    }
    if (typeof entry.useFactory === 'function') {
        // `Injector.getFactoryProviderDependencies`, including `{ token, optional }`.
        const inject = (entry.inject as unknown[] | undefined) ?? [];
        return {
            dependencies: inject.map((item, index) => {
                const optionalItem =
                    typeof item === 'object' &&
                    item !== null &&
                    'token' in item &&
                    'optional' in item &&
                    !('prototype' in item);
                return optionalItem
                    ? {
                          token: unwrap((item as { token: unknown }).token),
                          optional: Boolean((item as { optional: unknown }).optional),
                          at: `inject[${index}]`,
                      }
                    : { token: unwrap(item), optional: false, at: `inject[${index}]` };
            }),
        };
    }
    if ('useExisting' in entry) {
        // `Module.addCustomUseExisting` is a factory with `inject: [useExisting]`: required.
        return { dependencies: [{ token: entry.useExisting, optional: false, at: 'useExisting' }] };
    }
    return { dependencies: [] };
}

function providerLabel(entry: unknown, impl?: AnyClass): string {
    if (!isCustomProvider(entry)) return tokenLabel(entry);
    const token = tokenLabel(entry.provide);
    if (impl) return `${token} (useClass ${impl.name})`;
    if (typeof entry.useFactory === 'function') return `${token} (factory)`;
    if ('useExisting' in entry) return `${token} (useExisting ${tokenLabel(entry.useExisting)})`;
    return `${token} (value)`;
}

/** Every method name on a prototype chain, as `MetadataScanner.getAllMethodNames` reads it. */
function methodNames(cls: AnyClass): string[] {
    const names = new Set<string>();
    let prototype: object | null = cls.prototype as object;
    while (prototype && prototype !== Object.prototype) {
        for (const name of Object.getOwnPropertyNames(prototype)) {
            if (name === 'constructor') continue;
            const descriptor = Object.getOwnPropertyDescriptor(prototype, name);
            if (descriptor && typeof descriptor.value === 'function') names.add(name);
        }
        prototype = Object.getPrototypeOf(prototype) as object | null;
    }
    return [...names];
}

/**
 * The enhancer CLASSES Nest resolves in a controller's or provider's host module
 * (`DependenciesScanner.reflectDynamicMetadata`): guards, interceptors, filters and pipes
 * at class and method level, and route-argument pipes.
 */
function enhancerClasses(cls: AnyClass): AnyClass[] {
    const found = new Set<unknown>();
    const keys = [
        GUARDS_METADATA,
        INTERCEPTORS_METADATA,
        EXCEPTION_FILTERS_METADATA,
        PIPES_METADATA,
    ];
    for (const key of keys) metadataList(key, cls).forEach((item) => found.add(item));
    for (const name of methodNames(cls)) {
        const method = (cls.prototype as Record<string, unknown>)[name] as object;
        for (const key of keys) metadataList(key, method).forEach((item) => found.add(item));
        const args = Reflect.getMetadata(ROUTE_ARGS_METADATA, cls, name) as
            | Record<string, { pipes?: unknown[] }>
            | undefined;
        for (const arg of Object.values(args ?? {})) {
            (arg.pipes ?? []).forEach((pipe) => found.add(pipe));
        }
    }
    return [...found].filter((item): item is AnyClass => typeof item === 'function');
}

/** The middleware classes a module's `configure()` applies, read without an instance. */
function middlewareClasses(module: AnyClass): AnyClass[] {
    const configure = (module.prototype as { configure?: (consumer: unknown) => void }).configure;
    if (typeof configure !== 'function') return [];
    const applied: unknown[] = [];
    const route = { forRoutes: (): unknown => consumer, exclude: (): unknown => route };
    const consumer = {
        apply: (...middleware: unknown[]) => {
            applied.push(...middleware.flat());
            return route;
        },
    };
    configure.call(Object.create(module.prototype as object), consumer);
    return applied.filter(
        (item): item is AnyClass =>
            typeof item === 'function' &&
            typeof (item.prototype as { use?: unknown } | undefined)?.use === 'function',
    );
}

/** How to read one graph: which classes and tokens are App Works, and where each lives. */
interface Lens {
    readonly isAppWorks: (value: unknown) => boolean;
    readonly isWorkspace: (value: unknown) => boolean;
    readonly whereIs: (value: unknown) => string;
    /** `InternalCoreModule` gets no globals (`bindGlobalModuleToModule`). */
    readonly internalCore?: unknown;
    /** App Works module classes outside the graph, for the "provided only by" reason. */
    readonly outsideModules?: AnyClass[];
    readonly keyPrefix?: string;
    readonly limitations: string[];
}

function staticProviderTokens(module: AnyClass): unknown[] {
    return metadataList(MODULE_METADATA.PROVIDERS, module).map((entry) =>
        isCustomProvider(entry) ? entry.provide : entry,
    );
}

/**
 * Every App Works subject in one graph, every dependency of each, and the ones Nest cannot
 * resolve from the declaring module — `Injector.lookupComponent` +
 * `lookupComponentInImports`, as an existence check.
 */
function analyzeGraph(nodes: ModuleNode[], lens: Lens): GraphAnalysis {
    const globals = nodes.filter((node) => node.global);
    const importsOf = (node: ModuleNode): ModuleNode[] => [
        ...new Set([
            ...node.imports,
            // `NestContainer.bindGlobalModuleToModule`: every global joins every module's
            // imports, except its own and the internal core module's.
            ...(node.metatype === lens.internalCore
                ? []
                : globals.filter((global) => global !== node)),
        ]),
    ];
    const resolves = (from: ModuleNode, token: unknown): boolean => {
        if (from.providers.has(token)) return true;
        const visited = new Set<ModuleNode>();
        const search = (module: ModuleNode, traversing: boolean): boolean => {
            let children = importsOf(module);
            if (traversing)
                children = children.filter((child) => module.exports.has(child.metatype));
            for (const child of children) {
                if (visited.has(child)) continue;
                visited.add(child);
                if (child.exports.has(token) && child.providers.has(token)) return true;
                if (search(child, true)) return true;
            }
            return false;
        };
        return search(from, false);
    };
    const importPath = (from: ModuleNode, to: ModuleNode): ModuleNode[] | undefined => {
        const previous = new Map<ModuleNode, ModuleNode>();
        const queue = [from];
        const seen = new Set([from]);
        while (queue.length) {
            const current = queue.shift() as ModuleNode;
            if (current === to) {
                const chain = [current];
                while (previous.has(chain[0])) chain.unshift(previous.get(chain[0]) as ModuleNode);
                return chain;
            }
            for (const child of current.imports) {
                if (seen.has(child)) continue;
                seen.add(child);
                previous.set(child, current);
                queue.push(child);
            }
        }
        return undefined;
    };
    const why = (declaring: ModuleNode, token: unknown, providers: ModuleNode[]): string => {
        if (providers.length === 0) {
            const outside = (lens.outsideModules ?? []).filter((module) =>
                staticProviderTokens(module).includes(token),
            );
            if (outside.length) {
                return `provided only by ${outside.map((m) => m.name).join(', ')}, which nothing in this graph imports`;
            }
            return 'provided by no module in this graph';
        }
        return providers
            .map((provider) => {
                if (provider.global && !provider.exports.has(token)) {
                    return `${provider.label} is @Global() but does not export it`;
                }
                if (declaring.imports.includes(provider)) {
                    return `${declaring.label} imports ${provider.label}, which provides it but does not export it`;
                }
                const chain = importPath(declaring, provider);
                if (chain) {
                    return `${provider.label} is reached only via ${chain.map((m) => m.label).join(' -> ')}, and a module on that chain does not export it onward`;
                }
                return `${declaring.label} does not import ${provider.label} (not @Global())`;
            })
            .join('; ');
    };

    const subjects: Subject[] = [];
    const missingMetadata: string[] = [];
    const noteMissingMetadata = (node: ModuleNode, cls: AnyClass, label: string): void => {
        if (cls.length > 0 && !Reflect.hasMetadata(PARAMTYPES_METADATA, cls)) {
            missingMetadata.push(`${node.label} | ${label} (${lens.whereIs(cls)})`);
        }
    };
    /**
     * Add one subject. `full` (an App Works class, or any class of an App Works module)
     * checks every dependency; otherwise the class is a subject only for the App Works
     * tokens it asks for — the defect this spec guards does not stop at the surface's
     * edge: `TriggerInternalController`, `DeployFacadeService` and `WorkLifecycleService`
     * all hold App Works collaborators `@Optional()`, and a gap there is just as silent.
     */
    const addSubject = (
        node: ModuleNode,
        label: string,
        owner: unknown,
        dependencies: Dependency[],
        full: boolean,
        cls?: AnyClass,
    ): void => {
        const asked = full
            ? dependencies
            : dependencies.filter((dependency) => lens.isAppWorks(dependency.token));
        if (!full && asked.length === 0) return;
        if (cls) noteMissingMetadata(node, cls, label);
        subjects.push({ module: node, label, owner, dependencies: asked });
    };
    const addClassSubject = (node: ModuleNode, cls: AnyClass, label: string, full: boolean) =>
        addSubject(node, label, cls, classDependencies(cls), full, cls);
    const addEnhancers = (node: ModuleNode, host: AnyClass, full: boolean): void => {
        for (const enhancer of enhancerClasses(host)) {
            // Third-party enhancers (Nest's own pipes) resolve their own optional options.
            if (!lens.isWorkspace(enhancer)) continue;
            addClassSubject(
                node,
                enhancer,
                `${enhancer.name} (enhancer on ${host.name})`,
                full || lens.isAppWorks(enhancer),
            );
        }
    };
    for (const node of nodes) {
        const appWorksModule = lens.isAppWorks(node.metatype);
        for (const entry of node.providerEntries) {
            const { impl, dependencies } = providerDependencies(entry);
            const token = isCustomProvider(entry) ? entry.provide : entry;
            const full =
                appWorksModule ||
                (impl !== undefined && lens.isAppWorks(impl)) ||
                lens.isAppWorks(token);
            addSubject(node, providerLabel(entry, impl), impl ?? token, dependencies, full, impl);
            if (impl) addEnhancers(node, impl, full);
        }
        for (const controller of node.controllers) {
            const full = appWorksModule || lens.isAppWorks(controller);
            addClassSubject(node, controller, `${controller.name} (controller)`, full);
            addEnhancers(node, controller, full);
        }
        addClassSubject(
            node,
            node.metatype,
            `${node.metatype.name} (module class)`,
            appWorksModule,
        );
        try {
            for (const middleware of middlewareClasses(node.metatype)) {
                addClassSubject(
                    node,
                    middleware,
                    `${middleware.name} (middleware)`,
                    appWorksModule || lens.isAppWorks(middleware),
                );
            }
        } catch (error) {
            lens.limitations.push(
                `${node.label}.configure() could not be read without an instance: ${String(error)}`,
            );
        }
    }

    const unresolved: UnresolvedDependency[] = [];
    const reported = new Map<string, UnresolvedDependency>();
    let dependencies = 0;
    for (const subject of subjects) {
        for (const dependency of subject.dependencies) {
            dependencies += 1;
            if (resolves(subject.module, dependency.token)) continue;
            const token = tokenLabel(dependency.token);
            const key = `${lens.keyPrefix ?? ''}${subject.module.label} | ${subject.label} | ${token}`;
            const known = reported.get(key);
            if (known) {
                // The same class asking twice: one row, required if either ask is.
                known.at = `${known.at}, ${dependency.at}`;
                known.optional = known.optional && dependency.optional;
                continue;
            }
            const providers = nodes.filter(
                (node) =>
                    node.providers.has(dependency.token) && node.metatype !== dependency.token,
            );
            const entry: UnresolvedDependency = {
                key,
                module: subject.module.label,
                subject: subject.label,
                subjectFile: lens.whereIs(subject.owner),
                at: dependency.at,
                token,
                optional: dependency.optional,
                providedBy: providers.map((node) => node.label),
                why: why(subject.module, dependency.token, providers),
            };
            reported.set(key, entry);
            unresolved.push(entry);
        }
    }

    return {
        modules: nodes.length,
        moduleLabels: nodes.map((node) => node.label).sort(),
        appWorksModules: nodes
            .filter((node) => lens.isAppWorks(node.metatype))
            .map((node) => node.label)
            .sort(),
        subjects: subjects.length,
        dependencies,
        unresolved: unresolved.sort((a, b) => a.key.localeCompare(b.key)),
        missingMetadata: missingMetadata.sort(),
    };
}

/* -------------------------------------------------------------------------- *
 * The child's work
 * -------------------------------------------------------------------------- */

function productionFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === '__tests__' || entry.name === 'node_modules') continue;
            files.push(...productionFiles(path));
        } else if (
            entry.name.endsWith('.ts') &&
            !entry.name.endsWith('.spec.ts') &&
            !entry.name.endsWith('.d.ts')
        ) {
            files.push(path);
        }
    }
    return files;
}

function appWorksFiles(): string[] {
    return [
        ...APP_WORKS_AGENT_DIRS.flatMap((dir) => productionFiles(join(AGENT_SRC, dir))),
        ...APP_WORKS_API_DIRS.flatMap((dir) => productionFiles(join(API_SRC, dir))),
        ...APP_WORKS_API_FILES.map((file) => join(API_SRC, file)),
    ];
}

function repoPath(file: string): string {
    return relative(REPO, file).split(sep).join('/');
}

/**
 * Where every workspace class and symbol is declared: the first non-barrel file in the
 * require cache that exports it, overlaid with `declaredIn` (the defining file of a
 * decorated class, which covers the classes a file declares WITHOUT exporting them).
 * `node_modules` is skipped — its exports can be live getters (express's `request.query`
 * throws off an instance) and nothing here needs a third-party class's file.
 */
function locate(declaredIn: Map<unknown, string>): Map<unknown, string> {
    const location = new Map<unknown, string>(declaredIn);
    for (const [file, cached] of Object.entries(require.cache)) {
        if (!cached || file.includes(`${sep}node_modules${sep}`)) continue;
        if (file.endsWith(`${sep}index.ts`) || file.endsWith(`${sep}index.js`)) continue;
        const exported = cached.exports as unknown;
        if (!exported || (typeof exported !== 'object' && typeof exported !== 'function')) continue;
        for (const name of Object.keys(exported)) {
            let value: unknown;
            try {
                value = (exported as Record<string, unknown>)[name];
            } catch {
                continue;
            }
            if (
                (typeof value === 'function' || typeof value === 'symbol') &&
                !location.has(value)
            ) {
                location.set(value, file);
            }
        }
    }
    return location;
}

/** `NestFactory` registers `InternalCoreModuleFactory.create(...)` beside every root. */
async function internalCoreModule(): Promise<{ module: DynamicModule; metatype: unknown }> {
    const { ExternalContextCreator } =
        await import('@nestjs/core/helpers/external-context-creator');
    const { HttpAdapterHost } = await import('@nestjs/core/helpers/http-adapter-host');
    const { InternalCoreModule } =
        await import('@nestjs/core/injector/internal-core-module/internal-core-module');
    const { LazyModuleLoader } =
        await import('@nestjs/core/injector/lazy-module-loader/lazy-module-loader');
    const { ModulesContainer } = await import('@nestjs/core/injector/modules-container');
    const { SerializedGraph } = await import('@nestjs/core/inspector/serialized-graph');
    return {
        // @Global, and the provider of Reflector, REQUEST, INQUIRER and these five.
        module: InternalCoreModule.register([
            { provide: ExternalContextCreator, useFactory: () => undefined },
            { provide: ModulesContainer, useFactory: () => undefined },
            { provide: HttpAdapterHost, useFactory: () => undefined },
            { provide: LazyModuleLoader, useFactory: () => undefined },
            { provide: SerializedGraph, useFactory: () => undefined },
        ]),
        metatype: InternalCoreModule,
    };
}

/** Name the three App Works module classes that share a name across packages. */
function disambiguate(nodes: ModuleNode[], location: Map<unknown, string>): void {
    for (const node of nodes) {
        const twin = nodes.some(
            (other) =>
                other.metatype !== node.metatype && other.metatype.name === node.metatype.name,
        );
        const file = location.get(node.metatype);
        if (!twin || !file) continue;
        // `apps/api/...` -> `api`, `packages/agent/...` -> `agent`.
        const workspace = repoPath(file).split('/')[1];
        node.label = `${node.metatype.name}[${workspace}]${node.label.slice(node.metatype.name.length)}`;
    }
}

/** The child's entry point — `CHILD_BOOTSTRAP` calls it once the loader is installed. */
export async function runReachabilityChild(): Promise<void> {
    const request = JSON.parse(process.env[CHILD_FLAG] ?? '{}') as ChildRequest;
    writeFileSync(request.out, JSON.stringify(await computeReport()));
}

async function computeReport(): Promise<ReachabilityReport> {
    const limitations: string[] = [];
    const core = await internalCoreModule();

    // 1. The API graph.
    const { ApiModule } = await import('./api.module');
    const nodes = await walkModuleGraph([core.module, ApiModule]);

    // Every App Works production file, so a module no root imports is still seen.
    const surfaceFiles = appWorksFiles();
    for (const file of surfaceFiles) await import(file);
    const surface = new Set(surfaceFiles);

    // 4 (loaded now, walked below). The worker roots, recording the defining file of every
    // decorated class they declare — several task-local root modules are not exported.
    const declaredIn = new Map<unknown, string>();
    const roots = await workerRoots(declaredIn, limitations);

    const location = locate(declaredIn);
    const isAppWorks = (value: unknown): boolean => {
        const file = location.get(value);
        return file !== undefined && surface.has(file);
    };
    const whereIs = (value: unknown): string => {
        const file = location.get(value);
        return file ? repoPath(file) : '(outside the workspace)';
    };
    const appWorksModuleClasses = [...location.keys()].filter(
        (value): value is AnyClass =>
            typeof value === 'function' &&
            isAppWorks(value) &&
            (Reflect.getMetadataKeys(value) as unknown[]).some((key) =>
                Object.values(MODULE_METADATA).includes(key as string),
            ),
    );
    disambiguate(nodes, location);
    const inGraph = new Set(nodes.map((node) => node.metatype));
    const outsideModules = appWorksModuleClasses.filter((module) => !inGraph.has(module));
    const lens: Lens = {
        isAppWorks,
        isWorkspace: (value) => location.has(value),
        whereIs,
        internalCore: core.metatype,
        outsideModules,
        limitations,
    };

    // 1. Constructor and property dependencies.
    const api = analyzeGraph(nodes, lens);

    // 2. Module reachability.
    const unreachableModules: UnreachableModule[] = outsideModules
        .map((module) => ({
            key: module.name,
            file: whereIs(module),
            provides: staticProviderTokens(module).map(tokenLabel),
        }))
        .sort((a, b) => a.key.localeCompare(b.key));

    // 3. Lazy `ModuleRef` lookups.
    const lazy = await lazyLookups(surfaceFiles, nodes, limitations);

    // 4. The worker contexts.
    const workers: WorkerContext[] = [];
    const asked = new Map<string, { root: string; name: string; files: Set<string> }>();
    for (const root of roots) {
        const workerNodes = await walkModuleGraph([core.module, root.module]);
        disambiguate(workerNodes, location);
        // 5 (collected now, judged below). The files this context is built from: the task
        // files that boot it and every `packages/tasks` file declaring one of its modules.
        const files = new Set(root.bootedBy.map((file) => join(REPO, file)));
        for (const node of workerNodes) {
            const file = location.get(node.metatype);
            if (file?.startsWith(`${TASKS_SRC}${sep}`)) files.add(file);
        }
        const proxies = await remoteProxyNames([...files]);
        for (const [name, askedIn] of proxies) {
            const key = `${root.module.name} :: remote '${name}'`;
            const entry = asked.get(key) ?? { root: root.module.name, name, files: new Set() };
            askedIn.forEach((file) => entry.files.add(repoPath(file)));
            asked.set(key, entry);
        }
        workers.push({
            root: root.module.name,
            bootedBy: root.bootedBy,
            analysis: analyzeGraph(workerNodes, {
                ...lens,
                outsideModules: [],
                keyPrefix: `${root.module.name} :: `,
            }),
            remoteProxies: [...proxies.keys()].sort(),
        });
    }

    // 5. The API side of every remote target: a `remoteMap` entry whose collaborator resolves.
    const judge = await remoteTargetJudge(nodes, api, limitations);
    const remote: RemoteTarget[] = [...asked]
        .map(([key, entry]) => ({ key, askedIn: [...entry.files].sort(), ...judge(entry.name) }))
        .sort((a, b) => a.key.localeCompare(b.key));

    return {
        api,
        unreachableModules,
        lazy,
        workers: workers.sort((a, b) => a.root.localeCompare(b.root)),
        remote,
        limitations,
    };
}

/**
 * Every `createRemoteProxy(<client>, 'Name')` in `files`: name -> the files that ask for it.
 * A name built at run time is not seen (none is today).
 */
async function remoteProxyNames(files: string[]): Promise<Map<string, string[]>> {
    const ts = await import('typescript');
    const names = new Map<string, string[]>();
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('createRemoteProxy')) continue;
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const visit = (node: import('typescript').Node): void => {
            if (
                ts.isCallExpression(node) &&
                /(^|\.)createRemoteProxy$/.test(node.expression.getText(source))
            ) {
                const name = node.arguments[1];
                if (name && ts.isStringLiteralLike(name)) {
                    names.set(name.text, [...(names.get(name.text) ?? []), file]);
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
    }
    return names;
}

/**
 * How `TriggerInternalController.callRemote` answers a name: `remoteMap` (built in
 * `onModuleInit`) maps it to `this.<field>`, the field is a constructor parameter, and that
 * parameter resolves from the controller's module — or the worker's call answers
 * "Unknown remote target". Read from the controller's SOURCE for the map, and from the API
 * walk above for the parameter (the controller is an App Works subject, so every unresolved
 * parameter of it is a row there).
 */
async function remoteTargetJudge(
    nodes: ModuleNode[],
    api: GraphAnalysis,
    limitations: string[],
): Promise<(name: string) => { resolved: boolean; why: string }> {
    const ts = await import('typescript');
    const file = join(API_SRC, TRIGGER_INTERNAL_CONTROLLER_FILE);
    const { TriggerInternalController } = (await import(file)) as {
        TriggerInternalController: AnyClass;
    };
    const source = ts.createSourceFile(
        file,
        readFileSync(file, 'utf8'),
        ts.ScriptTarget.Latest,
        true,
    );

    const parameters: string[] = [];
    const fields = new Map<string, string | undefined>();
    const thisField = (node: import('typescript').Node): string | undefined => {
        if (
            ts.isPropertyAccessExpression(node) &&
            node.expression.kind === ts.SyntaxKind.ThisKeyword
        ) {
            return node.name.text;
        }
        return ts.forEachChild(node, thisField);
    };
    const collect = (literal: import('typescript').ObjectLiteralExpression): void => {
        for (const property of literal.properties) {
            if (ts.isPropertyAssignment(property)) {
                fields.set(
                    property.name.getText(source).replace(/^['"]|['"]$/g, ''),
                    thisField(property.initializer),
                );
            } else if (ts.isSpreadAssignment(property)) {
                const nested = (node: import('typescript').Node): void => {
                    if (ts.isObjectLiteralExpression(node)) collect(node);
                    else ts.forEachChild(node, nested);
                };
                nested(property.expression);
            }
        }
    };
    const visit = (node: import('typescript').Node): void => {
        if (ts.isClassDeclaration(node) && node.name?.text === TriggerInternalController.name) {
            for (const member of node.members) {
                if (ts.isConstructorDeclaration(member)) {
                    member.parameters.forEach((parameter) =>
                        parameters.push(parameter.name.getText(source)),
                    );
                }
            }
        }
        if (
            ts.isBinaryExpression(node) &&
            node.operatorToken.kind === ts.SyntaxKind.EqualsToken &&
            node.left.getText(source) === 'this.remoteMap' &&
            ts.isObjectLiteralExpression(node.right)
        ) {
            collect(node.right);
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    if (parameters.length === 0 || fields.size === 0) {
        limitations.push(
            `${repoPath(file)}: the constructor or \`this.remoteMap = { … }\` could not be read`,
        );
    }

    const hosted = nodes.some((node) => node.controllers.includes(TriggerInternalController));
    const subject = `${TriggerInternalController.name} (controller)`;
    const unresolvedAt = new Map<number, UnresolvedDependency>();
    for (const dependency of api.unresolved) {
        if (dependency.subject !== subject) continue;
        for (const match of dependency.at.matchAll(/constructor\[(\d+)\]/g)) {
            unresolvedAt.set(Number(match[1]), dependency);
        }
    }

    return (name) => {
        if (!hosted) {
            return { resolved: false, why: `${subject} is not in the API graph` };
        }
        if (!fields.has(name)) {
            return {
                resolved: false,
                why: `\`remoteMap\` in ${repoPath(file)} has no '${name}' entry — every call answers "Unknown remote target"`,
            };
        }
        const field = fields.get(name);
        const index = field === undefined ? -1 : parameters.indexOf(field);
        if (index < 0) {
            return {
                resolved: false,
                why: `\`remoteMap.${name}\` is not \`this.<constructor parameter>\`, so this spec cannot tell whether it is bound`,
            };
        }
        const gap = unresolvedAt.get(index);
        if (gap) {
            return {
                resolved: false,
                why: `\`remoteMap.${name}\` is \`this.${field}\` (constructor[${index}], ${gap.token}), which ${gap.module} cannot resolve: ${gap.why}`,
            };
        }
        return {
            resolved: true,
            why: `\`remoteMap.${name}\` is \`this.${field}\` (constructor[${index}])`,
        };
    };
}

/**
 * The lookups constructor metadata cannot see: `getOptionalProvider(ref, X)` (a NON-strict
 * `ModuleRef.get`, which finds `X` in ANY module of the container) and `ref.get(X)` /
 * `moduleRef.get(X, { strict })` in the App Works production files.
 *
 * A site is LIVE when its file exports something the graph registers — a module in it, a
 * provider entry of one, or a class one provides — and those modules are its hosts: a
 * strict `get` finds only its host's OWN providers.
 */
async function lazyLookups(
    files: string[],
    nodes: ModuleNode[],
    limitations: string[],
): Promise<LazyLookup[]> {
    const ts = await import('typescript');
    const { createRequire } = await import('node:module');
    const found: LazyLookup[] = [];
    for (const file of files) {
        const text = readFileSync(file, 'utf8');
        if (!text.includes('getOptionalProvider') && !text.includes('.get(')) continue;
        const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
        const imported = importedBindings(ts, source);
        const sites: { name: string; strict: boolean }[] = [];
        const visit = (node: import('typescript').Node): void => {
            if (ts.isCallExpression(node)) {
                const callee = node.expression;
                if (ts.isIdentifier(callee) && callee.text === 'getOptionalProvider') {
                    const token = node.arguments[1];
                    if (token && ts.isIdentifier(token))
                        sites.push({ name: token.text, strict: false });
                } else if (
                    ts.isPropertyAccessExpression(callee) &&
                    callee.name.text === 'get' &&
                    /(^|\.)(moduleRef|ref)$/.test(callee.expression.getText(source))
                ) {
                    const token = node.arguments[0];
                    const options = node.arguments[1];
                    const nonStrict =
                        options !== undefined &&
                        ts.isObjectLiteralExpression(options) &&
                        options.properties.some(
                            (property) =>
                                ts.isPropertyAssignment(property) &&
                                property.name.getText(source) === 'strict' &&
                                property.initializer.kind === ts.SyntaxKind.FalseKeyword,
                        );
                    if (token && ts.isIdentifier(token)) {
                        sites.push({ name: token.text, strict: !nonStrict });
                    }
                }
            }
            ts.forEachChild(node, visit);
        };
        visit(source);
        if (!sites.length) continue;

        const own = (await import(file)) as Record<string, unknown>;
        const exported = new Set(Object.values(own));
        const hosts = nodes.filter(
            (node) =>
                exported.has(node.metatype) ||
                node.providerEntries.some(
                    (entry) =>
                        exported.has(entry) ||
                        (isCustomProvider(entry) && exported.has(entry.useClass as unknown)),
                ),
        );
        const fromSite = createRequire(file);
        for (const site of sites) {
            const binding = imported.get(site.name);
            let token: unknown;
            try {
                token = binding
                    ? (fromSite(binding.specifier) as Record<string, unknown>)[binding.name]
                    : own[site.name];
            } catch (error) {
                limitations.push(
                    `${repoPath(file)}: could not load ${site.name}: ${String(error)}`,
                );
                continue;
            }
            if (token === undefined) {
                limitations.push(
                    `${repoPath(file)}: ${site.name} is not an export this spec can load`,
                );
                continue;
            }
            const providedBy = nodes
                .filter((node) => node.providers.has(token))
                .map((node) => node.label);
            const key = `${repoPath(file)} | ${tokenLabel(token)} (${site.strict ? 'strict' : 'non-strict'})`;
            if (found.some((entry) => entry.key === key)) continue;
            found.push({
                key,
                live: hosts.length > 0,
                found: site.strict
                    ? hosts.length > 0 && hosts.every((host) => host.providers.has(token))
                    : providedBy.length > 0,
                providedBy,
            });
        }
    }
    return found.sort((a, b) => a.key.localeCompare(b.key));
}

/** A file's named imports: local name -> `{ specifier, exported name }`. */
function importedBindings(
    ts: typeof import('typescript'),
    source: import('typescript').SourceFile,
): Map<string, { specifier: string; name: string }> {
    const imported = new Map<string, { specifier: string; name: string }>();
    for (const statement of source.statements) {
        if (!ts.isImportDeclaration(statement) || !statement.importClause) continue;
        const bindings = statement.importClause.namedBindings;
        if (!bindings || !ts.isNamedImports(bindings)) continue;
        for (const element of bindings.elements) {
            imported.set(element.name.text, {
                specifier: (statement.moduleSpecifier as import('typescript').StringLiteral).text,
                name: (element.propertyName ?? element.name).text,
            });
        }
    }
    return imported;
}

/**
 * The root module of every worker context an App Works task boots: the third argument of
 * `withWorkerContext(name, fn, Module)` (default `TriggerWorkerModule`) and the first of
 * `NestFactory.createApplicationContext(Module)`, in `packages/tasks/src/tasks/trigger/app-*.ts`.
 *
 * Several of those roots are task-local and NOT exported (`AppDependencyProvisionWorkerModule`,
 * `AppSpecEvaluateWorkerModule`), so the files are loaded with `Reflect.defineMetadata`
 * observed: a class that receives `imports`/`providers`/`__injectable__` metadata while a
 * task file is being evaluated is recorded against that file, and a root named in the file
 * is found there.
 */
async function workerRoots(
    declaredIn: Map<unknown, string>,
    limitations: string[],
): Promise<{ module: AnyClass; bootedBy: string[] }[]> {
    const ts = await import('typescript');
    const { createRequire } = await import('node:module');
    const taskDir = join(TASKS_SRC, 'tasks', 'trigger');
    const files = readdirSync(taskDir)
        .filter((name) => APP_WORKS_TASK_FILE.test(name) && !name.endsWith('.spec.ts'))
        .map((name) => join(taskDir, name));

    const tasksPrefix = `${TASKS_SRC}${sep}`;
    const defineMetadata = Reflect.defineMetadata.bind(Reflect) as (
        key: unknown,
        value: unknown,
        target: object,
        property?: string | symbol,
    ) => void;
    Reflect.defineMetadata = ((
        key: unknown,
        value: unknown,
        target: object,
        property?: string | symbol,
    ) => {
        if (
            property === undefined &&
            typeof target === 'function' &&
            (key === MODULE_METADATA.IMPORTS ||
                key === MODULE_METADATA.PROVIDERS ||
                key === '__injectable__') &&
            !declaredIn.has(target)
        ) {
            const frame = (new Error().stack ?? '')
                .split('\n')
                .find((line) => line.includes(tasksPrefix));
            const file = frame?.match(/\(?([A-Za-z]:[\\/][^():]+|\/[^():]+):\d+:\d+\)?\s*$/)?.[1];
            if (file) declaredIn.set(target, file);
        }
        defineMetadata(key, value, target, property);
    }) as typeof Reflect.defineMetadata;

    const roots = new Map<AnyClass, string[]>();
    try {
        for (const file of files) {
            await import(file);
            const text = readFileSync(file, 'utf8');
            const source = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true);
            const imported = importedBindings(ts, source);
            const names: string[] = [];
            const visit = (node: import('typescript').Node): void => {
                if (ts.isCallExpression(node)) {
                    const callee = node.expression.getText(source);
                    if (callee === 'withWorkerContext') {
                        const module = node.arguments[2];
                        if (!module) names.push('TriggerWorkerModule');
                        else if (ts.isIdentifier(module)) names.push(module.text);
                    } else if (/(^|\.)createApplicationContext$/.test(callee)) {
                        const module = node.arguments[0];
                        if (module && ts.isIdentifier(module)) names.push(module.text);
                    }
                }
                ts.forEachChild(node, visit);
            };
            visit(source);
            const fromFile = createRequire(file);
            for (const name of new Set(names)) {
                let module: unknown;
                const binding = imported.get(name);
                if (binding) {
                    module = (fromFile(binding.specifier) as Record<string, unknown>)[binding.name];
                } else if (name === 'TriggerWorkerModule') {
                    module = (
                        fromFile('../../trigger/worker/modules/trigger-worker.module') as Record<
                            string,
                            unknown
                        >
                    ).TriggerWorkerModule;
                } else {
                    module = [...declaredIn].find(
                        ([value, at]) =>
                            at === file &&
                            typeof value === 'function' &&
                            (value as AnyClass).name === name,
                    )?.[0];
                }
                if (typeof module !== 'function') {
                    limitations.push(`${repoPath(file)}: worker root ${name} could not be loaded`);
                    continue;
                }
                const bootedBy = roots.get(module as AnyClass) ?? [];
                bootedBy.push(repoPath(file));
                roots.set(module as AnyClass, bootedBy);
            }
        }
    } finally {
        Reflect.defineMetadata = defineMetadata as typeof Reflect.defineMetadata;
    }
    return [...roots].map(([module, bootedBy]) => ({ module, bootedBy: bootedBy.sort() }));
}

/* -------------------------------------------------------------------------- *
 * The spec side
 * -------------------------------------------------------------------------- */

function runChild(): ReachabilityReport {
    const config = jest.requireActual<{ moduleNameMapper: Record<string, string | string[]> }>(
        join(API_ROOT, 'jest.config.js'),
    );
    // Api jest's `@src/` rules are the ambiguous ones (see the header); the child resolves
    // `@src/` per package instead.
    const mapper: [string, string[]][] = Object.entries(config.moduleNameMapper)
        .filter(([source]) => !source.startsWith('^@src/'))
        .map(([source, target]) => [
            source,
            (Array.isArray(target) ? target : [target]).map((path) =>
                path.replace('<rootDir>', API_SRC),
            ),
        ]);
    const out = join(tmpdir(), `app-works-di-reachability-${process.pid}-${Date.now()}.json`);
    const request: ChildRequest = {
        repo: REPO,
        apiRoot: API_ROOT,
        tasksRoot: join(REPO, 'packages', 'tasks'),
        spec: __filename,
        out,
        mapper,
    };
    try {
        const child = spawnSync(
            process.execPath,
            ['--max-old-space-size=4096', '-e', CHILD_BOOTSTRAP],
            {
                cwd: API_ROOT,
                env: { ...process.env, [CHILD_FLAG]: JSON.stringify(request) },
                encoding: 'utf8',
                maxBuffer: 64 * 1024 * 1024,
                timeout: 10 * 60 * 1000,
            },
        );
        if (child.status !== 0 || !existsSync(out)) {
            throw new Error(
                `The graph child failed (status ${String(child.status)}, signal ${String(child.signal)}):\n` +
                    `${child.stderr}\n${String(child.stdout).slice(-4000)}`,
            );
        }
        return JSON.parse(readFileSync(out, 'utf8')) as ReachabilityReport;
    } finally {
        rmSync(out, { force: true });
    }
}

/** One RED row: what is missing, where it is asked for, and why Nest cannot reach it. */
function row(dependency: UnresolvedDependency): string {
    return `${dependency.key}  [${dependency.at} of ${dependency.subjectFile}]  — ${dependency.why}`;
}

function unexpected<T extends { key: string }>(found: T[], expected: readonly Expected[]): T[] {
    const keys = new Set(expected.map((entry) => entry.key));
    return found.filter((entry) => !keys.has(entry.key));
}

function stale(found: { key: string }[], expected: readonly Expected[]): string[] {
    const keys = new Set(found.map((entry) => entry.key));
    return expected.filter((entry) => !keys.has(entry.key)).map((entry) => entry.key);
}

/** The child runs once per file; every `describe` below reads the same report. */
let cachedReport: ReachabilityReport | undefined;
function report(): ReachabilityReport {
    cachedReport ??= runChild();
    return cachedReport;
}

/** The worker rows, one per `Root :: TOKEN`, with every consumer that asks for it. */
function workerGaps(workers: WorkerContext[]): { key: string; rows: UnresolvedDependency[] }[] {
    const groups = new Map<string, UnresolvedDependency[]>();
    for (const worker of workers) {
        for (const dependency of worker.analysis.unresolved) {
            if (!dependency.optional) continue;
            const key = `${worker.root} :: ${dependency.token}`;
            groups.set(key, [...(groups.get(key) ?? []), dependency]);
        }
    }
    return [...groups]
        .map(([key, rows]) => ({ key, rows }))
        .sort((a, b) => a.key.localeCompare(b.key));
}

function workerRow(gap: { key: string; rows: UnresolvedDependency[] }): string {
    const askedBy = gap.rows.map((dependency) => `${dependency.subject} [${dependency.at}]`);
    return `${gap.key}  — asked by ${askedBy.join(', ')}  — ${gap.rows[0].why}`;
}

/* -------------------------------------------------------------------------- *
 * The control: the walker against a graph a real Nest container answers
 * -------------------------------------------------------------------------- */

const CONTROL = {
    /** Provided and exported by a module the consumer reaches only through a re-export. */
    A: Symbol('CONTROL_A'),
    /** Provided by that same module and NOT exported. */
    B: Symbol('CONTROL_B'),
    /** Provided and exported by a `@Global()` module. */
    G: Symbol('CONTROL_G'),
    /** Provided by the `@Global()` module and NOT exported. */
    H: Symbol('CONTROL_H'),
    /** Exported by a dynamic module imported as a `Promise`. */
    D: Symbol('CONTROL_D'),
    /** Exported by a module imported through `forwardRef`. */
    L: Symbol('CONTROL_L'),
    /** Provided by nothing, asked for by an `@Optional()` property. */
    P: Symbol('CONTROL_P'),
    /** Provided by nothing. */
    X: Symbol('CONTROL_X'),
    /** A factory asking `{ token: B, optional: true }`. */
    F: Symbol('CONTROL_F'),
};

function controlGraph(withRequiredGap: boolean) {
    const { A, B, G, H, D, L, P, X, F } = CONTROL;

    @Module({
        providers: [
            { provide: A, useValue: 'a' },
            { provide: B, useValue: 'b' },
        ],
        exports: [A],
    })
    class ControlProviderModule {}

    @Module({ imports: [ControlProviderModule], exports: [ControlProviderModule] })
    class ControlReexportModule {}

    @Global()
    @Module({
        providers: [
            { provide: G, useValue: 'g' },
            { provide: H, useValue: 'h' },
        ],
        exports: [G],
    })
    class ControlGlobalModule {}

    @Module({})
    class ControlDynamicModule {
        static register(): DynamicModule {
            return {
                module: ControlDynamicModule,
                providers: [{ provide: D, useValue: 'd' }],
                exports: [D],
            };
        }
    }

    @Injectable()
    class ControlConsumer {
        @Optional()
        @Inject(P)
        readonly viaProperty?: unknown;

        constructor(
            @Inject(A) readonly a: unknown,
            @Optional() @Inject(B) readonly b: unknown,
            @Inject(G) readonly g: unknown,
            @Optional() @Inject(H) readonly h: unknown,
            @Inject(D) readonly d: unknown,
            @Inject(L) readonly l: unknown,
            @Optional() @Inject(X) readonly x: unknown,
        ) {}
    }

    @Injectable()
    class ControlRequiresX {
        constructor(@Inject(X) readonly x: unknown) {}
    }

    @Module({
        imports: [
            ControlReexportModule,
            Promise.resolve(ControlDynamicModule.register()),
            forwardRef(() => ControlLateModule),
        ],
        providers: [
            ControlConsumer,
            {
                provide: F,
                useFactory: (b?: unknown) => ({ b }),
                inject: [{ token: B, optional: true }],
            },
            ...(withRequiredGap ? [ControlRequiresX] : []),
        ],
    })
    class ControlConsumerModule {}

    @Module({ providers: [{ provide: L, useValue: 'l' }], exports: [L] })
    class ControlLateModule {}

    @Module({ imports: [ControlConsumerModule, ControlGlobalModule] })
    class ControlRootModule {}

    return {
        root: ControlRootModule,
        consumerModule: ControlConsumerModule,
        consumer: ControlConsumer,
    };
}

async function analyzeControl(withRequiredGap: boolean): Promise<GraphAnalysis> {
    const control = controlGraph(withRequiredGap);
    return analyzeGraph(await walkModuleGraph([control.root]), {
        isAppWorks: (value) => value === control.consumerModule,
        isWorkspace: () => true,
        whereIs: () => 'control',
        limitations: [],
    });
}

if (process.env[CHILD_FLAG] === undefined) {
    describe('App Works DI reachability — the walker, against a real Nest container', () => {
        it('finds exactly the dependencies a real container leaves undefined', async () => {
            const analysis = await analyzeControl(false);
            expect(
                analysis.unresolved.map((dependency) => [dependency.key, dependency.optional]),
            ).toEqual([
                ['ControlConsumerModule | CONTROL_F (factory) | CONTROL_B', true],
                ['ControlConsumerModule | ControlConsumer | CONTROL_B', true],
                ['ControlConsumerModule | ControlConsumer | CONTROL_H', true],
                ['ControlConsumerModule | ControlConsumer | CONTROL_P', true],
                ['ControlConsumerModule | ControlConsumer | CONTROL_X', true],
            ]);
            const why = Object.fromEntries(
                analysis.unresolved.map((dependency) => [dependency.key, dependency.why]),
            );
            expect(why['ControlConsumerModule | ControlConsumer | CONTROL_B']).toBe(
                'ControlProviderModule is reached only via ControlConsumerModule -> ControlReexportModule -> ControlProviderModule, and a module on that chain does not export it onward',
            );
            expect(why['ControlConsumerModule | ControlConsumer | CONTROL_H']).toBe(
                'ControlGlobalModule is @Global() but does not export it',
            );
            expect(why['ControlConsumerModule | ControlConsumer | CONTROL_X']).toBe(
                'provided by no module in this graph',
            );

            // The oracle: the SAME graph, compiled for real. Every token the walker calls
            // unresolved is `undefined` in the instance, and every other one is not.
            const control = controlGraph(false);
            const moduleRef = await Test.createTestingModule({ imports: [control.root] }).compile();
            try {
                const consumer = moduleRef.get(control.consumer, { strict: false });
                expect({
                    a: consumer.a,
                    b: consumer.b,
                    g: consumer.g,
                    h: consumer.h,
                    d: consumer.d,
                    l: consumer.l,
                    x: consumer.x,
                    viaProperty: consumer.viaProperty,
                }).toEqual({
                    a: 'a',
                    b: undefined,
                    g: 'g',
                    h: undefined,
                    d: 'd',
                    l: 'l',
                    x: undefined,
                    viaProperty: undefined,
                });
                expect(moduleRef.get(CONTROL.F, { strict: false })).toEqual({ b: undefined });
            } finally {
                await moduleRef.close();
            }
        });

        it('reports a REQUIRED gap as required — the graph a real container refuses to compile', async () => {
            const analysis = await analyzeControl(true);
            expect(
                analysis.unresolved.filter((dependency) => !dependency.optional).map((d) => d.key),
            ).toEqual(['ControlConsumerModule | ControlRequiresX | CONTROL_X']);

            const control = controlGraph(true);
            await expect(
                Test.createTestingModule({ imports: [control.root] }).compile(),
            ).rejects.toThrow(/ControlRequiresX/);
        });
    });

    describe('App Works DI reachability — the API graph (ApiModule, as SWC builds it)', () => {
        beforeAll(
            () => {
                report();
            },
            10 * 60 * 1000,
        );

        it('walks the real graph — a zero here would make every case below vacuous', () => {
            const { api, limitations } = report();
            expect(limitations).toEqual([]);
            expect(api.modules).toBeGreaterThan(150);
            expect(api.moduleLabels).toEqual(
                expect.arrayContaining([
                    'ApiModule',
                    'AppBuildsModule[agent]',
                    'AppBuildsModule[api]',
                    'AppDependenciesModule',
                    'AppDeployRequestModule',
                    'AppEnvModule',
                    'AppRuntimeEnvModule',
                    'AppRuntimeStateModule',
                    'AppSpecModule',
                    'AppWorksModule[agent]',
                    'AppWorksModule[api]',
                    'TriggerModule',
                ]),
            );
            expect(api.subjects).toBeGreaterThan(50);
            expect(api.dependencies).toBeGreaterThan(150);
            expect(api.missingMetadata).toEqual([]);
        });

        it('resolves every REQUIRED dependency — the API boots, so a row here means the walker is wrong', () => {
            expect(
                report()
                    .api.unresolved.filter((dependency) => !dependency.optional)
                    .map(row),
            ).toEqual([]);
        });

        it('leaves undefined only the @Optional() dependencies EXPECTED_UNBOUND or OPEN_API_GAPS names', () => {
            const optional = report().api.unresolved.filter((dependency) => dependency.optional);
            expect(unexpected(optional, [...EXPECTED_UNBOUND, ...OPEN_API_GAPS]).map(row)).toEqual(
                [],
            );
        });

        it('names nothing in EXPECTED_UNBOUND or OPEN_API_GAPS that now resolves — the lists stay exact', () => {
            expect(stale(report().api.unresolved, EXPECTED_UNBOUND)).toEqual([]);
            expect(stale(report().api.unresolved, OPEN_API_GAPS)).toEqual([]);
        });

        it('imports every App Works module somewhere in the API graph', () => {
            const { unreachableModules } = report();
            expect(
                unexpected(unreachableModules, EXPECTED_UNREACHABLE_MODULES).map(
                    (module) =>
                        `${module.key} (${module.file}) — provides ${module.provides.join(', ')}`,
                ),
            ).toEqual([]);
            expect(stale(unreachableModules, EXPECTED_UNREACHABLE_MODULES)).toEqual([]);
        });

        it('finds the target of every live ModuleRef lookup in the App Works sources', () => {
            const live = report().lazy.filter((lookup) => lookup.live);
            // Vacuity guard: `app-builds.module.ts` alone has eight.
            expect(live.length).toBeGreaterThanOrEqual(8);
            const misses = live.filter((lookup) => !lookup.found);
            expect(
                unexpected(misses, EXPECTED_LAZY_MISSES).map(
                    (lookup) => `${lookup.key} — provided by no module in the API graph`,
                ),
            ).toEqual([]);
            expect(stale(misses, EXPECTED_LAZY_MISSES)).toEqual([]);
        });
    });

    describe('App Works DI reachability — the Trigger worker contexts the app-* tasks boot', () => {
        beforeAll(
            () => {
                report();
            },
            10 * 60 * 1000,
        );

        it('finds every root an App Works task boots, and walks it', () => {
            const { workers } = report();
            expect(workers.map((worker) => worker.root)).toEqual(
                expect.arrayContaining([
                    'AppBuildPrepareWorkerModule',
                    'AppBuildWatchWorkerModule',
                    'AppDependencyProvisionWorkerModule',
                    'AppForkReadinessWorkerModule',
                    'TriggerAppRuntimeModule',
                ]),
            );
            const runtime = workers.find((worker) => worker.root === 'TriggerAppRuntimeModule');
            expect(runtime?.analysis.subjects).toBeGreaterThan(10);
            expect(runtime?.bootedBy).toEqual(
                expect.arrayContaining(['packages/tasks/src/tasks/trigger/app-deploy.task.ts']),
            );
            for (const worker of workers) {
                expect(worker.analysis.missingMetadata).toEqual([]);
                // A context with no App Works subject is still checked, through its remote
                // proxies (the lean RPC roots) — a context with neither is checked by nothing.
                expect({
                    root: worker.root,
                    checked: worker.analysis.subjects + worker.remoteProxies.length > 0,
                }).toEqual({ root: worker.root, checked: true });
            }
        });

        it('resolves every REQUIRED dependency — each context boots, so a row here means the walker is wrong', () => {
            const required = report().workers.flatMap((worker) =>
                worker.analysis.unresolved.filter((dependency) => !dependency.optional).map(row),
            );
            expect(required).toEqual([]);
        });

        it('leaves unbound only the tokens EXPECTED_WORKER_UNBOUND or OPEN_WORKER_GAPS names', () => {
            expect(
                unexpected(workerGaps(report().workers), [
                    ...EXPECTED_WORKER_UNBOUND,
                    ...OPEN_WORKER_GAPS,
                ]).map(workerRow),
            ).toEqual([]);
        });

        it('names nothing in EXPECTED_WORKER_UNBOUND or OPEN_WORKER_GAPS that is now bound — the lists stay exact', () => {
            expect(stale(workerGaps(report().workers), EXPECTED_WORKER_UNBOUND)).toEqual([]);
            expect(stale(workerGaps(report().workers), OPEN_WORKER_GAPS)).toEqual([]);
        });

        it('lands every remote proxy of an App Works worker context on a bound API collaborator', () => {
            const { remote } = report();
            // Vacuity guard: the four lean RPC roots and the runtime worker's reads are here.
            expect(remote.filter((target) => target.resolved).map((target) => target.key)).toEqual(
                expect.arrayContaining([
                    "AppBuildPrepareWorkerModule :: remote 'AppBuildPrepareRunner'",
                    "AppBuildSweepWorkerModule :: remote 'AppBuildSweepService'",
                    "AppBuildWatchWorkerModule :: remote 'AppBuildWatchRunner'",
                    "AppForkReadinessWorkerModule :: remote 'AppForkReadinessRunner'",
                    "TriggerAppRuntimeModule :: remote 'AppDeployBuildSourceAdapter'",
                    "TriggerAppRuntimeModule :: remote 'AppSpecService'",
                ]),
            );
            const misses = remote.filter((target) => !target.resolved);
            expect(
                unexpected(misses, EXPECTED_REMOTE_MISSES).map(
                    (target) => `${target.key}  [${target.askedIn.join(', ')}]  — ${target.why}`,
                ),
            ).toEqual([]);
            expect(stale(misses, EXPECTED_REMOTE_MISSES)).toEqual([]);
        });
    });

    describe('App Works DI reachability — the allow-lists themselves', () => {
        const lists: readonly (readonly Expected[])[] = [
            EXPECTED_UNBOUND,
            OPEN_API_GAPS,
            EXPECTED_UNREACHABLE_MODULES,
            EXPECTED_LAZY_MISSES,
            EXPECTED_REMOTE_MISSES,
            EXPECTED_WORKER_UNBOUND,
            OPEN_WORKER_GAPS,
        ];

        it('keeps every list sorted, unique, reasoned and sourced', () => {
            for (const list of lists) {
                const keys = list.map((entry) => entry.key);
                expect(keys).toEqual([...keys].sort());
                expect(new Set(keys).size).toBe(keys.length);
                for (const entry of list) {
                    expect(entry.reason.length).toBeGreaterThan(10);
                    // A line number, not a vibe.
                    expect(entry.source).toMatch(/\.(ts|md):\d+/);
                }
            }
            for (const gap of [...OPEN_API_GAPS, ...OPEN_WORKER_GAPS]) {
                expect(gap.routedTo.length).toBeGreaterThan(10);
            }
        });

        it('never calls one gap both deliberate and open', () => {
            const deliberate = new Set(
                [...EXPECTED_UNBOUND, ...EXPECTED_WORKER_UNBOUND].map((entry) => entry.key),
            );
            expect(
                [...OPEN_API_GAPS, ...OPEN_WORKER_GAPS]
                    .map((gap) => gap.key)
                    .filter((key) => deliberate.has(key)),
            ).toEqual([]);
        });

        /**
         * Every citation written as a repository path names a file that exists, at lines it has.
         * Deliberately NOT "the cited lines still say it": the cited files are edited by other
         * lanes every day, and a guard that goes red when an unrelated docstring grows a line is
         * a guard people learn to ignore. A renamed or truncated file is a real signal.
         */
        it('cites repository paths that exist, at lines they have', () => {
            const broken: string[] = [];
            for (const list of lists) {
                for (const entry of list) {
                    const cited = entry.source.matchAll(
                        /((?:apps|docs|packages)\/[\w./-]+\.(?:ts|md)):(\d+)(?:-(\d+))?/g,
                    );
                    for (const [, path, from, to] of cited) {
                        const file = join(REPO, path);
                        if (!existsSync(file)) {
                            broken.push(`${entry.key}: ${path} does not exist`);
                            continue;
                        }
                        const lines = readFileSync(file, 'utf8').split('\n').length;
                        if (Number(to ?? from) > lines) {
                            broken.push(
                                `${entry.key}: ${path} has ${lines} lines, cited to ${to ?? from}`,
                            );
                        }
                    }
                }
            }
            expect(broken).toEqual([]);
        });
    });
}
