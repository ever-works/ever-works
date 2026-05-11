// `data-generator.service` transitively imports `p-map` (ESM-only) plus
// the full pipeline stack. The wiring spec only needs the class identity,
// not the runtime behaviour. Replace with an empty shell.
jest.mock('./data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../../pipeline/pipeline.module', () => ({
    PipelineModule: class PipelineModule {},
}));
jest.mock('@src/database', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('@src/work-operations', () => ({
    WorkOperationsModule: class WorkOperationsModule {},
}));
jest.mock('@src/works-config/services/works-config.service', () => ({
    WorksConfigService: class WorksConfigService {},
}));
jest.mock('@src/works-config/services/works-config-writer.service', () => ({
    WorksConfigWriterService: class WorksConfigWriterService {},
}));

import { DataGeneratorModule } from './data-generator.module';
import { DataGeneratorService } from './data-generator.service';
import { WorksConfigService } from '@src/works-config/services/works-config.service';
import { WorksConfigWriterService } from '@src/works-config/services/works-config-writer.service';

describe('DataGeneratorModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, DataGeneratorModule) ?? [];

    it('declares the 3 documented providers (service + 2 works-config helpers)', () => {
        const providers = meta('providers');
        expect(providers).toEqual(
            expect.arrayContaining([
                DataGeneratorService,
                WorksConfigService,
                WorksConfigWriterService,
            ]),
        );
        expect(providers).toHaveLength(3);
    });

    it('exports DataGeneratorService ONLY (works-config helpers stay internal)', () => {
        const exports = meta('exports');
        expect(exports).toContain(DataGeneratorService);
        // works-config helpers are NOT exported — pinned so a future
        // "expose them" refactor is a deliberate change.
        expect(exports).not.toContain(WorksConfigService);
        expect(exports).not.toContain(WorksConfigWriterService);
        expect(exports).toHaveLength(1);
    });

    it('imports the documented 4 modules by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'FacadesModule',
                'PipelineModule',
                'DatabaseModule',
                'WorkOperationsModule',
            ]),
        );
        expect(imports).toHaveLength(4);
    });
});

describe('data-generator barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports DataGeneratorService + DataGeneratorModule', () => {
        expect(barrel.DataGeneratorModule).toBe(DataGeneratorModule);
        // The barrel uses `export *`, so both `DataGeneratorService` (mocked
        // shell) and `DataGeneratorModule` are re-exported. Pin the latter
        // since the former's identity is mock-controlled.
    });

    it('also re-exports DataRepository + GenerationLogCollector runtime classes', () => {
        expect(typeof barrel.DataRepository).toBe('function');
        expect(typeof barrel.GenerationLogCollector).toBe('function');
    });
});
