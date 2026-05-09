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
import {
    createGenerationCancelledError,
    isGenerationCancelledError,
} from '@src/utils';
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
            await expect(
                service.updateDomainType('work-1', 'tools', buildUser()),
            ).rejects.toBe(err);
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
            await expect(
                service.regenerateMarkdown('work-1', buildUser()),
            ).rejects.toBe(err);
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
                    expect.objectContaining({ status: 'error', id: 'work-1', message: 'disk full' }),
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
                    expect.objectContaining({ status: 'error', workId: 'work-1', message: 'disk full' }),
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
            websiteUpdateService.updateRepository.mockResolvedValue({ method: 'pull', message: 'ok' });

            const service = buildService();
            await service.updateWebsiteRepository('work-1', user);

            expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        });

        it('rethrows HttpException verbatim', async () => {
            const err = new BadRequestException('not allowed');
            ownershipService.ensureCanEdit.mockRejectedValue(err);
            const service = buildService();
            await expect(
                service.updateWebsiteRepository('work-1', buildUser()),
            ).rejects.toBe(err);
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
                    expect.objectContaining({ status: 'error', workId: 'work-1', message: 'clone failed' }),
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
            expect(prompt).toContain('Prefer matching one of these existing categories: tools, libs');
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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser({ id: 'caller' }),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

            expect(result.status).toBe('partial');
            expect(result.successCount).toBe(1);
            expect(result.errorCount).toBe(1);
            expect(result.results[0]).toEqual(
                expect.objectContaining({ itemSlug: 'a', primaryImage: null, error: 'upstream 5xx' }),
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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

            expect(result.results[0].error).toBe('Unknown error');
        });

        it('status = "error" when EVERY capture fails (successCount === 0 AND errorCount > 0)', async () => {
            ownershipService.ensureCanEdit.mockResolvedValue({ work: buildWork() } as any);
            dataGenerator.getItems.mockResolvedValue([
                { slug: 'a', name: 'A', source_url: 'https://a.com' },
            ]);
            screenshotFacade.capture.mockRejectedValue(new Error('failed'));

            const service = buildService();
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
            const result = await service.bulkCaptureImages(
                'work-1',
                { mode: 'all' },
                buildUser(),
            );

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
        it('uses schedule.user verbatim when present — does NOT call userRepository.findById', async () => {
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

            expect(userRepository.findById).not.toHaveBeenCalled();
            expect(workScheduleService.validateRunEntitlement).toHaveBeenCalledWith(schedule, user);
        });

        it('falls back to userRepository.findById when schedule.user is unset', async () => {
            const work = buildWork();
            const fetchedUser = buildUser({ id: 'u-1' });
            userRepository.findById.mockResolvedValue(fetchedUser);
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

            expect(userRepository.findById).toHaveBeenCalledWith('u-1');
        });

        it('throws NotFoundException when schedule.user is unset AND userRepository.findById returns null', async () => {
            userRepository.findById.mockResolvedValue(null);
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

            expect(result).toEqual(
                expect.objectContaining({ slug: 'work-99', status: 'skipped' }),
            );
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
            userRepository.findById.mockResolvedValue(null);

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
            await service.removeItem('work-1', { item_slug: 'old-item' } as any, buildUser({ id: 'u-1' }));

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
            expect(result).toEqual(expect.objectContaining({ status: 'success', extraField: 'preserved' }));
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
                await service.removeItem(
                    'work-1',
                    { item_slug: 'x' } as any,
                    buildUser(),
                );
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
            await service.updateItemMetadata(
                'work-1',
                { item_slug: 'x' } as any,
                buildUser(),
            );

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
            await service.updateItemMetadata(
                'work-1',
                { item_slug: 'x' } as any,
                buildUser(),
            );

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
                service.updateItemMetadata(
                    'work-1',
                    { item_slug: 'x' } as any,
                    buildUser(),
                ),
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
                await service.updateItemMetadata(
                    'work-1',
                    { item_slug: 'x' } as any,
                    buildUser(),
                );
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
                service.generateItems(
                    'work-1',
                    { name: 'X', prompt: 'p' } as any,
                    buildUser(),
                ),
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

            const [{ dto: payload }] =
                generationDispatcher.dispatchWorkGeneration.mock.calls[0];
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

            const [{ dto: payload }] =
                generationDispatcher.dispatchWorkGeneration.mock.calls[0];
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

            const [{ dto: payload }] =
                generationDispatcher.dispatchWorkGeneration.mock.calls[0];
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

            const [{ dto: payload }] =
                generationDispatcher.dispatchWorkGeneration.mock.calls[0];
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

            const [{ dto: payload }] =
                generationDispatcher.dispatchWorkGeneration.mock.calls[0];
            expect(payload.config).toEqual({
                max_search_queries: 10,
                max_results_per_query: 5,
                max_pages_to_process: 10,
                ai_first_generation_enabled: false,
            });
        });
    });
});
