import { readdirSync, readFileSync } from 'node:fs';
import { join, relative } from 'node:path';
import ts from 'typescript';
import { AppBuildsModule } from '../../app-builds/app-builds.module';
import { AppDependenciesModule } from '../../app-dependencies/app-dependencies.module';
import { AppEnvModule } from '../../app-env/app-env.module';
import { AppLauncherModule } from '../../app-launcher/app-launcher.module';
import { AppSpecModule } from '../../app-spec/app-spec.module';
import { AppWorksModule } from '../../app-works/app-works.module';
import { AppDeployRequestModule } from '../app-deploy-request.module';
import { AppRuntimeEnvModule } from '../../app-env/app-runtime-env.module';
import { AppRuntimeStateModule } from '../app-runtime-state.module';

/**
 * §5.10 — **the dormancy register.**
 *
 * The App Works branch carries ~73 `Symbol()` injection tokens across APW-01…
 * APW-11, and for most of its life the honest answer to "which of them is
 * actually bound?" was a `grep` somebody ran once and wrote into a handover.
 * That is how `WORK_APP_RUNTIME_STATES` stayed unbound through fourteen
 * thousand lines of deploy code: every injection site is `@Optional()`, so an
 * unbound token does not crash anything — the feature behind it simply never
 * runs, and nothing says so.
 *
 * This file turns that into a CHECKED FACT with a number attached, so "17%
 * wired" stops being folklore and becomes a value that moves when someone
 * changes it.
 *
 * ## What it reads, and why that is not a grep
 *
 * Nest records a module's `providers` and `exports` as **decorator metadata**
 * (`Reflect.getMetadata('providers', Module)`), so what is read below is the
 * module's own declaration, not a regular expression over its text. A provider
 * added through a spread, a conditional, a `forFeature` or a helper shows up
 * here exactly as Nest sees it, and a token mentioned only in a comment does
 * not. `packages/tasks`' `trigger.module.spec.ts` reads its exports the same
 * way, and it was that assertion which caught three dispatchers bound and never
 * exported.
 *
 * It is deliberately **not** a booted container: compiling these modules for
 * real needs a DataSource, the plugin registry and the job runtime, which is a
 * different test with a different failure mode (and `AppRuntimeStateModule` is
 * covered that way already — the API is booted in CI and by hand). What this
 * file answers is narrower and exact: *of the tokens this programme declares,
 * which ones does any App Works module **in this package** claim to provide?*
 *
 * ## ⚠ The scope is THIS PACKAGE, and {@link UNBOUND} does not mean "dormant
 * ## everywhere"
 *
 * `packages/tasks`' own `TriggerAppRuntimeModule` binds thirteen of these tokens
 * for the isolated App cluster worker — the process that actually reaches a
 * cluster. This file cannot see them: `packages/tasks` depends on
 * `packages/agent`, so importing that module here would invert the dependency.
 *
 * A token in {@link UNBOUND} therefore means **"no module in `packages/agent`
 * provides it"**, which is the right question for the API's graph and the wrong
 * one for the worker's. {@link WORKER_BOUND} names the thirteen so a reader of
 * this register is not misled into re-binding something that is already bound
 * somewhere it belongs better — `AppRuntimeFacadeService` is worker-ONLY by
 * design (`requireAppClusterWorkerContext`), so its tokens must NOT move here.
 *
 * `WORKER_BOUND` is maintained by hand for the dependency reason above, and
 * `trigger-app-runtime.module.spec.ts` is what keeps the worker's own side
 * honest.
 *
 * ## ⚠ {@link BOUND} means "provided by module metadata", NOT "works in the API"
 *
 * A token in BOUND is one that some App Works module's `providers` metadata
 * names. That says nothing about whether the module is REACHABLE from the API's
 * (or the worker's) root module, and a module that nothing imports binds nothing
 * in any process. This register cannot see that difference.
 *
 * Measured 2026-09-26: `AppEnvModule` was in BOUND's reasoning while no API or
 * `packages/tasks` module imported it, so `APP_ENV_RESOLVER_FINGERPRINTS`,
 * `AppEnvResolver` and `AppEnvService` were `undefined` in the API's Builds
 * module. `AppBuildsModule` now imports it, and
 * `apps/api/src/app-builds/app-builds.module.spec.ts` pins that by composing the
 * API's real module. `AppRuntimeEnvModule` and `AppDependenciesModule` were, the
 * same day, still imported by no API or `packages/tasks` module, so their four
 * tokens (`APP_RUNTIME_ENV_SOURCE`, `APP_ENV_DEPLOY_READINESS`,
 * `APP_DEPENDENCIES_SERVICE`, `APP_DEPENDENCY_CONFIG_CIPHER`) sat in BOUND here
 * while absent from the API. `AppDeployRequestModule` imports both now (for the
 * deploy preconditions it declares), and
 * `__tests__/app-deploy-request.graph.spec.ts` composes it. The reachability
 * question is asked by `apps/api/src/app-works-di-reachability.spec.ts`, not by
 * this register — within its stated scope: every class of the App Works surface,
 * every ask FOR an App Works token anywhere in the API graph, the worker contexts
 * the `app-*` tasks boot, and the remote proxies those contexts dial. A
 * type-erased (`Object`) ask outside the surface is not in it; read that spec's
 * "What the walker does not see" before treating a green run as "all wired".
 *
 * ## How to use it when a number below changes
 *
 * A token moving from UNBOUND to BOUND is the point — update {@link BOUND} and
 * say in the commit what now works that did not. A token moving the other way
 * means a binding was lost; find it before changing the list. And a NEW token
 * declared under any `app-*` directory that is neither in {@link BOUND} nor in
 * {@link UNBOUND} fails the case "classifies every token the App Works
 * directories declare" on purpose: a port added without a decision about who
 * provides it is exactly the thing this register exists to stop. (That case was
 * promised here from the start and only written on 2026-09-26; five tokens had
 * slipped through in the meantime — see the headline case.) A token an App Works
 * module provides and {@link BOUND} does not name fails "names in BOUND every
 * declared …", the other half of "binds exactly".
 */

