// Mock the agent runtime tree at module scope so importing the controller does
// not pull in the agent's NestJS DI graph (database, entities, services, etc.).
jest.mock('@ever-works/agent/dto', () => ({}));
jest.mock('@ever-works/agent/items-generator', () => ({}));
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
        GENERATION: 'GENERATION',
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

import { WorksController } from './works.controller';
import type { AuthenticatedUser } from '../auth/types/auth.types';

type Mock = jest.Mock;

interface Stubs {
    cacheManager: { wrap: Mock };
    cacheEntryRepository: { typeormAdapter: { deleteUnscopedEntriesLike: Mock } };
    workQueryService: Record<string, never>;
    workLifecycleService: Record<string, never>;
    workGenerationService: {
        generateItems: Mock;
        updateItemsGenerator: Mock;
        cancelGeneration: Mock;
    };
    authService: { getUser: Mock };
    workDetailService: { generateWorkDetails: Mock };
    workScheduleService: Record<string, never>;
    workImportService: Record<string, never>;
    repositoryManagementService: Record<string, never>;
    workOwnershipService: { ensureAccess: Mock };
    workAdvancedPromptsService: Record<string, never>;
    workTaxonomyService: Record<string, never>;
    generatorFormSchemaService: { getFormSchema: Mock };
    itemHealthService: Record<string, never>;
    communityPrProcessorService: Record<string, never>;
    comparisonGenerationService: Record<string, never>;
    workRepository: Record<string, never>;
    sourceValidationService: Record<string, never>;
    subscriptionService: Record<string, never>;
    activityLogService: { log: Mock };
    templateCatalogService: Record<string, never>;
    itemExportService: Record<string, never>;
    itemImportService: Record<string, never>;
    itemImportExecutor: Record<string, never>;
}

function makeStubs(): Stubs {
    return {
        cacheManager: { wrap: jest.fn() },
        cacheEntryRepository: {
            typeormAdapter: { deleteUnscopedEntriesLike: jest.fn().mockResolvedValue(undefined) },
        },
        workQueryService: {} as any,
        workLifecycleService: {} as any,
        workGenerationService: {
            generateItems: jest.fn(),
            updateItemsGenerator: jest.fn(),
            cancelGeneration: jest.fn(),
        },
        authService: { getUser: jest.fn() },
        workDetailService: { generateWorkDetails: jest.fn() },
        workScheduleService: {} as any,
        workImportService: {} as any,
        repositoryManagementService: {} as any,
        workOwnershipService: { ensureAccess: jest.fn().mockResolvedValue(undefined) },
        workAdvancedPromptsService: {} as any,
        workTaxonomyService: {} as any,
        generatorFormSchemaService: { getFormSchema: jest.fn() },
        itemHealthService: {} as any,
        communityPrProcessorService: {} as any,
        comparisonGenerationService: {} as any,
        workRepository: {} as any,
        sourceValidationService: {} as any,
        subscriptionService: {} as any,
        activityLogService: { log: jest.fn().mockResolvedValue(undefined) },
        templateCatalogService: {} as any,
        itemExportService: {} as any,
        itemImportService: {} as any,
        itemImportExecutor: {} as any,
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
        { rotate: jest.fn(), getOrGenerate: jest.fn() } as any,
    );
}

const auth: AuthenticatedUser = { userId: 'auth-1' } as any;

