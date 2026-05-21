import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DatabaseModule } from '../database/database.module';
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
import { KnowledgeBaseService } from './knowledge-base.service';
import { KnowledgeBaseGitMirrorService } from './knowledge-base-git-mirror.service';
import { KnowledgeBaseBufferExtractorService } from './knowledge-base-buffer-extractor.service';
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
 * It depends on `GitFacadeService`, which is provided by the API-side
 * `FacadesModule`. Importers that need the mirror service (the
 * Trigger.dev `kb-mirror-document` task) must ensure `FacadesModule` is
 * available in their dependency graph.
 *
 * Entities registered:
 *  - WorkKnowledgeDocument
 *  - WorkKnowledgeUpload
 *  - WorkKnowledgeTag
 *  - WorkKnowledgeCitation
 *  - WorkKnowledgeChunk (no repo yet — Phase 2 introduces embedding code)
 */
@Module({
    imports: [
        DatabaseModule,
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
        KnowledgeBaseService,
        KnowledgeBaseGitMirrorService,
        KnowledgeBaseBufferExtractorService,
    ],
    exports: [
        WorkKnowledgeDocumentRepository,
        WorkKnowledgeUploadRepository,
        WorkKnowledgeTagRepository,
        WorkKnowledgeCitationRepository,
        KnowledgeBaseService,
        KnowledgeBaseGitMirrorService,
        KnowledgeBaseBufferExtractorService,
    ],
})
export class KnowledgeBaseModule {}