/** Every Nest module this programme declares, by the name its file gives it. */
const APP_WORKS_MODULES = {
    AppBuildsModule,
    AppDeployRequestModule,
    AppDependenciesModule,
    AppEnvModule,
    AppLauncherModule,
    AppRuntimeEnvModule,
    AppRuntimeStateModule,
    AppSpecModule,
    AppWorksModule,
} as const;

/** One provider entry as Nest's `providers` metadata can hold it. */
type ProviderEntry = { provide?: unknown } | (new (...args: never[]) => unknown);

/**
 * Every token any App Works module provides, read from Nest's own metadata.
 *
 * `provide` is what a `{ provide, useX }` entry declares; a bare class provider
 * provides itself, and is recorded under its class name.
 */
function boundTokenNames(): Set<string> {
    const names = new Set<string>();
    for (const module of Object.values(APP_WORKS_MODULES)) {
        const providers = (Reflect.getMetadata('providers', module) as ProviderEntry[]) ?? [];
        for (const provider of providers) {
            if (typeof provider === 'function') {
                names.add(provider.name);
                continue;
            }
            const token = (provider as { provide?: unknown }).provide;
            if (typeof token === 'symbol') {
                // `Symbol(FOO)` -> `FOO`
                names.add(token.description ?? token.toString());
            } else if (typeof token === 'function') {
                names.add((token as { name: string }).name);
            } else if (typeof token === 'string') {
                names.add(token);
            }
        }
    }
    return names;
}

/**
 * The tokens an App Works module really provides today.
 *
 * Measured 2026-09-21, from the metadata this file reads — not copied from a
 * document. Keep it sorted; it is read by people.
 */
