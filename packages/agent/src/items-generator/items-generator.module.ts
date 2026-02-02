import { Module } from '@nestjs/common';
import { ItemSubmissionService } from './item-submission.service';
import { AiModule } from '../ai';
import { DatabaseModule } from '../database/database.module';
import { FacadesModule } from '../facades/facades.module';
import { PipelineModule } from '../pipeline/pipeline.module';

/**
 * Items Generator Module
 *
 * Note: Generation is now handled via PipelineOrchestratorService directly.
 * This module only provides the ItemSubmissionService for single-item operations.
 */
@Module({
    imports: [AiModule, DatabaseModule, FacadesModule, PipelineModule],
    providers: [ItemSubmissionService],
    exports: [ItemSubmissionService],
})
export class ItemsGeneratorModule {}
