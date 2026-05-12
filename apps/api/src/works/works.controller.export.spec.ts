// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph.
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({
    EXPORT_FORMATS: ['csv', 'xlsx'],
    ItemImportExecutorService: class {},
}));
jest.mock('@ever-works/agent/services', () => ({}));
jest.mock('@ever-works/agent/comparison-generator', () => ({}));
jest.mock('@ever-works/agent/template-catalog', () => ({}));
jest.mock('@ever-works/agent/generators', () => ({
    getDefaultWebsiteTemplateId: jest.fn(() => 'default-template'),
}));
jest.mock('@ever-works/agent/community-pr', () => ({}));
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/cache', () => ({
    CACHE_MANAGER: 'CACHE_MANAGER',
}));
jest.mock('@ever-works/agent/entities', () => ({
    ActivityActionType: {
        EXPORT: 'EXPORT',
        IMPORT: 'IMPORT',
        ITEM_ADDED: 'ITEM_ADDED',
        ITEM_REMOVED: 'ITEM_REMOVED',
        ITEM_UPDATED: 'ITEM_UPDATED',
    },
    ActivityStatus: { COMPLETED: 'COMPLETED', IN_PROGRESS: 'IN_PROGRESS' },
    WorkScheduleStatus: { ACTIVE: 'ACTIVE' },
}));
jest.mock('@ever-works/agent/subscriptions', () => ({}));
jest.mock('@ever-works/agent/activity-log', () => ({}));
jest.mock('../auth', () => ({
    AuthService: class {},
    AuthSessionGuard: class {},
    CurrentUser: () => () => undefined,
}));

import { BadRequestException, NotFoundException } from '@nestjs/common';
import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: { workItems: Mock; workConfig: Mock };
    workLifecycleService: Record<string, never>;
    workGenerationService: Record<string, never>;
    authService: { getUser: Mock };
    workDetailService: Record<string, never>;
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: { ensureCanEdit: Mock };
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: Record<string, never>;
    generatorFormSchemaService: Record<string, never>;
    itemHealthService: Record<string, never>;
    communityPrProcessorService: Record<string, never>;
    comparisonGenerationService: Record<string, never>;
    workRepository: Record<string, never>;
    sourceValidationService: Record<string, never>;
    subscriptionService: Record<string, never>;
    activityLogService: { log: Mock };
    templateCatalogService: Record<string, never>;
    itemExportService: { exportItems: Mock };
    itemImportService: {
        parseCSV: Mock;
        parseXLSX: Mock;
        validateRows: Mock;
    };
    itemImportExecutor: { executeImport: Mock };
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {
            workItems: jest.fn(),
            workConfig: jest.fn(),
        },
        workLifecycleService: {} as any,
        workGenerationService: {} as any,
        authService: { getUser: jest.fn().mockResolvedValue({ id: 'user-1' }) },
        workDetailService: {} as any,
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: {
            ensureCanEdit: jest.fn().mockResolvedValue({ work: { id: 'w-1', slug: 'demo' } }),
        },
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {} as any,
        generatorFormSchemaService: {} as any,
        itemHealthService: {} as any,
        communityPrProcessorService: {} as any,
        comparisonGenerationService: {} as any,
        workRepository: {} as any,
        sourceValidationService: {} as any,
        subscriptionService: {} as any,
        activityLogService: { log: jest.fn().mockResolvedValue(undefined) },
        templateCatalogService: {} as any,
        itemExportService: {
            exportItems: jest.fn(),
        },
        itemImportService: {
            parseCSV: jest.fn(),
            parseXLSX: jest.fn(),
            validateRows: jest.fn(),
        },
        itemImportExecutor: {
            executeImport: jest.fn().mockResolvedValue({
                total: 0,
                created: 0,
                updated: 0,
                skipped: 0,
                errors: [],
            }),
        },
    };
}

function makeController(s: Stubs): WorksController {
    return new WorksController(
        s.cacheManager as any,
        s.cacheEntryRepository as any,
        s.workQueryService as any,
        s.workLifecycleService as any,
        s.workGenerationService as any,
        s.authService as any,
        s.workDetailService as any,
        s.workScheduleService as any,
        s.workImportService as any,
        s.repositoryManagementService as any,
        s.workOwnershipService as any,
        s.workAdvancedPromptsService as any,
        s.workTaxonomyService as any,
        s.generatorFormSchemaService as any,
        s.itemHealthService as any,
        s.communityPrProcessorService as any,
        s.comparisonGenerationService as any,
        s.workRepository as any,
        s.sourceValidationService as any,
        s.subscriptionService as any,
        s.activityLogService as any,
        s.templateCatalogService as any,
        s.itemExportService as any,
        s.itemImportService as any,
        s.itemImportExecutor as any,
    );
}

