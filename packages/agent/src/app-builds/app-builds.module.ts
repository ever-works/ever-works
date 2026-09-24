import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { getOptionalProvider } from '../utils/optional-provider.util';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { DistributedTaskLockService } from '../cache/distributed-task-lock.service';
import { DatabaseModule } from '../database/database.module';
import { WorkRepository } from '../database/repositories/work.repository';
import { WorkAppSpecStateRepository } from '../database/repositories/work-app-spec-state.repository';
import { AppSpecService } from '../app-spec/app-spec.service';
import { AppEnvRuntimeSource } from '../app-env/app-env-runtime.source';
import { AppBuildPreparationRepository } from '../database/repositories/app-build-preparation.repository';
import { AppBuildRepository } from '../database/repositories/app-build.repository';
import { WorkBuild } from '../entities/work-build.entity';
import { WorkBuildPreparation } from '../entities/work-build-preparation.entity';
import { UsageModule } from '../usage/usage.module';
import { AppBuildPullTokenService } from './app-build-pull-token.service';
import { AppBuildPrepareRunner } from './app-build-prepare.runner';
import { AppBuildWatchRunner } from './app-build-watch.runner';
import {
    APP_BUILD_PLUGIN_RESOLVER,
    APP_BUILD_PREPARE_RUNNER,
    APP_BUILD_RUNNER_RECIPE_SOURCE,
    APP_BUILD_SPEC_SOURCE,
    APP_BUILD_WATCH_RUNNER,
    APP_BUILD_WORK_SOURCE,
    AppBuildsService,
    type AppBuildPluginResolver,
    type AppBuildRunnerRecipeSource,
    type AppBuildSpecSource,
    type AppBuildWorkSource,
} from './app-builds.service';
import {
    BUILD_REPOSITORY_FACTS_SOURCE,
    BUILD_TOKEN_SOURCE,
    BuildFacadeService,
    type BuildRepositoryFactsSource,
    type BuildTokenSource,
} from './build-facade.service';
import { GitBuildTokenSource } from './git-build-token.source';
import { UpstreamBuildFactsSource } from './upstream-build-facts.source';
import { AppBuildSpecReadSource } from './build-spec.source';
import { AppBuildWorkContextSource } from './build-work-context.source';
import { WorkUpstreamStateRepository } from '../database/repositories/work-upstream-state.repository';
import { GitFacadeService } from '../facades/git.facade';