const BOUND: readonly string[] = [
    // APW-05 T16 — `BuildFacadeService`, provided by `AppBuildsModule` (2026-09-21).
    // Four services in this epic inject it; until it was bound every one of them
    // took its `pluginUnavailable` branch and no Build could be requested.
    'APP_BUILD_PLUGIN_RESOLVER',
    // APW-05 T19/T20 — provided by `AppBuildsModule`. Found by THIS register on
    // its first run: they were in the unbound list when it was drafted from the
    // handover's prose, and the metadata said otherwise. Which is the point.
    'APP_BUILD_PREPARE_RUNNER',
    // APW-05 — the spec and work sources, bound 2026-09-22 by `AppBuildsModule`.
    // `APP_BUILD_WORK_SOURCE` carries the six facts a Build row cannot be
    // written without, so unbound `requestPrepare` answered `workUnavailable`
    // for EVERY App Work and no Build could be requested at all;
    // `APP_BUILD_SPEC_SOURCE` is what §5.1's `specValidAtCommit` clause reads,
    // so unbound it could never hold.
    // APW-05 §4.12 — APW-07's value-free runner recipe. The TOKEN has been
    // provided by `AppBuildsModule` since 2026-09-22, as a lazy lookup of
    // `AppEnvRuntimeSource`. Only `AppRuntimeEnvModule` provides that class, and
    // until 2026-09-26 no API module imported it, so the lookup found nothing and
    // a verification Build got "no recipe, nothing missing". The API reaches it
    // through `AppDeployRequestModule` now
    // (`app-builds/__tests__/app-builds.recipe-source.graph.spec.ts`).
    'APP_BUILD_RUNNER_RECIPE_SOURCE',
    'APP_BUILD_SPEC_SOURCE',
    'APP_BUILD_WATCH_RUNNER',
    'APP_BUILD_WORK_SOURCE',
    // ---- APW-07, wired 2026-09-22 ----------------------------------------
    //
    // `AppEnvModule` (T13) and `AppDependenciesModule` (T16) were both complete
    // and both in NO DI graph at all. `AppRuntimeEnvModule` imports the two and
    // performs the `useExisting` swaps their own docstrings specify. What each
    // token unblocked, measured rather than assumed:
    //
    //   APP_DEPENDENCIES_SERVICE       the Deploy preconditions' dependency
    //                                  check, the lifecycle removal ordering and
    //                                  the deletion task's kept-rows report
    //   APP_DEPENDENCY_CONFIG_CIPHER   every `configure` call and every stored
    //                                  dependency output answered
    //                                  `secureStorageUnavailable` on an
    //                                  installation that had a key
    //   APP_ENV_DEPLOY_READINESS       `AppEnvRuntimeSource.resolve` reported no
    //                                  not-ready dependencies AND dispatched no
    //                                  provisioning at all (GAP-05)
    //   APP_ENV_ENSURE_GENERATED       a generated entry with no row was
    //                                  unresolved rather than generated
    //   APP_ENV_RESOLVER_FINGERPRINTS  FR-24's changed-since-build and
    //                                  changed-since-deploy flags were ALWAYS
    //                                  false
    //   APP_RUNTIME_ENV_SOURCE         `AppDeployPreconditionsService` answered
    //                                  `env_source_unavailable`, so no
    //                                  Deployment could pass preconditions
    //
    // ⚠ Correction, 2026-09-26: "unblocked" above meant "provided by module
    // metadata", not "works in the API". At the time nothing imported
    // `AppRuntimeEnvModule`, and only that module imported `AppDependenciesModule`,
    // so `APP_DEPENDENCIES_SERVICE`, `APP_DEPENDENCY_CONFIG_CIPHER`,
    // `APP_ENV_DEPLOY_READINESS` and `APP_RUNTIME_ENV_SOURCE` were absent from the
    // API graph and `AppDeployPreconditionsService` answered
    // `env_source_unavailable`. Fixed the same day: `AppDeployRequestModule`
    // imports both modules, so the preconditions receive the env source and the
    // dependency service (`app-deploy-request.graph.spec.ts`). What that surfaces
    // next is `APP_DEPENDENCY_SPEC_SOURCE` (APW-07 T25, in UNBOUND below):
    // `ensureReadyForDeploy` answers `specUnavailable` until it is bound.
    // `AppEnvModule`'s three (`APP_ENV_SPEC_SOURCE`, `APP_ENV_ENSURE_GENERATED`,
    // `APP_ENV_RESOLVER_FINGERPRINTS`) reach the API through `AppBuildsModule`.
    'APP_DEPENDENCIES_SERVICE',
    'APP_DEPENDENCY_CONFIG_CIPHER',
    // APW-06 §9.2 — the deploy dispatcher and its availability probe, bound
    // 2026-09-22 by `AppDeployRequestModule` to ONE gate over the job-runtime
    // registry. Unbound, `request()` refused `422 worker_not_isolated` before
    // reading anything — which it STILL does when no runtime is registered or,
    // in production, when the operator has not attested the worker. Binding it
    // can only move a request from "refused before a row" to "dispatched".
    // APW-06 T16 — `AppDeployDeploymentStoreAdapter`, bound 2026-09-22 once
    // `work_deployments` grew the six App columns of plan §7.1. §2.2 step 4 had
    // nowhere to write the row a Deployment IS: the draft's `buildId`,
    // `appTarget`, `appTrigger` and `appRender` were not columns, so TypeORM
    // would have dropped all four silently.
    // APW-06 §5.1 — `AppDeployBuildSourceAdapter` over APW-05's Build rows,
    // bound 2026-09-22. Unbound, the preconditions answered `no_green_build`
    // for every App Work whether or not it had one.
    'APP_DEPLOY_BUILD_SOURCE',
    'APP_DEPLOY_DEPLOYMENT_STORE',
    'APP_DEPLOY_DISPATCHER',
    'APP_DEPLOY_DISPATCHER_AVAILABILITY',
    // APW-06 §5.1 — APW-03's `AppSpecService`, bound 2026-09-22. Unbound, the
    // preconditions pushed `spec_invalid` with "no App spec source is available
    // in this process" for EVERY request, so no App Work could deploy whatever
    // its spec actually said.
    'APP_DEPLOY_SPEC_SOURCE',
    'APP_ENV_DEPLOY_READINESS',
    'APP_ENV_ENSURE_GENERATED',
    'APP_ENV_RESOLVER_FINGERPRINTS',
    // APW-07 — APW-03's effective spec, bound 2026-09-22. The seam every read
    // in that epic goes through: unbound, `list` answered `[]`,
    // `missingRequired` found nothing missing and `ensureGenerated` had
    // nothing to generate, for every App Work.
    'APP_ENV_SPEC_SOURCE',
    // C10 — `buildAppForkReadinessDispatcherProvider()`, provided by `AppWorksModule`
    // over the active job runtime's dispatchers view. It had been provided since C10
    // and listed nowhere: the register only checked BOUND ⊆ provided until the
    // "names in BOUND every declared …" case (2026-09-26) checked the other half.
    'APP_FORK_READINESS_DISPATCHER',
    'APP_RUNTIME_ENV_SOURCE',
    // APW-03 T26 (explicit + probe halves) — `AppSourceCatalogAdapter`, bound
    // 2026-09-25 by `AppWorksModule`, beside the inspector and the create service
    // that inject it. Unbound, every inspect answered Blueprint `unavailable` and
    // licence class `unknown`, and every explicit `blueprintId` was refused
    // `400 blueprint_mismatch`. Now, wherever the platform holds a GitHub
    // credential for the ever-works catalog, the create preview carries a real
    // licence class (and `none` for a repository no Blueprint names), while a Blueprint
    // MATCH stays behind the apply gate until `APP_BLUEPRINT_APPLY_SERVICE`
    // (T28) is bound — without it a match would fail the Work's readiness.
    'APP_SOURCE_CATALOG_PORT',
    // APW-05 T16's two credential/fact ports, provided by `AppBuildsModule`
    // (2026-09-22). Declared by `build-facade.service.ts`, so they belong in this
    // register like any other port — a new token in NEITHER list fails the
    // "classifies every token …" case below.
    'BUILD_REPOSITORY_FACTS_SOURCE',
    'BUILD_TOKEN_SOURCE',
    // APW-06 — `DefaultManagedHostRootResolver`, provided by `AppLauncherModule`
    // (`useClass`). Provided and unlisted until 2026-09-26, like the readiness
    // dispatcher above.
    'MANAGED_HOST_ROOT_RESOLVER',
    // APW-06 T17 — provided by `AppRuntimeStateModule` (2026-09-21).
    'WORK_APP_RUNTIME_STATES',
];