describe('WorksController — generation + cancellation endpoints', () => {
    let s: Stubs;
    let controller: WorksController;

    beforeEach(() => {
        s = makeStubs();
        s.authService.getUser.mockResolvedValue({ id: 'user-1' });
        controller = makeController(s);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    // -----------------------------------------------------------------------
    // generateWorkDetails
    // -----------------------------------------------------------------------
    describe('generateWorkDetails', () => {
        it('forwards positional args (work_name, prompt, user, ai_provider) to workDetailService', async () => {
            const dto: any = {
                work_name: 'My Work',
                prompt: 'Generate details',
                ai_provider: 'openai',
            };
            s.workDetailService.generateWorkDetails.mockResolvedValue({
                name: 'My Work',
                description: 'Generated',
            });

            const result = await controller.generateWorkDetails(auth, dto);

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.workDetailService.generateWorkDetails).toHaveBeenCalledWith(
                'My Work',
                'Generate details',
                { id: 'user-1' },
                'openai',
            );
            expect(result).toEqual({ name: 'My Work', description: 'Generated' });
        });

        it('forwards undefined ai_provider when not specified', async () => {
            const dto: any = { work_name: 'X', prompt: 'p' };

            await controller.generateWorkDetails(auth, dto);

            expect(s.workDetailService.generateWorkDetails).toHaveBeenCalledWith(
                'X',
                'p',
                { id: 'user-1' },
                undefined,
            );
        });

        it('propagates errors from workDetailService.generateWorkDetails', async () => {
            s.workDetailService.generateWorkDetails.mockRejectedValue(new Error('boom'));

            await expect(
                controller.generateWorkDetails(auth, { work_name: 'X', prompt: 'p' } as any),
            ).rejects.toThrow('boom');
        });
    });

    // -----------------------------------------------------------------------
    // getGlobalGeneratorFormSchema
    // -----------------------------------------------------------------------
    describe('getGlobalGeneratorFormSchema', () => {
        it('forwards pipelineId + { userId } to generatorFormSchemaService.getFormSchema', async () => {
            s.generatorFormSchemaService.getFormSchema.mockResolvedValue({ schema: { x: 1 } });

            const result = await controller.getGlobalGeneratorFormSchema(auth, 'pipe-1');

            expect(s.authService.getUser).toHaveBeenCalledWith('auth-1');
            expect(s.generatorFormSchemaService.getFormSchema).toHaveBeenCalledWith('pipe-1', {
                userId: 'user-1',
            });
            expect(result).toEqual({ schema: { x: 1 } });
        });

        it('forwards undefined pipelineId when not specified', async () => {
            await controller.getGlobalGeneratorFormSchema(auth);

            expect(s.generatorFormSchemaService.getFormSchema).toHaveBeenCalledWith(undefined, {
                userId: 'user-1',
            });
        });

        it('does NOT include workId in the form context', async () => {
            await controller.getGlobalGeneratorFormSchema(auth, 'pipe-1');

            const [, ctx] = s.generatorFormSchemaService.getFormSchema.mock.calls[0];
            expect(ctx).not.toHaveProperty('workId');
        });
    });

    // -----------------------------------------------------------------------
    // getGeneratorFormSchema (per-work)
    // -----------------------------------------------------------------------
    describe('getGeneratorFormSchema', () => {
        it('runs ensureAccess(id, user.id) before resolving the schema', async () => {
            s.generatorFormSchemaService.getFormSchema.mockResolvedValue({ schema: { y: 2 } });

            const result = await controller.getGeneratorFormSchema(auth, 'w-1', 'pipe-1');

            // Order must be: getUser → ensureAccess → getFormSchema
            const ensureAccessOrder =
                s.workOwnershipService.ensureAccess.mock.invocationCallOrder[0];
            const getFormSchemaOrder =
                s.generatorFormSchemaService.getFormSchema.mock.invocationCallOrder[0];
            expect(ensureAccessOrder).toBeLessThan(getFormSchemaOrder);

            expect(s.workOwnershipService.ensureAccess).toHaveBeenCalledWith('w-1', 'user-1');
            expect(s.generatorFormSchemaService.getFormSchema).toHaveBeenCalledWith('pipe-1', {
                workId: 'w-1',
                userId: 'user-1',
            });
            expect(result).toEqual({ schema: { y: 2 } });
        });

        it('does NOT call getFormSchema when ensureAccess rejects', async () => {
            s.workOwnershipService.ensureAccess.mockRejectedValue(new Error('forbidden'));

            await expect(controller.getGeneratorFormSchema(auth, 'w-1', 'pipe-1')).rejects.toThrow(
                'forbidden',
            );
            expect(s.generatorFormSchemaService.getFormSchema).not.toHaveBeenCalled();
        });

        it('forwards undefined pipelineId', async () => {
            await controller.getGeneratorFormSchema(auth, 'w-1');

            expect(s.generatorFormSchemaService.getFormSchema).toHaveBeenCalledWith(undefined, {
                workId: 'w-1',
                userId: 'user-1',
            });
        });
    });

    // -----------------------------------------------------------------------
    // generateItems
    // -----------------------------------------------------------------------
    describe('generateItems', () => {
        it('logs IN_PROGRESS GENERATION and forwards dto + user with awaitCompletion=false', async () => {
            const dto: any = { count: 10 };
            s.workGenerationService.generateItems.mockResolvedValue({ generationId: 'g-1' });

            const result = await controller.generateItems(auth, 'w-1', dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'GENERATION',
                action: 'generation.started',
                status: 'IN_PROGRESS',
                summary: 'Started item generation',
            });
            expect(s.workGenerationService.generateItems).toHaveBeenCalledWith(
                'w-1',
                dto,
                { id: 'user-1' },
                false,
            );
            expect(result).toEqual({ generationId: 'g-1' });
        });

        it('still resolves when the activity log rejects (fire-and-forget)', async () => {
            s.workGenerationService.generateItems.mockResolvedValue({ generationId: 'g-1' });
            s.activityLogService.log.mockRejectedValueOnce(new Error('log down'));

            await expect(controller.generateItems(auth, 'w-1', {} as any)).resolves.toEqual({
                generationId: 'g-1',
            });
        });

        it('logs the start event even when generateItems rejects (log fired before service call)', async () => {
            // The controller fires `.catch(()=>{})` on the log then awaits the
            // service. So if the service rejects, the log was still requested.
            s.workGenerationService.generateItems.mockRejectedValue(new Error('quota'));

            await expect(controller.generateItems(auth, 'w-1', {} as any)).rejects.toThrow('quota');
            expect(s.activityLogService.log).toHaveBeenCalledTimes(1);
            expect(s.activityLogService.log).toHaveBeenCalledWith(
                expect.objectContaining({
                    actionType: 'GENERATION',
                    action: 'generation.started',
                    status: 'IN_PROGRESS',
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // updateItemsGenerator
    // -----------------------------------------------------------------------
    describe('updateItemsGenerator', () => {
        it('logs IN_PROGRESS update_started and forwards an object payload with awaitCompletion=false', async () => {
            const dto: any = { itemIds: ['i1', 'i2'] };
            s.workGenerationService.updateItemsGenerator.mockResolvedValue({ generationId: 'g-2' });

            const result = await controller.updateItemsGenerator(auth, 'w-1', dto);

            expect(s.activityLogService.log).toHaveBeenCalledWith({
                userId: 'auth-1',
                workId: 'w-1',
                actionType: 'GENERATION',
                action: 'generation.update_started',
                status: 'IN_PROGRESS',
                summary: 'Started item update',
            });
            expect(s.workGenerationService.updateItemsGenerator).toHaveBeenCalledWith({
                workId: 'w-1',
                updateDto: dto,
                user: { id: 'user-1' },
                awaitCompletion: false,
            });
            expect(result).toEqual({ generationId: 'g-2' });
        });

        it('still resolves when the activity log rejects (fire-and-forget)', async () => {
            s.workGenerationService.updateItemsGenerator.mockResolvedValue({ generationId: 'g-2' });
            s.activityLogService.log.mockRejectedValueOnce(new Error('log down'));

            await expect(controller.updateItemsGenerator(auth, 'w-1', {} as any)).resolves.toEqual({
                generationId: 'g-2',
            });
        });

        it('uses an OBJECT payload for updateItemsGenerator (not positional args)', async () => {
            // Pin the argument shape — the service method takes a single object,
            // not positional args. Refactoring to positional args would be a
            // breaking change for the agent-package contract.
            await controller.updateItemsGenerator(auth, 'w-1', {} as any);

            const args = s.workGenerationService.updateItemsGenerator.mock.calls[0];
            expect(args).toHaveLength(1);
            expect(args[0]).toEqual(
                expect.objectContaining({
                    workId: 'w-1',
                    updateDto: expect.anything(),
                    user: expect.objectContaining({ id: 'user-1' }),
                    awaitCompletion: false,
                }),
            );
        });
    });

    // -----------------------------------------------------------------------
    // cancelGeneration
    // -----------------------------------------------------------------------
    describe('cancelGeneration', () => {
        it('forwards id + user to workGenerationService.cancelGeneration with no activity log', async () => {
            s.workGenerationService.cancelGeneration.mockResolvedValue({ status: 'cancelled' });

            const result = await controller.cancelGeneration(auth, 'w-1');

            expect(s.workGenerationService.cancelGeneration).toHaveBeenCalledWith('w-1', {
                id: 'user-1',
            });
            expect(s.activityLogService.log).not.toHaveBeenCalled();
            expect(result).toEqual({ status: 'cancelled' });
        });

        it('propagates errors from cancelGeneration', async () => {
            s.workGenerationService.cancelGeneration.mockRejectedValue(new Error('not found'));

            await expect(controller.cancelGeneration(auth, 'w-1')).rejects.toThrow('not found');
        });
    });
});
