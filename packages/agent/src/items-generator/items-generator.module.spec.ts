// `ItemImportExecutorService` imports `p-map` v7, which is ESM-only and
// can't be parsed by jest's CJS transform. The mock matches the one in
// `item-import-executor.service.spec.ts` — this spec only exercises module
// metadata (Reflect API), so a no-op default export is sufficient.
jest.mock('p-map', () => ({
    __esModule: true,
    default: async <T, R>(
        iterable: Iterable<T>,
        mapper: (item: T, index: number) => Promise<R>,
    ): Promise<R[]> => {
        const results: R[] = [];
        let index = 0;
        for (const item of iterable) {
            results.push(await mapper(item, index));
            index += 1;
        }
        return results;
    },
}));

import * as itemsGeneratorBarrel from './index';
import { ItemsGeneratorModule } from './items-generator.module';
import { ItemSubmissionService } from './item-submission.service';
import { ItemExportService } from './item-export.service';
import { ItemImportService } from './item-import.service';
import { ItemImportExecutorService } from './item-import-executor.service';
import { DomainType } from '@ever-works/contracts';

/**
 * Pins the public `@ever-works/agent/items-generator` barrel surface and
 * the `ItemsGeneratorModule` provider/exports map.
 *
 * Two non-obvious contracts are pinned here:
 *
 *   1. The module exposes four services: `ItemSubmissionService` (single-
 *      item submit) and the three EW-533 services (`ItemExportService`,
 *      `ItemImportService`, `ItemImportExecutorService`). Generation
 *      itself runs through `PipelineOrchestratorService` (imported from
 *      `PipelineModule` indirectly). A future refactor that moves
 *      generation back into this module would have to consciously update
 *      this contract.
 *
 *   2. `DomainType` is re-exported from `@ever-works/contracts` for CJS
 *      consumers that import via the items-generator barrel. The
 *      contracts package is ESM-only, so this re-export is the bridge.
 *      Removing it silently breaks downstream CJS code.
 */

describe('ItemsGeneratorModule + barrel re-exports', () => {
    describe('barrel re-exports', () => {
        it('re-exports ItemsGeneratorModule', () => {
            expect(itemsGeneratorBarrel.ItemsGeneratorModule).toBe(ItemsGeneratorModule);
        });

        it('re-exports the four services exposed by this submodule', () => {
            expect(itemsGeneratorBarrel.ItemSubmissionService).toBe(ItemSubmissionService);
            expect(itemsGeneratorBarrel.ItemExportService).toBe(ItemExportService);
            expect(itemsGeneratorBarrel.ItemImportService).toBe(ItemImportService);
            expect(itemsGeneratorBarrel.ItemImportExecutorService).toBe(ItemImportExecutorService);
        });

        it('re-exports DomainType from @ever-works/contracts (CJS bridge)', () => {
            // Pinning that the runtime symbol is present and identity-matches
            // the contract package's export. Removing this import silently
            // breaks CJS consumers — see the comment in `index.ts`.
            expect(itemsGeneratorBarrel.DomainType).toBe(DomainType);
        });

        it('re-exports the runtime DTO classes (forwarding from ./dto barrel)', () => {
            // The `./dto` barrel is re-exported wholesale, so adding a new
            // runtime DTO there must surface here. This regression guard
            // pins the documented runtime classes plus the DeployWebsiteDto
            // exclusion (which is also a deliberate design choice in
            // `dto/index.ts`).
            const expected = [
                'CheckItemHealthDto',
                'CreateItemsGeneratorDto',
                'UpdateItemsGeneratorDto',
                'ProvidersDto',
                'GenerationMethod',
                'WebsiteRepositoryCreationMethod',
                'DeleteWorkDto',
                'ExtractItemDetailsDto',
                'RemoveItemDto',
                'SubmitItemDto',
                'UpdateItemDto',
            ];
            for (const key of expected) {
                expect(Object.prototype.hasOwnProperty.call(itemsGeneratorBarrel, key)).toBe(true);
            }
            // DeployWebsiteDto is intentionally NOT exported (internal-only)
            expect(
                Object.prototype.hasOwnProperty.call(itemsGeneratorBarrel, 'DeployWebsiteDto'),
            ).toBe(false);
        });

        it('re-exports the zod schemas from ./schemas/item-extraction.schemas', () => {
            // 7 documented schemas
            const schemaKeys = [
                'itemDataSchema',
                'itemDataWithCategoriesAndTagsSchema',
                'extractedItemsSchema',
                'extractedItemsSchemaWithTags',
                'promptUnderstandingAssessmentSchema',
                'itemBadgesSchema',
                'itemDataWithBadgesSchema',
            ];
            for (const key of schemaKeys) {
                expect(Object.prototype.hasOwnProperty.call(itemsGeneratorBarrel, key)).toBe(true);
            }
        });
    });

    describe('ItemsGeneratorModule decorator metadata', () => {
        function getMeta(key: 'imports' | 'providers' | 'exports'): any[] {
            return Reflect.getMetadata(key, ItemsGeneratorModule) ?? [];
        }

        it('declares the four EW-533 services as providers', () => {
            const providers = getMeta('providers');
            expect(providers).toContain(ItemSubmissionService);
            expect(providers).toContain(ItemExportService);
            expect(providers).toContain(ItemImportService);
            expect(providers).toContain(ItemImportExecutorService);
            expect(providers).toHaveLength(4);
        });

        it('exports the four services (consumed by apps/api works module)', () => {
            const exports = getMeta('exports');
            expect(exports).toContain(ItemSubmissionService);
            expect(exports).toContain(ItemExportService);
            expect(exports).toContain(ItemImportService);
            expect(exports).toContain(ItemImportExecutorService);
            expect(exports).toHaveLength(4);
        });

        it('imports DatabaseModule, FacadesModule, and PipelineModule (by name)', () => {
            const imports = getMeta('imports');
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            expect(importNames).toContain('DatabaseModule');
            expect(importNames).toContain('FacadesModule');
            expect(importNames).toContain('PipelineModule');
        });

        it('does NOT import PluginsModule, ItemsGeneratorPipelineModule, or other indirect deps directly (kept thin)', () => {
            const imports = getMeta('imports');
            const importNames = imports.map((m: any) => m?.name ?? String(m));
            // Pinning the explicit dependency surface — three modules.
            // Adding more imports here MUST be a deliberate change because
            // it grows the cold-start dependency graph for every consumer.
            expect(imports).toHaveLength(3);
            expect(importNames).not.toContain('PluginsModule');
            expect(importNames).not.toContain('PipelineOrchestratorModule');
        });
    });
});
