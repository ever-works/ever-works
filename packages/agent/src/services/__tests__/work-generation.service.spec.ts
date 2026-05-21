// `data-generator` / `markdown-generator` / `website-generator` /
// `website-update` are pulled in by the SUT module graph and transitively
// import `p-map` (ESM-only) which jest can't load without the experimental
// VM modules flag. We replace each with an empty class shell — the SUT
// only consumes them as DI tokens, runtime behaviour is fully substituted
// by hand-built mocks passed into the constructor.
jest.mock('@src/generators/data-generator/data-generator.service', () => ({
    DataGeneratorService: class DataGeneratorService {},
}));
jest.mock('@src/generators/markdown-generator/markdown-generator.service', () => ({
    MarkdownGeneratorService: class MarkdownGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-generator.service', () => ({
    WebsiteGeneratorService: class WebsiteGeneratorService {},
}));
jest.mock('@src/generators/website-generator/website-update.service', () => ({
    WebsiteUpdateService: class WebsiteUpdateService {},
}));

import {
    BadRequestException,
    ConflictException,
    HttpException,
    NotFoundException,
} from '@nestjs/common';
import { WorkGenerationService } from '../work-generation.service';
import { GenerateStatusType } from '@src/entities/types';
import { WorkScheduleBillingMode } from '@src/entities/types';
import { WorkHistoryActivityType } from '@ever-works/contracts/api';
import { GenerationMethod } from '@src/items-generator/dto/create-items-generator.dto';
import { createGenerationCancelledError, isGenerationCancelledError } from '@src/utils';
import { GENERATION_CANCELLED } from '@src/constants/messages';

import type { Work } from '@src/entities/work.entity';
import type { User } from '@src/entities/user.entity';
import type { WorkSchedule } from '@src/entities/work-schedule.entity';

