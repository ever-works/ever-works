// The two sibling modules `AppWorksModule` imports (APW-01 T12/T13) pull in the
// whole TypeORM + facade + plugin-registry tree, exactly as `CommunityPrModule`'s
// spec records for its own two. They are replaced with empty class shells at
// module scope so this spec stays a test of THIS module's wiring: the metadata
// assertions below still see the real `AppWorksModule`'s imports, and the compiles
// then exercise only what this module provides or mints itself. The APW-01
// services inject every collaborator those modules would supply `@Optional()`, so
// a shelled module is a supported graph and not a broken one.
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
// 2026-09-26 — `AppWorksModule` also imports the Activity, notification and Task
// modules its services inject (see its "bound by IMPORT" section). They are shelled
// for the reason the two above are: this is a bare-graph test of THIS module's own
// wiring, and every one of those collaborators is `@Optional()`.
// `app-works.module.graph.spec.ts` composes all of them for real.
jest.mock('../../activity-log/activity-log.module', () => ({
    ActivityLogModule: class ActivityLogModule {},
}));
jest.mock('../../notifications/notifications.module', () => ({
    NotificationsModule: class NotificationsModule {},
}));
jest.mock('../../tasks-domain/tasks.module', () => ({
    TasksDomainModule: class TasksDomainModule {},
}));

import { Global, Module } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { AppWorksModule } from '../app-works.module';
import { AppSourceInspectorService } from '../app-source-inspector.service';
import { AppWorkCreateService } from '../app-work-create.service';
import { APP_SOURCE_CATALOG_PORT } from '../app-source-catalog.port';
import { AppBlueprintResolverService } from '../../apps-catalog/app-blueprint-resolver.service';
import { AppSourceCatalogAdapter } from '../../apps-catalog/app-source-catalog.adapter';
import { DistributedTaskLockService } from '../../cache/distributed-task-lock.service';
import { AppSourceInitializerService } from '../app-source-initializer.service';
import {
    APP_WORKS_TELEMETRY_EVENTS,
    APP_WORKS_TELEMETRY_SINK,
    AppWorksTelemetryService,
} from '../app-works-telemetry.service';

/**
 * APW-02 T15 — the App Works module, pinned against a REAL Nest container.
 *
 * Two compiles prove the wiring:
 *
 *  1. a compile of `AppWorksModule` on its own, with nothing but the tokens it
 *     cannot mint itself bound (the entity's repository, which the DataSource
 *     supplies, and the create lock, whose own `CacheEntry` repository lives in
 *     the shelled `DatabaseModule`), so a collaborator that later services will
 *     own cannot be quietly required today;
 *  2. a compile beside a real in-memory better-sqlite3 DataSource, which is what
 *     proves the fourth entity registration point of plan §3.1
 *     (`plan.md:261-263`) — `TypeOrmModule.forFeature([WorkUpstreamState])`. A
 *     `forFeature` without the entity, or an entity missing from the inventory,
 *     fails here with "no such table" instead of at API boot.
 *
 * ## APW-01 T12/T13 — the two sibling imports this spec now pins
 *
 * The epic's inspector and create services read `WorkRepository` and write through
 * it, and they talk to providers only through the git and deploy facades. Those
 * live in `DatabaseModule` and `FacadesModule`, and a Nest provider can only
 * resolve a dependency from the module that **declares** it or from that module's
 * own imports — so `AppWorksModule` imports both, and the assertion below exists
 * because dropping either import would take the whole API down at boot with
 * `UnknownDependenciesException`, invisible to every unit spec that constructs the
 * service by hand.
 *
 * Every uuid below is obviously synthetic. The table is empty in both compiles:
 * this spec is about wiring, not about the repository's behaviour — that is T14's
 * `work-upstream-state.repository.spec.ts`.
 */

/** A uuid that exists in no database, so `findByWorkId` must resolve `null`. */
const WORK_ID = '00000000-0000-4000-8000-0000000000ff';

/**
 * The two tokens this module cannot mint itself, supplied for the compiles.
 *
 * The entity's repository comes from the DataSource the application opens, and
 * `DistributedTaskLockService` (APW-01 T13's create lock) needs the `CacheEntry`
 * repository, which the shelled `DatabaseModule` would have supplied. Both are
 * replaced with values, so a module that quietly required a collaborator neither it
 * nor its own imports provide fails HERE rather than at API boot.
 */
function lockStub(): { runExclusive: jest.Mock; isLocked: jest.Mock } {
    return { runExclusive: jest.fn(), isLocked: jest.fn() };
}

