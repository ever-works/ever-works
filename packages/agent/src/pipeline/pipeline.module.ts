import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CacheModule } from '@nestjs/cache-manager';

import { PluginsModule } from '../plugins/plugins.module';
import { FacadesModule } from '../facades/facades.module';

import { DefaultPipelinePlugin } from './default-pipeline.plugin';
import { PipelineBuilderService } from './pipeline-builder.service';
import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { ProviderOverrideService } from './provider-override.service';
import { StepAdapterService } from './step-adapter.service';

/**
 * All pipeline providers
 */
const PROVIDERS = [
    DefaultPipelinePlugin,
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    ProviderOverrideService,
    StepAdapterService,
];

/**
 * Exported services for consumers
 */
const EXPORTS = [
    DefaultPipelinePlugin,
    PipelineBuilderService,
    StepPipelineExecutorService,
    FullPipelineExecutorService,
    PipelineOrchestratorService,
    ProviderOverrideService,
    StepAdapterService,
];

/**
 * Pipeline module providing the plugin-driven pipeline system.
 *
 * This module exports:
 * - DefaultPipelinePlugin: NestJS wrapper for the standalone default-pipeline plugin
 * - PipelineBuilderService: Builds executable pipelines from step definitions
 * - StepPipelineExecutorService: Executes pipelines step-by-step
 * - FullPipelineExecutorService: Delegates to full pipeline plugins
 * - PipelineOrchestratorService: Main entry point for pipeline execution
 * - ProviderOverrideService: Handles provider overrides for steps
 * - StepAdapterService: Adapts legacy step services to the new interface
 */
@Module({
    imports: [
        PluginsModule.forRoot(),
        FacadesModule,
        EventEmitterModule.forRoot(),
        CacheModule.register(),
    ],
    providers: PROVIDERS,
    exports: EXPORTS,
})
export class PipelineModule {}
