import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { Work } from '../entities/work.entity';
import { WorkKnowledgeChunk } from '../entities/work-knowledge-chunk.entity';
import { VectorNamespaceChunk } from '../entities/vector-namespace-chunk.entity';
import { WorkKnowledgeChunkRepository } from '../database/repositories/work-knowledge-chunk.repository';
import { VectorNamespaceChunkRepository } from '../database/repositories/vector-namespace-chunk.repository';
import { VectorStoreHostChunkTablesService } from './vector-store-host-chunk-tables.service';

/**
 * AW-07 — publishes the platform database's vector chunk tables to the
 * plugin host (see `VectorStoreHostChunkTablesService`), so the bundled
 * pgvector store serves both the Knowledge Base (`work_knowledge_chunks`)
 * and non-Work namespaces such as memory facts (`vector_namespace_chunks`).
 *
 * Imported once by the API root module. `CustomCapabilityRegistryService`
 * arrives from the `@Global()` plugins module; the two repositories are
 * feature-owned and provided here (stateless, so a second instance beside
 * `KnowledgeBaseModule`'s is harmless).
 */
@Module({
    imports: [
        DatabaseModule,
        TypeOrmModule.forFeature([Work, WorkKnowledgeChunk, VectorNamespaceChunk]),
    ],
    providers: [
        WorkKnowledgeChunkRepository,
        VectorNamespaceChunkRepository,
        VectorStoreHostChunkTablesService,
    ],
    exports: [VectorNamespaceChunkRepository, VectorStoreHostChunkTablesService],
})
export class VectorStoreHostChunkTablesModule {}
