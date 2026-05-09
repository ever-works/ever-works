jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));

import { ComparisonGeneratorModule } from './comparison-generator.module';
import { ComparisonGenerationService } from './comparison-generation.service';

describe('ComparisonGeneratorModule', () => {
    const meta = (key: string): unknown[] =>
        Reflect.getMetadata(key, ComparisonGeneratorModule) ?? [];

    it('declares ComparisonGenerationService as a provider', () => {
        expect(meta('providers')).toContain(ComparisonGenerationService);
    });

    it('exports ComparisonGenerationService for downstream modules', () => {
        expect(meta('exports')).toContain(ComparisonGenerationService);
    });

    it('imports DatabaseModule + FacadesModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        expect(names).toEqual(expect.arrayContaining(['DatabaseModule', 'FacadesModule']));
    });

    it('keeps the imports list at the documented 2-module shape', () => {
        expect(meta('imports')).toHaveLength(2);
    });
});

describe('comparison-generator barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports ComparisonGenerationService and ComparisonGeneratorModule', () => {
        expect(barrel.ComparisonGenerationService).toBe(ComparisonGenerationService);
        expect(barrel.ComparisonGeneratorModule).toBe(ComparisonGeneratorModule);
    });
});
