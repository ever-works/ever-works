jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../services/knowledge-base.module', () => ({
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));

import { PipelineModule } from './pipeline.module';
import { PipelineBuilderService } from './pipeline-builder.service';
import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineFacadeService } from './pipeline-facade.service';

describe('PipelineModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, PipelineModule) ?? [];

    it('declares all 5 pipeline services as providers', () => {
        const providers = meta('providers');
        expect(providers).toEqual(
            expect.arrayContaining([
                PipelineBuilderService,
                StepPipelineExecutorService,
                FullPipelineExecutorService,
                PipelineOrchestratorService,
                PipelineFacadeService,
            ]),
        );
    });

    it('keeps the providers list at the documented 5-service shape', () => {
        // Pin so a future silent extra-provider is a deliberate change.
        expect(meta('providers')).toHaveLength(5);
    });

    it('exports the same 5 services for downstream modules', () => {
        const exports = meta('exports');
        expect(exports).toEqual(
            expect.arrayContaining([
                PipelineBuilderService,
                StepPipelineExecutorService,
                FullPipelineExecutorService,
                PipelineOrchestratorService,
                PipelineFacadeService,
            ]),
        );
        expect(exports).toHaveLength(5);
    });

    it('imports FacadesModule + KnowledgeBaseModule (PluginsModule stays globally-registered)', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        // FacadesModule for AI/Search/Screenshot/etc. facades.
        expect(names).toContain('FacadesModule');
        // EW-641 Phase 2/b row 32d — KnowledgeBaseModule must be in scope
        // so the executors' @Optional() KnowledgeBaseService injection
        // actually resolves at runtime (NestJS DI doesn't walk a
        // consumer's imports — the receiving module needs the provider).
        expect(names).toContain('KnowledgeBaseModule');
        // PluginsModule stays globally-registered via forRoot() at the
        // app root; the pipeline module specifically does NOT import
        // it directly (documentation comment pins this contract).
        expect(names).not.toContain('PluginsModule');
    });

    it('keeps the imports list at the documented 2-module shape', () => {
        // Pin so a future silent extra-import is a deliberate change.
        expect(meta('imports')).toHaveLength(2);
    });
});