/**
 * What `packages/tasks`' `TriggerAppRuntimeModule` binds, for the isolated App
 * cluster worker.
 *
 * Every one of these but three also appears in {@link UNBOUND}, and that is not a
 * contradiction — see the scope note in this file's header. They are listed
 * here so the register cannot be read as "nothing provides these anywhere",
 * which is the mistake it would otherwise invite. The three that are in
 * {@link BOUND} instead are the allow-listed overlap the case below names.
 *
 * Six are bound to real classes:
 *
 *   `APP_DEPLOY_TARGET_RESOLVER`, `APP_RUNTIME_DELETION_FACADE`,
 *   `APP_RUNTIME_VERIFICATION_FACADE` and `APP_RUNTIME_HEALTH_FACADE` all to
 *   `AppRuntimeFacadeService` — one class, so no consumer can be handed a
 *   different plugin; `APP_VERIFICATION_SPEC_SOURCE` to `AppRenderInputBuilder`;
 *   `APP_DEPLOY_HOST_SOURCE` to `AppHostsService`.
 *
 * Five are bound to `default-ports.ts`'s **deliberate fail-closed stubs** until
 * their owners land. `APP_RUNTIME_ENV_SOURCE` is the one worth understanding:
 * the agent package binds it to the REAL `AppEnvRuntimeSource`
 * (`AppRuntimeEnvModule`), and the worker deliberately does not — the worker
 * holds no DataSource, so the env service and resolver behind it cannot read a
 * row there. Two different answers for two different processes, both correct.
 *
 * Two are **proxied by name to the API's own binding** (2026-09-25):
 * `APP_DEPLOY_SPEC_SOURCE` to `AppSpecService` and `APP_DEPLOY_BUILD_SOURCE` to
 * `AppDeployBuildSourceAdapter`, the very providers `AppDeployRequestModule`
 * binds here. One implementation reached from two processes, not two instances.
 */
