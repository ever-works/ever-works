import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';

import { FacadesModule } from '../facades/facades.module';

import { PipelineBuilderService } from './pipeline-builder.service';
import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineFacadeService } from './pipeline-facade.service';

const PROVIDERS = [
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    PipelineFacadeService,
];

const EXPORTS = [
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    PipelineFacadeService,
];

/**
 * Pipeline module providing the plugin-driven pipeline system.
 *
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 *
 * Pipeline plugins are loaded via the plugin system, not as NestJS providers.
 * Access them via PluginRegistryService.getByCapability('pipeline').
 */
@Module({
    imports: [FacadesModule, EventEmitterModule.forRoot()],
    providers: PROVIDERS,
    exports: EXPORTS,
})
export class PipelineModule {}