/**
 * APW-05 T17 — the Builds module (T19 adds the prepare runner — see below).
 *
 * It provides and exports the three services, the two repositories and T19's
 * prepare runner this epic owns; everything else this service needs is injected
 * `@Optional()` behind a token this epic does not yet have a binder for, so the
 * module compiles and boots on its own (see `AppBuildsService`'s docstring).
 *
 * ## `TypeOrmModule.forFeature` is the fifth registration point
 *
 * `work_builds` and `work_build_preparations` are registered by
 * `entities/index.ts` (`export *`), `AGENT_ENTITY_NAMES`,
 * `_entities-inventory.ts` and the migration (§3.4:572-580). This is the fifth:
 * without `forFeature` the two repositories' `@InjectRepository` has no provider
 * to inject and the API fails at boot — the same reason `AppWorksModule` carries
 * its own `forFeature`.
 *
 * ## `WorkBuild` is injected into the service, not only into the repository
 *
 * `AppBuildsService` performs two conditional claims (`startedAt`, and the
 * terminal transition) whose whole point is the WHERE predicate, plus the field
 * patches that turn a snapshot into a row. `AppBuildRepository` owns the number
 * arithmetic and the run-identity upsert; it exposes no generic patch. Including
 * the entity in `forFeature` is what makes `@InjectRepository(WorkBuild)` resolvable
 * in the service.
 *
 * ## What is deliberately NOT bound here
 *
 * `APP_BUILD_PLUGIN_RESOLVER` (T16), `APP_BUILD_PREPARE_DISPATCHER` /
 * `APP_BUILD_WATCH_DISPATCHER` (T18), `APP_BUILD_WATCH_RUNNER` (T20),
 * `APP_BUILD_WORK_SOURCE`, `APP_BUILD_SPEC_SOURCE` (APW-03),
 * `APP_BUILD_RUNNER_RECIPE_SOURCE` (APW-07), `APP_BUILD_PLATFORM_SETTINGS_WRITER`
 * (§4.12), `APP_BUILD_EDIT_ACCESS` and `APP_PROVISION_EVENTS_PORT` (APW-04) all
 * stay **unbound**: binding a placeholder would make an unconfigured installation
 * look configured, which is the failure mode `AppWorksModule`'s docstring names
 * for exactly this reason. Each absence has a documented, fail-closed behaviour —
 * `null` plugin ⇒ `pullTokenUnavailable` / no provider call; unbound dispatcher ⇒
 * §7.1's in-process fallback; unbound fingerprints ⇒ `staleInputs`; unbound edit
 * port ⇒ `canEdit: false`. T19's prepare runner answers three of the same
 * absences in its own vocabulary, so the two lists agree: `null` plugin ⇒
 * `pluginUnavailable` and no provider call; unbound APW-07 resolver ⇒
 * `buildValuesUnavailable`, never a zero-secret sync; unbound work or spec source
 * ⇒ `workUnavailable` / `specUnavailable`.
 *
 * ## T19 — the prepare runner joins them, and its token is bound
 *
 * `AppBuildPrepareRunner` is provided and exported beside the service, because
 * §7.1's null-dispatch fallback is only real when the runner is resolvable: with
 * the token unbound, `AppBuildsService.dispatchPrepare` would return `false`,
 * run nothing, and leave every requested Build `queued` forever behind a log
 * line. Binding it is therefore not "making an unconfigured installation look
 * configured" — it IS the implementation; its COLLABORATORS are what stay
 * unbound, and the runner fails closed without them by name.
 *
 * The token is bound through a `ModuleRef` factory rather than
 * `useExisting: AppBuildPrepareRunner`, and that is load-bearing: the runner
 * injects `AppBuildsService`, which injects
 * `@Optional() @Inject(APP_BUILD_PREPARE_RUNNER)`, so a plain alias would be a
 * provider cycle Nest refuses to bootstrap. The lookup happens at call time,
 * which costs nothing because a dispatch is already asynchronous — the same
 * de-cycling shape `app-env.resolver.ts:97-116` documents for
 * `APP_ENV_ENSURE_GENERATED`.
 *
 * `DatabaseModule` is imported for `CacheEntry`'s repository, which
 * `DistributedTaskLockService` injects non-optionally; the lock itself is
 * provided locally exactly as `AppSpecModule`, `AppWorksModule` and
 * `CommunityPrModule` provide it.
 */