function makeResponse() {
    const setHeader = jest.fn();
    const send = jest.fn();
    return { setHeader, send };
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — item export endpoints (EW-533 Phase 1)', () => {
    let s: Stubs;
    let controller: WorksController;

    beforeEach(() => {
        s = makeStubs();
        controller = makeController(s);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    describe('getExportItemsSettings', () => {
        it('returns export_enabled = true when the directory config opts in', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { export_enabled: true } },
            });
            const result = await controller.getExportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ export_enabled: true });
            expect(s.workQueryService.workConfig).toHaveBeenCalledWith('w-1', { id: 'user-1' });
        });

        it('returns export_enabled = false when the flag is missing', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: {} },
            });
            const result = await controller.getExportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ export_enabled: false });
        });

        it('returns export_enabled = false when the whole config is null', async () => {
            s.workQueryService.workConfig.mockResolvedValue({ status: 'success', config: null });
            const result = await controller.getExportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ export_enabled: false });
        });
    });

    describe('exportWorkItems', () => {
        it('rejects requests without a csv|xlsx format', async () => {
            const res = makeResponse();
            await expect(
                controller.exportWorkItems(auth, 'w-1', 'json', res),
            ).rejects.toBeInstanceOf(BadRequestException);
            await expect(
                controller.exportWorkItems(auth, 'w-1', undefined, res),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(s.itemExportService.exportItems).not.toHaveBeenCalled();
            expect(res.send).not.toHaveBeenCalled();
        });

        it('returns 404 when export is not enabled for the directory', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { export_enabled: false } },
            });
            const res = makeResponse();
            await expect(
                controller.exportWorkItems(auth, 'w-1', 'csv', res),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(s.itemExportService.exportItems).not.toHaveBeenCalled();
            expect(res.send).not.toHaveBeenCalled();
        });

        it('streams the export bytes + sets Content-Type / Content-Disposition when enabled', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { export_enabled: true } },
            });
            const items = [{ name: 'A' }, { name: 'B' }];
            s.workQueryService.workItems.mockResolvedValue({ status: 'success', items });
            s.itemExportService.exportItems.mockResolvedValue({
                data: 'name\r\nA\r\nB\r\n',
                contentType: 'text/csv; charset=utf-8',
                filename: 'items-export-2026-05-11.csv',
            });

            const res = makeResponse();
            await controller.exportWorkItems(auth, 'w-1', 'csv', res);

            expect(s.itemExportService.exportItems).toHaveBeenCalledWith(items, 'csv');
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
            expect(res.setHeader).toHaveBeenCalledWith(
                'Content-Disposition',
                'attachment; filename="items-export-2026-05-11.csv"',
            );
            expect(res.send).toHaveBeenCalledWith('name\r\nA\r\nB\r\n');
            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'EXPORT',
                    action: 'items.exported',
                    status: 'COMPLETED',
                    summary: 'Exported 2 items as CSV',
                }),
            );
        });

        it('treats a missing items field from workItems as zero items', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { export_enabled: true } },
            });
            s.workQueryService.workItems.mockResolvedValue({ status: 'success' });
            s.itemExportService.exportItems.mockResolvedValue({
                data: 'name\r\n',
                contentType: 'text/csv; charset=utf-8',
                filename: 'items-export-2026-05-11.csv',
            });
            const res = makeResponse();
            await controller.exportWorkItems(auth, 'w-1', 'csv', res);
            expect(s.itemExportService.exportItems).toHaveBeenCalledWith([], 'csv');
        });
    });

    // -----------------------------------------------------------------------
    // Import (EW-533 Phase 2): settings probe + sample + validate (dry-run)
    // -----------------------------------------------------------------------

    describe('getImportItemsSettings', () => {
        it('returns the flag and cap from settings when both are set', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true, import_max_rows: 1000 } },
            });
            const result = await controller.getImportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ import_enabled: true, import_max_rows: 1000 });
        });

        it('falls back to 500 when import_max_rows is missing', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            const result = await controller.getImportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ import_enabled: true, import_max_rows: 500 });
        });

        it('returns import_enabled = false when config is null', async () => {
            s.workQueryService.workConfig.mockResolvedValue({ status: 'success', config: null });
            const result = await controller.getImportItemsSettings(auth, 'w-1');
            expect(result).toEqual({ import_enabled: false, import_max_rows: 500 });
        });
    });

    describe('getImportItemsSample', () => {
        it('rejects an unsupported format with BadRequest', async () => {
            const res = makeResponse();
            await expect(
                controller.getImportItemsSample(auth, 'w-1', 'json', res),
            ).rejects.toBeInstanceOf(BadRequestException);
            expect(s.itemExportService.exportItems).not.toHaveBeenCalled();
            expect(res.send).not.toHaveBeenCalled();
        });

        it('returns 404 when import is not enabled', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: false } },
            });
            const res = makeResponse();
            await expect(
                controller.getImportItemsSample(auth, 'w-1', 'csv', res),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('streams a sample template when enabled', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            // generateSample lives on itemExportService — the import route
            // re-uses it because the column contract is shared.
            (s.itemExportService as unknown as { generateSample: jest.Mock }).generateSample =
                jest.fn().mockResolvedValue({
                    data: 'name,description\r\n',
                    contentType: 'text/csv; charset=utf-8',
                    filename: 'items-import-template.csv',
                });
            const res = makeResponse();
            await controller.getImportItemsSample(auth, 'w-1', 'csv', res);
            expect(res.setHeader).toHaveBeenCalledWith('Content-Type', 'text/csv; charset=utf-8');
            expect(res.setHeader).toHaveBeenCalledWith(
                'Content-Disposition',
                'attachment; filename="items-import-template.csv"',
            );
            expect(res.send).toHaveBeenCalledWith('name,description\r\n');
        });
    });

    describe('validateImportItems', () => {
        const csvFile = (): Express.Multer.File =>
            ({
                buffer: Buffer.from('name,description,source_url,category\nA,d,https://a.test,T'),
                originalname: 'items.csv',
                mimetype: 'text/csv',
            }) as Express.Multer.File;

        it('rejects when no file is uploaded', async () => {
            await expect(
                controller.validateImportItems(auth, 'w-1', undefined, undefined),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('returns 404 when import is not enabled', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: false } },
            });
            await expect(
                controller.validateImportItems(auth, 'w-1', csvFile(), undefined),
            ).rejects.toBeInstanceOf(NotFoundException);
        });

        it('rejects files with a non-csv/xlsx extension', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            const file = {
                buffer: Buffer.from('x'),
                originalname: 'notes.txt',
                mimetype: 'text/plain',
            } as Express.Multer.File;
            await expect(
                controller.validateImportItems(auth, 'w-1', file, undefined),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('rejects files that exceed the per-directory max-rows cap', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true, import_max_rows: 1 } },
            });
            s.itemImportService.parseCSV.mockReturnValue({
                headers: ['name'],
                rows: [{ name: 'a' }, { name: 'b' }],
            });
            await expect(
                controller.validateImportItems(auth, 'w-1', csvFile(), undefined),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('parses + validates the file and returns the service response', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true, import_max_rows: 500 } },
            });
            s.itemImportService.parseCSV.mockReturnValue({
                headers: ['name', 'description', 'source_url', 'category'],
                rows: [
                    { name: 'A', description: 'd', source_url: 'https://a.test', category: 'T' },
                ],
            });
            s.workQueryService.workItems.mockResolvedValue({
                status: 'success',
                items: [{ slug: 'existing', source_url: 'https://existing.test' }],
            });
            const validationResponse = {
                headers: ['name', 'description', 'source_url', 'category'],
                suggestedMapping: {},
                validationResults: [],
                summary: { total: 1, valid: 1, invalid: 0, duplicates: 0 },
            };
            s.itemImportService.validateRows.mockReturnValue(validationResponse);

            const result = await controller.validateImportItems(auth, 'w-1', csvFile(), undefined);
            expect(s.itemImportService.parseCSV).toHaveBeenCalled();
            expect(s.itemImportService.validateRows).toHaveBeenCalledWith(
                expect.any(Object),
                {},
                [{ slug: 'existing', source_url: 'https://existing.test' }],
            );
            expect(result).toBe(validationResponse);
        });

        it('decodes a JSON `mapping` form field and passes it to the service', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true, import_max_rows: 500 } },
            });
            s.itemImportService.parseCSV.mockReturnValue({ headers: [], rows: [] });
            s.workQueryService.workItems.mockResolvedValue({ status: 'success', items: [] });
            s.itemImportService.validateRows.mockReturnValue({
                headers: [],
                suggestedMapping: {},
                validationResults: [],
                summary: { total: 0, valid: 0, invalid: 0, duplicates: 0 },
            });
            const mappingJson = JSON.stringify({ 'Item Name': 'name', URL: 'source_url' });
            await controller.validateImportItems(auth, 'w-1', csvFile(), mappingJson);
            expect(s.itemImportService.validateRows).toHaveBeenCalledWith(
                expect.any(Object),
                { 'Item Name': 'name', URL: 'source_url' },
                [],
            );
        });

        it('falls back to an empty mapping when the form field is invalid JSON', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true, import_max_rows: 500 } },
            });
            s.itemImportService.parseCSV.mockReturnValue({ headers: [], rows: [] });
            s.workQueryService.workItems.mockResolvedValue({ status: 'success', items: [] });
            s.itemImportService.validateRows.mockReturnValue({
                headers: [],
                suggestedMapping: {},
                validationResults: [],
                summary: { total: 0, valid: 0, invalid: 0, duplicates: 0 },
            });
            await controller.validateImportItems(auth, 'w-1', csvFile(), 'not-json');
            expect(s.itemImportService.validateRows).toHaveBeenCalledWith(
                expect.any(Object),
                {},
                [],
            );
        });
    });

    // -----------------------------------------------------------------------
    // Execute (EW-533 Phase 3): POST /:id/import-items
    // -----------------------------------------------------------------------

    describe('executeImportItems', () => {
        const validRow = (rowIndex: number) => ({
            rowIndex,
            valid: true,
            errors: [],
            warnings: [],
            data: {
                name: `Item ${rowIndex}`,
                description: 'd',
                source_url: `https://r${rowIndex}.test`,
                category: 'T',
            },
        });

        it('rejects requests with no rows array', async () => {
            await expect(
                controller.executeImportItems(auth, 'w-1', {} as any),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('returns 404 when import is not enabled', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: false } },
            });
            await expect(
                controller.executeImportItems(auth, 'w-1', {
                    rows: [validRow(0)],
                } as any),
            ).rejects.toBeInstanceOf(NotFoundException);
            expect(s.itemImportExecutor.executeImport).not.toHaveBeenCalled();
        });

        it("defaults duplicate_strategy to 'skip' and default_status to 'pending'", async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            await controller.executeImportItems(auth, 'w-1', {
                rows: [validRow(0)],
            } as any);
            expect(s.itemImportExecutor.executeImport).toHaveBeenCalledWith(
                { id: 'w-1', slug: 'demo' },
                { id: 'user-1' },
                expect.objectContaining({
                    duplicate_strategy: 'skip',
                    default_status: 'pending',
                }),
            );
        });

        it("threads duplicate_strategy='update' through to the executor", async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            await controller.executeImportItems(auth, 'w-1', {
                rows: [validRow(0)],
                duplicate_strategy: 'update',
                default_status: 'published',
            } as any);
            expect(s.itemImportExecutor.executeImport).toHaveBeenCalledWith(
                expect.any(Object),
                expect.any(Object),
                expect.objectContaining({
                    duplicate_strategy: 'update',
                    default_status: 'published',
                }),
            );
        });

        it('invalidates caches and logs IMPORT activity on success', async () => {
            s.workQueryService.workConfig.mockResolvedValue({
                status: 'success',
                config: { settings: { import_enabled: true } },
            });
            s.itemImportExecutor.executeImport.mockResolvedValue({
                total: 3,
                created: 2,
                updated: 1,
                skipped: 0,
                errors: [],
                pr_number: 7,
                pr_url: 'https://github.com/o/r/pull/7',
            });

            const result = await controller.executeImportItems(auth, 'w-1', {
                rows: [validRow(0), validRow(1), validRow(2)],
            } as any);

            expect(result.created).toBe(2);
            expect(result.pr_number).toBe(7);
            expect(
                s.cacheEntryRepository.typeormAdapter.deleteUnscopedEntriesLike,
            ).toHaveBeenCalledWith('w-1');
            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'IMPORT',
                    action: 'items.imported',
                    status: 'COMPLETED',
                    summary: 'Imported 2 items, 1 updated',
                }),
            );
        });
    });
});