/** A provider entry is either a class or `{ provide, useFactory, inject }`. */
function tokenOf(provider: unknown): unknown {
    return typeof provider === 'function'
        ? provider
        : (provider as { provide?: unknown } | null)?.provide;
}

describe('AppWorksModule', () => {
    const metadata = (key: string): unknown[] =>
        (Reflect.getMetadata(key, AppWorksModule) as unknown[]) ?? [];

    it('provides and exports the epic’s repository', () => {
        expect(metadata('providers')).toContain(WorkUpstreamStateRepository);
        expect(metadata('exports')).toContain(WorkUpstreamStateRepository);
    });

    it('registers WorkUpstreamState through TypeOrmModule.forFeature', () => {
        // The fourth registration point of plan §3.1: without the entity here,
        // `@InjectRepository(WorkUpstreamState)` on the repository has nothing
        // to inject and the application fails at boot.
        const feature = metadata('imports').find((entry) =>
            ((entry as { providers?: unknown[] } | null)?.providers ?? []).some(
                (provider) => tokenOf(provider) === getRepositoryToken(WorkUpstreamState),
            ),
        );

        expect(feature).toBeDefined();
    });

    it('imports the two sibling modules its APW-01 services resolve through', () => {
        // APW-01 T12/T13: `AppSourceInspectorService` reads `WorkRepository` and
        // `AppWorkCreateService` writes through it, and both talk to providers
        // only through `GitFacadeService` / `DeployFacadeService`. A Nest provider
        // resolves a dependency from the module that declares it or from that
        // module's own imports, so WITHOUT these two imports the API refuses to
        // boot with `UnknownDependenciesException` — a failure no hand-constructed
        // unit spec can see.
        const names = (metadata('imports') as Array<{ name?: string }>).map((entry) => entry?.name);
        expect(names).toEqual(expect.arrayContaining(['DatabaseModule', 'FacadesModule']));
    });

    it('provides and exports both APW-01 services beside the APW-02 trio', () => {
        for (const service of [AppSourceInspectorService, AppWorkCreateService]) {
            expect(metadata('providers')).toContain(service);
            expect(metadata('exports')).toContain(service);
        }
    });

    it('compiles in a bare graph once the tokens it cannot mint are bound — no root DataSource', async () => {
        const entityRepository = { findOne: jest.fn().mockResolvedValue(null) };

        const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
            .overrideProvider(getRepositoryToken(WorkUpstreamState))
            .useValue(entityRepository)
            .overrideProvider(DistributedTaskLockService)
            .useValue(lockStub())
            .compile();

        const repository = moduleRef.get(WorkUpstreamStateRepository);
        expect(repository).toBeInstanceOf(WorkUpstreamStateRepository);

        // The two APW-01 services are real instances, not tokens that resolved to
        // `undefined`: their constructors ran, which is what proves the DI graph.
        expect(moduleRef.get(AppSourceInspectorService)).toBeInstanceOf(AppSourceInspectorService);
        expect(moduleRef.get(AppWorkCreateService)).toBeInstanceOf(AppWorkCreateService);

        // Injection is by the entity token from `forFeature`, not by class name
        // or by a second provider: a call must arrive at the bound repository.
        await expect(repository.findByWorkId(WORK_ID)).resolves.toBeNull();
        expect(entityRepository.findOne).toHaveBeenCalledWith({ where: { workId: WORK_ID } });

        await moduleRef.close();
    });

    it('binds APP_SOURCE_CATALOG_PORT to ONE adapter both APW-01 services receive (APW-03 T26)', async () => {
        // The port is injected `@Optional()` by the inspector and the create service,
        // which are declared HERE — so the binding must be here too (a provider declared
        // in a module that imports this one is invisible to them; see the C10 section of
        // the module's docstring). The bare graph shells `FacadesModule`, so the
        // resolver's git facade is absent and it answers "credential unavailable": the
        // adapter still resolves, which is what makes the binding boot-safe.
        const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
            .overrideProvider(getRepositoryToken(WorkUpstreamState))
            .useValue({ findOne: jest.fn().mockResolvedValue(null) })
            .overrideProvider(DistributedTaskLockService)
            .useValue(lockStub())
            .compile();

        const port = moduleRef.get(APP_SOURCE_CATALOG_PORT);
        expect(port).toBeInstanceOf(AppSourceCatalogAdapter);
        expect(moduleRef.get(AppBlueprintResolverService)).toBeInstanceOf(
            AppBlueprintResolverService,
        );
        expect(
            (moduleRef.get(AppSourceInspectorService) as unknown as { catalog: unknown }).catalog,
        ).toBe(port);
        expect(
            (moduleRef.get(AppWorkCreateService) as unknown as { catalog: unknown }).catalog,
        ).toBe(port);

        // Not exported: only the two services declared here consume it.
        expect(metadata('exports')).not.toContain(APP_SOURCE_CATALOG_PORT);

        await moduleRef.close();
    });

    it('provides and exports ONE telemetry service every App Works emitter receives (APW-01 T36)', async () => {
        // The inspector, the create service and the ready handler are declared HERE, so
        // the service must be provided here; it is exported so the API-side ready
        // handler and `WorkModule`'s `WorkLifecycleService` receive the same instance.
        expect(metadata('providers')).toContain(AppWorksTelemetryService);
        expect(metadata('exports')).toContain(AppWorksTelemetryService);
        // The sink is the API's to bind (a `@Global()` alias to PostHog): this package
        // never binds it, so no module here may provide it.
        expect(metadata('providers').map(tokenOf)).not.toContain(APP_WORKS_TELEMETRY_SINK);

        const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
            .overrideProvider(getRepositoryToken(WorkUpstreamState))
            .useValue({ findOne: jest.fn().mockResolvedValue(null) })
            .overrideProvider(DistributedTaskLockService)
            .useValue(lockStub())
            .compile();

        const telemetry = moduleRef.get(AppWorksTelemetryService);
        expect(telemetry).toBeInstanceOf(AppWorksTelemetryService);
        for (const emitter of [
            AppSourceInspectorService,
            AppWorkCreateService,
            AppSourceInitializerService,
        ]) {
            expect((moduleRef.get(emitter) as unknown as { telemetry: unknown }).telemetry).toBe(
                telemetry,
            );
        }

        // Unbound in this graph: an event is counted and dropped, never thrown.
        expect(() =>
            telemetry.track(
                APP_WORKS_TELEMETRY_EVENTS.deleted,
                { mode: 'link', repositoryDeleted: false },
                'user-1',
            ),
        ).not.toThrow();
        expect(telemetry.stats()).toMatchObject({ emitted: 0, dropped: 1 });

        await moduleRef.close();
    });

    it('receives a sink bound by a @Global() module — the shape the API binding uses (APW-01 T36)', async () => {
        const track = jest.fn();

        @Global()
        @Module({
            providers: [{ provide: APP_WORKS_TELEMETRY_SINK, useValue: { track } }],
            exports: [APP_WORKS_TELEMETRY_SINK],
        })
        class SinkBindingModule {}

        const moduleRef = await Test.createTestingModule({
            imports: [SinkBindingModule, AppWorksModule],
        })
            .overrideProvider(getRepositoryToken(WorkUpstreamState))
            .useValue({ findOne: jest.fn().mockResolvedValue(null) })
            .overrideProvider(DistributedTaskLockService)
            .useValue(lockStub())
            .compile();

        moduleRef
            .get(AppWorksTelemetryService)
            .track(
                APP_WORKS_TELEMETRY_EVENTS.deleted,
                { mode: 'fork', repositoryDeleted: true },
                'user-1',
            );

        expect(track).toHaveBeenCalledWith('user-1', 'app_work.deleted', {
            mode: 'fork',
            repositoryDeleted: true,
        });

        await moduleRef.close();
    });

    it('resolves against a real DataSource and queries the registered table', async () => {
        const moduleRef = await Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                AppWorksModule,
            ],
        })
            .overrideProvider(DistributedTaskLockService)
            .useValue(lockStub())
            .compile();

        const repository = moduleRef.get(WorkUpstreamStateRepository);
        expect(repository).toBeInstanceOf(WorkUpstreamStateRepository);
        // A `forFeature` the DataSource never heard of throws
        // "no such table: work_upstream_states" here.
        await expect(repository.findByWorkId(WORK_ID)).resolves.toBeNull();

        await moduleRef.close();
    });
});

describe('app-works barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('../index');

    it('re-exports the module that apps/api imports', () => {
        expect(barrel.AppWorksModule).toBe(AppWorksModule);
    });

    it('re-exports the telemetry sink token the API binds (APW-01 T36)', () => {
        // `apps/api`'s binding imports the token from `@ever-works/agent/app-works`; a
        // second `Symbol()` of the same name would bind nothing this package injects.
        expect(barrel.APP_WORKS_TELEMETRY_SINK).toBe(APP_WORKS_TELEMETRY_SINK);
        expect(barrel.AppWorksTelemetryService).toBe(AppWorksTelemetryService);
    });
});
