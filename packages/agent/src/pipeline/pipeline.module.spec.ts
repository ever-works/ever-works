jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
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

    it('imports FacadesModule ONLY (PluginsModule is registered globally via forRoot)', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        // The pipeline module specifically does NOT import PluginsModule —
        // the documentation comment in the source pins this contract.
        expect(names).toContain('FacadesModule');
        expect(names).not.toContain('PluginsModule');
    });

    it('keeps the imports list at the documented 1-module shape', () => {
        expect(meta('imports')).toHaveLength(1);
    });
});
