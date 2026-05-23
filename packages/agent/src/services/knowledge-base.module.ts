import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import {
    WorkKnowledgeChunk,
    WorkKnowledgeCitation,
    WorkKnowledgeDocument,
    WorkKnowledgeTag,
    WorkKnowledgeUpload,
} from '../entities';
import { WorkKnowledgeDocumentRepository } from '../database/repositories/work-knowledge-document.repository';
import { WorkKnowledgeUploadRepository } from '../database/repositories/work-knowledge-upload.repository';
import { WorkKnowledgeTagRepository } from '../database/repositories/work-knowledge-tag.repository';
import { WorkKnowledgeCitationRepository } from '../database/repositories/work-knowledge-citation.repository';
import { WorkKnowledgeChunkRepository } from '../database/repositories/work-knowledge-chunk.repository';
import { KnowledgeBaseService } from './knowledge-base.service';
import { KnowledgeBaseGitMirrorService } from './knowledge-base-git-mirror.service';
import { KnowledgeBaseBufferExtractorService } from './knowledge-base-buffer-extractor.service';
import { KbMentionResolverService } from './kb-mention-resolver.service';
import { WorkOwnershipService } from './work-ownership.service';

/**
 * NestJS module wiring the Knowledge Base service + repositories.
 *
 * Imports `WorkOwnershipService` for permission gates; that service
 * is provided by `WorkModule` in the application graph, so consumers
 * should make sure WorkModule is imported alongside this module or
 * provide WorkOwnershipService via a parent module.
 *
 * EW-641 Phase 1B/a — `KnowledgeBaseGitMirrorService` is also exported.
 * It depends on `GitFacadeService`, which is provided by `FacadesModule`.
 * The original Phase 1B/a docstring asked importers to add `FacadesModule`
 * themselves; that didn't actually work because NestJS DI only walks a
 * module's *own* `imports`, not its consumers' imports. Result: the API
 * boot died with `UnknownDependenciesException: KnowledgeBaseGitMirrorService
 * (?, WorkRepository, ...)` and develop E2E went red on `652d1a4d`.
 *
 * Fix: import `FacadesModule` directly. No circular dep — `FacadesModule`
 * imports only `DatabaseModule + UsageModule + BudgetsModule`, none of
 * which depend on KB.
 *
 * Entities registered:
 *  - WorkKnowledgeDocument
 *  - WorkKnowledgeUpload
 *  - WorkKnowledgeTag
 *  - WorkKnowledgeCitation
 *  - WorkKnowledgeChunk (repo added in Phase 2/a row 29a — embedding
 *    write path wired in rows 29b/29c)
 */
@Module({
    imports: [
        DatabaseModule,
        FacadesModule,
        TypeOrmModule.forFeature([
            WorkKnowledgeDocument,
            WorkKnowledgeUpload,
            WorkKnowledgeTag,
            WorkKnowledgeCitation,
            WorkKnowledgeChunk,
        ]),
    ],
    providers: [
        WorkOwnershipService,
        WorkKnowledgeDocumentRepository,
        WorkKnowledgeUploadRepository,
        WorkKnowledgeTagRepository,
        WorkKnowledgeCitationRepository,
        WorkKnowledgeChunkRepository,
        KnowledgeBaseService,
        KnowledgeBaseGitMirrorService,
        KnowledgeBaseBufferExtractorService,
        KbMentionResolverService,
    ],
    exports: [
        WorkKnowledgeDocumentRepository,
        WorkKnowledgeUploadRepository,
        WorkKnowledgeTagRepository,
        WorkKnowledgeCitationRepository,
        WorkKnowledgeChunkRepository,
        KnowledgeBaseService,
        KnowledgeBaseGitMirrorService,
        KnowledgeBaseBufferExtractorService,
        KbMentionResolverService,
    ],
})
export class KnowledgeBaseModule {}