const WORKER_BOUND: readonly string[] = [
    'APPS_TIER_POLICY',
    'APP_DEPLOY_BUILD_SOURCE',
    'APP_DEPLOY_HOST_SOURCE',
    'APP_DEPLOY_SPEC_SOURCE',
    'APP_DEPLOY_TARGET_RESOLVER',
    'APP_IMAGE_PULL_CREDENTIAL_SOURCE',
    'APP_RUNTIME_DELETION_FACADE',
    'APP_RUNTIME_ENV_SOURCE',
    'APP_RUNTIME_HEALTH_FACADE',
    'APP_RUNTIME_TARGET',
    'APP_RUNTIME_VERIFICATION_FACADE',
    'APP_VERIFICATION_SINK',
    'APP_VERIFICATION_SPEC_SOURCE',
];

/**
 * The tokens that are declared, injected, and provided by NOTHING.
 *
 * Every one of them is an `@Optional()` injection, so an installation carrying
 * all of them boots perfectly and answers a refusal code instead of doing the
 * work. The refusal is usually named and honest — `pluginUnavailable`,
 * `state_unavailable`, `Unknown remote target` — which is the branch's best
 * habit; what was missing was anywhere that counted them.
 *
 * Keep it sorted. Shrinking it is the job.
 */
const UNBOUND: readonly string[] = [
    'APPS_DOMAIN_DNS_SERVICE',
    'APPS_TIER_POLICY',
    'APP_BLUEPRINT_APPLY_SERVICE',
    'APP_BUILD_EDIT_ACCESS',
    'APP_BUILD_PLATFORM_SETTINGS_WRITER',
    'APP_CLUSTER_OP_DISPATCHER',
    'APP_COMMIT_ANCESTRY',
    'APP_CUSTOM_DOMAIN_STORE',
    'APP_DEPENDENCY_CLUSTER_ACCESS',
    'APP_DEPENDENCY_SPEC_SOURCE',
    'APP_DEPLOY_HOST_SOURCE',
    'APP_DEPLOY_TARGET_RESOLVER',
    'APP_ENV_ACTIVITY',
    'APP_ENV_ACTOR_NAMES',
    'APP_ENV_BUILD_FINGERPRINTS',
    'APP_ENV_DEPLOY_FINGERPRINTS',
    // APW-01 T15 — bound OUTSIDE this package, twice: `apps/api`'s App Works module
    // (`useExisting: AppSourceInitializerService`) and the Trigger worker module. No
    // module in `packages/agent` provides it, which is all this list claims.
    'APP_FORK_READY_HANDLER',
    'APP_HEALTH_EGRESS_SOURCE',
    'APP_HOSTS_APPS_DOMAIN',
    'APP_HOSTS_DEPLOYMENT_STORE',
    'APP_HOSTS_DEPLOY_REQUESTER',
    'APP_HOSTS_REBUILD_REQUESTER',
    'APP_HOSTS_WORK_STORE',
    'APP_IMAGE_PULL_CREDENTIAL_SOURCE',
    'APP_IMAGE_REFERENCE_RESOLVER',
    'APP_LICENSE_SERVICE',
    // Still unbound ON PURPOSE (2026-09-22): its declared owner is APW-07's env
    // write path, and `AppEnvService.apply` needs an `AppEnvActor` and a spec
    // that declares the name. `storePrompted(workId, values)` carries neither,
    // and at create time the Blueprint that would declare the names has not
    // been applied. Binding it means inventing an actor and an ordering that
    // APW-07 T24/T25 own, and both are open.
    'APP_PROMPTED_VALUES_PORT',
    'APP_PROVISIONING_SERVICE',
    'APP_PROVISION_EVENTS_PORT',
    'APP_PUBLISHED_HOSTS',
    'APP_RUNTIME_DELETION_FACADE',
    'APP_RUNTIME_EVENT_SINK',
    'APP_RUNTIME_HEALTH_FACADE',
    'APP_RUNTIME_NOTIFICATIONS',
    'APP_RUNTIME_TARGET',
    'APP_RUNTIME_VERIFICATION_FACADE',
    'APP_SPEC_DISPLAY_NAMES',
    'APP_TARGET_UPDATED_PORT',
    'APP_UPSTREAM_LICENSE_SERVICE',
    'APP_UPSTREAM_PRIVATE_COPY_PORT',
    'APP_UPSTREAM_STATE_READER',
    // APW-02 T31's — `app-works.module.ts` records that its binding is not that
    // file's to add; nothing provides it anywhere yet.
    'APP_UPSTREAM_SYNC_DISPATCHER',
    'APP_UPSTREAM_SYNC_SPEC_SOURCE',
    'APP_VERIFICATION_SINK',
    'APP_VERIFICATION_SPEC_SOURCE',
    // APW-01 T36 — bound in `apps/api` by the `@Global()`
    // `AppWorksTelemetryBindingModule` (`useExisting: AnalyticsService`), whose global
    // export reaches `AppWorksTelemetryService` without an import. Unbound in THIS
    // package on purpose: the agent never depends on `@ever-works/monitoring`.
    'APP_WORKS_TELEMETRY_SINK',
    'APP_WORK_AGENT_RESOLVER',
    'APP_WORK_DELETION_COMPLETION',
    'APP_WORK_DELETION_PORT',
];

