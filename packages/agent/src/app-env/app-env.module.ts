/**
 * APW-07 T13 — the App env module.
 *
 * What it binds, and nothing more:
 *
 * - `WorkAppEnvValue` through `TypeOrmModule.forFeature`, so the feature-owned
 *   repository below can be constructed; the table itself is created by T7's
 *   migration.
 * - `WorkAppEnvValueRepository` — feature-owned (T8): provided here and exported,
 *   NOT by `DatabaseModule`, which is why `_repository-inventory.ts` deliberately
 *   does not list it.
 * - `AppEnvCrypto` (T9), exported because `AppDependenciesModule`'s
 *   `APP_DEPENDENCY_CONFIG_CIPHER` swap is `useExisting: AppEnvCrypto` — the
 *   epic's ONE envelope, shared by env values, provider configuration and
 *   dependency outputs (`app-dependencies.service.ts:304-323`). Its own
 *   collaborator, `PluginSecretEncService`, comes from the globally registered
 *   `PluginsModule.forRoot()` and is `@Optional()` there, so a module graph
 *   without it means "no key" — a 503, never a plaintext fallback.
 * - `AppEnvService`, exported for T24/T25's routes, APW-05's Build value
 *   materialisation, APW-06's Deploy preflight and T15's listener (plan
 *   §5:822-826).
 *
 * The `.env` parser is T12's `dotenv-parser.ts` — a pure function this module
 * does not and must not provide. `AppEnvService.apply` imports it directly, so
 * there is no token that could resolve to nothing and no way for an import to
 * answer "0 imported" because a provider was forgotten.
 *
 * - `AppEnvResolver` (T14) and the two seams it closes, added 2026-09-22 — see
 *   below.
 *
 * ## The two seams this module DOES bind, and why they moved here
 *
 * An earlier revision of this docstring listed `APP_ENV_RESOLVER_FINGERPRINTS`
 * among the seams whose implementation "does not exist in this tree yet",
 * naming APW-07 T14's `AppEnvResolver`. That was **false when it was written**:
 * `app-env.resolver.ts` is 1,000+ lines in this same folder and `AppEnvResolver`
 * is the class the claim says is missing. The consequence was not cosmetic —
 * `AppEnvService.fingerprints` answered "no resolution" for an installation that
 * had one, so FR-24's changed-since-deploy flags were always `false`.
 *
 * Both bindings have to live **here**, not in a wiring module that imports this
 * one, because Nest resolves a provider's dependencies in the module that
 * declares the provider: `AppEnvService` is declared here, so the token it
 * injects must be provided here or it receives `undefined`.
 *
 * - `APP_ENV_RESOLVER_FINGERPRINTS` → `{ useExisting: AppEnvResolver }`, the
 *   swap `app-env.service.ts:314` documents.
 * - `APP_ENV_ENSURE_GENERATED` → a **call-time** `ModuleRef` lookup of
 *   `AppEnvService`, exactly as `app-env.resolver.ts:97-117` requires: the two
 *   classes inject each other's token, and two plain `useExisting` aliases are a
 *   provider cycle Nest refuses to bootstrap. `ensureGenerated` is idempotent,
 *   so resolving the service per call costs nothing.
 *
 * `TypeOrmModule.forFeature` also gained `WorkAppDependency`, because
 * `AppEnvResolver` reads dependency rows directly (`app-env.resolver.ts:591`)
 * and without the feature every `ew-dep://` reference resolves
 * `dependencyNotReady`. The rows are read, never written, here.
 *
 * ## The seams this module still does NOT bind (and why that is deliberate)
 * `APP_ENV_SPEC_SOURCE`, `APP_ENV_ACTIVITY`, `APP_ENV_BUILD_FINGERPRINTS`,
 * `APP_ENV_DEPLOY_FINGERPRINTS` and `APP_ENV_ACTOR_NAMES` are other owners' —
 * APW-03's `AppSpecService`, APW-07 T26's activity writer, APW-05's
 * `WorkBuild.buildValueFingerprints`, APW-06's `appRender.envFingerprints` and
 * APW-01's Work-member read. None of those exists in this tree, so none can be
 * bound without inventing it. `AppEnvService` takes every one `@Optional()` and
 * answers each absence explicitly (`specUnavailable`, `activityRecorded: false`,
 * `false` for both change flags, `null` for an unresolvable actor name), so an
 * unbound seam degrades into a named answer rather than a silent success. The
 * bindings land with their owners — the exact `useExisting` swap of each is in
 * the block above its token in `app-env.service.ts`.
 *
 * `APP_RUNTIME_ENV_SOURCE` and `APP_ENV_DEPLOY_READINESS` are bound by
 * `AppRuntimeEnvModule` (`app-runtime-env.module.ts`) rather than here: their
 * consumer is `AppEnvRuntimeSource`, which needs `AppDependenciesService`, and
 * importing `AppDependenciesModule` from here would make the two modules
 * mutually dependent. That module imports both and is the composition root.
 */

