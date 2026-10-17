// `AppDependenciesModule` imports `FacadesModule` for `AppDependencyFacadeService`,
// and that module pulls in the whole plugin-registry tree, which is registered
// GLOBALLY by `PluginsModule.forRoot()` at application bootstrap. This file used
// to shell `FacadesModule` (`jest.mock`) so it stayed a test of THIS wiring,
// leaning on `AppDependenciesService` taking the facade `@Optional()`.
//
// #2688 (A0.10, APW-07 T25) made `AppDependenciesModule` import `AppSpecModule`
// for the dependency spec source, and `AppSpecService` injects `GitFacadeService`
// from `FacadesModule` NON-optionally (plus the global event emitter and the
// cache the distributed lock reads). A shelled `FacadesModule` can no longer
// compile that graph, so the shell is gone: the compile below stands in only what
// the API ROOT registers — the in-memory DataSource, the global event emitter,
// the global cache and the global `PluginsModule.forRoot()` (registered, never
// bootstrapped: no plugin is loaded) — exactly as
// `app-runtime/__tests__/app-deploy-request.graph.spec.ts` composes it. Every
// assertion below is unchanged; the graph under test is now the real one.
import { CacheModule } from '@nestjs/cache-manager';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';

import { ENTITIES } from '../../database/_entities-inventory';
import { PluginsModule } from '../../plugins/plugins.module';
import { AppDependenciesService } from '../../app-dependencies/app-dependencies.service';
import { APP_DEPENDENCY_CONFIG_CIPHER } from '../../app-dependencies/app-dependencies.service';
import { APP_DEPENDENCIES_SERVICE } from '../../app-runtime/app-runtime-deletion.service';
import { APP_RUNTIME_ENV_SOURCE } from '../../app-runtime/ports';
import { AppEnvCrypto } from '../app-env-crypto';
import { APP_ENV_DEPLOY_READINESS, AppEnvRuntimeSource } from '../app-env-runtime.source';
import { APP_ENV_ENSURE_GENERATED, AppEnvResolver } from '../app-env.resolver';
import { APP_ENV_RESOLVER_FINGERPRINTS, AppEnvService } from '../app-env.service';
import { AppRuntimeEnvModule } from '../app-runtime-env.module';

/**
 * APW-07 — the env and dependency modules, COMPILED and WIRED.
 *
 * `AppEnvModule` and `AppDependenciesModule` were both complete and both in no
 * DI graph at all. That is the exact gap a unit test cannot see: every spec in
 * this epic hand-constructs its subject, so all of them passed while nothing in
 * the product could reach any of it.
 *
 * What this file proves is the part hand-construction cannot:
 *
 *   1. the graph BOOTS — including `AppEnvResolver`'s two TypeORM repositories
 *      and the `APP_ENV_ENSURE_GENERATED` factory that exists to break a
 *      provider cycle Nest would otherwise refuse;
 *   2. each seam resolves to the class its own docstring names, not to
 *      `undefined`, which is what an `@Optional()` injection silently becomes;
 *   3. the two token pairs that must be the SAME instance are.
 *
 * A real in-memory DataSource, not a mock: `AppEnvModule` carries
 * `TypeOrmModule.forFeature` and a mocked one would not prove a repository the
 * module declares but cannot resolve — the failure that has broken the API boot
 * on this branch before.
 */
describe('AppRuntimeEnvModule (APW-07 wiring)', () => {
    async function compile() {
        return Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                EventEmitterModule.forRoot(),
                CacheModule.register({ isGlobal: true }),
                PluginsModule.forRoot(),
                AppRuntimeEnvModule,
            ],
        }).compile();
    }

    it('compiles — the two-module cycle this composition root exists to avoid does not happen', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(AppEnvRuntimeSource)).toBeInstanceOf(AppEnvRuntimeSource);

        await moduleRef.close();
    });

    it('binds APP_RUNTIME_ENV_SOURCE to the runtime source APW-06 asks for', async () => {
        // Unbound, `AppDeployPreconditionsService` answers `env_source_unavailable`
        // and no Deployment can pass preconditions at all.
        const moduleRef = await compile();

        expect(moduleRef.get(APP_RUNTIME_ENV_SOURCE, { strict: false })).toBeInstanceOf(
            AppEnvRuntimeSource,
        );

        await moduleRef.close();
    });

    it('binds APP_ENV_DEPLOY_READINESS to the dependency service ITSELF, not a wrapper', async () => {
        // The identity matters: `ensureReadyForDeploy` also DISPATCHES
        // provisioning for the `pending` kinds (GAP-05), so a narrowed forwarder
        // would answer the question and silently drop the side effect.
        const moduleRef = await compile();

        expect(moduleRef.get(APP_ENV_DEPLOY_READINESS, { strict: false })).toBe(
            moduleRef.get(AppDependenciesService, { strict: false }),
        );

        await moduleRef.close();
    });

    it('binds APP_DEPENDENCIES_SERVICE — APW-06 declares it, three of its services inject it', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(APP_DEPENDENCIES_SERVICE, { strict: false })).toBeInstanceOf(
            AppDependenciesService,
        );

        await moduleRef.close();
    });

    it('binds APP_DEPENDENCY_CONFIG_CIPHER to the SAME envelope env values use', async () => {
        // One envelope for the epic. Two would be two things to rotate, and a
        // dependency output sealed under a second key could never be read back.
        const moduleRef = await compile();

        expect(moduleRef.get(APP_DEPENDENCY_CONFIG_CIPHER, { strict: false })).toBe(
            moduleRef.get(AppEnvCrypto, { strict: false }),
        );

        await moduleRef.close();
    });

    it('binds APP_ENV_RESOLVER_FINGERPRINTS to the resolver — FR-24 was always false without it', async () => {
        const moduleRef = await compile();

        expect(moduleRef.get(APP_ENV_RESOLVER_FINGERPRINTS, { strict: false })).toBe(
            moduleRef.get(AppEnvResolver, { strict: false }),
        );

        await moduleRef.close();
    });

    it('APP_ENV_ENSURE_GENERATED resolves at CALL time, which is why the graph boots', async () => {
        // A plain `useExisting: AppEnvService` here is a provider cycle: the
        // service injects the resolver's token and the resolver injects this
        // one. The factory holds a `ModuleRef` instead, so the cycle is closed
        // after both are constructed.
        const moduleRef = await compile();
        const port = moduleRef.get<{ ensureGenerated: (workId: string) => Promise<void> }>(
            APP_ENV_ENSURE_GENERATED,
            { strict: false },
        );

        expect(port).toBeDefined();
        expect(port).not.toBeInstanceOf(AppEnvService);
        expect(typeof port.ensureGenerated).toBe('function');

        await moduleRef.close();
    });

    it('resolves the AppEnvResolver with BOTH its repositories — the dependency rows included', async () => {
        // `AppEnvResolver` reads `work_app_dependencies` directly. Without the
        // feature registration every `ew-dep://` reference resolves
        // `dependencyNotReady`, which reads as "your database is down" to the
        // member and is really "a module forgot an entity".
        const moduleRef = await compile();
        const resolver = moduleRef.get(AppEnvResolver, { strict: false }) as unknown as {
            rows?: unknown;
            dependencyRows?: unknown;
        };

        expect(resolver.rows).toBeDefined();
        expect(resolver.dependencyRows).toBeDefined();

        await moduleRef.close();
    });
});
