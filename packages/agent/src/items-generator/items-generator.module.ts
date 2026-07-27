import { Module } from '@nestjs/common';
import { ItemSubmissionService } from './item-submission.service';
import { ItemExportService } from './item-export.service';
import { ItemImportService } from './item-import.service';
import { ItemImportExecutorService } from './item-import-executor.service';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PipelineModule } from '../pipeline/pipeline.module';
import { PolicyModule } from '../policy/policy.module';

/**
 * Items Generator Module
 *
 * Note: Generation is now handled via PipelineOrchestratorService directly.
 * This module provides:
 *  - ItemSubmissionService       — single-item submit (existing)
 *  - ItemExportService           — CSV/Excel bulk export (EW-533 Phase 1)
 *  - ItemImportService           — CSV/Excel parse + validate (EW-533 Phase 2)
 *  - ItemImportExecutorService   — CSV/Excel bulk write + PR (EW-533 Phase 3)
 *
 * `PolicyModule` is imported for `PullRequestGateService` (audit W3 M3):
 * both PR-opening services here route through the Work's quality gate. It
 * is a deliberately leaf module (four entities, no service graph), so this
 * costs the cold-start dependency graph almost nothing.
 */
@Module({
    imports: [DatabaseModule, FacadesModule, PipelineModule, PolicyModule],
    providers: [
        ItemSubmissionService,
        ItemExportService,
        ItemImportService,
        ItemImportExecutorService,
    ],
    exports: [
        ItemSubmissionService,
        ItemExportService,
        ItemImportService,
        ItemImportExecutorService,
    ],
})
export class ItemsGeneratorModule {}