import { Module } from '@nestjs/common';
import { ModuleRef } from '@nestjs/core';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAppEnvValue } from '../entities/work-app-env-value.entity';
import { WorkAppDependency } from '../entities/work-app-dependency.entity';
import { WorkAppEnvValueRepository } from '../database/repositories/work-app-env-value.repository';
import { AppEnvCrypto } from './app-env-crypto';
import { AppSpecService } from '../app-spec/app-spec.service';
import {
    APP_ENV_RESOLVER_FINGERPRINTS,
    APP_ENV_SPEC_SOURCE,
    AppEnvService,
    type AppEnvSpecSource,
} from './app-env.service';
import { AppEnvSpecReadSource } from './app-env-spec.source';
import { APP_ENV_ENSURE_GENERATED, AppEnvResolver } from './app-env.resolver';

@Module({
    imports: [TypeOrmModule.forFeature([WorkAppEnvValue, WorkAppDependency])],
    providers: [
        WorkAppEnvValueRepository,
        AppEnvCrypto,
        AppEnvResolver,
        AppEnvService,
        // APW-03's effective spec — the seam EVERY read in this epic goes
        // through. Unbound it answered "no entries at all" for every App Work.
        //
        // Lazy through `ModuleRef` rather than an `AppSpecModule` import: that
        // module carries `DatabaseModule`, `FacadesModule` and
        // `ActivityLogModule`, and `FacadesModule` needs the `@Global()` plugin
        // registry that only exists at the API root. `AppEnvModule` is compiled
        // standalone by its own spec and by `AppRuntimeEnvModule`'s, and this
        // keeps both possible — the same shape `app-builds.module.ts` uses for
        // its four cross-module sources.
        {
            provide: APP_ENV_SPEC_SOURCE,
            useFactory: (ref: ModuleRef): AppEnvSpecSource => ({
                read: async (workId: string) => {
                    const specs = ref.get(AppSpecService, { strict: false });
                    if (!specs) return null;
                    return new AppEnvSpecReadSource(specs).read(workId);
                },
            }),
            inject: [ModuleRef],
        },
        // FR-24's changed-since-build / changed-since-deploy flags. A plain
        // alias, because the resolver IS the resolution this token names.
        { provide: APP_ENV_RESOLVER_FINGERPRINTS, useExisting: AppEnvResolver },
        {
            // The cycle break `app-env.resolver.ts:97-117` specifies: the service
            // injects the resolver's token and the resolver injects the
            // service's, so the generation side resolves at CALL time. Nest
            // refuses to bootstrap two plain aliases here.
            provide: APP_ENV_ENSURE_GENERATED,
            useFactory: (ref: ModuleRef) => ({
                ensureGenerated: async (workId: string) => {
                    await ref.get(AppEnvService).ensureGenerated(workId);
                },
            }),
            inject: [ModuleRef],
        },
    ],
    exports: [
        AppEnvService,
        AppEnvCrypto,
        AppEnvResolver,
        WorkAppEnvValueRepository,
        APP_ENV_RESOLVER_FINGERPRINTS,
        APP_ENV_ENSURE_GENERATED,
        APP_ENV_SPEC_SOURCE,
    ],
})
export class AppEnvModule {}
