/**
 * AW-07 — DI wiring for the memory-facts tier.
 *
 * Two halves, both of which fail silently rather than loudly when broken:
 *
 *  1. **Module metadata.** `MemoryFactService` and friends inject
 *     `@Optional()` collaborators owned by sibling modules (the activity
 *     writer, the AI and vector-store facades). If `ActivityLogModule` or
 *     `FacadesModule` drops out of `imports`, the API still boots — and every
 *     fact mutation silently records no activity, every search silently
 *     degrades to exact words. Pinned here so a cleanup trips a unit test.
 *
 *  2. **Constructor tokens.** The embed dispatcher is resolved by SYMBOL
 *     through `@Optional() @Inject(MEMORY_FACT_EMBED_DISPATCHER)`. A Nest
 *     testing module compiles the real service classes against value
 *     providers and proves each optional dependency actually lands — the
 *     decorator order is what decides that, and a mock-constructed service
 *     (as in the service spec) never exercises it.
 */

import { Test } from '@nestjs/testing';
import { MemoryFactsModule } from '../memory-facts.module';
import { MemoryFactService } from '../memory-fact.service';
import { MemoryFactSearchService } from '../memory-fact-search.service';
import { MemoryFactVectorIndexService } from '../memory-fact-vector-index.service';
import { MemoryFactEmbedService } from '../memory-fact-embed.service';
import { MemoryFactSweepService } from '../memory-fact-sweep.service';
import { MemoryFactRepository } from '../../database/repositories/memory-fact.repository';
import { AgentRepository } from '../../database/repositories/agent.repository';
import { ActivityLogModule } from '../../activity-log/activity-log.module';
import { ActivityLogService } from '../../activity-log/activity-log.service';
import { FacadesModule } from '../../facades/facades.module';
import { DatabaseModule } from '../../database/database.module';
import { AiFacadeService } from '../../facades/ai.facade';
import { VectorStoreFacadeService } from '../../facades/vector-store.facade';
import { MEMORY_FACT_EMBED_DISPATCHER } from '../../tasks/memory-fact-embed-dispatcher';

describe('MemoryFactsModule', () => {
    it('imports the modules that own its optional collaborators', () => {
        const imports: unknown[] = Reflect.getMetadata('imports', MemoryFactsModule) ?? [];
        expect(imports).toEqual(
            expect.arrayContaining([DatabaseModule, FacadesModule, ActivityLogModule]),
        );
    });

    it('provides and exports the services the API and the job RPC channel resolve', () => {
        const providers: unknown[] = Reflect.getMetadata('providers', MemoryFactsModule) ?? [];
        const exported: unknown[] = Reflect.getMetadata('exports', MemoryFactsModule) ?? [];
        for (const token of [
            MemoryFactRepository,
            MemoryFactService,
            MemoryFactSearchService,
            MemoryFactEmbedService,
            MemoryFactSweepService,
        ]) {
            expect(providers).toContain(token);
            expect(exported).toContain(token);
        }
        expect(providers).toEqual(
            expect.arrayContaining([AgentRepository, MemoryFactVectorIndexService]),
        );
    });

    it('resolves every optional collaborator by its real token', async () => {
        const dispatcher = { dispatchMemoryFactEmbed: jest.fn().mockResolvedValue('run-1') };
        const activity = { log: jest.fn().mockResolvedValue({}) };
        const repo = {
            countByStatus: jest
                .fn()
                .mockResolvedValue({ active: 0, proposed: 0, forgotten: 0, pinned: 0 }),
            findLiveDuplicate: jest.fn().mockResolvedValue(null),
            create: jest.fn().mockResolvedValue({
                id: 'f-1',
                userId: 'u-1',
                body: 'hello',
                status: 'active',
                origin: 'user',
                scope: 'workspace',
                pinned: false,
                createdAt: new Date(),
                updatedAt: new Date(),
            }),
        };

        const moduleRef = await Test.createTestingModule({
            providers: [
                MemoryFactService,
                MemoryFactSearchService,
                MemoryFactVectorIndexService,
                MemoryFactEmbedService,
                MemoryFactSweepService,
                { provide: MemoryFactRepository, useValue: repo },
                { provide: AgentRepository, useValue: { findByIdAndUser: jest.fn() } },
                { provide: ActivityLogService, useValue: activity },
                { provide: AiFacadeService, useValue: { embed: jest.fn() } },
                { provide: VectorStoreFacadeService, useValue: { select: jest.fn() } },
                { provide: MEMORY_FACT_EMBED_DISPATCHER, useValue: dispatcher },
            ],
        }).compile();

        const service = moduleRef.get(MemoryFactService);
        await service.create({ userId: 'u-1' }, { body: 'hello' });

        expect(activity.log).toHaveBeenCalledTimes(1);
        expect(dispatcher.dispatchMemoryFactEmbed).toHaveBeenCalledWith({
            factId: 'f-1',
            userId: 'u-1',
        });
        expect(moduleRef.get(MemoryFactSweepService)).toBeInstanceOf(MemoryFactSweepService);
    });

    it('still compiles with no dispatcher, no facades and no activity writer bound', async () => {
        const moduleRef = await Test.createTestingModule({
            providers: [
                MemoryFactService,
                MemoryFactSearchService,
                MemoryFactVectorIndexService,
                { provide: MemoryFactRepository, useValue: {} },
            ],
        }).compile();
        expect(moduleRef.get(MemoryFactService)).toBeInstanceOf(MemoryFactService);
    });
});
