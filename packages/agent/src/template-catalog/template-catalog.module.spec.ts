jest.mock('../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));
jest.mock('../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));

import { TemplateCatalogModule } from './template-catalog.module';
import { TemplateCatalogService } from './template-catalog.service';

describe('TemplateCatalogModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, TemplateCatalogModule) ?? [];

    it('declares TemplateCatalogService as a provider', () => {
        expect(meta('providers')).toContain(TemplateCatalogService);
    });

    it('exports TemplateCatalogService for downstream modules', () => {
        expect(meta('exports')).toContain(TemplateCatalogService);
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

    it('re-exports TemplateCatalogService and TemplateCatalogModule', () => {
        expect(barrel.TemplateCatalogService).toBe(TemplateCatalogService);
        expect(barrel.TemplateCatalogModule).toBe(TemplateCatalogModule);
    });
});
