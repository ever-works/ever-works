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
import { WorkOwnershipService } from './work-ownership.service';

/**
 * NestJS module wiring the Knowledge Base service + repositories.
 *
 * Imports `WorkOwnershipService` for permission gates; that service
 * is provided by `WorkModule` in the application graph, so consumers
 * should make sure WorkModule is imported alongside this module or
 * provide WorkOwnershipService via a parent module.
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
    ],
    exports: [
        WorkKnowledgeDocumentRepository,
        WorkKnowledgeUploadRepository,
        WorkKnowledgeTagRepository,
        WorkKnowledgeCitationRepository,
        KnowledgeBaseService,
    ],
})
export class KnowledgeBaseModule {}
