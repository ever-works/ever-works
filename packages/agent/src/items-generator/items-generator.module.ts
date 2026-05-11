import { Module } from '@nestjs/common';
import { ItemSubmissionService } from './item-submission.service';
import { ItemExportService } from './item-export.service';
import { ItemImportService } from './item-import.service';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PipelineModule } from '../pipeline/pipeline.module';

/**
 * Items Generator Module
 *
 * Note: Generation is now handled via PipelineOrchestratorService directly.
 * This module provides:
 *  - ItemSubmissionService — single-item submit (existing)
 *  - ItemExportService     — CSV/Excel bulk export (EW-533 Phase 1)
 *  - ItemImportService     — CSV/Excel parse + validate (EW-533 Phase 2)
 */
@Module({
    imports: [DatabaseModule, FacadesModule, PipelineModule],
    providers: [ItemSubmissionService, ItemExportService, ItemImportService],
    exports: [ItemSubmissionService, ItemExportService, ItemImportService],
})
export class ItemsGeneratorModule {}