/**
 * `Symbol()`s under the App Works directories that are NOT injection tokens, each with
 * its reason — the only names the classification case below lets through unlisted.
 */
const NOT_A_PORT: readonly string[] = [
    // `app-deploy-request.service.ts` — the sentinel FR-23's 2 s dispatch budget rejects
    // with, so a dispatch failure is never mistaken for the budget running out. It is
    // compared by identity inside one method and never `@Inject()`ed.
    'APP_DEPLOY_REQUEST_BUDGET_EXCEEDED',
];

/**
 * Every `Symbol('…')` the App Works programme declares, by description → where: the
 * production sources of every `app-*` directory under `packages/agent/src`, read through
 * the same TypeScript-parser scan the duplicate-name case below uses (so a token quoted in
 * a comment is not a declaration).
 *
 * The job-runtime dispatchers under `tasks/` (`APP_BUILD_PREPARE_DISPATCHER` and the
 * rest) are deliberately out of scope: `buildJobRuntimeProviders()` binds every one of
 * them in `packages/tasks`' `@Global()` `TriggerModule`, and `job-runtime.providers.spec.ts`
 * is their register.
 */
function appWorksDeclaredTokens(): Map<string, string> {
    const declared = new Map<string, string>();
    const appDirectories = readdirSync(AGENT_SRC, { withFileTypes: true })
        .filter((entry) => entry.isDirectory() && entry.name.startsWith('app-'))
        .map((entry) => join(AGENT_SRC, entry.name));
    for (const directory of appDirectories) {
        for (const file of productionSourceFiles(directory)) {
            const at = relative(AGENT_SRC, file).split('\\').join('/');
            for (const { description } of symbolDeclarationsIn(at, readFileSync(file, 'utf8'))) {
                if (!declared.has(description)) declared.set(description, at);
            }
        }
    }
    return declared;
}

