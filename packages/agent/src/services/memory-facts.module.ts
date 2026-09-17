import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { ActivityLogModule } from '../activity-log/activity-log.module';
import { MemoryFact } from '../entities/memory-fact.entity';
import { Agent } from '../entities/agent.entity';
import { MemoryFactRepository } from '../database/repositories/memory-fact.repository';
import { AgentRepository } from '../database/repositories/agent.repository';
import { MemoryFactService } from './memory-fact.service';
import { MemoryFactSearchService } from './memory-fact-search.service';
import { MemoryFactVectorIndexService } from './memory-fact-vector-index.service';
import { MemoryFactEmbedService } from './memory-fact-embed.service';
import { MemoryFactSweepService } from './memory-fact-sweep.service';

/**
 * AW-07 — Memory facts: the atomic tier of Memory.
 *
 * Wiring:
 *  - `DatabaseModule` + `TypeOrmModule.forFeature([MemoryFact, Agent])` so
 *    the feature-owned repositories resolve their TypeORM tokens inside THIS
 *    module (house pattern — see `McpModule` / `MemoryFilesModule`).
 *  - `FacadesModule` supplies `AiFacadeService` (embeddings) and
 *    `VectorStoreFacadeService` (the vector-store capability). Both are
 *    injected `@Optional()`; without them facts still save and search falls
 *    back to literal matching.
 *  - `ActivityLogModule` is imported so the `@Optional()` activity writer
 *    actually resolves — without it every mutation would silently record
 *    nothing (the lesson `MemoryFilesModule` documents).
 *
 * `MEMORY_FACT_EMBED_DISPATCHER` is NOT bound here: its adapter carries the
 * job-runtime SDK, which this package deliberately does not depend on. The
 * API binds it in a `@Global()` module so the `@Optional()` injection in
 * `MemoryFactService` can see it.
 */
@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        ActivityLogModule,
        TypeOrmModule.forFeature([MemoryFact, Agent]),
    ],
    providers: [
        MemoryFactRepository,
        AgentRepository,
        MemoryFactVectorIndexService,
        MemoryFactSearchService,
        MemoryFactEmbedService,
        MemoryFactSweepService,
        MemoryFactService,
    ],
    exports: [
        MemoryFactRepository,
        MemoryFactService,
        MemoryFactSearchService,
        MemoryFactEmbedService,
        MemoryFactSweepService,
    ],
})
export class MemoryFactsModule {}
