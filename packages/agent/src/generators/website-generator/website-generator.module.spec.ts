jest.mock('../../facades/facades.module', () => ({
    FacadesModule: class FacadesModule {},
}));
jest.mock('../../database/database.module', () => ({
    DatabaseModule: class DatabaseModule {},
}));

import { WebsiteGeneratorModule } from './website-generator.module';
import { WebsiteGeneratorService } from './website-generator.service';
import { WebsiteUpdateService } from './website-update.service';
import { BranchSyncService } from './branch-sync.service';
import { WebsiteTemplateResolverService } from './website-template-resolver.service';

describe('WebsiteGeneratorModule', () => {
    const meta = (key: string): unknown[] => Reflect.getMetadata(key, WebsiteGeneratorModule) ?? [];

    it('declares all 4 website-generator services as providers', () => {
        const providers = meta('providers');
        expect(providers).toEqual(
            expect.arrayContaining([
                WebsiteGeneratorService,
                WebsiteUpdateService,
                BranchSyncService,
                WebsiteTemplateResolverService,
            ]),
        );
    });

    it('keeps the providers list at the documented 4-service shape', () => {
        expect(meta('providers')).toHaveLength(4);
    });

    it('exports the same 4 services (mirrors providers)', () => {
        const exports = meta('exports');
        expect(exports).toEqual(
            expect.arrayContaining([
                WebsiteGeneratorService,
                WebsiteUpdateService,
                BranchSyncService,
                WebsiteTemplateResolverService,
            ]),
        );
        expect(exports).toHaveLength(4);
    });

    it('imports FacadesModule + DatabaseModule by name', () => {
        const imports = meta('imports') as Array<{ name?: string }>;
        const names = imports.map((m) => m?.name);
        expect(names).toEqual(expect.arrayContaining(['FacadesModule', 'DatabaseModule']));
    });

    it('keeps the imports list at the documented 2-module shape', () => {
        expect(meta('imports')).toHaveLength(2);
    });
});

describe('website-generator barrel', () => {
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const barrel = require('./index');

    it('re-exports the module + all 4 service runtime classes', () => {
        expect(barrel.WebsiteGeneratorModule).toBe(WebsiteGeneratorModule);
        expect(barrel.WebsiteGeneratorService).toBe(WebsiteGeneratorService);
        expect(barrel.WebsiteUpdateService).toBe(WebsiteUpdateService);
        expect(barrel.BranchSyncService).toBe(BranchSyncService);
        expect(barrel.WebsiteTemplateResolverService).toBe(WebsiteTemplateResolverService);
    });
});
