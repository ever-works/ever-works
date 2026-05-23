jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../services/knowledge-base.module', () => ({
    KnowledgeBaseModule: class KnowledgeBaseModule {},
}));

import { Test, TestingModule } from '@nestjs/testing';
import { EventEmitter2 } from '@nestjs/event-emitter';
import { Logger } from '@nestjs/common';

import { PipelineModule } from './pipeline.module';
import { PipelineBuilderService } from './pipeline-builder.service';
import { StepPipelineExecutorService } from './step-pipeline-executor.service';
import { FullPipelineExecutorService } from './full-pipeline-executor.service';
import { PipelineOrchestratorService } from './pipeline-orchestrator.service';
import { PipelineFacadeService } from './pipeline-facade.service';
import { PluginRegistryService } from '../plugins/services/plugin-registry.service';
import { PluginContextFactoryService } from '../plugins/services/plugin-context-factory.service';
import { KnowledgeBaseService } from '../services/knowledge-base.service';

// Silence loggers for the runtime-DI block — keeps assertion failures front-and-centre.
jest.spyOn(Logger.prototype, 'error').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);

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

// EW-641 Phase 2/b row 33c — runtime DI smoke test. The metadata tests
// above pin the module's *static* shape (decorator inputs); this block
// pins the *runtime* DI graph: when `KnowledgeBaseService` is in scope
// of the executor's module, the executor's `@Optional()` injection
// actually finds it (not silently dropped to undefined).
//
// This catches a class of regressions where module-import rewiring
// breaks the row 32d wiring without breaking the static metadata
// (e.g., a future cleanup removes the import from PipelineModule but
// adds it transitively through a different module → the meta test
// passes but the executors stop seeing the service at runtime).
//
// We can't easily import the real `PipelineModule` here (jest.mock at
// the top substitutes `KnowledgeBaseModule` with a bare class that
// exports nothing — that's required so the metadata tests don't pull
// in the heavy TypeORM/Database transitives). Instead, we replicate
// the production *injection shape* with manual providers + assert that
// the executor instance's `knowledgeBaseService` field is the stub.
// If a future change removes `KnowledgeBaseService` from the executor's
// constructor or flips `@Optional()` to required, these tests will
// fail; if someone moves `KnowledgeBaseModule` out of PipelineModule's
// imports (the row 32d wiring), the metadata test above catches it.
describe('PipelineModule — runtime DI resolution (row 33c)', () => {
    const baseProviders = (kbService?: {
        resolveContext: jest.Mock;
    }): Array<{ provide: any; useValue: unknown }> => {
        const providers: Array<{ provide: any; useValue: unknown }> = [
            {
                provide: EventEmitter2,
                useValue: { emit: jest.fn(), on: jest.fn(), off: jest.fn() },
            },
            {
                provide: PipelineFacadeService,
                useValue: { createStepExecutionContext: jest.fn() },
            },
            {
                provide: PluginRegistryService,
                useValue: {
                    register: jest.fn(),
                    getByCapability: jest.fn().mockReturnValue([]),
                    updateState: jest.fn(),
                },
            },
            {
                provide: PluginContextFactoryService,
                useValue: { addLogInterceptor: jest.fn().mockReturnValue(() => undefined) },
            },
        ];
        if (kbService) {
            providers.push({ provide: KnowledgeBaseService, useValue: kbService });
        }
        return providers;
    };

    it('StepPipelineExecutorService resolves KnowledgeBaseService through its module scope when wired', async () => {
        const kbServiceStub = { resolveContext: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StepPipelineExecutorService,
                PipelineBuilderService,
                ...baseProviders(kbServiceStub),
            ],
        }).compile();

        const service = module.get(StepPipelineExecutorService);
        // The `@Optional()` injection landed the stub on the private
        // `knowledgeBaseService` field — proves the DI token (class
        // reference) matches between provider and constructor metadata.
        expect((service as any).knowledgeBaseService).toBe(kbServiceStub);
    });

    it('StepPipelineExecutorService — @Optional() injection leaves knowledgeBaseService undefined when not in scope', async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [
                StepPipelineExecutorService,
                PipelineBuilderService,
                ...baseProviders(/* no kbService */),
            ],
        }).compile();

        const service = module.get(StepPipelineExecutorService);
        // No `KnowledgeBaseService` provider → @Optional() resolves to
        // undefined. (If row 32c flipped @Optional() to required, this
        // would have thrown at `.compile()` time.)
        expect((service as any).knowledgeBaseService).toBeUndefined();
    });

    it('FullPipelineExecutorService resolves KnowledgeBaseService through its module scope when wired', async () => {
        const kbServiceStub = { resolveContext: jest.fn() };

        const module: TestingModule = await Test.createTestingModule({
            providers: [FullPipelineExecutorService, ...baseProviders(kbServiceStub)],
        }).compile();

        const service = module.get(FullPipelineExecutorService);
        expect((service as any).knowledgeBaseService).toBe(kbServiceStub);
    });

    it('FullPipelineExecutorService — @Optional() injection leaves knowledgeBaseService undefined when not in scope', async () => {
        const module: TestingModule = await Test.createTestingModule({
            providers: [FullPipelineExecutorService, ...baseProviders(/* no kbService */)],
        }).compile();

        const service = module.get(FullPipelineExecutorService);
        expect((service as any).knowledgeBaseService).toBeUndefined();
    });
});