describe('App Works port dormancy register (§5.10)', () => {
    it('reads real provider metadata — a zero here would make every case below vacuous', () => {
        const bound = boundTokenNames();

        // Nine modules that between them provide services, repositories and at
        // least one symbol token. If this collapses, the metadata read broke and
        // the assertions underneath would all pass by accident.
        expect(Object.keys(APP_WORKS_MODULES)).toHaveLength(9);
        expect(bound.size).toBeGreaterThan(5);
    });

    it('binds exactly the tokens the BOUND list names', () => {
        const bound = boundTokenNames();
        const actuallyBound = [...BOUND].filter((name) => bound.has(name)).sort();

        expect(actuallyBound).toEqual([...BOUND].sort());
    });

    it('names in BOUND every declared App Works token an App Works module provides', () => {
        // The other half of "exactly": the case above proves every BOUND name is
        // provided, and this one that nothing provided is missing from BOUND — a
        // binding added without a line here would otherwise go uncounted.
        const bound = boundTokenNames();
        const providedButUnlisted = [...appWorksDeclaredTokens().keys()]
            .filter((name) => bound.has(name) && !BOUND.includes(name))
            .sort();

        expect(providedButUnlisted).toEqual([]);
    });

    it('WORK_APP_RUNTIME_STATES is bound — APW-06 T17, and the reason the list is not empty', () => {
        // Called out by name as well as by the derived assertion above, because
        // it is the one binding that took a table, a migration, a repository and
        // a port to make, and a refactor that quietly dropped it would put the
        // deploy path back on `503 app_deploy_state_unavailable` with nothing
        // else failing.
        expect(boundTokenNames().has('WORK_APP_RUNTIME_STATES')).toBe(true);
    });

    it('leaves the UNBOUND tokens unbound — the number, stated', () => {
        const bound = boundTokenNames();
        const wronglyBound = UNBOUND.filter((name) => bound.has(name));

        // If this fails, someone BOUND one of these: good news. Move it to
        // `BOUND` and say in the commit what now works that did not.
        expect(wronglyBound).toEqual([]);

        // The register's headline, and it is about THIS PACKAGE — see the
        // scope note in the header and `WORKER_BOUND`. It is an assertion
        // and not a log line so
        // that it cannot drift: **49 of the 73 tokens in these two lists are
        // dormant**, and the 24 that are not are named in `BOUND`. It was 62 of
        // 68 on 2026-09-21; APW-07's seven, APW-06's five and APW-05's three
        // moved across on 2026-09-22, and APW-03's catalog port on 2026-09-25.
        //
        // 46/22 → 49/24 on 2026-09-26 was not a binding change: the header had
        // promised a case that fails on a token in neither list, and no such
        // case existed, so five declared tokens were counted nowhere. The
        // "classifies every token …" case now exists and placed them — two
        // provided here (`APP_FORK_READINESS_DISPATCHER`,
        // `MANAGED_HOST_ROOT_RESOLVER`) and three that no module in this package
        // provides (`APP_FORK_READY_HANDLER`, `APP_UPSTREAM_SYNC_DISPATCHER`,
        // `APP_WORKS_TELEMETRY_SINK`).
        expect(UNBOUND).toHaveLength(49);
        expect(BOUND).toHaveLength(24);
    });

    it('names where the worker binds what this package does not', () => {
        // The register measures `packages/agent` only, and reading `UNBOUND` as
        // "dormant everywhere" is the mistake it invites.
        //
        // A token bound in BOTH packages is usually a defect — two instances of
        // a cluster facade is a way to hand two consumers different plugins —
        // so the overlap is an allow-list of three, each with its reason:
        //
        //   `APP_RUNTIME_ENV_SOURCE` is the REAL `AppEnvRuntimeSource` here and
        //   a fail-closed stub in the worker, because the worker holds no
        //   DataSource and the env service behind it cannot read a row there.
        //   Two processes, two correct answers.
        //
        //   `APP_DEPLOY_BUILD_SOURCE` and `APP_DEPLOY_SPEC_SOURCE` are NOT a
        //   second instance: the worker binds each to a `createRemoteProxy` of
        //   the API's own provider (`AppDeployBuildSourceAdapter`,
        //   `AppSpecService`), so both processes read through one implementation.
        const BOUND_IN_BOTH: readonly string[] = [
            'APP_DEPLOY_BUILD_SOURCE',
            'APP_DEPLOY_SPEC_SOURCE',
            'APP_RUNTIME_ENV_SOURCE',
        ];

        const overlap = BOUND.filter((name) => WORKER_BOUND.includes(name));
        expect(overlap).toEqual([...BOUND_IN_BOTH]);

        for (const name of WORKER_BOUND) {
            if (BOUND_IN_BOTH.includes(name)) continue;
            expect(UNBOUND).toContain(name);
        }

        // Sorted, like the other two, because it is read by people.
        expect([...WORKER_BOUND]).toEqual([...WORKER_BOUND].sort());
    });

    it('keeps both lists sorted and disjoint, so the register stays readable', () => {
        expect([...UNBOUND]).toEqual([...UNBOUND].sort());
        expect([...BOUND]).toEqual([...BOUND].sort());
        expect(UNBOUND.filter((name) => BOUND.includes(name))).toEqual([]);
    });

    it('classifies every token the App Works directories declare — a new port needs a decision', () => {
        // The case the header promises. A `Symbol()` added under an `app-*` directory
        // that is in neither list fails HERE, by name, until someone decides who
        // provides it; a list entry whose declaration was deleted fails here too.
        const declared = appWorksDeclaredTokens();
        const ports = [...declared.keys()].filter((name) => !NOT_A_PORT.includes(name));

        // Vacuity guard: the programme declares seventy-odd tokens. An empty scan would
        // pass both assertions below by accident.
        expect(ports.length).toBeGreaterThan(50);
        expect(NOT_A_PORT.filter((name) => !declared.has(name))).toEqual([]);

        const unclassified = ports
            .filter((name) => !BOUND.includes(name) && !UNBOUND.includes(name))
            .map((name) => `${name} (${declared.get(name)})`)
            .sort();
        const stale = [...BOUND, ...UNBOUND].filter((name) => !declared.has(name)).sort();

        expect(unclassified).toEqual([]);
        expect(stale).toEqual([]);
    });
});

/* -------------------------------------------------------------------------- *
 * One Symbol per name — the class of defect this register cannot see
 * -------------------------------------------------------------------------- */

/**
 * `packages/agent/src`, the tree the scan below reads.
 *
 * This spec lives in `src/app-runtime/__tests__/`, so the root is two levels up.
 */
const AGENT_SRC = join(__dirname, '..', '..');

/** One `Symbol('…')` call with a literal description, where it is written. */
interface SymbolDeclaration {
    description: string;
    at: string;
}

