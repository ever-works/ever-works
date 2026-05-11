// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph.
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({
    EXPORT_FORMATS: ['csv', 'xlsx'],
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
    workOwnershipService: Record<string, never>;
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
        workOwnershipService: {} as any,
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
});
