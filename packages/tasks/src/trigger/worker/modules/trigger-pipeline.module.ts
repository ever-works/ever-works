import { Module } from '@nestjs/common';
import {
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    PipelineFacadeService,
} from '@ever-works/agent/pipeline';
import { TriggerFacadesModule } from './trigger-facades.module';

const PROVIDERS = [
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    PipelineFacadeService,
];

/**
 * Pipeline module for Trigger.dev context.
 *
 * Provides pipeline services without importing DatabaseModule.
 * Uses TriggerFacadesModule instead of FacadesModule.
 *
 * EventEmitterModule is already registered by TriggerPluginsModule.
 */
@Module({
    imports: [TriggerFacadesModule],
    providers: PROVIDERS,
    exports: PROVIDERS,
})
export class TriggerPipelineModule {}
