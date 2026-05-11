import { Module } from '@nestjs/common';
import { ItemSubmissionService } from './item-submission.service';
import { ItemExportService } from './item-export.service';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PipelineModule } from '../pipeline/pipeline.module';

/**
 * Items Generator Module
 *
 * Note: Generation is now handled via PipelineOrchestratorService directly.
 * This module provides the ItemSubmissionService for single-item operations
 * and the ItemExportService for CSV/Excel bulk export (EW-533).
 */
@Module({
    imports: [DatabaseModule, FacadesModule, PipelineModule],
    providers: [ItemSubmissionService, ItemExportService],
    exports: [ItemSubmissionService, ItemExportService],
})
export class ItemsGeneratorModule {}
