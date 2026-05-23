import { Module } from '@nestjs/common';

import { FacadesModule } from '../facades/facades.module';
import { KnowledgeBaseModule } from '../services/knowledge-base.module';

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
 *
 * EW-641 Phase 2/b row 32d — `KnowledgeBaseModule` is imported here so
 * the row 32c `@Optional() KnowledgeBaseService` injection on
 * `StepPipelineExecutorService` / `FullPipelineExecutorService` actually
 * resolves at runtime. NestJS DI does not walk a consumer's imports —
 * the provider has to be in scope of the module that declares the
 * receiving class, even when the dep is optional. `KnowledgeBaseModule`
 * is self-sufficient (it imports `DatabaseModule` + `FacadesModule` and
 * locally provides `WorkOwnershipService`), so no cascade is needed.
 */
@Module({
    imports: [FacadesModule, KnowledgeBaseModule],
    providers: PROVIDERS,
    exports: EXPORTS,
})
export class PipelineModule {}
