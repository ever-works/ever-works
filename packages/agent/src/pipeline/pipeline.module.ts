import { Module } from '@nestjs/common';
import { EventEmitterModule } from '@nestjs/event-emitter';
import { CacheModule } from '@nestjs/cache-manager';

import { FacadesModule } from '../facades/facades.module';

import { PipelineBuilderService } from './pipeline-builder.service';
import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { ProviderOverrideService } from './provider-override.service';
import { StepAdapterService } from './step-adapter.service';

/**
 * All pipeline providers
 *
 * Note: DefaultPipelinePlugin is NOT registered here as a NestJS provider.
 * It is loaded via the plugin system (PluginBootstrapService.bootstrap()).
 * The standalone plugin in @ever-works/default-pipeline-plugin is the single source of truth.
 */
const PROVIDERS = [
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
 * Note: This module relies on PluginsModule being registered globally via forRoot()
 * at the application root level. Do not import PluginsModule directly here.
 *
 * The DefaultPipelinePlugin is loaded via the plugin system, not as a NestJS provider.
 * Access it via PluginRegistryService.getPluginsByCapability('pipeline-step').
 */
@Module({
    imports: [FacadesModule, EventEmitterModule.forRoot(), CacheModule.register()],
    providers: PROVIDERS,
    exports: EXPORTS,
})
export class PipelineModule {}
