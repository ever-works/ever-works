jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));

import { TemplateCatalogModule } from './template-catalog.module';
import { TemplateCatalogService } from './template-catalog.service';
import { TemplateCustomizationService } from './template-customization.service';

describe('TemplateCatalogModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, TemplateCatalogModule) ?? [];

    it('declares TemplateCatalogService + TemplateCustomizationService as providers', () => {
        const providers = meta('providers');
        expect(providers).toContain(TemplateCatalogService);
        expect(providers).toContain(TemplateCustomizationService);
    });

    it('exports both services for downstream modules', () => {
        const exports = meta('exports');
        expect(exports).toContain(TemplateCatalogService);
        expect(exports).toContain(TemplateCustomizationService);
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

describe('template-catalog barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports services + module + prompt helpers', () => {
        expect(barrel.TemplateCatalogService).toBe(TemplateCatalogService);
        expect(barrel.TemplateCatalogModule).toBe(TemplateCatalogModule);
        expect(barrel.TemplateCustomizationService).toBe(TemplateCustomizationService);
        expect(typeof barrel.getCustomizationPromptForBaseTemplate).toBe('function');
        expect(typeof barrel.hasCustomizationPromptForBaseTemplate).toBe('function');
    });
});