describe('WorkGenerationService', () => {
    // ── Hand-built mocks ────────────────────────────────────────────────
    let dataGenerator: any;
    let markdownGenerator: any;
    let websiteGenerator: any;
    let websiteUpdateService: any;
    let itemSubmissionService: any;
    let workRepository: any;
    let eventEmitter: any;
    let generationHistoryRepository: any;
    let ownershipService: any;
    let workScheduleService: any;
    let workImportService: any;
    let userRepository: any;
    let screenshotFacade: any;
    let aiFacade: any;
    let contentExtractorFacade: any;
    let generatorFormSchemaService: any;
    let pluginOperationsService: any;
    let pluginRegistryService: any;
    let generationDispatcher: any;
    let notificationService: any;

    const buildUser = (overrides: Partial<User> = {}): User =>
        ({ id: 'user-1', ...overrides }) as User;

    const buildWork = (overrides: Partial<Work> = {}): Work => {
        const work: any = {
            id: 'work-1',
            slug: 'best-tools',
            name: 'Best Tools',
            userId: 'creator-1',
            gitProvider: 'github',
            user: { id: 'creator-1' } as User,
            generateStatus: null,
            getRepoOwner: jest.fn().mockReturnValue('acme'),
            getWebsiteRepo: jest.fn().mockReturnValue('best-tools-website'),
            getDataRepo: jest.fn().mockReturnValue('best-tools-data'),
            ...overrides,
        };
        return work as Work;
    };

    const buildSchedule = (overrides: Partial<WorkSchedule> = {}): WorkSchedule =>
        ({
            id: 'schedule-1',
            workId: 'work-1',
            userId: 'user-1',
            user: undefined,
            work: undefined,
            cadence: null,
            status: 'active',
            billingMode: WorkScheduleBillingMode.SUBSCRIPTION,
            failureCount: 0,
            maxFailureBeforePause: 3,
            alwaysCreatePullRequest: false,
            ...overrides,
        }) as unknown as WorkSchedule;

    const buildService = (
        opts: {
            withDispatcher?: boolean;
            withNotifications?: boolean;
        } = {},
    ): WorkGenerationService => {
        const withDispatcher = opts.withDispatcher ?? false;
        const withNotifications = opts.withNotifications ?? true;
        return new WorkGenerationService(
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            websiteUpdateService,
            itemSubmissionService,
            workRepository,
            eventEmitter,
            generationHistoryRepository,
            ownershipService,
            workScheduleService,
            workImportService,
            userRepository,
            screenshotFacade,
            aiFacade,
            contentExtractorFacade,
            generatorFormSchemaService,
            pluginOperationsService,
            pluginRegistryService,
            withDispatcher ? generationDispatcher : undefined,
            withNotifications ? notificationService : undefined,
        );
    };

    let errorSpy: jest.SpyInstance;
    let warnSpy: jest.SpyInstance;

    beforeEach(() => {
        dataGenerator = {
            getConfig: jest.fn(),
            getItems: jest.fn(),
            updateMarkdownTemplate: jest.fn(),
        };
        markdownGenerator = {
            initialize: jest.fn().mockResolvedValue(undefined),
        };
        websiteGenerator = {
            initialize: jest.fn(),
        };
        websiteUpdateService = {
            updateRepository: jest.fn(),
        };
        itemSubmissionService = {
            submitItem: jest.fn(),
            removeItem: jest.fn(),
            updateItem: jest.fn(),
        };
        workRepository = {
            findById: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            recordGenerationStartTime: jest.fn().mockResolvedValue(undefined),
            recordGenerationFinishTime: jest.fn().mockResolvedValue(undefined),
            updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
        };
        eventEmitter = {
            emit: jest.fn(),
        };
        generationHistoryRepository = {
            createEntry: jest.fn(),
            updateEntry: jest.fn().mockResolvedValue(undefined),
            findLatestInProgressByWork: jest.fn(),
            appendLogs: jest.fn(),
        };
        ownershipService = {
            ensureCanEdit: jest.fn(),
        };
        workScheduleService = {
            validateRunEntitlement: jest.fn().mockResolvedValue(true),
            finalizeScheduleRun: jest.fn().mockResolvedValue(undefined),
            pauseSchedule: jest.fn().mockResolvedValue(undefined),
        };
        workImportService = {
            syncWork: jest.fn(),
        };
        userRepository = {
            findById: jest.fn(),
            findByIdForScheduledRun: jest.fn(),
        };
        screenshotFacade = {
            isAvailable: jest.fn().mockReturnValue(true),
            capture: jest.fn(),
        };
        aiFacade = {
            askJson: jest.fn(),
            isConfigured: jest.fn().mockReturnValue(true),
        };
        contentExtractorFacade = {
            extractContent: jest.fn(),
        };
        generatorFormSchemaService = {
            validateSelectedProviders: jest.fn().mockResolvedValue(undefined),
            validateFormSchemaPlugins: jest.fn().mockResolvedValue(undefined),
            processFormConfig: jest
                .fn()
                .mockResolvedValue({ config: undefined, pluginConfig: undefined }),
        };
        pluginOperationsService = {
            enablePluginForWork: jest.fn(),
        };
        pluginRegistryService = {
            isPluginEnabledForScope: jest.fn().mockResolvedValue(true),
        };
        generationDispatcher = {
            dispatchWorkGeneration: jest.fn(),
            cancelWorkGeneration: jest.fn(),
        };
        notificationService = {
            notifyAiCreditsDepleted: jest.fn().mockResolvedValue(undefined),
            notifyAiProviderError: jest.fn().mockResolvedValue(undefined),
            notifyGitAuthExpired: jest.fn().mockResolvedValue(undefined),
            notifyGenerationAccountError: jest.fn().mockResolvedValue(undefined),
        };
    });

    afterEach(() => {
        if (errorSpy) errorSpy.mockRestore();
        if (warnSpy) warnSpy.mockRestore();
        jest.clearAllMocks();
    });

    // ════════════════════════════════════════════════════════════════════
    //  updateDomainType
    // ════════════════════════════════════════════════════════════════════
    describe('updateDomainType', () => {
        it('runs ensureCanEdit BEFORE workRepository.update', async () => {
            // Order pinned via shared `order` array w/ mockImplementation
            // push so an accidental swap (which would let unauthorised
            // callers mutate the domainType) breaks loudly.
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
                return { work: buildWork(), isCreator: true } as any;
            });
            workRepository.update.mockImplementation(async () => {
                order.push('update');
            });

            const service = buildService();
            await service.updateDomainType('work-1', 'tools', buildUser());

            expect(order).toEqual(['ensureCanEdit', 'update']);
        });

        it('defaults manuallySet to true when omitted', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            const service = buildService();
            const result = await service.updateDomainType('work-1', 'tools', buildUser());

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                domainType: 'tools',
                domainTypeManuallySet: true,
            });
            expect(result.domainTypeManuallySet).toBe(true);
        });

        it('honours explicit manuallySet=false (auto-detected branch)', async () => {
            // The auto-domain-detect path passes `manuallySet=false` so the
            // user's explicit choice (when they later pick) is the one that
            // wins. Pinned to guard against a future "default-true wins
            // everywhere" refactor.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            const service = buildService();
            const result = await service.updateDomainType('work-1', 'tools', buildUser(), false);

            expect(workRepository.update).toHaveBeenCalledWith('work-1', {
                domainType: 'tools',
                domainTypeManuallySet: false,
            });
            expect(result.domainTypeManuallySet).toBe(false);
        });

        it('returns the documented success envelope', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            const service = buildService();
            const result = await service.updateDomainType('work-1', 'tools', buildUser());

            expect(result).toEqual({
                status: 'success',
                domainType: 'tools',
                domainTypeManuallySet: true,
            });
        });

        it('rethrows HttpException verbatim (preserves identity)', async () => {
            const err = new BadRequestException('forbidden domain');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(service.updateDomainType('work-1', 'tools', buildUser())).rejects.toBe(
                err,
            );
        });

        it('wraps generic Error in BadRequestException with normalized message', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            workRepository.update.mockRejectedValue(new Error('database down'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const service = buildService();
            try {
                await service.updateDomainType('work-1', 'tools', buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({ status: 'error', message: 'database down' }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  regenerateMarkdown
    // ════════════════════════════════════════════════════════════════════
    describe('regenerateMarkdown', () => {
        it('runs ensureCanEdit BEFORE markdownGenerator.initialize', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
                return { work: buildWork() } as any;
            });
            markdownGenerator.initialize.mockImplementation(async () => {
                order.push('initialize');
            });

            const service = buildService();
            await service.regenerateMarkdown('work-1', buildUser());

            expect(order).toEqual(['ensureCanEdit', 'initialize']);
        });

        it('forwards generation_method=RECREATE to markdownGenerator.initialize', async () => {
            // Pinned: regenerate-markdown is the user-facing "rebuild every
            // *.md file from data" action — a future swap to CREATE_UPDATE
            // would silently leave stale markdown for items that no longer
            // exist in the data repo.
            const work = buildWork();
            const user = buildUser();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            const service = buildService();

            await service.regenerateMarkdown('work-1', user);

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(work, user, {
                generation_method: GenerationMethod.RECREATE,
            });
        });

        it('returns {status:"success"} envelope', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            const service = buildService();
            const result = await service.regenerateMarkdown('work-1', buildUser());

            expect(result).toEqual({ status: 'success' });
        });

        it('rethrows HttpException verbatim', async () => {
            const err = new BadRequestException('not allowed');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(service.regenerateMarkdown('work-1', buildUser())).rejects.toBe(err);
        });

        it('wraps generic Error and includes id in BadRequestException payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            markdownGenerator.initialize.mockRejectedValue(new Error('disk full'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const service = buildService();
            try {
                await service.regenerateMarkdown('work-1', buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        id: 'work-1',
                        message: 'disk full',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  updateReadme
    // ════════════════════════════════════════════════════════════════════
    describe('updateReadme', () => {
        it('returns "skipped" envelope when repo not initialized — does NOT call markdownGenerator.initialize', async () => {
            // Pinned: the not-initialized branch is the "user just created
            // the work, repo not yet provisioned" case. UI relies on the
            // distinct `status:'skipped'` to render a "create the
            // repository first" prompt rather than a generic error.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockResolvedValue({
                updated: false,
                reason: 'not_initialized',
                message: 'Repository not yet created',
            });

            const service = buildService();
            const result = await service.updateReadme('work-1', buildUser());

            expect(result).toEqual({
                status: 'skipped',
                updated: false,
                slug: 'best-tools',
                message: 'Repository not yet created',
            });
            expect(markdownGenerator.initialize).not.toHaveBeenCalled();
        });

        it('triggers markdownGenerator.initialize w/ CREATE_UPDATE when template was updated', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockResolvedValue({
                updated: true,
                message: 'Template synced',
            });

            const service = buildService();
            await service.updateReadme('work-1', buildUser());

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                { generation_method: GenerationMethod.CREATE_UPDATE },
            );
        });

        it('does NOT call markdownGenerator.initialize when updated:false (template already up to date)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockResolvedValue({ updated: false });

            const service = buildService();
            const result = await service.updateReadme('work-1', buildUser());

            expect(markdownGenerator.initialize).not.toHaveBeenCalled();
            expect(result).toEqual({
                status: 'success',
                updated: false,
                slug: 'best-tools',
                message: 'README already up to date.',
            });
        });

        it('uses templateUpdate.message when provided over the default copy', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockResolvedValue({
                updated: true,
                message: 'Custom synced message',
            });

            const service = buildService();
            const result = await service.updateReadme('work-1', buildUser());

            expect(result.message).toBe('Custom synced message');
        });

        it('falls back to "README updated successfully." when message is empty AND updated:true', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockResolvedValue({ updated: true });

            const service = buildService();
            const result = await service.updateReadme('work-1', buildUser());

            expect(result.message).toBe('README updated successfully.');
        });

        it('rethrows HttpException verbatim', async () => {
            const err = new BadRequestException('forbidden');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(service.updateReadme('work-1', buildUser())).rejects.toBe(err);
        });

        it('wraps generic Error w/ workId in BadRequestException payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.updateMarkdownTemplate.mockRejectedValue(new Error('disk full'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const service = buildService();
            try {
                await service.updateReadme('work-1', buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        workId: 'work-1',
                        message: 'disk full',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  updateWebsiteRepository
    // ════════════════════════════════════════════════════════════════════
    describe('updateWebsiteRepository', () => {
        it('returns the documented envelope w/ owner from getRepoOwner("website") AND owner/repo composite', async () => {
            const work = buildWork({
                slug: 'best-tools',
                getRepoOwner: jest.fn().mockReturnValue('website-owner'),
                getWebsiteRepo: jest.fn().mockReturnValue('best-tools-website'),
            } as any);
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            websiteUpdateService.updateRepository.mockResolvedValue({
                method: 'create-using-template',
                message: 'Created from template',
            });

            const service = buildService();
            const result = await service.updateWebsiteRepository('work-1', buildUser());

            expect(work.getRepoOwner).toHaveBeenCalledWith('website');
            expect(work.getWebsiteRepo).toHaveBeenCalledWith();
            expect(result).toEqual({
                status: 'success',
                slug: 'best-tools',
                owner: 'website-owner',
                repository: 'website-owner/best-tools-website',
                message: 'Created from template',
                method_used: 'create-using-template',
            });
        });

        it('forwards (work, user) positionally to websiteUpdateService.updateRepository', async () => {
            const work = buildWork();
            const user = buildUser();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            websiteUpdateService.updateRepository.mockResolvedValue({
                method: 'pull',
                message: 'ok',
            });

            const service = buildService();
            await service.updateWebsiteRepository('work-1', user);

            expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        });

        it('rethrows HttpException verbatim', async () => {
            const err = new BadRequestException('not allowed');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(service.updateWebsiteRepository('work-1', buildUser())).rejects.toBe(err);
        });

        it('wraps generic Error w/ workId in BadRequestException payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            websiteUpdateService.updateRepository.mockRejectedValue(new Error('clone failed'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});
            const service = buildService();
            try {
                await service.updateWebsiteRepository('work-1', buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        workId: 'work-1',
                        message: 'clone failed',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  extractItemDetails
    // ════════════════════════════════════════════════════════════════════
    describe('extractItemDetails', () => {
        it('returns error envelope when extracted is null/undefined — does NOT call AI', async () => {
            // Defence in depth: extractContent is allowed to return
            // undefined when the URL is unreachable. Calling the AI on
            // empty content would hallucinate the item name from the URL.
            contentExtractorFacade.extractContent.mockResolvedValue(undefined);

            const service = buildService();
            const result = await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser(),
            );

            expect(result).toEqual({
                status: 'error',
                source_url: 'https://example.com',
                message: 'Could not extract content from the provided URL',
            });
            expect(aiFacade.askJson).not.toHaveBeenCalled();
        });

        it('returns error envelope when extracted.rawContent is empty — does NOT call AI', async () => {
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: '' });

            const service = buildService();
            const result = await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser(),
            );

            expect(result.status).toBe('error');
            expect(aiFacade.askJson).not.toHaveBeenCalled();
        });

        it('forwards content sliced to 12_000 chars + facadeOptions {userId} to aiFacade.askJson', async () => {
            // The slice cap is documented as 12000 chars to prevent prompt
            // explosion on large blog posts. Pinned because dropping the
            // cap (or raising it) directly affects token cost per call.
            const longContent = 'x'.repeat(20_000);
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: longContent });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'Item A',
                    description: 'desc',
                    category: 'tools',
                    tags: ['t1'],
                    brand: null,
                    brand_logo_url: null,
                    images: [],
                },
            });

            const service = buildService();
            await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser({ id: 'caller-1' }),
            );

            expect(contentExtractorFacade.extractContent).toHaveBeenCalledWith(
                'https://example.com',
                undefined,
                { userId: 'caller-1' },
            );
            const [, , askJsonOptions, askJsonContext] = aiFacade.askJson.mock.calls[0];
            expect(askJsonOptions.temperature).toBe(0.1);
            expect(askJsonOptions.routing).toEqual({ complexity: 'simple' });
            expect(askJsonOptions.variables.source_url).toBe('https://example.com');
            expect(askJsonOptions.variables.content).toHaveLength(12_000);
            expect(askJsonContext).toEqual({ userId: 'caller-1' });
        });

        it('validates edit access and forwards workId when provided for usage attribution', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'Item A',
                    description: 'desc',
                    category: 'tools',
                    tags: ['t1'],
                    brand: null,
                    brand_logo_url: null,
                    images: [],
                },
            });

            const service = buildService();
            await service.extractItemDetails(
                { source_url: 'https://example.com', workId: 'work-1' },
                buildUser({ id: 'caller-1' }),
            );

            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('work-1', 'caller-1');
            expect(contentExtractorFacade.extractContent).toHaveBeenCalledWith(
                'https://example.com',
                undefined,
                { userId: 'caller-1', workId: 'work-1' },
            );
            expect(aiFacade.askJson.mock.calls[0][3]).toEqual({
                userId: 'caller-1',
                workId: 'work-1',
            });
        });

        it('omits the categoriesHint segment when existing_categories is undefined or empty', async () => {
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'X',
                    description: 'd',
                    category: 'c',
                    tags: [],
                    brand: null,
                    brand_logo_url: null,
                    images: [],
                },
            });

            const service = buildService();
            await service.extractItemDetails(
                { source_url: 'https://example.com', existing_categories: [] },
                buildUser(),
            );

            const [prompt] = aiFacade.askJson.mock.calls[0];
            expect(prompt).not.toContain('Prefer matching one of these existing categories');
        });

        it('appends categoriesHint when existing_categories has entries', async () => {
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'X',
                    description: 'd',
                    category: 'tools',
                    tags: [],
                    brand: null,
                    brand_logo_url: null,
                    images: [],
                },
            });

            const service = buildService();
            await service.extractItemDetails(
                {
                    source_url: 'https://example.com',
                    existing_categories: ['tools', 'libs'],
                },
                buildUser(),
            );

            const [prompt] = aiFacade.askJson.mock.calls[0];
            expect(prompt).toContain(
                'Prefer matching one of these existing categories: tools, libs',
            );
        });

        it('coerces falsy brand to undefined via `||` (NOT `??`) — empty-string brand drops too', async () => {
            // Pinned: the source uses `result.brand || undefined` so an
            // empty-string brand (the LLM sometimes returns "" rather than
            // null) is collapsed to undefined. Swap to `??` would let
            // empty-string through to the UI rendering an empty cell.
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'X',
                    description: 'd',
                    category: 'c',
                    tags: [],
                    brand: '',
                    brand_logo_url: null,
                    images: [],
                },
            });

            const service = buildService();
            const result = await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser(),
            );

            expect(result.status).toBe('success');
            expect((result as any).item.brand).toBeUndefined();
        });

        it('filters images to http-prefixed URLs only — drops relative + data: + javascript:', async () => {
            // Defence against AI returning relative URLs, javascript:, or
            // data: URIs which are unsafe to render in the UI.
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'X',
                    description: 'd',
                    category: 'c',
                    tags: [],
                    brand: null,
                    brand_logo_url: null,
                    images: [
                        'https://example.com/a.png',
                        'http://example.com/b.png',
                        '/relative.png',
                        'data:image/png;base64,abc',
                        'javascript:alert(1)',
                    ],
                },
            });

            const service = buildService();
            const result = await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser(),
            );

            expect((result as any).item.images).toEqual([
                'https://example.com/a.png',
                'http://example.com/b.png',
            ]);
        });

        it('coerces missing images array to [] via `|| []` short-circuit', async () => {
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockResolvedValue({
                result: {
                    name: 'X',
                    description: 'd',
                    category: 'c',
                    tags: [],
                    brand: null,
                    brand_logo_url: null,
                    images: undefined,
                },
            });

            const service = buildService();
            const result = await service.extractItemDetails(
                { source_url: 'https://example.com' },
                buildUser(),
            );

            expect((result as any).item.images).toEqual([]);
        });

        it('throws BadRequestException on AI failure w/ source_url + normalized message', async () => {
            contentExtractorFacade.extractContent.mockResolvedValue({ rawContent: 'page' });
            aiFacade.askJson.mockRejectedValue(new Error('rate limit'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.extractItemDetails(
                    { source_url: 'https://example.com' },
                    buildUser(),
                );
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        source_url: 'https://example.com',
                        message: 'rate limit',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  bulkCaptureImages
    // ════════════════════════════════════════════════════════════════════
    describe('bulkCaptureImages', () => {
        it('returns success envelope w/ "No items found" message when getItems returns []', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([]);

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result).toEqual({
                status: 'success',
                results: [],
                totalProcessed: 0,
                successCount: 0,
                errorCount: 0,
                message: 'No items found in work',
            });
            expect(screenshotFacade.capture).not.toHaveBeenCalled();
        });

        it('filters by itemSlugs when provided', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
                { slug: 'b', name: 'B', source_url: 'https://b.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({
                cacheUrl: 'https://cdn/a.png',
                imageUrl: null,
            });

            const service = buildService();
            await service.bulkCaptureImages(
                'work-1',
                { mode: 'all', itemSlugs: ['a'] },
                buildUser(),
            );

            expect(screenshotFacade.capture).toHaveBeenCalledTimes(1);
            const [{ url }] = screenshotFacade.capture.mock.calls[0];
            expect(url).toBe('https://a.com');
        });

        it('mode="missing" filters out items that already have images', async () => {
            // Pinned: "missing" is the default UI mode — picks items that
            // never had a capture attempt yet. A future swap to also
            // include items with empty `images: []` is fine, but items
            // with existing populated `images` must NEVER be re-captured
            // in this mode (would double the screenshot bill).
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com', images: ['x'] },
                { slug: 'b', name: 'B', source_url: 'https://b.com' },
                { slug: 'c', name: 'C', source_url: 'https://c.com', images: [] },
            ]);
            screenshotFacade.capture.mockResolvedValue({ cacheUrl: 'cdn', imageUrl: null });

            const service = buildService();
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'missing' },
                buildUser(),
            );

            // "a" has images so skipped; "b" + "c" eligible
            expect(result.totalProcessed).toBe(2);
            expect(result.results.map((r) => r.itemSlug).sort()).toEqual(['b', 'c']);
        });

        it('drops items without source_url unconditionally', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A' }, // no source_url
                { slug: 'b', name: 'B', source_url: 'https://b.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({ cacheUrl: 'cdn', imageUrl: null });

            const service = buildService();
            await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(screenshotFacade.capture).toHaveBeenCalledTimes(1);
        });

        it('returns "No items without images found" message-flavour when mode=missing AND nothing eligible', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com', images: ['x'] },
            ]);

            const service = buildService();
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'missing' },
                buildUser(),
            );

            expect(result.message).toBe('No items without images found');
            expect(screenshotFacade.capture).not.toHaveBeenCalled();
        });

        it('returns "No items with source URLs found" message-flavour when mode=all AND every item missing source_url', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A' },
                { slug: 'b', name: 'B' },
            ]);

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.message).toBe('No items with source URLs found');
            expect(screenshotFacade.capture).not.toHaveBeenCalled();
        });

        it('returns error envelope when screenshotFacade.isAvailable() === false', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.isAvailable.mockReturnValue(false);

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.status).toBe('error');
            expect(result.message).toBe('Screenshot service is not available');
            expect(screenshotFacade.capture).not.toHaveBeenCalled();
        });

        it('forwards (capture-options, {userId, workId}) shape to screenshotFacade.capture', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({ cacheUrl: 'cdn', imageUrl: null });

            const service = buildService();
            await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser({ id: 'caller' }));

            const [opts, ctx] = screenshotFacade.capture.mock.calls[0];
            expect(opts).toEqual({
                url: 'https://a.com',
                blockAds: true,
                blockCookieBanners: true,
                cache: true,
            });
            expect(ctx).toEqual({ userId: 'caller', workId: 'work-1' });
        });

        it('uses cacheUrl over imageUrl when both present (cacheUrl wins)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({
                cacheUrl: 'https://cdn/a.png',
                imageUrl: 'https://upstream/a.png',
            });

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.results[0].primaryImage).toBe('https://cdn/a.png');
        });

        it('falls back to imageUrl when cacheUrl is empty', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({
                cacheUrl: '',
                imageUrl: 'https://upstream/a.png',
            });

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.results[0].primaryImage).toBe('https://upstream/a.png');
        });

        it('catches per-item capture failure and continues with the remaining items', async () => {
            // Pinned: per-item rejection MUST NOT short-circuit the bulk
            // run — partial success is the documented happy path here.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
                { slug: 'b', name: 'B', source_url: 'https://b.com' },
            ]);
            screenshotFacade.capture
                .mockRejectedValueOnce(new Error('upstream 5xx'))
                .mockResolvedValueOnce({ cacheUrl: 'https://cdn/b.png', imageUrl: null });

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.status).toBe('partial');
            expect(result.successCount).toBe(1);
            expect(result.errorCount).toBe(1);
            expect(result.results[0]).toEqual(
                expect.objectContaining({
                    itemSlug: 'a',
                    primaryImage: null,
                    error: 'upstream 5xx',
                }),
            );
            expect(result.results[1]).toEqual(
                expect.objectContaining({ itemSlug: 'b', primaryImage: 'https://cdn/b.png' }),
            );
        });

        it('coerces non-Error rejection to "Unknown error" copy', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockRejectedValue('plain-string');

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.results[0].error).toBe('Unknown error');
        });

        it('status = "error" when EVERY capture fails (successCount === 0 AND errorCount > 0)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockRejectedValue(new Error('failed'));

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.status).toBe('error');
            expect(result.successCount).toBe(0);
            expect(result.errorCount).toBe(1);
        });

        it('status = "success" when ALL captures succeed (errorCount === 0)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockResolvedValue({
                cacheUrl: 'https://cdn/a.png',
                imageUrl: null,
            });

            const service = buildService();
            const result = await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());

            expect(result.status).toBe('success');
        });

        it('rethrows HttpException verbatim from ensureCanEdit', async () => {
            const err = new BadRequestException('nope');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(
                service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser()),
            ).rejects.toBe(err);
        });

        it('wraps generic Error from getItems in BadRequestException', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockRejectedValue(new Error('db down'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.bulkCaptureImages('work-1', { mode: 'all' }, buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({ status: 'error', message: 'db down' }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  cancelGeneration
    // ════════════════════════════════════════════════════════════════════
    describe('cancelGeneration', () => {
        it('returns "already_finished" envelope when work is NOT in GENERATING status — no history lookup, no abort', async () => {
            // Pinned: the no-op short-circuit MUST happen BEFORE the
            // history lookup (saves a DB call) AND MUST NOT touch the
            // abort-controller map (defensive — a stale entry would crash
            // on .abort()).
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATED } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);

            const service = buildService();
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(result).toEqual({
                status: 'success',
                message: 'Work "Best Tools" is no longer generating.',
                mode: 'already_finished',
            });
            expect(generationHistoryRepository.findLatestInProgressByWork).not.toHaveBeenCalled();
        });

        it('triggerRunId + no-dispatcher → finalizeCancelledGeneration + "stale" envelope', async () => {
            // The dispatcher is @Optional. When absent, the row is
            // marked CANCELLED locally so the UI doesn't show "stalled
            // generation" forever.
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue({
                id: 'h-1',
                triggerRunId: 'run-1',
                scheduleId: null,
                startedAt: new Date('2026-05-01'),
            });
            workRepository.findById.mockResolvedValue({
                ...work,
                generateStatus: { status: GenerateStatusType.CANCELLED } as any,
            });

            const service = buildService(); // no dispatcher
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(result.mode).toBe('stale');
            expect(workRepository.recordGenerationFinishTime).toHaveBeenCalled();
            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({ status: GenerateStatusType.CANCELLED }),
            );
        });

        it('dispatcher cancel-success → finalizeCancelledGeneration + "trigger" envelope', async () => {
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue({
                id: 'h-1',
                triggerRunId: 'run-1',
                scheduleId: 'sched-1',
                startedAt: new Date('2026-05-01'),
            });
            generationDispatcher.cancelWorkGeneration.mockResolvedValue(true);
            workRepository.findById.mockResolvedValue({
                ...work,
                generateStatus: { status: GenerateStatusType.CANCELLED } as any,
            });

            const service = buildService({ withDispatcher: true });
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(generationDispatcher.cancelWorkGeneration).toHaveBeenCalledWith('run-1');
            expect(result.mode).toBe('trigger');
            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('sched-1', {
                status: 'failed',
                reason: GENERATION_CANCELLED,
            });
        });

        it('dispatcher cancel-fails AND refreshed work no longer GENERATING → "already_finished" envelope w/ refreshed name', async () => {
            // Race-condition recovery: the trigger run completed naturally
            // between our findLatestInProgressByWork and the cancel call.
            // We must NOT mark the row CANCELLED in that case (the row is
            // GENERATED already) — pinned via not.toHaveBeenCalled() on
            // recordGenerationFinishTime.
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue({
                id: 'h-1',
                triggerRunId: 'run-1',
                scheduleId: null,
                startedAt: new Date('2026-05-01'),
            });
            generationDispatcher.cancelWorkGeneration.mockResolvedValue(false);
            workRepository.findById.mockResolvedValue({
                ...work,
                name: 'Best Tools v2',
                generateStatus: { status: GenerateStatusType.GENERATED } as any,
            });

            const service = buildService({ withDispatcher: true });
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(result).toEqual({
                status: 'success',
                message: 'Work "Best Tools v2" is no longer generating.',
                mode: 'already_finished',
            });
            expect(workRepository.recordGenerationFinishTime).not.toHaveBeenCalled();
        });

        it('dispatcher cancel-fails AND refreshed work STILL GENERATING → finalizeCancelledGeneration + "stale" envelope', async () => {
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue({
                id: 'h-1',
                triggerRunId: 'run-1',
                scheduleId: null,
                startedAt: new Date('2026-05-01'),
            });
            generationDispatcher.cancelWorkGeneration.mockResolvedValue(false);
            workRepository.findById.mockResolvedValue({
                ...work,
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });

            const service = buildService({ withDispatcher: true });
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(result.mode).toBe('stale');
            expect(workRepository.recordGenerationFinishTime).toHaveBeenCalled();
        });

        it('no triggerRunId AND in-process abortController present → controller.abort + "in_process" envelope', async () => {
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue({
                id: 'h-1',
                triggerRunId: null,
                scheduleId: null,
                startedAt: new Date('2026-05-01'),
            });

            const service = buildService();
            // Inject a fake controller via the private map — mirrors
            // what processGeneration would do.
            const controller = new AbortController();
            const abortSpy = jest.spyOn(controller, 'abort');
            (service as any).generationAbortControllers.set('work-1', controller);

            const result = await service.cancelGeneration('work-1', buildUser());

            expect(abortSpy).toHaveBeenCalledTimes(1);
            const [reason] = abortSpy.mock.calls[0];
            expect(isGenerationCancelledError(reason)).toBe(true);
            expect(result.mode).toBe('in_process');
            // No finalize on the in-process branch — the catch block in
            // processGeneration handles cleanup via the AbortError.
            expect(workRepository.recordGenerationFinishTime).not.toHaveBeenCalled();
        });

        it('no triggerRunId AND no abortController → finalizeCancelledGeneration + "stale" envelope', async () => {
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.findLatestInProgressByWork.mockResolvedValue(null);

            const service = buildService();
            const result = await service.cancelGeneration('work-1', buildUser());

            expect(result.mode).toBe('stale');
            expect(workRepository.recordGenerationFinishTime).toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  runScheduledUpdate
    // ════════════════════════════════════════════════════════════════════
    describe('runScheduledUpdate', () => {
        it('uses schedule.user verbatim when present — does NOT call userRepository.findByIdForScheduledRun', async () => {
            // Avoids an N+1 lookup on the cron path: callers preload the
            // user via JOIN and we MUST trust it.
            const user = buildUser({ id: 'u-1' });
            const work = buildWork({
                generateStatus: null,
                sourceRepository: undefined,
            } as any);
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            const schedule = buildSchedule({
                user: user as any,
                work: work as any,
                alwaysCreatePullRequest: false,
            });

            // Stub updateItemsGenerator's internal happy path (config exists)
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'Item A', prompt: 'old prompt' },
                    initial_prompt: 'init prompt',
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.runScheduledUpdate(schedule);

            expect(userRepository.findByIdForScheduledRun).not.toHaveBeenCalled();
            expect(workScheduleService.validateRunEntitlement).toHaveBeenCalledWith(schedule, user);
        });

        it('falls back to userRepository.findByIdForScheduledRun when schedule.user is unset', async () => {
            const work = buildWork();
            const fetchedUser = buildUser({ id: 'u-1' });
            userRepository.findByIdForScheduledRun.mockResolvedValue(fetchedUser);
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);

            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'Item A', prompt: 'old' },
                    initial_prompt: 'init',
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            const schedule = buildSchedule({
                userId: 'u-1',
                user: undefined,
                work: work as any,
            });
            await service.runScheduledUpdate(schedule);

            expect(userRepository.findByIdForScheduledRun).toHaveBeenCalledWith('u-1');
        });

        it('throws NotFoundException when schedule.user is unset AND userRepository.findByIdForScheduledRun returns null', async () => {
            userRepository.findByIdForScheduledRun.mockResolvedValue(null);
            const schedule = buildSchedule({ user: undefined, userId: 'u-missing' });

            const service = buildService();
            await expect(service.runScheduledUpdate(schedule)).rejects.toBeInstanceOf(
                NotFoundException,
            );
            // Outer try/catch finalizes the schedule on failure.
            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('schedule-1', {
                status: 'failed',
                reason: 'User not found for scheduled update',
            });
        });

        it('returns "skipped" envelope when validateRunEntitlement returns false — finalizes schedule + does NOT enter updateItemsGenerator', async () => {
            // Pinned: a downgraded user must not have their schedule rip
            // through to a real generation. The "skipped" outcome is the
            // documented signal to the dispatcher that the run was
            // intentionally not executed.
            const user = buildUser();
            const work = buildWork();
            const schedule = buildSchedule({ user: user as any, work: work as any });
            workScheduleService.validateRunEntitlement.mockResolvedValue(false);

            const service = buildService();
            const result = await service.runScheduledUpdate(schedule);

            expect(result).toEqual({
                slug: 'best-tools',
                status: 'skipped',
                message: 'Entitlement check failed — schedule paused',
            });
            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('schedule-1', {
                status: 'skipped',
                reason: 'Entitlement check failed — schedule paused',
            });
            expect(dataGenerator.getConfig).not.toHaveBeenCalled();
        });

        it('skipped envelope falls back to schedule.workId when work.slug missing', async () => {
            const user = buildUser();
            const schedule = buildSchedule({
                user: user as any,
                work: undefined,
                workId: 'work-99',
            });
            workScheduleService.validateRunEntitlement.mockResolvedValue(false);

            const service = buildService();
            const result = await service.runScheduledUpdate(schedule);

            expect(result).toEqual(expect.objectContaining({ slug: 'work-99', status: 'skipped' }));
        });

        it('routes to runScheduledSync when work has a syncable sourceRepository', async () => {
            const user = buildUser();
            const work = buildWork({
                sourceRepository: { type: 'data_repo', url: 'https://github.com/upstream' },
            } as any);
            const schedule = buildSchedule({ user: user as any, work: work as any });

            generationHistoryRepository.createEntry.mockResolvedValue({ id: 'h-1' } as any);
            workImportService.syncWork.mockResolvedValue({ success: true });

            const service = buildService();
            const result = await service.runScheduledUpdate(schedule);

            expect(workImportService.syncWork).toHaveBeenCalledWith(work, user, 'h-1');
            // sync-success path resolves to undefined (per the void
            // signature on runScheduledSync) — explicitly NOT a
            // 'pending' / 'skipped' envelope.
            expect(result).toBeUndefined();
        });

        it('routes to runScheduledSync but propagates handleSyncFailure when syncWork returns success:false', async () => {
            const user = buildUser();
            const work = buildWork({
                sourceRepository: { type: 'awesome_readme', url: 'https://github.com/foo' },
            } as any);
            const schedule = buildSchedule({ user: user as any, work: work as any });

            generationHistoryRepository.createEntry.mockResolvedValue({ id: 'h-1' } as any);
            workImportService.syncWork.mockResolvedValue({
                success: false,
                error: 'upstream 404',
            });

            const service = buildService();
            await service.runScheduledUpdate(schedule);

            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('schedule-1', {
                status: 'failed',
                reason: 'upstream 404',
            });
            expect(generationHistoryRepository.updateEntry).toHaveBeenCalledWith(
                'h-1',
                expect.objectContaining({
                    status: GenerateStatusType.ERROR,
                    errorMessage: 'upstream 404',
                }),
            );
        });

        it('non-syncable sourceRepository falls through to the regular update flow', async () => {
            const user = buildUser();
            const work = buildWork({
                // 'mcp' or any other type is NOT in SYNCABLE_SOURCE_TYPES.
                sourceRepository: { type: 'mcp', url: 'https://example.com' },
            } as any);
            const schedule = buildSchedule({ user: user as any, work: work as any });

            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'X', prompt: 'p' },
                    initial_prompt: 'init',
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            const result = await service.runScheduledUpdate(schedule);

            // syncWork was NOT called, the regular update path was used.
            expect(workImportService.syncWork).not.toHaveBeenCalled();
            expect(result).toEqual(
                expect.objectContaining({ slug: 'best-tools', status: 'pending' }),
            );
        });

        it('forwards schedule.providerOverrides into updateDto.providers', async () => {
            const user = buildUser();
            const work = buildWork();
            const overrides = { ai: 'openai', search: 'tavily' } as any;
            const schedule = buildSchedule({
                user: user as any,
                work: work as any,
                providerOverrides: overrides,
                alwaysCreatePullRequest: true,
            });

            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'X', prompt: 'p' },
                    initial_prompt: 'init',
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.runScheduledUpdate(schedule);

            // payload.providers ends up in the dispatcher payload (the
            // last-request-data spread overrides + the dto providers
            // override the dto's providers per the source's deep-merge).
            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.providers).toEqual(overrides);
            expect(payload.update_with_pull_request).toBe(true);
        });

        it('alwaysCreatePullRequest defaults to false via `?? false` when undefined on schedule', async () => {
            const user = buildUser();
            const work = buildWork();
            const schedule = buildSchedule({
                user: user as any,
                work: work as any,
                alwaysCreatePullRequest: undefined as any,
            });

            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'X', prompt: 'p' },
                    initial_prompt: 'init',
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.runScheduledUpdate(schedule);

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.update_with_pull_request).toBe(false);
        });

        it('finalizes schedule as failed AND rethrows when an inner step throws', async () => {
            // markRunFailed is documented as idempotent so a duplicate
            // call from inside updateItemsGenerator is harmless. The
            // outer catch ensures the schedule does NOT linger in
            // GENERATING when a step before any inner finalization
            // throws (e.g. our own NotFoundException above).
            const schedule = buildSchedule({ user: undefined, userId: 'u-missing' });
            userRepository.findByIdForScheduledRun.mockResolvedValue(null);

            const service = buildService();
            await expect(service.runScheduledUpdate(schedule)).rejects.toThrow(
                'User not found for scheduled update',
            );
            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledTimes(1);
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  submitItem
    // ════════════════════════════════════════════════════════════════════
    describe('submitItem', () => {
        it('runs ensureCanEdit BEFORE itemSubmissionService.submitItem', async () => {
            const order: string[] = [];
            ownershipService.ensureCanEdit.mockImplementation(async () => {
                order.push('ensureCanEdit');
                return { work: buildWork() } as any;
            });
            itemSubmissionService.submitItem.mockImplementation(async () => {
                order.push('submitItem');
                return { status: 'success', auto_merged: false };
            });

            const service = buildService();
            await service.submitItem(
                'work-1',
                { name: 'New', source_url: 'https://x.com' } as any,
                buildUser(),
            );

            expect(order).toEqual(['ensureCanEdit', 'submitItem']);
        });

        it('success + pr_number → markdownGenerator.initialize w/ pr_update — does NOT recordActivityHistory', async () => {
            // The activity-history recording is reserved for the direct-
            // commit branch (no PR). PR-based submits get their history
            // entry at PR-merge time via a separate listener.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.submitItem.mockResolvedValue({
                status: 'success',
                auto_merged: false,
                pr_number: 42,
                pr_branch_name: 'submit/x',
                pr_title: 'Add x',
                pr_body: 'body',
                item_name: 'x',
                item_slug: 'x',
            });

            const service = buildService();
            await service.submitItem(
                'work-1',
                { name: 'x', source_url: 'https://x.com' } as any,
                buildUser(),
            );

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({
                    generation_method: GenerationMethod.CREATE_UPDATE,
                    pr_update: { branch: 'submit/x', title: 'Add x', body: 'body' },
                }),
            );
            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('auto_merged=true → generation_method=RECREATE (NOT CREATE_UPDATE)', async () => {
            // The auto-merge path bypasses PR review so the data repo is
            // already in sync — we use RECREATE to rebuild ALL markdown
            // including any cross-item references.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.submitItem.mockResolvedValue({
                status: 'success',
                auto_merged: true,
                item_name: 'x',
                item_slug: 'x',
            });

            const service = buildService();
            await service.submitItem(
                'work-1',
                { name: 'x', source_url: 'https://x.com' } as any,
                buildUser(),
            );

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ generation_method: GenerationMethod.RECREATE }),
            );
        });

        it('success + no pr_number → recordActivityHistory w/ ITEM_ADDED + summary "Item added: <name>"', async () => {
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            itemSubmissionService.submitItem.mockResolvedValue({
                status: 'success',
                auto_merged: false,
                item_name: 'New Item',
                item_slug: 'new-item',
                // pr_number omitted — direct-commit branch
            });

            const service = buildService();
            await service.submitItem(
                'work-1',
                { name: 'New Item', source_url: 'https://x.com' } as any,
                buildUser({ id: 'u-1' }),
            );

            expect(generationHistoryRepository.createEntry).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    userId: 'u-1',
                    activityType: WorkHistoryActivityType.ITEM_ADDED,
                    newItemsCount: 1,
                    triggeredBy: 'user',
                    durationInSeconds: 0,
                    status: GenerateStatusType.GENERATED,
                    changelog: expect.objectContaining({
                        summary: 'Item added: New Item',
                        addedCount: 1,
                        entries: [
                            {
                                entityType: 'item',
                                action: 'added',
                                name: 'New Item',
                                slug: 'new-item',
                            },
                        ],
                    }),
                }),
            );
        });

        it('skips activity history when item_name OR item_slug is missing on the success branch', async () => {
            // Defensive: legacy branches in itemSubmissionService can
            // return success WITHOUT name/slug (e.g. aborted commit
            // races). We must not write a half-baked changelog row.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.submitItem.mockResolvedValue({
                status: 'success',
                auto_merged: false,
                item_name: undefined,
                item_slug: 'x',
            });

            const service = buildService();
            await service.submitItem(
                'work-1',
                { name: 'x', source_url: 'https://x.com' } as any,
                buildUser(),
            );

            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('status=error → BadRequestException w/ normalized message in payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.submitItem.mockResolvedValue({
                status: 'error',
                message: 'duplicate slug',
            });

            const service = buildService();
            try {
                await service.submitItem(
                    'work-1',
                    { name: 'x', source_url: 'https://x.com' } as any,
                    buildUser(),
                );
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({ status: 'error', message: 'duplicate slug' }),
                );
            }
        });

        it('rethrows HttpException verbatim from inner pipeline', async () => {
            const err = new BadRequestException('boom');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(
                service.submitItem(
                    'work-1',
                    { name: 'x', source_url: 'https://x.com' } as any,
                    buildUser(),
                ),
            ).rejects.toBe(err);
        });

        it('catches generic Error and wraps w/ workId + item_name in BadRequestException payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.submitItem.mockRejectedValue(new Error('git push rejected'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.submitItem(
                    'work-1',
                    { name: 'x', source_url: 'https://x.com' } as any,
                    buildUser(),
                );
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        workId: 'work-1',
                        item_name: 'x',
                        message: 'git push rejected',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  removeItem
    // ════════════════════════════════════════════════════════════════════
    describe('removeItem', () => {
        it('success + no pr_number → recordActivityHistory w/ ITEM_REMOVED + summary "Item removed: <name>"', async () => {
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            itemSubmissionService.removeItem.mockResolvedValue({
                status: 'success',
                item_name: 'Old Item',
                item_slug: 'old-item',
            });

            const service = buildService();
            await service.removeItem(
                'work-1',
                { item_slug: 'old-item' } as any,
                buildUser({ id: 'u-1' }),
            );

            expect(generationHistoryRepository.createEntry).toHaveBeenCalledWith(
                expect.objectContaining({
                    workId: 'work-1',
                    userId: 'u-1',
                    activityType: WorkHistoryActivityType.ITEM_REMOVED,
                    triggeredBy: 'user',
                    changelog: expect.objectContaining({
                        summary: 'Item removed: Old Item',
                        removedCount: 1,
                        entries: [
                            {
                                entityType: 'item',
                                action: 'removed',
                                name: 'Old Item',
                                slug: 'old-item',
                            },
                        ],
                    }),
                }),
            );
        });

        it('success + pr_number set → no recordActivityHistory (PR-based removal)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.removeItem.mockResolvedValue({
                status: 'success',
                item_name: 'x',
                item_slug: 'x',
                pr_number: 99,
            });

            const service = buildService();
            await service.removeItem('work-1', { item_slug: 'x' } as any, buildUser());
            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('forces final status:"success" on the resolved envelope (overrides upstream)', async () => {
            // Pinned current behaviour: the source spreads `result` then
            // hard-codes `status: 'success'`. Any future swap to
            // preserve upstream status would silently let `'partial'`
            // (or other future values) leak — break loudly here.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.removeItem.mockResolvedValue({
                status: 'success',
                item_name: 'x',
                item_slug: 'x',
                pr_number: 1,
                extraField: 'preserved',
            });

            const service = buildService();
            const result = await service.removeItem(
                'work-1',
                { item_slug: 'x' } as any,
                buildUser(),
            );
            expect(result).toEqual(
                expect.objectContaining({ status: 'success', extraField: 'preserved' }),
            );
        });

        it('status=error → BadRequestException w/ normalized message', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.removeItem.mockResolvedValue({
                status: 'error',
                message: 'item locked',
            });

            const service = buildService();
            await expect(
                service.removeItem('work-1', { item_slug: 'x' } as any, buildUser()),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('catches generic Error and wraps w/ slug + item_slug in payload', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.removeItem.mockRejectedValue(new Error('git rejected'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.removeItem('work-1', { item_slug: 'x' } as any, buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        slug: 'work-1',
                        item_slug: 'x',
                        message: 'git rejected',
                    }),
                );
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  updateItemMetadata
    // ════════════════════════════════════════════════════════════════════
    describe('updateItemMetadata', () => {
        it('success + no pr_number → recordActivityHistory w/ ITEM_UPDATED, fieldsChanged whitelist', async () => {
            // The whitelist is exactly featured/order/source_url —
            // pinned via the `dto.X !== undefined` guards in source.
            // A future addition that smuggles arbitrary dto fields in
            // would change the activity-log shape that the UI depends on.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockResolvedValue({
                status: 'success',
                item_name: 'X',
                item_slug: 'x',
            });

            const service = buildService();
            await service.updateItemMetadata(
                'work-1',
                {
                    item_slug: 'x',
                    featured: true,
                    order: 5,
                    extra: 'should-be-ignored',
                } as any,
                buildUser({ id: 'u-1' }),
            );

            expect(generationHistoryRepository.createEntry).toHaveBeenCalledWith(
                expect.objectContaining({
                    activityType: WorkHistoryActivityType.ITEM_UPDATED,
                    updatedItemsCount: 1,
                    changelog: expect.objectContaining({
                        summary: 'Item updated: X',
                        entries: [
                            expect.objectContaining({
                                entityType: 'item',
                                action: 'updated',
                                name: 'X',
                                slug: 'x',
                                fieldsChanged: ['featured', 'order'],
                            }),
                        ],
                    }),
                }),
            );
        });

        it('omits fields from fieldsChanged when undefined on dto (PATCH semantics)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockResolvedValue({
                status: 'success',
                item_name: 'X',
                item_slug: 'x',
            });

            const service = buildService();
            await service.updateItemMetadata(
                'work-1',
                { item_slug: 'x', source_url: 'https://x.com' } as any,
                buildUser(),
            );

            const [[entry]] = generationHistoryRepository.createEntry.mock.calls;
            expect(entry.changelog.entries[0].fieldsChanged).toEqual(['source_url']);
        });

        it('runs markdownGenerator.initialize w/ CREATE_UPDATE on success', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockResolvedValue({
                status: 'success',
                item_name: 'X',
                item_slug: 'x',
            });

            const service = buildService();
            await service.updateItemMetadata('work-1', { item_slug: 'x' } as any, buildUser());

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                { generation_method: GenerationMethod.CREATE_UPDATE },
            );
        });

        it('success + pr_number set → no recordActivityHistory (PR-based update)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockResolvedValue({
                status: 'success',
                item_name: 'X',
                item_slug: 'x',
                pr_number: 7,
            });

            const service = buildService();
            await service.updateItemMetadata('work-1', { item_slug: 'x' } as any, buildUser());

            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('status=error → BadRequestException w/ normalized message', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockResolvedValue({
                status: 'error',
                message: 'invalid url',
            });

            const service = buildService();
            await expect(
                service.updateItemMetadata('work-1', { item_slug: 'x' } as any, buildUser()),
            ).rejects.toBeInstanceOf(BadRequestException);
        });

        it('catches generic Error and wraps w/ slug only (NOT item_slug — pinned)', async () => {
            // Asymmetry pin vs. removeItem: the update-error envelope
            // does NOT include item_slug because the surface point is
            // metadata-only (different UI badge). A future symmetry
            // refactor would change client expectations.
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            itemSubmissionService.updateItem.mockRejectedValue(new Error('boom'));
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.updateItemMetadata('work-1', { item_slug: 'x' } as any, buildUser());
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual({
                    status: 'error',
                    slug: 'work-1',
                    message: 'boom',
                });
            }
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  generateItems (smoke + ConflictException + scope)
    // ════════════════════════════════════════════════════════════════════
    describe('generateItems', () => {
        it('throws ConflictException when work is already in GENERATING status — does NOT create history', async () => {
            // Pinned: ensureNotAlreadyGenerating is the documented
            // race-prevention guard. A second concurrent request from the
            // SAME user would otherwise blow up at the data-repo layer
            // (two clones of the same dest dir). Better to fail fast.
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);

            const service = buildService();
            await expect(
                service.generateItems('work-1', { name: 'X', prompt: 'p' } as any, buildUser()),
            ).rejects.toBeInstanceOf(ConflictException);
            expect(generationHistoryRepository.createEntry).not.toHaveBeenCalled();
        });

        it('returns "pending" envelope w/ historyId + slug + parameters when awaitCompletion=false', async () => {
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            const dto = { name: 'X', prompt: 'p' } as any;
            const result = await service.generateItems('work-1', dto, buildUser(), false);

            expect(result).toEqual({
                status: 'pending',
                slug: 'best-tools',
                parameters: dto,
                message: "Processing request for 'X'. Check logs or data work for updates.",
                historyId: 'h-1',
            });
        });

        it('passes positional (workId, userId) to ensureCanEdit', async () => {
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.generateItems(
                'work-1',
                { name: 'X', prompt: 'p' } as any,
                buildUser({ id: 'u-99' }),
                false,
            );

            expect(ownershipService.ensureCanEdit).toHaveBeenCalledWith('work-1', 'u-99');
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  updateItemsGenerator (BadRequest on missing config, schedule-skip path)
    // ════════════════════════════════════════════════════════════════════
    describe('updateItemsGenerator', () => {
        it('returns "skipped" envelope when scheduled run hits a GENERATING work — finalizes schedule', async () => {
            // Schedule-aware skip: the cron path MUST NOT 409 because
            // a queue-driven retry would burn entitlement quota for a
            // run that didn't happen. Instead, finalize as 'skipped'.
            const work = buildWork({
                generateStatus: { status: GenerateStatusType.GENERATING } as any,
            });
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);

            const service = buildService();
            const result = await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: {} as any,
                user: buildUser(),
                awaitCompletion: false,
                context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            });

            expect(result).toEqual(
                expect.objectContaining({
                    slug: 'best-tools',
                    status: 'skipped',
                    message: 'Skipped — work already generating',
                }),
            );
            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('sched-1', {
                status: 'skipped',
                reason: 'Work already has a generation in progress',
            });
        });

        it('throws BadRequestException w/ documented copy when last_request_data missing', async () => {
            // The "Configuration invalid" copy is user-facing — pinned
            // because a future refactor that changes the message would
            // surface a generic "BadRequest" in the UI rather than the
            // actionable "Please run a manual generation first." prompt.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({ metadata: {} });
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.updateItemsGenerator({
                    workId: 'work-1',
                    updateDto: {} as any,
                    user: buildUser(),
                });
                throw new Error('should not reach');
            } catch (error: any) {
                expect(error).toBeInstanceOf(BadRequestException);
                expect(error.getResponse()).toEqual(
                    expect.objectContaining({
                        status: 'error',
                        slug: 'best-tools',
                        message:
                            'Configuration invalid or missing. Please run a manual generation first.',
                    }),
                );
            }
        });

        it('on missing-config + scheduled trigger → finalizes AND pauses the schedule', async () => {
            // The pause is critical — without it, the next cron tick
            // would just re-fail-and-finalize on the same broken config,
            // burning entitlement quota indefinitely.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({ metadata: {} });
            warnSpy = jest.spyOn(console, 'error').mockImplementation(() => {});

            const service = buildService();
            try {
                await service.updateItemsGenerator({
                    workId: 'work-1',
                    updateDto: {} as any,
                    user: buildUser(),
                    context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
                });
            } catch {
                /* expected */
            }

            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('sched-1', {
                status: 'failed',
                reason: 'Invalid configuration (stale data). Please run a manual generation to fix.',
            });
            expect(workScheduleService.pauseSchedule).toHaveBeenCalledWith('sched-1');
        });

        it('uses initial_prompt instead of last_request_data.prompt for scheduled runs', async () => {
            // Pinned: scheduled runs MUST use the initial prompt because
            // the user might have adjusted last_request_data.prompt to
            // a one-off variant (e.g. for a manual single-run debug). A
            // future swap that always uses last_request_data.prompt would
            // produce wildly inconsistent scheduled output.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    initial_prompt: 'INITIAL',
                    last_request_data: { name: 'X', prompt: 'one-off' },
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: {} as any,
                user: buildUser(),
                awaitCompletion: false,
                context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            });

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.prompt).toBe('INITIAL');
        });

        it('falls back to last_request_data.prompt via `??` when initial_prompt is missing', async () => {
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    last_request_data: { name: 'X', prompt: 'fallback' },
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: {} as any,
                user: buildUser(),
                awaitCompletion: false,
            });

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.prompt).toBe('fallback');
        });

        it('forces per-run defaults (CREATE_UPDATE + update_with_pull_request:true) over last-request-data', async () => {
            // Pinned: a previous manual RECREATE run would otherwise
            // poison every subsequent scheduled run, causing the data
            // repo to be torn down and rebuilt every interval. The
            // perRunDefaults reset is the ONLY safety here.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    initial_prompt: 'init',
                    last_request_data: {
                        name: 'X',
                        prompt: 'p',
                        generation_method: GenerationMethod.RECREATE,
                        update_with_pull_request: false,
                    },
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: {} as any,
                user: buildUser(),
                awaitCompletion: false,
            });

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.generation_method).toBe(GenerationMethod.CREATE_UPDATE);
            expect(payload.update_with_pull_request).toBe(true);
        });

        it('deep-merges providers — overrides win per-field, unset fields inherit from last run', async () => {
            // Pinned: a flat spread (`...lastRequestData, ...updateDto`)
            // would replace the entire providers object on every update.
            // The deep merge is what lets a user toggle ONE provider
            // without resetting the rest.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    initial_prompt: 'init',
                    last_request_data: {
                        name: 'X',
                        prompt: 'p',
                        providers: { ai: 'openai', search: 'tavily' },
                    },
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: { providers: { ai: 'anthropic' } } as any,
                user: buildUser(),
                awaitCompletion: false,
            });

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.providers).toEqual({ ai: 'anthropic', search: 'tavily' });
        });

        it('overrides config caps (max_search_queries/results/pages + AI-first off) for scheduled runs', async () => {
            // Pinned: scheduled runs use trimmed caps to keep cost
            // predictable. A future swap to "use whatever the user set"
            // would let a manual --large run produce a very expensive
            // schedule trigger.
            const work = buildWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work } as any);
            dataGenerator.getConfig.mockResolvedValue({
                metadata: {
                    initial_prompt: 'init',
                    last_request_data: {
                        name: 'X',
                        prompt: 'p',
                        config: { max_search_queries: 999, ai_first_generation_enabled: true },
                    },
                },
            });
            generationHistoryRepository.createEntry.mockResolvedValue({
                id: 'h-1',
                startedAt: new Date(),
            } as any);
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            const service = buildService({ withDispatcher: true });
            await service.updateItemsGenerator({
                workId: 'work-1',
                updateDto: {} as any,
                user: buildUser(),
                awaitCompletion: false,
                context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            });

            const [{ dto: payload }] = generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.config).toEqual({
                max_search_queries: 10,
                max_results_per_query: 5,
                max_pages_to_process: 10,
                ai_first_generation_enabled: false,
            });
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  resolveGenerationFinalStatus (private helper, exercised via cast)
    // ════════════════════════════════════════════════════════════════════
    describe('resolveGenerationFinalStatus', () => {
        it('returns CANCELLED for a generation-cancelled error', () => {
            // Pinned: the cancellation branch must come BEFORE the
            // generic-error branch — a future swap would record a real
            // ERROR for a user-initiated cancel and trigger downstream
            // notifications that should not fire on cancellation.
            const service = buildService() as any;
            const cancelled = createGenerationCancelledError();
            expect(service.resolveGenerationFinalStatus(cancelled)).toBe(
                GenerateStatusType.CANCELLED,
            );
            expect(isGenerationCancelledError(cancelled)).toBe(true);
        });

        it('returns ERROR for any non-cancelled truthy error', () => {
            const service = buildService() as any;
            expect(service.resolveGenerationFinalStatus(new Error('boom'))).toBe(
                GenerateStatusType.ERROR,
            );
            // Non-Error truthy values still classify as ERROR (the helper
            // does not require an Error instance — pinned because callers
            // pass `unknown` from generic catch blocks).
            expect(service.resolveGenerationFinalStatus('boom')).toBe(GenerateStatusType.ERROR);
            expect(service.resolveGenerationFinalStatus({ message: 'boom' })).toBe(
                GenerateStatusType.ERROR,
            );
        });

        it('returns GENERATED when error is falsy', () => {
            const service = buildService() as any;
            expect(service.resolveGenerationFinalStatus(null)).toBe(GenerateStatusType.GENERATED);
            expect(service.resolveGenerationFinalStatus(undefined)).toBe(
                GenerateStatusType.GENERATED,
            );
            // Documented behaviour: 0 / '' are also "no error" because the
            // helper uses truthy-checks. Pinned so a future "must be Error
            // instance" tightening is a deliberate change.
            expect(service.resolveGenerationFinalStatus(0)).toBe(GenerateStatusType.GENERATED);
            expect(service.resolveGenerationFinalStatus('')).toBe(GenerateStatusType.GENERATED);
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  resolveGenerationErrorMessage (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('resolveGenerationErrorMessage', () => {
        it('returns undefined when error is falsy', () => {
            const service = buildService() as any;
            expect(service.resolveGenerationErrorMessage(null)).toBeUndefined();
            expect(service.resolveGenerationErrorMessage(undefined)).toBeUndefined();
            expect(service.resolveGenerationErrorMessage(0)).toBeUndefined();
            expect(service.resolveGenerationErrorMessage('')).toBeUndefined();
        });

        it('returns the GENERATION_CANCELLED constant for a cancelled error', () => {
            // Pinned: the cancelled branch must return the human-facing
            // constant verbatim (so the UI can show "Generation cancelled."
            // without translating an Error.message). A future "use the
            // Error.message directly" refactor would surface internal
            // wording instead.
            const service = buildService() as any;
            const cancelled = createGenerationCancelledError();
            expect(service.resolveGenerationErrorMessage(cancelled)).toBe(GENERATION_CANCELLED);
        });

        it('falls through to normalizeGeneratorError for other errors', () => {
            const service = buildService() as any;
            // normalizeGeneratorError converts "not found" into the
            // documented "Repository not found." copy — pinned because
            // the user-facing copy lives in the normaliser, not in the
            // service.
            expect(service.resolveGenerationErrorMessage(new Error('repository not found'))).toBe(
                'Repository not found. Please verify the repository exists and try again.',
            );
            // Generic message passes through verbatim.
            expect(service.resolveGenerationErrorMessage(new Error('boom'))).toBe('boom');
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  buildScheduleRunOutcome (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('buildScheduleRunOutcome', () => {
        it('returns {status: completed, historyId} when error is falsy', () => {
            const service = buildService() as any;
            expect(service.buildScheduleRunOutcome(null, 'h-1')).toEqual({
                status: 'completed',
                historyId: 'h-1',
            });
        });

        it('omits historyId when not provided on success', () => {
            // Pinned: the {historyId} field is optional. Generated outcome
            // must not carry an explicit `undefined` field — a downstream
            // consumer that does `if ('historyId' in outcome)` would
            // misread an explicit-undefined as "set but empty".
            const service = buildService() as any;
            const result = service.buildScheduleRunOutcome(null);
            expect(result).toEqual({ status: 'completed', historyId: undefined });
        });

        it('returns {status: failed, reason: GENERATION_CANCELLED} on a cancelled error', () => {
            const service = buildService() as any;
            const cancelled = createGenerationCancelledError();
            expect(service.buildScheduleRunOutcome(cancelled, 'h-1')).toEqual({
                status: 'failed',
                reason: GENERATION_CANCELLED,
            });
        });

        it('returns {status: failed, reason: <normalized>} on a generic error', () => {
            const service = buildService() as any;
            expect(service.buildScheduleRunOutcome(new Error('boom'), 'h-1')).toEqual({
                status: 'failed',
                reason: 'boom',
            });
        });

        it('drops historyId on a failed outcome (failure wins, no historyId leak)', () => {
            // Pinned: when the schedule run failed, the outcome envelope
            // is `{status:'failed', reason}` — the historyId arg is
            // intentionally NOT propagated because it would mislead a
            // consumer into treating the failed run as a successful one
            // they could resume.
            const service = buildService() as any;
            const result = service.buildScheduleRunOutcome(new Error('boom'), 'h-1');
            expect(result).not.toHaveProperty('historyId');
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  isNonFatalWebsiteGenerationError (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('isNonFatalWebsiteGenerationError', () => {
        it('returns false when no items were generated', () => {
            // Pinned: with zero new+updated items, a website-gen failure
            // is fatal — there is nothing to publish, so we surface the
            // error. A future "always swallow website failures" refactor
            // would mask real config issues during a brand-new work setup.
            const service = buildService() as any;
            expect(
                service.isNonFatalWebsiteGenerationError(new Error('repository not found'), 0, 0),
            ).toBe(false);
        });

        it('returns false when items exist but error is not "repository not found"', () => {
            const service = buildService() as any;
            expect(service.isNonFatalWebsiteGenerationError(new Error('boom'), 1, 0)).toBe(false);
        });

        it('returns true when items exist AND error is "repository not found"', () => {
            // Documented behaviour: data-gen succeeded (items exist) but
            // the website repo is missing — we attach the warning rather
            // than failing the whole pipeline so the user can still see
            // their data-side progress.
            const service = buildService() as any;
            expect(
                service.isNonFatalWebsiteGenerationError(new Error('Repository not found'), 1, 0),
            ).toBe(true);
            expect(
                service.isNonFatalWebsiteGenerationError(new Error('repository not found'), 0, 1),
            ).toBe(true);
        });

        it('matches via normalizeGeneratorError (which lower-cases)', () => {
            // Pinned: the helper lowercases AFTER normaliser runs, so
            // mixed-case "Repository Not Found" still matches. Without
            // this the case-sensitivity of upstream Git error messages
            // would silently flip the branch.
            const service = buildService() as any;
            expect(
                service.isNonFatalWebsiteGenerationError(new Error('Repository Not Found'), 1, 1),
            ).toBe(true);
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  markGenerationStarted (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('markGenerationStarted', () => {
        it('records start time + sets GENERATING in parallel without touching history', async () => {
            // Pinned: when `history` is undefined (legacy path / direct
            // generation w/o history record), only the work-side updates
            // run. A future "always require history" tightening would
            // break the legacy direct-generation path silently.
            const service = buildService() as any;
            const startTime = new Date('2026-01-01T00:00:00.000Z');
            await service.markGenerationStarted('work-1', startTime);

            expect(workRepository.recordGenerationStartTime).toHaveBeenCalledWith(
                'work-1',
                startTime,
            );
            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith('work-1', {
                status: GenerateStatusType.GENERATING,
            });
            expect(generationHistoryRepository.updateEntry).not.toHaveBeenCalled();
        });

        it('also marks the history entry GENERATING when history is provided', async () => {
            const service = buildService() as any;
            const startTime = new Date('2026-01-01T00:00:00.000Z');
            const history = { id: 'h-1' } as any;
            await service.markGenerationStarted('work-1', startTime, history);

            expect(generationHistoryRepository.updateEntry).toHaveBeenCalledWith('h-1', {
                startedAt: startTime,
                status: GenerateStatusType.GENERATING,
            });
        });

        it('runs work-side updates via Promise.all (one rejection rejects the call)', async () => {
            // Pinned via Promise.all rejection semantics: if either of
            // the two work-side updates throws, the helper rejects
            // (and the caller's try/catch can record the failure).
            const service = buildService() as any;
            workRepository.updateGenerateStatus.mockRejectedValueOnce(new Error('db down'));
            await expect(service.markGenerationStarted('work-1', new Date())).rejects.toThrow(
                'db down',
            );
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  finalizeCancelledGeneration (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('finalizeCancelledGeneration', () => {
        it('writes CANCELLED status + GENERATION_CANCELLED error and clears step', async () => {
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(buildWork());

            await service.finalizeCancelledGeneration('work-1');

            expect(workRepository.recordGenerationFinishTime).toHaveBeenCalledWith(
                'work-1',
                expect.any(Date),
            );
            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith('work-1', {
                status: GenerateStatusType.CANCELLED,
                error: GENERATION_CANCELLED,
                step: null,
            });
        });

        it('updates history entry with CANCELLED + duration when history is provided', async () => {
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(buildWork());
            const startedAt = new Date(Date.now() - 5000);
            const history = { id: 'h-1', startedAt } as any;

            await service.finalizeCancelledGeneration('work-1', history);

            const [historyId, payload] = generationHistoryRepository.updateEntry.mock.calls[0];
            expect(historyId).toBe('h-1');
            expect(payload).toMatchObject({
                status: GenerateStatusType.CANCELLED,
                errorMessage: GENERATION_CANCELLED,
            });
            expect(payload.finishedAt).toBeInstanceOf(Date);
            expect(typeof payload.durationInSeconds).toBe('number');
            expect(payload.durationInSeconds).toBeGreaterThanOrEqual(0);
        });

        it('falls back to finishedAt for startedAt when history.startedAt is missing', async () => {
            // Pinned: a partial history row (no startedAt) must not
            // produce a NaN duration — the fallback uses finishedAt so
            // the duration is exactly zero. A future "trust startedAt"
            // refactor would write NaN into the duration column.
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(buildWork());
            const history = { id: 'h-1' } as any; // startedAt undefined

            await service.finalizeCancelledGeneration('work-1', history);

            const [, payload] = generationHistoryRepository.updateEntry.mock.calls[0];
            expect(payload.durationInSeconds).toBe(0);
        });

        it('finalizes the schedule run with status=failed + GENERATION_CANCELLED reason when scheduleId is set', async () => {
            // Pinned: cancellation propagates to the schedule as a
            // failure (not a completion) so the cadence's failure
            // counter advances and pause-on-N-failures still works.
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(buildWork());

            await service.finalizeCancelledGeneration('work-1', undefined, 'sched-1');

            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('sched-1', {
                status: 'failed',
                reason: GENERATION_CANCELLED,
            });
        });

        it('does not touch the schedule when scheduleId is null/undefined', async () => {
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(buildWork());

            await service.finalizeCancelledGeneration('work-1', undefined, null);
            await service.finalizeCancelledGeneration('work-1', undefined, undefined);

            expect(workScheduleService.finalizeScheduleRun).not.toHaveBeenCalled();
        });

        it('emits WorkGenerationCompletedEvent with the refreshed work after finalisation', async () => {
            // Pinned: the event payload uses the freshly-refetched work
            // (so listeners see the CANCELLED status and downstream
            // observers don't replay stale GENERATING state). Pinned via
            // a `findById`-returns-distinct-instance assertion.
            const service = buildService() as any;
            const refreshed = buildWork({ id: 'work-1', name: 'After Cancel' });
            workRepository.findById.mockResolvedValue(refreshed);

            await service.finalizeCancelledGeneration('work-1');

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                'work.generation.completed',
                expect.objectContaining({ work: refreshed }),
            );
        });

        it('skips the event when the refreshed work is missing', async () => {
            // Pinned: a deleted-mid-cancel work must NOT emit the event
            // with a null payload — listeners that destructure
            // `event.work.X` would crash and crash the listener queue.
            const service = buildService() as any;
            workRepository.findById.mockResolvedValue(null);

            await service.finalizeCancelledGeneration('work-1');

            expect(eventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  handleErrorNotification (private helper)
    // ════════════════════════════════════════════════════════════════════
    describe('handleErrorNotification', () => {
        it('is a no-op when no NotificationService is wired', async () => {
            // Pinned: agent-package consumers can opt out of in-app
            // notifications by omitting the service from the DI graph.
            // A future "always required" tightening would break those
            // headless callers (CLI, internal-cli runs).
            const service = buildService({ withNotifications: false }) as any;
            await expect(
                service.handleErrorNotification(
                    new Error('insufficient_quota'),
                    buildUser(),
                    buildWork(),
                ),
            ).resolves.toBeUndefined();

            // None of the four notify methods were created (no service);
            // assert via `notificationService` mock that nothing fired.
            expect(notificationService.notifyAiCreditsDepleted).not.toHaveBeenCalled();
        });

        it('routes ai_credits classification to notifyAiCreditsDepleted', async () => {
            const service = buildService() as any;
            await service.handleErrorNotification(
                new Error('OpenAI insufficient_quota'),
                buildUser({ id: 'user-9' }),
                buildWork(),
            );

            expect(notificationService.notifyAiCreditsDepleted).toHaveBeenCalledWith(
                'user-9',
                'OpenAI',
                'OpenAI insufficient_quota',
            );
        });

        it('routes ai_provider classification to notifyAiProviderError', async () => {
            const service = buildService() as any;
            await service.handleErrorNotification(
                new Error('Anthropic invalid_api_key'),
                buildUser({ id: 'user-9' }),
                buildWork(),
            );

            expect(notificationService.notifyAiProviderError).toHaveBeenCalledWith(
                'user-9',
                'Anthropic',
                'Anthropic invalid_api_key',
            );
        });

        it('routes git_auth classification to notifyGitAuthExpired (provider only, no message)', async () => {
            // Pinned: git-auth notifications carry the provider but NOT
            // the raw error string — exposing the upstream error to the
            // user adds no value and can leak internal hostnames /
            // request IDs.
            const service = buildService() as any;
            await service.handleErrorNotification(
                new Error('GitHub token expired'),
                buildUser({ id: 'user-9' }),
                buildWork(),
            );

            expect(notificationService.notifyGitAuthExpired).toHaveBeenCalledWith(
                'user-9',
                'GitHub',
            );
        });

        it('routes account_level classification to notifyGenerationAccountError with workId+name', async () => {
            const service = buildService() as any;
            await service.handleErrorNotification(
                new Error('Subscription not configured'),
                buildUser({ id: 'user-9' }),
                buildWork({ id: 'w-9', name: 'My Site' }),
            );

            expect(notificationService.notifyGenerationAccountError).toHaveBeenCalledWith(
                'user-9',
                'w-9',
                'My Site',
                'Subscription not configured',
            );
        });

        it('does NOT notify on unknown classification', async () => {
            // Pinned: an "unknown" error must not page the user — random
            // pipeline crashes (e.g. Zod parse failure on AI output) are
            // for ops to investigate, not the end-user. A future
            // catch-all "tell the user something is wrong" refactor
            // would create alert noise.
            const service = buildService() as any;
            await service.handleErrorNotification(
                new Error('TypeError: Cannot read property foo of undefined'),
                buildUser(),
                buildWork(),
            );

            expect(notificationService.notifyAiCreditsDepleted).not.toHaveBeenCalled();
            expect(notificationService.notifyAiProviderError).not.toHaveBeenCalled();
            expect(notificationService.notifyGitAuthExpired).not.toHaveBeenCalled();
            expect(notificationService.notifyGenerationAccountError).not.toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  ensureProvidersEnabledForWork (private)
    // ════════════════════════════════════════════════════════════════════
    describe('ensureProvidersEnabledForWork', () => {
        it('is a no-op when providers is undefined', async () => {
            // Pinned: dto.providers is optional. A future "always send a
            // providers object" tightening would silently invoke the
            // per-provider loop with an empty literal — pin the bare-undefined
            // short-circuit so the early return remains.
            const service = buildService() as any;
            await service.ensureProvidersEnabledForWork(undefined, 'work-1', 'user-1');

            expect(pluginRegistryService.isPluginEnabledForScope).not.toHaveBeenCalled();
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('skips falsy provider entries (no pluginId set for that uiKey)', async () => {
            const service = buildService() as any;
            await service.ensureProvidersEnabledForWork(
                { search: undefined, ai: '', screenshot: null as unknown as string },
                'work-1',
                'user-1',
            );

            expect(pluginRegistryService.isPluginEnabledForScope).not.toHaveBeenCalled();
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
        });

        it('auto-enables a configured provider via enablePluginForWork with the resolved capability', async () => {
            // Pinned: capability resolution maps `ai` uiKey → `ai-provider`
            // capability via getCapabilityFromUIKey (NOT the literal uiKey).
            // A future "ship the uiKey straight through" refactor would
            // mis-tag enable rows in the plugin scope table.
            const service = buildService() as any;
            pluginRegistryService.isPluginEnabledForScope.mockResolvedValue(true);

            await service.ensureProvidersEnabledForWork({ ai: 'openai' }, 'work-1', 'user-1');

            expect(pluginRegistryService.isPluginEnabledForScope).toHaveBeenCalledWith(
                'openai',
                'work-1',
                'user-1',
            );
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'openai',
                'user-1',
                { activeCapability: 'ai-provider' },
            );
        });

        it('removes a disabled provider from the dto and warns (so pipeline falls back to default)', async () => {
            // Pinned: explicit-disable wins. If the plugin was disabled
            // for this work, do NOT re-enable it via enablePluginForWork —
            // just delete it from the request so the system default kicks in.
            // A future "always re-enable on generation" flip would defeat
            // the user's explicit disable.
            const service = buildService() as any;
            warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            pluginRegistryService.isPluginEnabledForScope.mockResolvedValue(false);

            const providers: any = { search: 'tavily' };
            await service.ensureProvidersEnabledForWork(providers, 'work-1', 'user-1');

            expect(providers.search).toBeUndefined();
            expect(pluginOperationsService.enablePluginForWork).not.toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('disabled for work'));
        });

        it('swallows enablePluginForWork failures silently (plugin may already be enabled)', async () => {
            // Pinned: agent-package consumers may pre-enable plugins via
            // a different code path; calling enable again can throw a
            // "duplicate row" error. The catch block must NOT propagate
            // that error — generation should proceed with the provider
            // already enabled.
            const service = buildService() as any;
            pluginRegistryService.isPluginEnabledForScope.mockResolvedValue(true);
            pluginOperationsService.enablePluginForWork.mockRejectedValue(
                new Error('already enabled'),
            );

            await expect(
                service.ensureProvidersEnabledForWork({ search: 'tavily' }, 'work-1', 'user-1'),
            ).resolves.toBeUndefined();
        });

        it('processes every selectable category (search/screenshot/ai/contentExtractor/pipeline) when set', async () => {
            // Pinned: every uiKey from SELECTABLE_PROVIDER_CATEGORIES is
            // walked. A future addition to that constant must show up
            // here — if a new category lands without test coverage,
            // rerunning the loop with all five present should still
            // succeed AND enable each one through the operations service.
            const service = buildService() as any;
            pluginRegistryService.isPluginEnabledForScope.mockResolvedValue(true);

            await service.ensureProvidersEnabledForWork(
                {
                    search: 'tavily',
                    screenshot: 'screenshotone',
                    ai: 'openai',
                    contentExtractor: 'firecrawl',
                    pipeline: 'standard-pipeline',
                },
                'work-1',
                'user-1',
            );

            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledTimes(5);
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'tavily',
                'user-1',
                { activeCapability: 'search' },
            );
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'screenshotone',
                'user-1',
                { activeCapability: 'screenshot' },
            );
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'openai',
                'user-1',
                { activeCapability: 'ai-provider' },
            );
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'firecrawl',
                'user-1',
                { activeCapability: 'content-extractor' },
            );
            expect(pluginOperationsService.enablePluginForWork).toHaveBeenCalledWith(
                'work-1',
                'standard-pipeline',
                'user-1',
                { activeCapability: 'pipeline' },
            );
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  prepareProviders (private)
    // ════════════════════════════════════════════════════════════════════
    describe('prepareProviders', () => {
        it('runs ensureProvidersEnabledForWork → validateSelectedProviders → validateFormSchemaPlugins → processFormConfig in order', async () => {
            // Pinned via shared `order` array w/ mockImplementation push.
            // A future swap (e.g. validate before ensure-enabled) would
            // run validation on a mid-mutation `dto.providers` and could
            // reject providers the auto-enable step would have just deleted.
            const order: string[] = [];
            pluginRegistryService.isPluginEnabledForScope.mockImplementation(async () => {
                order.push('isEnabled');
                return true;
            });
            generatorFormSchemaService.validateSelectedProviders.mockImplementation(async () => {
                order.push('validateSelectedProviders');
            });
            generatorFormSchemaService.validateFormSchemaPlugins.mockImplementation(async () => {
                order.push('validateFormSchemaPlugins');
            });
            generatorFormSchemaService.processFormConfig.mockImplementation(async () => {
                order.push('processFormConfig');
                return { config: undefined, pluginConfig: undefined };
            });

            const service = buildService() as any;
            const dto: any = {
                providers: { search: 'tavily' },
                pluginConfig: undefined,
            };

            await service.prepareProviders(dto, { workId: 'work-1', userId: 'user-1' });

            expect(order).toEqual([
                'isEnabled',
                'validateSelectedProviders',
                'validateFormSchemaPlugins',
                'processFormConfig',
            ]);
        });

        it('forwards processed config back into the dto (mutates pluginConfig + _processedPluginConfig)', async () => {
            // Pinned: prepareProviders mutates the input dto in place so
            // the caller's downstream pipeline sees the canonicalised
            // config. A future "return a new dto" refactor would silently
            // pass the un-processed config to the data generator.
            generatorFormSchemaService.processFormConfig.mockResolvedValue({
                config: { canonical: true },
                pluginConfig: { resolved: 'yes' },
            });

            const service = buildService() as any;
            const dto: any = { pluginConfig: { raw: true } };
            await service.prepareProviders(dto, { workId: 'work-1', userId: 'user-1' });

            expect(dto.pluginConfig).toEqual({ canonical: true });
            expect(dto._processedPluginConfig).toEqual({ resolved: 'yes' });
        });

        it('forwards (pipelineProviderId, originalPluginConfig, scopeOptions) positionally to processFormConfig', async () => {
            // Pinned: scopeOptions is the third positional arg, NOT spread
            // into the second. Mis-positioning would leak the dto's other
            // keys into pluginConfig and break form-config processing.
            const service = buildService() as any;
            const scope = { workId: 'work-1', userId: 'user-1' };
            const dto: any = {
                providers: { pipeline: 'standard-pipeline' },
                pluginConfig: { foo: 'bar' },
            };
            await service.prepareProviders(dto, scope);

            expect(generatorFormSchemaService.processFormConfig).toHaveBeenCalledWith(
                'standard-pipeline',
                { foo: 'bar' },
                scope,
            );
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  runInProcessGeneration (private)
    // ════════════════════════════════════════════════════════════════════
    describe('runInProcessGeneration', () => {
        it('returns normally when processGeneration succeeds', async () => {
            const service = buildService() as any;
            jest.spyOn(service, 'processGeneration').mockResolvedValue(undefined);

            await expect(
                service.runInProcessGeneration(buildWork(), buildUser(), {} as any),
            ).resolves.toBeUndefined();
        });

        it('rethrows HttpException unchanged so NestJS HTTP semantics are preserved', async () => {
            // Pinned: HttpException carries an HTTP status code that the
            // controller layer needs to map to a response. A future
            // "wrap everything in BadRequest" flip would collapse all
            // statuses to 400.
            const service = buildService() as any;
            const conflict = new ConflictException('already running');
            jest.spyOn(service, 'processGeneration').mockRejectedValue(conflict);

            await expect(
                service.runInProcessGeneration(buildWork(), buildUser(), {} as any),
            ).rejects.toBe(conflict);
        });

        it('wraps a non-HttpException in BadRequestException with {status:"error", slug, message}', async () => {
            // Pinned: arbitrary Error instances become a 400 with the
            // generator-shaped envelope so the API layer can return a
            // consistent error body. A future "rethrow original error"
            // flip would let internal stack traces leak through.
            const service = buildService() as any;
            const work = buildWork({ slug: 'best-tools' });
            jest.spyOn(service, 'processGeneration').mockRejectedValue(new Error('boom'));

            const promise = service.runInProcessGeneration(work, buildUser(), {} as any);
            await expect(promise).rejects.toBeInstanceOf(BadRequestException);
            await promise.catch((e: BadRequestException) => {
                const response = e.getResponse() as any;
                expect(response).toMatchObject({
                    status: 'error',
                    slug: 'best-tools',
                    message: expect.stringContaining('boom'),
                });
            });
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  finalizeGeneration (private)
    // ════════════════════════════════════════════════════════════════════
    describe('finalizeGeneration', () => {
        it('writes GENERATED status + clears step on success (no error / no warnings)', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(Date.now() - 1000),
                history: undefined,
                error: null,
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'user' },
            });

            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith('work-1', {
                status: GenerateStatusType.GENERATED,
                step: null,
                warnings: undefined,
            });
            expect(workRepository.recordGenerationFinishTime).toHaveBeenCalledWith(
                'work-1',
                expect.any(Date),
            );
        });

        it('writes ERROR status + error message + preserves step (no `step: null` clear) when error is present', async () => {
            // Pinned: on the error path, the step the pipeline crashed
            // on stays in place so the UI can surface "failed during X".
            // The conditional `step: null` only fires on the success
            // path. A future "always clear step" refactor would erase
            // the failure context.
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(Date.now() - 1000),
                history: undefined,
                error: new Error('pipeline crashed'),
                stats: null,
                warnings: ['some warning'],
                context: { triggeredBy: 'user' },
            });

            const [, payload] = workRepository.updateGenerateStatus.mock.calls[0];
            expect(payload).toMatchObject({
                status: GenerateStatusType.ERROR,
                error: expect.stringContaining('pipeline crashed'),
                warnings: ['some warning'],
            });
            expect(payload).not.toHaveProperty('step');
        });

        it('writes CANCELLED status + GENERATION_CANCELLED message on cancellation errors', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(Date.now() - 1000),
                history: undefined,
                error: createGenerationCancelledError(),
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'user' },
            });

            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith(
                'work-1',
                expect.objectContaining({
                    status: GenerateStatusType.CANCELLED,
                    error: GENERATION_CANCELLED,
                }),
            );
        });

        it('updates the history entry with terminal status + duration + warnings + stats when history is provided', async () => {
            const service = buildService() as any;
            const startTime = new Date(Date.now() - 5000);
            const history: any = { id: 'h-1' };
            const stats = {
                newItemsCount: 3,
                updatedItemsCount: 1,
                totalItemsCount: 10,
            };

            await service.finalizeGeneration({
                workId: 'work-1',
                startTime,
                history,
                error: null,
                stats,
                warnings: ['skipped foo'],
                context: { triggeredBy: 'user' },
            });

            const [historyId, payload] = generationHistoryRepository.updateEntry.mock.calls[0];
            expect(historyId).toBe('h-1');
            expect(payload).toMatchObject({
                status: GenerateStatusType.GENERATED,
                warnings: ['skipped foo'],
                newItemsCount: 3,
                updatedItemsCount: 1,
                totalItemsCount: 10,
            });
            expect(typeof payload.durationInSeconds).toBe('number');
            expect(payload.durationInSeconds).toBeGreaterThanOrEqual(0);
        });

        it('skips the history update when no history is provided', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(),
                history: undefined,
                error: null,
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'user' },
            });
            expect(generationHistoryRepository.updateEntry).not.toHaveBeenCalled();
        });

        it('finalizes the schedule run with status=completed + historyId on a successful schedule trigger', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(Date.now() - 1000),
                history: { id: 'h-1' } as any,
                error: null,
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            });

            expect(workScheduleService.finalizeScheduleRun).toHaveBeenCalledWith('sched-1', {
                status: 'completed',
                historyId: 'h-1',
            });
        });

        it('finalizes the schedule run with status=failed + reason on a failed schedule trigger', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(Date.now() - 1000),
                history: undefined,
                error: new Error('boom'),
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            });

            const [scheduleId, outcome] = workScheduleService.finalizeScheduleRun.mock.calls[0];
            expect(scheduleId).toBe('sched-1');
            expect(outcome).toMatchObject({ status: 'failed' });
            expect((outcome as any).reason).toContain('boom');
        });

        it('does not touch the schedule when triggeredBy=user (even with a scheduleId set)', async () => {
            // Pinned: only schedule-triggered runs report back to the
            // schedule. A user-triggered run with a stray scheduleId
            // (defensive coding) must NOT advance the schedule's
            // failure-counter or completion timestamp.
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(),
                history: undefined,
                error: null,
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'user', scheduleId: 'sched-1' },
            });
            expect(workScheduleService.finalizeScheduleRun).not.toHaveBeenCalled();
        });

        it('does not touch the schedule on a schedule trigger with NO scheduleId (resilience)', async () => {
            const service = buildService() as any;
            await service.finalizeGeneration({
                workId: 'work-1',
                startTime: new Date(),
                history: undefined,
                error: null,
                stats: null,
                warnings: undefined,
                context: { triggeredBy: 'schedule' },
            });
            expect(workScheduleService.finalizeScheduleRun).not.toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  executeGenerationPipeline (private)
    // ════════════════════════════════════════════════════════════════════
    describe('executeGenerationPipeline', () => {
        const buildAcc = () =>
            ({ stats: null, warnings: undefined }) as { stats: any; warnings?: string[] };

        beforeEach(() => {
            dataGenerator.initialize = jest.fn();
        });

        it('skips markdown + website when initialise returns success=true with zero items and no existing items', async () => {
            // Pinned: a no-op generation (no new + no updated + no
            // existing items) means the website repo has nothing to
            // render, so we skip the markdown + website steps entirely.
            // A future "always run markdown" tightening would crash on
            // the empty data set.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
                warnings: ['heads up'],
            });

            const acc = buildAcc();
            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                {} as any,
                { triggeredBy: 'user' },
                acc,
            );

            expect(acc.stats).toEqual({
                newItemsCount: 0,
                updatedItemsCount: 0,
                totalItemsCount: 0,
            });
            expect(acc.warnings).toEqual(['heads up']);
            expect(markdownGenerator.initialize).not.toHaveBeenCalled();
            expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        });

        it('runs markdown when newItemsCount > 0 and runs website when hasExistingItems OR newItemsCount > 0', async () => {
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 5, updatedItemsCount: 0, totalItemsCount: 5 },
                hasExistingItems: false,
                prUpdate: null,
            });

            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                { generation_method: GenerationMethod.CREATE_UPDATE } as any,
                { triggeredBy: 'user' },
                buildAcc(),
            );

            expect(markdownGenerator.initialize).toHaveBeenCalled();
            expect(websiteGenerator.initialize).toHaveBeenCalled();
        });

        it('runs website when hasExistingItems=true even if no new/updated items', async () => {
            // Pinned: re-running a website regenerate after a no-op data
            // generation (nothing new on the upstream source) must still
            // touch the website pipeline so the repo gets rebuilt with
            // any template/markdown changes.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: true,
                prUpdate: null,
            });

            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                {} as any,
                { triggeredBy: 'user' },
                buildAcc(),
            );

            expect(markdownGenerator.initialize).not.toHaveBeenCalled();
            expect(websiteGenerator.initialize).toHaveBeenCalled();
        });

        it('throws error.cause when initialise returns success=false with a cause', async () => {
            // Pinned: error.cause is the original Error from inside the
            // pipeline (with a real stack). A future "always synthesise
            // a fresh Error" refactor would lose the original stack and
            // make incidents harder to triage.
            const cause = new Error('clone failed');
            dataGenerator.initialize.mockResolvedValue({
                success: false,
                error: { code: 'CLONE_FAILED', message: 'cant clone', cause },
            });

            const service = buildService() as any;
            errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            await expect(
                service.executeGenerationPipeline(
                    buildWork(),
                    buildUser(),
                    {} as any,
                    { triggeredBy: 'user' },
                    buildAcc(),
                ),
            ).rejects.toBe(cause);
        });

        it('throws a fresh Error(message) when initialise fails without a cause', async () => {
            dataGenerator.initialize.mockResolvedValue({
                success: false,
                error: { code: 'GENERATION_FAILED', message: 'pipeline crashed' },
            });

            const service = buildService() as any;
            errorSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            await expect(
                service.executeGenerationPipeline(
                    buildWork(),
                    buildUser(),
                    {} as any,
                    { triggeredBy: 'user' },
                    buildAcc(),
                ),
            ).rejects.toThrow('pipeline crashed');
        });

        it('forwards tryResume=true to dataGenerator.initialize on a schedule trigger', async () => {
            // Pinned: schedule-triggered generations resume in-progress
            // pipelines (so a mid-run process restart picks back up).
            // User-triggered generations always start fresh — pinned via
            // `tryResume:false` on the user-trigger path below.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
            });

            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                {} as any,
                { triggeredBy: 'schedule', scheduleId: 'sched-1' },
                buildAcc(),
            );

            expect(dataGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ tryResume: true }),
            );
        });

        it('forwards tryResume=false to dataGenerator.initialize on a user trigger', async () => {
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
            });

            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                {} as any,
                { triggeredBy: 'user' },
                buildAcc(),
            );

            expect(dataGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ tryResume: false }),
            );
        });

        it('forwards generated.prUpdate into markdownGenerator.initialize', async () => {
            const prUpdate = { number: 42 } as any;
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 1, updatedItemsCount: 0, totalItemsCount: 1 },
                hasExistingItems: false,
                prUpdate,
            });

            const service = buildService() as any;
            await service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                { generation_method: GenerationMethod.CREATE_UPDATE } as any,
                { triggeredBy: 'user' },
                buildAcc(),
            );

            expect(markdownGenerator.initialize).toHaveBeenCalledWith(
                expect.anything(),
                expect.anything(),
                expect.objectContaining({ pr_update: prUpdate }),
            );
        });

        it('swallows a "repository not found" website failure into a warning when items are present', async () => {
            // Pinned by isNonFatalWebsiteGenerationError: a missing
            // website repo on a successful data generation is recoverable
            // (the user can configure the repo afterwards). A future
            // "all website failures are fatal" tightening would crash the
            // generation after the data was already pushed.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 1, updatedItemsCount: 0, totalItemsCount: 1 },
                hasExistingItems: false,
                prUpdate: null,
            });
            websiteGenerator.initialize.mockRejectedValue(new Error('Repository not found'));

            const acc = buildAcc();
            const service = buildService() as any;
            warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});
            await expect(
                service.executeGenerationPipeline(
                    buildWork(),
                    buildUser(),
                    {} as any,
                    { triggeredBy: 'user' },
                    acc,
                ),
            ).resolves.toBeUndefined();

            expect(acc.warnings).toEqual(
                expect.arrayContaining([
                    expect.stringContaining('Website repository setup skipped'),
                ]),
            );
            expect(warnSpy).toHaveBeenCalled();
        });

        it('rethrows non-recoverable website failures', async () => {
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 1, updatedItemsCount: 0, totalItemsCount: 1 },
                hasExistingItems: false,
                prUpdate: null,
            });
            websiteGenerator.initialize.mockRejectedValue(new Error('Permission denied'));

            const service = buildService() as any;
            await expect(
                service.executeGenerationPipeline(
                    buildWork(),
                    buildUser(),
                    {} as any,
                    { triggeredBy: 'user' },
                    buildAcc(),
                ),
            ).rejects.toThrow('Permission denied');
        });

        it('aborts the pipeline before the markdown step when the abort signal is already aborted', async () => {
            // Pinned: throwIfGenerationCancelled fires AFTER data
            // generation but BEFORE markdown. A future "skip the
            // mid-pipeline cancel check" refactor would let the markdown
            // step run on cancelled work.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 5, updatedItemsCount: 0, totalItemsCount: 5 },
                hasExistingItems: false,
                prUpdate: null,
            });

            const controller = new AbortController();
            const service = buildService() as any;

            const promise = service.executeGenerationPipeline(
                buildWork(),
                buildUser(),
                {} as any,
                { triggeredBy: 'user' },
                buildAcc(),
                undefined,
                controller.signal,
            );

            controller.abort();
            await expect(promise).rejects.toThrow();
            // markdown must NOT have run because the cancel check fires first
            expect(markdownGenerator.initialize).not.toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  dispatchGenerationTask (private)
    // ════════════════════════════════════════════════════════════════════
    describe('dispatchGenerationTask', () => {
        it('marks the work GENERATING immediately for instant UI feedback (does not wait for Trigger.dev)', async () => {
            // Pinned: the user needs to see "Generating…" the moment they
            // press the button. A future "wait for trigger ack first"
            // refactor would leave the UI on the prior status until the
            // dispatch round-trips.
            const service = buildService({ withDispatcher: true }) as any;
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');

            await service.dispatchGenerationTask(
                'create',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: new Date('2026-01-01T00:00:00.000Z') } as any,
                { triggeredBy: 'user' },
            );

            expect(workRepository.recordGenerationStartTime).toHaveBeenCalledWith(
                'work-1',
                expect.any(Date),
            );
            expect(workRepository.updateGenerateStatus).toHaveBeenCalledWith('work-1', {
                status: GenerateStatusType.GENERATING,
            });
        });

        it('persists triggerRunId on the history entry when the dispatcher returns a run id', async () => {
            const service = buildService({ withDispatcher: true }) as any;
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-42');

            await service.dispatchGenerationTask(
                'update',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: new Date() } as any,
                { triggeredBy: 'user' },
            );

            expect(generationHistoryRepository.updateEntry).toHaveBeenCalledWith('h-1', {
                triggerRunId: 'run-42',
            });
        });

        it('builds the WorkGenerationPayload with mode + workId + userId + dto + historyId + triggerSource + scheduleId', async () => {
            const service = buildService({ withDispatcher: true }) as any;
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');
            const dto = { generation_method: GenerationMethod.CREATE_UPDATE } as any;

            await service.dispatchGenerationTask(
                'create',
                buildWork({ id: 'w-9' }),
                buildUser({ id: 'u-9' }),
                dto,
                'h-9',
                { id: 'h-9', startedAt: new Date('2026-01-01T00:00:00.000Z') } as any,
                { triggeredBy: 'schedule', scheduleId: 'sched-7' },
            );

            const payload = generationDispatcher.dispatchWorkGeneration.mock.calls[0][0];
            expect(payload).toMatchObject({
                workId: 'w-9',
                userId: 'u-9',
                mode: 'create',
                dto,
                historyId: 'h-9',
                triggerSource: 'schedule',
                scheduleId: 'sched-7',
            });
            expect(typeof payload.historyStartedAt).toBe('string'); // ISO
        });

        it('falls back to history.createdAt when history.startedAt is missing', async () => {
            const service = buildService({ withDispatcher: true }) as any;
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue('run-1');
            const createdAt = new Date('2025-12-31T00:00:00.000Z');

            await service.dispatchGenerationTask(
                'create',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: undefined, createdAt } as any,
                { triggeredBy: 'user' },
            );

            const payload = generationDispatcher.dispatchWorkGeneration.mock.calls[0][0];
            expect(payload.historyStartedAt).toBe(createdAt.toISOString());
        });

        it('falls back to in-process generation (await) when the dispatcher is unavailable on a schedule trigger', async () => {
            // Pinned: schedule-triggered fallbacks AWAIT processGeneration
            // so the cron loop runs sequentially (one work at a time).
            // Concurrent fallback runs would explode resource usage.
            const service = buildService({ withDispatcher: false }) as any;
            const processSpy = jest
                .spyOn(service, 'processGeneration')
                .mockResolvedValue(undefined);
            warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

            await service.dispatchGenerationTask(
                'create',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: new Date() } as any,
                { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            );

            expect(processSpy).toHaveBeenCalled();
            expect(warnSpy).toHaveBeenCalled();
        });

        it('falls back to fire-and-forget processGeneration on a user trigger when no dispatcher is wired', async () => {
            // Pinned: user-triggered fallbacks DON'T await — the API
            // controller has already returned to the user with the
            // GENERATING status. Awaiting here would block the request
            // for the duration of the entire pipeline.
            const service = buildService({ withDispatcher: false }) as any;
            let processResolve: () => void = () => {};
            const processPromise = new Promise<void>((resolve) => {
                processResolve = resolve;
            });
            const processSpy = jest
                .spyOn(service, 'processGeneration')
                .mockReturnValue(processPromise);
            warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

            await service.dispatchGenerationTask(
                'create',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: new Date() } as any,
                { triggeredBy: 'user' },
            );

            // dispatchGenerationTask returned WITHOUT awaiting processGeneration
            expect(processSpy).toHaveBeenCalled();
            processResolve();
            await processPromise;
        });

        it('falls back to fire-and-forget processGeneration when the dispatcher returns null', async () => {
            // Pinned: a dispatcher that resolved to null (e.g. trigger
            // disabled at runtime) is treated identically to "no
            // dispatcher wired" — fall back rather than fail.
            const service = buildService({ withDispatcher: true }) as any;
            generationDispatcher.dispatchWorkGeneration.mockResolvedValue(null);
            const processSpy = jest
                .spyOn(service, 'processGeneration')
                .mockResolvedValue(undefined);
            warnSpy = jest.spyOn(service['logger'], 'warn').mockImplementation(() => {});

            await service.dispatchGenerationTask(
                'create',
                buildWork(),
                buildUser(),
                {} as any,
                'h-1',
                { id: 'h-1', startedAt: new Date() } as any,
                { triggeredBy: 'schedule', scheduleId: 'sched-1' },
            );

            expect(processSpy).toHaveBeenCalled();
            // No history.triggerRunId update either, since dispatchedId was null
            expect(generationHistoryRepository.updateEntry).not.toHaveBeenCalled();
        });
    });

    // ════════════════════════════════════════════════════════════════════
    //  processGeneration (private)
    // ════════════════════════════════════════════════════════════════════
    describe('processGeneration', () => {
        beforeEach(() => {
            dataGenerator.initialize = jest.fn();
        });

        it('emits WorkGenerationCompletedEvent on the happy path with the refreshed work payload', async () => {
            // Pinned: the event payload always carries the post-finalisation
            // work (so listeners see the GENERATED status). A future "emit
            // the pre-pipeline work" refactor would replay stale state.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
            });
            const refreshed = buildWork({ name: 'Refreshed' });
            workRepository.findById.mockResolvedValue(refreshed);

            const service = buildService() as any;
            await service.processGeneration(buildWork(), buildUser(), {} as any);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                'work.generation.completed',
                expect.objectContaining({ work: refreshed }),
            );
        });

        it('emits with the original work as a fallback when refresh returns null (defence in depth)', async () => {
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
            });
            workRepository.findById.mockResolvedValue(null);

            const original = buildWork({ name: 'Original' });
            const service = buildService() as any;
            await service.processGeneration(original, buildUser(), {} as any);

            expect(eventEmitter.emit).toHaveBeenCalledWith(
                'work.generation.completed',
                expect.objectContaining({ work: original }),
            );
        });

        it('returns silently on a cancellation error (no notification, no rethrow, no error log)', async () => {
            // Pinned: cancellation is intentional, not exceptional. The
            // error-notification path must NOT fire, and the function
            // must not rethrow. A future "treat cancellation as failure"
            // flip would page the user with a generic "generation failed".
            const cancelled = createGenerationCancelledError();
            dataGenerator.initialize.mockRejectedValue(cancelled);
            workRepository.findById.mockResolvedValue(buildWork());

            const service = buildService() as any;
            const errSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});

            await expect(
                service.processGeneration(buildWork(), buildUser(), {} as any),
            ).resolves.toBeUndefined();

            expect(notificationService.notifyAiCreditsDepleted).not.toHaveBeenCalled();
            expect(notificationService.notifyAiProviderError).not.toHaveBeenCalled();
            expect(notificationService.notifyGitAuthExpired).not.toHaveBeenCalled();
            expect(notificationService.notifyGenerationAccountError).not.toHaveBeenCalled();
            // The cancellation path returns BEFORE the "Error during generation"
            // logger.error line, so it must NOT have fired.
            expect(errSpy).not.toHaveBeenCalledWith('Error during generation:', cancelled);
        });

        it('routes the error through handleErrorNotification on a real failure (and logs the error)', async () => {
            const failure = new Error('OpenAI insufficient_quota');
            dataGenerator.initialize.mockRejectedValue(failure);
            workRepository.findById.mockResolvedValue(buildWork());

            const service = buildService() as any;
            const errSpy = jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            await service.processGeneration(buildWork(), buildUser({ id: 'u-9' }), {} as any);

            expect(notificationService.notifyAiCreditsDepleted).toHaveBeenCalledWith(
                'u-9',
                'OpenAI',
                'OpenAI insufficient_quota',
            );
            expect(errSpy).toHaveBeenCalled();
        });

        it('rethrows an HttpException after notifying (so the API layer can map the status code)', async () => {
            const httpError = new BadRequestException('rate limited');
            dataGenerator.initialize.mockRejectedValue(httpError);
            workRepository.findById.mockResolvedValue(buildWork());

            const service = buildService() as any;
            jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            await expect(
                service.processGeneration(buildWork(), buildUser(), {} as any),
            ).rejects.toBe(httpError);
        });

        it('runs finalizeGeneration even when the pipeline throws (terminal-state guarantee)', async () => {
            // Pinned: finalize ALWAYS runs (it sits in `finally`). A
            // future "skip finalize on schedule failures" refactor would
            // leave the work stuck in GENERATING.
            dataGenerator.initialize.mockRejectedValue(new Error('boom'));
            workRepository.findById.mockResolvedValue(buildWork());

            const service = buildService() as any;
            jest.spyOn(service['logger'], 'error').mockImplementation(() => {});
            await service.processGeneration(buildWork(), buildUser(), {} as any);

            // The finalize step writes ERROR status — pin via that side effect.
            const calls = workRepository.updateGenerateStatus.mock.calls;
            const errorWrite = calls.find(
                ([, payload]: any[]) => payload?.status === GenerateStatusType.ERROR,
            );
            expect(errorWrite).toBeTruthy();
        });

        it('clears the abort controller from the in-memory map after processing', async () => {
            // Pinned: leaving stale controllers around would leak memory
            // on a long-lived process and would also let cancelGeneration
            // for a subsequent run fire on the wrong signal.
            dataGenerator.initialize.mockResolvedValue({
                success: true,
                stats: { newItemsCount: 0, updatedItemsCount: 0, totalItemsCount: 0 },
                hasExistingItems: false,
                prUpdate: null,
            });
            workRepository.findById.mockResolvedValue(buildWork());

            const service = buildService() as any;
            const work = buildWork({ id: 'work-9' });
            await service.processGeneration(work, buildUser(), {} as any);

            expect(service['generationAbortControllers'].has('work-9')).toBe(false);
        });
    });
});
