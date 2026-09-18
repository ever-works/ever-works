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
 * ## The seams this module does NOT bind (and why that is deliberate)
 * `APP_ENV_SPEC_SOURCE`, `APP_ENV_ACTIVITY`, `APP_ENV_BUILD_FINGERPRINTS`,
 * `APP_ENV_DEPLOY_FINGERPRINTS`, `APP_ENV_RESOLVER_FINGERPRINTS` and
 * `APP_ENV_ACTOR_NAMES` are other owners' — APW-03's `AppSpecService`, APW-07
 * T26's activity writer, APW-05's `WorkBuild.buildValueFingerprints`, APW-06's
 * `appRender.envFingerprints`, APW-07 T14's `AppEnvResolver` and APW-01's
 * Work-member read. None of them exists in this tree yet, so none can be bound
 * without inventing it. `AppEnvService` takes every one `@Optional()` and answers
 * each absence explicitly (`specUnavailable`, `activityRecorded: false`, `false`
 * for both change flags, `null` for an unresolvable actor name), so an unbound
 * seam degrades into a named answer rather than a silent success. The bindings
 * land with their owners — the exact `useExisting` swap of each is in the block
 * above its token in `app-env.service.ts`.
 */

import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { WorkAppEnvValue } from '../entities/work-app-env-value.entity';
import { WorkAppEnvValueRepository } from '../database/repositories/work-app-env-value.repository';
import { AppEnvCrypto } from './app-env-crypto';
import { AppEnvService } from './app-env.service';

@Module({
    imports: [TypeOrmModule.forFeature([WorkAppEnvValue])],
    providers: [WorkAppEnvValueRepository, AppEnvCrypto, AppEnvService],
    exports: [AppEnvService, AppEnvCrypto, WorkAppEnvValueRepository],
})
export class AppEnvModule {}