/**
 * Every `Symbol('literal')` call in one source text, read through the TypeScript parser — so a
 * `Symbol('X')` inside a comment or a string is NOT a declaration (several files quote a token's
 * text in prose), and `Symbol.for('X')`, which is one shared symbol by design, is never counted.
 */
function symbolDeclarationsIn(fileName: string, text: string): SymbolDeclaration[] {
    const source = ts.createSourceFile(fileName, text, ts.ScriptTarget.Latest, false);
    const found: SymbolDeclaration[] = [];
    const visit = (node: ts.Node): void => {
        if (
            ts.isCallExpression(node) &&
            ts.isIdentifier(node.expression) &&
            node.expression.text === 'Symbol' &&
            node.arguments.length === 1 &&
            ts.isStringLiteralLike(node.arguments[0])
        ) {
            const { line } = source.getLineAndCharacterOfPosition(node.getStart(source));
            found.push({
                description: (node.arguments[0] as ts.StringLiteralLike).text,
                at: `${fileName}:${line + 1}`,
            });
        }
        ts.forEachChild(node, visit);
    };
    visit(source);
    return found;
}

/** The production `.ts` files under `dir` — specs and `__tests__` build their own controls. */
function productionSourceFiles(dir: string): string[] {
    const files: string[] = [];
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const path = join(dir, entry.name);
        if (entry.isDirectory()) {
            if (entry.name === 'node_modules' || entry.name === '__tests__') continue;
            files.push(...productionSourceFiles(path));
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

/** Descriptions declared more than once, each with every place it is declared. */
function duplicatedDescriptions(declarations: SymbolDeclaration[]): Record<string, string[]> {
    const byDescription = new Map<string, string[]>();
    for (const { description, at } of declarations) {
        byDescription.set(description, [...(byDescription.get(description) ?? []), at]);
    }
    return Object.fromEntries([...byDescription].filter(([, places]) => places.length > 1));
}

describe('no two Symbol() tokens in packages/agent/src share a description', () => {
    // A Nest token is compared by IDENTITY, and a `Symbol('X')` in one file and another
    // `Symbol('X')` in a second file are two tokens that PRINT identically. When a provisional
    // seam re-declares its owner's token, the owner's binding never reaches the injection, every
    // `@Optional()` consumer stays `undefined`, and nothing fails — C8 (the two APW-05
    // dispatchers) and `APP_WORK_DELETION_PORT` (APW-06's provider vs APW-01's injection, which
    // would have let an App Work's row go while its workloads kept running) were both this.
    //
    // The register above cannot catch it: it keys tokens by DESCRIPTION, so a provider of the
    // wrong twin would even be reported as BOUND. This scan is what makes the name unique.

    it('detects a same-named pair and ignores comments, strings and Symbol.for (control)', () => {
        const control = [
            "// const inALineComment = Symbol('CONTROL_TOKEN');",
            "/* const inABlockComment = Symbol('CONTROL_TOKEN'); */",
            'const inAString = "Symbol(\'CONTROL_TOKEN\')";',
            "const shared = Symbol.for('CONTROL_TOKEN');",
            "export const FIRST = Symbol('CONTROL_TOKEN');",
            'export const SECOND = Symbol(`CONTROL_TOKEN`);',
            "export const UNIQUE = Symbol('UNIQUE_CONTROL_TOKEN');",
        ].join('\n');

        const declarations = symbolDeclarationsIn('control.ts', control);

        expect(declarations).toEqual([
            { description: 'CONTROL_TOKEN', at: 'control.ts:5' },
            { description: 'CONTROL_TOKEN', at: 'control.ts:6' },
            { description: 'UNIQUE_CONTROL_TOKEN', at: 'control.ts:7' },
        ]);
        expect(duplicatedDescriptions(declarations)).toEqual({
            CONTROL_TOKEN: ['control.ts:5', 'control.ts:6'],
        });
    });

    it('finds every description declared exactly once', () => {
        const declarations = productionSourceFiles(AGENT_SRC).flatMap((file) =>
            symbolDeclarationsIn(
                relative(AGENT_SRC, file).split('\\').join('/'),
                readFileSync(file, 'utf8'),
            ),
        );

        // Vacuity guard: the tree declares a hundred-odd tokens. If the walk or the parse
        // broke, an empty scan would pass the assertion below by accident.
        expect(declarations.length).toBeGreaterThan(50);
        expect(declarations.map((d) => d.description)).toContain('APP_WORK_DELETION_PORT');

        // If this fails, import the owner's token (and re-export it under the same name if a
        // barrel needs it) instead of declaring a second `Symbol()` — the C8 fix, f6fadb7b2.
        expect(duplicatedDescriptions(declarations)).toEqual({});
    });
});
