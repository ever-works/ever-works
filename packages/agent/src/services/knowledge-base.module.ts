import { Module } from '@nestjs/common';
import { TypeOrmModule } from '@nestjs/typeorm';
import { ActivityLogModule } from '../activity-log/activity-log.module';
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
import { KbAgentToolsService } from './kb-agent-tools.service';
import { KbToolsFacadeAdapter } from './kb-tools-facade.adapter';
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
 * EW-639 Phase 2/e (post-cascade fix) — `ActivityLogModule` is imported
 * for the same DI-walkback reason. `KnowledgeBaseService.recordUploadActivity`
 * injects `@Optional() activityLog?: ActivityLogService` and silently
 * early-returns when it's undefined. Without this import the API boots
 * fine but no `kb_upload_created` / `kb_upload_extracted` /
 * `kb_document_created` / `kb_upload_deduped` / `kb_upload_extraction_skipped`
 * rows are ever written, which manifests as 3 of the 4 KB e2e specs
 * timing out polling for activity rows that never arrive (kb-activity-log,
 * kb-dedup, kb-extraction-retry). `ActivityLogModule` imports only
 * `DatabaseModule`, no circular dep.
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
        ActivityLogModule,
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
        KbAgentToolsService,
        KbToolsFacadeAdapter,
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
        KbAgentToolsService,
        KbToolsFacadeAdapter,
    ],
})
export class KnowledgeBaseModule {}
