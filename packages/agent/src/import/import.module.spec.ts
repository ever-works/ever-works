jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../generators/data-generator/data-generator.module', () => ({
    DataGeneratorModule: class DataGeneratorModule {},
}));
jest.mock('../generators/markdown-generator/markdown-generator.module', () => ({
    MarkdownGeneratorModule: class MarkdownGeneratorModule {},
}));
jest.mock('../generators/website-generator/website-generator.module', () => ({
    WebsiteGeneratorModule: class WebsiteGeneratorModule {},
}));
// Service classes — `source-repo-analyzer` and `import-executor` transitively
// pull in `p-map` (ESM-only) etc. through the generator stack. Stub them to
// class shells so the wiring metadata still resolves to a real reference.
jest.mock('./source-repo-analyzer.service', () => ({
    SourceRepoAnalyzerService: class SourceRepoAnalyzerService {},
}));
jest.mock('./import-executor.service', () => ({
    ImportExecutorService: class ImportExecutorService {},
}));
jest.mock('@src/works-config/services/works-config.service', () => ({
    WorksConfigService: class WorksConfigService {},
}));

import { ImportModule } from './import.module';
import { SourceRepoAnalyzerService } from './source-repo-analyzer.service';
import { ImportExecutorService } from './import-executor.service';
import { WorksConfigService } from '@src/works-config/services/works-config.service';

describe('ImportModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, ImportModule) ?? [];

    it('declares all three services as providers', () => {
        const providers = meta('providers');
        expect(providers).toEqual(
            expect.arrayContaining([
                SourceRepoAnalyzerService,
                ImportExecutorService,
                WorksConfigService,
            ]),
        );
    });

    it('exports all three services for downstream modules', () => {
        const exports = meta('exports');
        expect(exports).toEqual(
            expect.arrayContaining([
                SourceRepoAnalyzerService,
                ImportExecutorService,
                WorksConfigService,
            ]),
        );
        expect(exports).toHaveLength(3);
    });

    it('imports the documented 4 modules by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'FacadesModule',
                'DataGeneratorModule',
                'MarkdownGeneratorModule',
                'WebsiteGeneratorModule',
            ]),
        );
    });

    it('keeps the imports list at the documented 4-module shape', () => {
        expect(meta('imports')).toHaveLength(4);
    });
});