@Module({
    imports: [
        // This epic's two tables. `forFeature` is what registers the entities with
        // the DataSource the application opened; without it the repositories'
        // `@InjectRepository` has no provider and the API fails at boot.
        TypeOrmModule.forFeature([WorkBuild, WorkBuildPreparation]),
        // The repository wrappers `DatabaseModule` provides and exports — the
        // `cache_entries` repository `DistributedTaskLockService` needs above all,
        // since it injects `@InjectRepository(CacheEntry)` non-optionally.
        DatabaseModule,
        // The single Activity + event writer of §7.8 needs `ActivityLogService`; the
        // receipt of §7.3 needs `PluginUsageService`. Both modules are leaf imports
        // with respect to this one — neither imports it — so nothing here can become
        // a cycle.
        ActivityLogModule,
        UsageModule,
    ],
    providers: [
        AppBuildRepository,
        AppBuildPreparationRepository,
        // §7.2's `app-build-prepare:<workId>` lock, held for the job's passes.
        DistributedTaskLockService,
        AppBuildsService,
        AppBuildPullTokenService,
        AppBuildPrepareRunner,
        // APW-05 T16 — the resolver four services in this epic inject and nothing
        // provided until 2026-09-21, so every one of them took its
        // `pluginUnavailable` branch and no Build could be requested at all.
        //
        // `useExisting`, so the facade is one instance under two names. It is
        // constructed with `PluginRegistryService` and `WorkRepository` required
        // and its two credential/fact ports `@Optional()`, which is why binding
        // it here does not drag the credential stack into this module: with
        // nothing bound for those, `resolve` answers `null` and says which half
        // was missing in the log.
        BuildFacadeService,
        { provide: APP_BUILD_PLUGIN_RESOLVER, useExisting: BuildFacadeService },
        // APW-05 T16's credential half. Without it `BuildFacadeService` resolves
        // to `null` for every Work — an honest refusal and a useless one, since
        // nothing could ever build. `GitFacadeService.getAccessToken` is the
        // platform's existing answer to "what token acts on this Work's
        // repository for this member", ladder and all.
        //
        // Resolved through `ModuleRef` NON-STRICTLY, and deliberately not by
        // importing `FacadesModule`. That import was tried and is not shippable:
        // it drags the whole facade graph in, and `AiFacadeService` needs
        // `PluginRegistryService` from the `@Global()` plugins module — which is
        // registered at the API root and absent when this module is compiled
        // alone. `app-builds.module.spec.ts` compiles it alone on purpose, and it
        // failed with `Nest can't resolve dependencies of the AiFacadeService`.
        //
        // So the lookup is lazy and per call: the module composes standalone, a
        // running API finds the real facade, and an injector that has none gets a
        // `null` token — which `BuildFacadeService` already reports as "no
        // credential" with the reason logged.
        {
            provide: BUILD_TOKEN_SOURCE,
            useFactory: (ref: ModuleRef): BuildTokenSource => ({
                getBuildToken: async (input) => {
                    const gitFacade = getOptionalProvider<GitFacadeService>(ref, GitFacadeService);
                    if (!gitFacade) return null;
                    return new GitBuildTokenSource(gitFacade).getBuildToken(input);
                },
            }),
            inject: [ModuleRef],
        },
        // APW-05 T16's other half: whether the repository is ours to push a
        // workflow change into (`WorkUpstreamState.relation`), and which runner
        // class it needs. Resolved through `ModuleRef` non-strictly for the same
        // reason the token source above is: `WorkUpstreamStateRepository` is
        // provided by `AppWorksModule`, not by this one, and importing that
        // module here would make `app-builds.module.spec.ts` stop compiling
        // standalone. With nothing to find, the facade's own SAFE defaults apply
        // and a Build takes the pull-request path on the private runner.
        {
            provide: BUILD_REPOSITORY_FACTS_SOURCE,
            useFactory: (ref: ModuleRef): BuildRepositoryFactsSource => ({
                getBuildRepositoryFacts: async (input) => {
                    const states = getOptionalProvider<WorkUpstreamStateRepository>(
                        ref,
                        WorkUpstreamStateRepository,
                    );
                    if (!states) return null;
                    return new UpstreamBuildFactsSource(states).getBuildRepositoryFacts(input);
                },
            }),
            inject: [ModuleRef],
        },
        // APW-05 — the six facts a Build row cannot be written without. Unbound,
        // `requestPrepare` answered `workUnavailable` for every App Work, so no
        // Build could be requested at all.
        //
        // Lazy through `ModuleRef` for the reason the two credential sources
        // above are: `WorkAppSpecStateRepository` belongs to `AppSpecModule` and
        // importing that module here would stop `app-builds.module.spec.ts`
        // compiling standalone (it carries `FacadesModule`, which needs the
        // `@Global()` plugin registry). `WorkRepository` comes from
        // `DatabaseModule`, which this module already imports, so it is resolved
        // strictly — its absence IS a wiring fault and should say so.
        {
            provide: APP_BUILD_WORK_SOURCE,
            useFactory: (ref: ModuleRef, works: WorkRepository): AppBuildWorkSource => ({
                read: async (workId: string) =>
                    new AppBuildWorkContextSource(
                        works,
                        getOptionalProvider<WorkAppSpecStateRepository>(
                            ref,
                            WorkAppSpecStateRepository,
                        ) ?? null,
                        getOptionalProvider<AppBuildPluginResolver>(
                            ref,
                            APP_BUILD_PLUGIN_RESOLVER,
                        ) ?? null,
                    ).read(workId),
            }),
            inject: [ModuleRef, WorkRepository],
        },
        // APW-07's VALUE-FREE recipe, for §4.12's runner verification. The plan
        // is explicit that it carries the recipe and **never a resolved value**
        // (`plan.md:1025-1030`), which is why only the `runner` half of
        // `resolveEphemeral` is declared on this port: the `cluster` half
        // returns real values and has no business in a Build.
        //
        // The context is widened here rather than by the port. APW-07's method
        // takes `AppRuntimeEphemeralEnvContext` — primary host, primary URL,
        // build commit, internal URLs — and the runner branch reads none of
        // them; a Build has no host and no URL to resolve against, which is what
        // makes its recipe value-free in the first place. Passing `null` for
        // each is the honest translation, not a stub.
        {
            provide: APP_BUILD_RUNNER_RECIPE_SOURCE,
            useFactory: (ref: ModuleRef): AppBuildRunnerRecipeSource => ({
                resolveEphemeral: async (workId, specCommitSha, ctx) => {
                    const env = getOptionalProvider<AppEnvRuntimeSource>(ref, AppEnvRuntimeSource);
                    if (!env) {
                        // Unbound reads as "no recipe and nothing missing",
                        // which is what §4.12 already does with an absent one:
                        // the verification job runs with no env rather than
                        // refusing the Build.
                        return { secretNames: [], unsetRequired: [] };
                    }
                    return env.resolveEphemeral(workId, specCommitSha, {
                        target: ctx.target,
                        primaryUrl: null,
                        primaryHost: null,
                        buildCommitSha: null,
                        internalUrls: {},
                    });
                },
            }),
            inject: [ModuleRef],
        },
        // APW-03's effective spec, collapsed to the four facts §5.1 reads. Same
        // lazy shape, same reason: `AppSpecService` lives in `AppSpecModule`.
        {
            provide: APP_BUILD_SPEC_SOURCE,
            useFactory: (ref: ModuleRef): AppBuildSpecSource => ({
                read: async (workId: string, sha?: string | null) => {
                    const specs = getOptionalProvider<AppSpecService>(ref, AppSpecService);
                    if (!specs) return null;
                    return new AppBuildSpecReadSource(specs).read(workId, sha);
                },
            }),
            inject: [ModuleRef],
        },
        {
            provide: APP_BUILD_PREPARE_RUNNER,
            useFactory: (ref: ModuleRef) => ({
                run: async (payload: unknown) =>
                    (await ref.get(AppBuildPrepareRunner)).run(payload as never),
            }),
            inject: [ModuleRef],
        },
        // APW-05 T20 + C17 — the same binding for the watch half, and for exactly the same
        // reason (see the prepare block above and the class docstring): §7.1's fallback is
        // `this.watchRunner?.run(payload)`, so with `APP_BUILD_WATCH_RUNNER` unbound the
        // `@Optional()` injection stays `undefined` and a watch whose job runtime is absent
        // is **silently dropped** — the sweep re-offers it later, which is why the defect is
        // invisible rather than loud. Same de-cycling shape: `AppBuildWatchRunner` injects
        // `AppBuildsService`, which injects this token, so `useExisting` would be a cycle and
        // the lookup happens at call time.
        AppBuildWatchRunner,
        {
            provide: APP_BUILD_WATCH_RUNNER,
            useFactory: (ref: ModuleRef) => ({
                run: async (payload: unknown) =>
                    (await ref.get(AppBuildWatchRunner)).run(payload as never),
            }),
            inject: [ModuleRef],
        },
    ],
    exports: [
        AppBuildRepository,
        AppBuildPreparationRepository,
        AppBuildsService,
        AppBuildPullTokenService,
        AppBuildPrepareRunner,
        AppBuildWatchRunner,
        // Exported as well as provided: a token bound in `providers` and absent
        // from `exports` resolves to `undefined` at every `@Optional() @Inject()`
        // site in another module, silently — which is exactly the defect
        // `packages/tasks`' own guard caught three dispatchers committing.
        BuildFacadeService,
        APP_BUILD_PLUGIN_RESOLVER,
        BUILD_TOKEN_SOURCE,
        BUILD_REPOSITORY_FACTS_SOURCE,
        APP_BUILD_WORK_SOURCE,
        APP_BUILD_SPEC_SOURCE,
        APP_BUILD_RUNNER_RECIPE_SOURCE,
    ],
})
export class AppBuildsModule {}
