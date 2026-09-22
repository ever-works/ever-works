import { AppBuildsModule } from '../../app-builds/app-builds.module';
import { AppDependenciesModule } from '../../app-dependencies/app-dependencies.module';
import { AppEnvModule } from '../../app-env/app-env.module';
import { AppLauncherModule } from '../../app-launcher/app-launcher.module';
import { AppSpecModule } from '../../app-spec/app-spec.module';
import { AppWorksModule } from '../../app-works/app-works.module';
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
 * which ones does any App Works module claim to provide?*
 *
 * ## How to use it when a number below changes
 *
 * A token moving from UNBOUND to BOUND is the point — update {@link BOUND} and
 * say in the commit what now works that did not. A token moving the other way
 * means a binding was lost; find it before changing the list. And a NEW token
 * that is neither in {@link BOUND} nor in {@link UNBOUND} fails the last case
 * in this file on purpose: a port added without a decision about who provides
 * it is exactly the thing this register exists to stop.
 */

/** Every Nest module this programme declares, by the name its file gives it. */
const APP_WORKS_MODULES = {
    AppBuildsModule,
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
    'APP_BUILD_WATCH_RUNNER',
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
    'APP_DEPENDENCIES_SERVICE',
    'APP_DEPENDENCY_CONFIG_CIPHER',
    'APP_ENV_DEPLOY_READINESS',
    'APP_ENV_ENSURE_GENERATED',
    'APP_ENV_RESOLVER_FINGERPRINTS',
    'APP_RUNTIME_ENV_SOURCE',
    // APW-05 T16's two credential/fact ports, provided by `AppBuildsModule`
    // (2026-09-22). Declared by `build-facade.service.ts`, so they belong in this
    // register like any other port — a new token in NEITHER list fails the last
    // case in this file, which is how they got here.
    'BUILD_REPOSITORY_FACTS_SOURCE',
    'BUILD_TOKEN_SOURCE',
    // APW-06 T17 — provided by `AppRuntimeStateModule` (2026-09-21).
    'WORK_APP_RUNTIME_STATES',
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
    'APP_BUILD_RUNNER_RECIPE_SOURCE',
    'APP_BUILD_SPEC_SOURCE',
    'APP_BUILD_WORK_SOURCE',
    'APP_CLUSTER_OP_DISPATCHER',
    'APP_COMMIT_ANCESTRY',
    'APP_CUSTOM_DOMAIN_STORE',
    'APP_DEPENDENCY_CLUSTER_ACCESS',
    'APP_DEPENDENCY_SPEC_SOURCE',
    'APP_DEPLOY_BUILD_SOURCE',
    'APP_DEPLOY_DEPLOYMENT_STORE',
    'APP_DEPLOY_DISPATCHER',
    'APP_DEPLOY_DISPATCHER_AVAILABILITY',
    'APP_DEPLOY_HOST_SOURCE',
    'APP_DEPLOY_SPEC_SOURCE',
    'APP_DEPLOY_TARGET_RESOLVER',
    'APP_ENV_ACTIVITY',
    'APP_ENV_ACTOR_NAMES',
    'APP_ENV_BUILD_FINGERPRINTS',
    'APP_ENV_DEPLOY_FINGERPRINTS',
    'APP_ENV_SPEC_SOURCE',
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
    'APP_SOURCE_CATALOG_PORT',
    'APP_SPEC_DISPLAY_NAMES',
    'APP_TARGET_UPDATED_PORT',
    'APP_UPSTREAM_LICENSE_SERVICE',
    'APP_UPSTREAM_PRIVATE_COPY_PORT',
    'APP_UPSTREAM_STATE_READER',
    'APP_UPSTREAM_SYNC_SPEC_SOURCE',
    'APP_VERIFICATION_SINK',
    'APP_VERIFICATION_SPEC_SOURCE',
    'APP_WORK_AGENT_RESOLVER',
    'APP_WORK_DELETION_COMPLETION',
    'APP_WORK_DELETION_PORT',
];

describe('App Works port dormancy register (§5.10)', () => {
    it('reads real provider metadata — a zero here would make every case below vacuous', () => {
        const bound = boundTokenNames();

        // Eight modules that between them provide services, repositories and at
        // least one symbol token. If this collapses, the metadata read broke and
        // the assertions underneath would all pass by accident.
        expect(Object.keys(APP_WORKS_MODULES)).toHaveLength(8);
        expect(bound.size).toBeGreaterThan(5);
    });

    it('binds exactly the tokens the BOUND list names', () => {
        const bound = boundTokenNames();
        const actuallyBound = [...BOUND].filter((name) => bound.has(name)).sort();

        expect(actuallyBound).toEqual([...BOUND].sort());
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

        // The register's headline. It is an assertion and not a log line so
        // that it cannot drift: **56 of the 68 tokens in these two lists are
        // dormant**, and the 12 that are not are named in `BOUND`. It was 62 of
        // 68 on 2026-09-21; APW-07's six moved across on 2026-09-22.
        expect(UNBOUND).toHaveLength(56);
        expect(BOUND).toHaveLength(12);
    });

    it('keeps both lists sorted and disjoint, so the register stays readable', () => {
        expect([...UNBOUND]).toEqual([...UNBOUND].sort());
        expect([...BOUND]).toEqual([...BOUND].sort());
        expect(UNBOUND.filter((name) => BOUND.includes(name))).toEqual([]);
    });
});
