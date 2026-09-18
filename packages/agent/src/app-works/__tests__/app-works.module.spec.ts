import { Test } from '@nestjs/testing';
import { TypeOrmModule, getRepositoryToken } from '@nestjs/typeorm';
import { ENTITIES } from '../../database/_entities-inventory';
import { WorkUpstreamStateRepository } from '../../database/repositories/work-upstream-state.repository';
import { WorkUpstreamState } from '../../entities/work-upstream-state.entity';
import { AppWorksModule } from '../app-works.module';

/**
 * APW-02 T15 — the App Works module, pinned against a REAL Nest container.
 *
 * The task's Test line is the claim under test: **the module compiles with only
 * its own providers**. Two compiles prove it, and neither of them needs a
 * sibling module:
 *
 *  1. a bare compile of `AppWorksModule` on its own, with nothing but the
 *     entity's repository token bound (no `DatabaseModule`, no `FacadesModule`,
 *     no root `TypeOrmModule.forRoot`), so a collaborator that later services
 *     will own cannot be quietly required today;
 *  2. a compile beside a real in-memory better-sqlite3 DataSource, which is
 *     what proves the fourth entity registration point of plan §3.1
 *     (`plan.md:261-263`) — `TypeOrmModule.forFeature([WorkUpstreamState])`. A
 *     `forFeature` without the entity, or an entity missing from the inventory,
 *     fails here with "no such table" instead of at API boot.
 *
 * Every uuid below is obviously synthetic. The table is empty in both compiles:
 * this spec is about wiring, not about the repository's behaviour — that is T14's
 * `work-upstream-state.repository.spec.ts`.
 */

/** A uuid that exists in no database, so `findByWorkId` must resolve `null`. */
const WORK_ID = '00000000-0000-4000-8000-0000000000ff';

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

    it('compiles with only its own providers — no sibling module, no root DataSource', async () => {
        // The entity repository is the ONE token this module cannot mint
        // itself: it is supplied by the DataSource the application opens. With
        // it bound as a value, a module that secretly needed `DatabaseModule`,
        // a facade or a service of a later task would fail to compile here.
        const entityRepository = { findOne: jest.fn().mockResolvedValue(null) };

        const moduleRef = await Test.createTestingModule({ imports: [AppWorksModule] })
            .overrideProvider(getRepositoryToken(WorkUpstreamState))
            .useValue(entityRepository)
            .compile();

        const repository = moduleRef.get(WorkUpstreamStateRepository);
        expect(repository).toBeInstanceOf(WorkUpstreamStateRepository);

        // Injection is by the entity token from `forFeature`, not by class name
        // or by a second provider: a call must arrive at the bound repository.
        await expect(repository.findByWorkId(WORK_ID)).resolves.toBeNull();
        expect(entityRepository.findOne).toHaveBeenCalledWith({ where: { workId: WORK_ID } });

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
        }).compile();

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
});
