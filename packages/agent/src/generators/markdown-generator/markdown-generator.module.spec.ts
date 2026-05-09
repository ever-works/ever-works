// `github-slugger` is ESM-only and the module under test transitively imports
// it via readme-builder. Stub it so the CommonJS Jest runtime can parse the chain.
jest.mock('github-slugger', () => {
    return class MockGithubSlugger {
        slug(input: string): string {
            return input.toLowerCase().replace(/[^a-z0-9]+/g, '-');
        }
    };
});

// `data-generator.service` transitively imports `p-map` (ESM-only). The
// module wiring under test only needs the class identity, not its runtime
// behaviour. Replace it with an empty shell — same pattern as the
// agent-package services/__tests__/*.spec.ts suites.
jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));

import { MarkdownGeneratorModule } from './markdown-generator.module';
import { MarkdownGeneratorService } from './markdown-generator.service';

describe('MarkdownGeneratorModule', () => {
    const getModuleMetadata = (key: string): unknown[] => {
        return Reflect.getMetadata(key, MarkdownGeneratorModule) ?? [];
    };

    it('declares MarkdownGeneratorService as a provider', () => {
        const providers = getModuleMetadata('providers');
        expect(providers).toContain(MarkdownGeneratorService);
    });

    it('exports MarkdownGeneratorService for downstream modules', () => {
        const exports = getModuleMetadata('exports');
        expect(exports).toContain(MarkdownGeneratorService);
    });

    it('imports DataGenerator / Facades / Database / WorkOperations modules by name', () => {
        const imports = getModuleMetadata('imports');
        const names = imports.map((mod: any) => mod?.name);
        expect(names).toEqual(
            expect.arrayContaining([
                'DataGeneratorModule',
                'FacadesModule',
                'DatabaseModule',
                'WorkOperationsModule',
            ]),
        );
    });

    it('keeps the imports list at the documented 4-module shape', () => {
        const imports = getModuleMetadata('imports');
        // Pin the count so a future silent extra-import is a deliberate change.
        expect(imports).toHaveLength(4);
    });
});

describe('markdown-generator barrel', () => {
    // The local barrel re-exports module + service + repository + builder. We
    // pin the runtime symbols here so a future drop is a deliberate change.
    // Resolved via require() to dodge `moduleResolution: nodenext` insisting on
    // an explicit `.js` suffix in dynamic imports.
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports MarkdownGeneratorService and MarkdownGeneratorModule', () => {
        expect(barrel.MarkdownGeneratorService).toBe(MarkdownGeneratorService);
        expect(barrel.MarkdownGeneratorModule).toBe(MarkdownGeneratorModule);
    });

    it('also re-exports MarkdownRepository + ReadmeBuilder runtime classes', () => {
        expect(typeof barrel.MarkdownRepository).toBe('function');
        expect(typeof barrel.ReadmeBuilder).toBe('function');
    });
});
