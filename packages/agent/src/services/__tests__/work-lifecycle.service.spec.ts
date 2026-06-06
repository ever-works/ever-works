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

const previousMinimalRepo = process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
// Concrete GitHub repo name — bulk rename incorrectly produced
// `work-web-template-minimal`; the real repo is
// https://github.com/ever-works/directory-web-minimal-template
process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = 'directory-web-minimal-template';

import { NotFoundException } from '@nestjs/common';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { GenerateStatusType } from '@src/entities/types';

describe('WorkLifecycleService', () => {
    const user = { id: 'user-1' } as any;

    let workRepository: any;
    let dataGenerator: any;
    let markdownGenerator: any;
    let websiteGenerator: any;
    let websiteUpdateService: any;
    let ownershipService: any;
    let organizationRepository: any;
    let deployFacade: any;
    let templateCatalogService: any;
    let websiteRepositoryState: any;
    let eventEmitter: any;
    let service: WorkLifecycleService;

    afterAll(() => {
        if (previousMinimalRepo === undefined) {
            delete process.env.WEBSITE_TEMPLATE_MINIMAL_REPO;
        } else {
            process.env.WEBSITE_TEMPLATE_MINIMAL_REPO = previousMinimalRepo;
        }
    });

    beforeEach(() => {
        workRepository = {
            create: jest.fn(),
            update: jest.fn().mockResolvedValue(undefined),
            updateGenerateStatus: jest.fn(),
            findById: jest.fn(),
        };
        dataGenerator = {
            getItems: jest.fn(),
            getDataSyncSnapshot: jest.fn(),
        };
        markdownGenerator = {
            removeRepository: jest.fn(),
        };
        websiteGenerator = {
            removeRepository: jest.fn(),
            initialize: jest.fn(),
        };
        websiteUpdateService = {
            updateRepository: jest.fn().mockResolvedValue({
                method: 'create-using-template',
                message: 'updated',
            }),
        };
        ownershipService = {
            ensureCanEdit: jest.fn(),
            ensureIsOwner: jest.fn(),
        };
        // EW-711 #27: org-KB enrollment tenant guard resolves the target org
        // before persisting a non-null organizationId. Default to no lookup;
        // tests that enroll into an org stub this explicitly.
        organizationRepository = {
            findById: jest.fn(),
        };
        deployFacade = {
            getAvailableProviders: jest.fn().mockReturnValue([]),
        };
        templateCatalogService = {
            getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
            getVisibleTemplateForUser: jest.fn().mockImplementation(async (_kind, templateId) => ({
                id: templateId,
            })),
        };
        websiteRepositoryState = {
            isInitialized: jest.fn().mockResolvedValue(false),
        };

        const userRepository = {
            findById: jest.fn().mockResolvedValue({ id: 'u1', onboardingState: null }),
        } as never;
        const everWorksDeployQuota = {
            assertWithinQuota: jest.fn().mockResolvedValue(undefined),
        } as never;
        // EW-614: WorkLifecycleService also depends on EverWorksGitProvider.
        // These tests don't exercise the EverWorks Git path; default the
        // mock to disabled so the createWork code-path skips it.
        const everWorksGit = {
            isEnabled: jest.fn().mockReturnValue(false),
            createRepository: jest.fn(),
        } as never;
        eventEmitter = {
            emit: jest.fn(),
        };
        // EW-617 G5: DNS provider mock — no-op by default so tests that
        // don't deploy to ever-works see no extra calls.
        const everWorksDns = {
            getProvider: jest.fn().mockReturnValue(null),
            ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
            removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
            ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
        } as never;
        // EW-617 G8: funnel emit sink — no-op stub.
        const funnel = { emit: jest.fn() } as never;

        service = new WorkLifecycleService(
            workRepository,
            userRepository,
            dataGenerator,
            markdownGenerator,
            websiteGenerator,
            websiteUpdateService,
            ownershipService,
            deployFacade,
            templateCatalogService,
            websiteRepositoryState,
            everWorksDeployQuota,
            everWorksGit,
            everWorksDns,
            funnel,
            eventEmitter as never,
            organizationRepository,
        );
    });

    it('does not clear generateStatus when sync finds zero items', async () => {
        const work = {
            id: 'dir-1',
            itemsCount: 12,
            generateStatus: {
                status: GenerateStatusType.GENERATED,
            },
            lastPullRequest: null,
            readmeConfig: {},
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        dataGenerator.getDataSyncSnapshot.mockResolvedValue({
            itemsCount: 0,
            prUpdate: null,
            readmeTemplate: null,
        });

        await service.syncFromDataRepository(work.id, user);

        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                itemsCount: 0,
            }),
        );
        expect(workRepository.update).not.toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                generateStatus: null,
            }),
        );
    });

    describe('updateWork — organizationId (EW-639 Phase 2/e)', () => {
        const baseWork = (overrides: Record<string, unknown> = {}) =>
            ({
                id: 'dir-1',
                name: 'Test Work',
                description: 'Test description',
                owner: 'ever-works',
                organization: false,
                organizationId: null,
                tenantId: 'tenant-a',
                readmeConfig: {},
                gitProvider: 'github',
                userId: user.id,
                website: 'https://example.com',
                websiteTemplateId: 'classic',
                getRepoOwner: jest.fn().mockReturnValue('ever-works'),
                getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
                ...overrides,
            }) as any;

        it('persists a non-null organizationId from the DTO (org in the same tenant)', async () => {
            const work = baseWork();
            ownershipService.ensureCanEdit.mockResolvedValue({ work });
            // EW-711 #27: enrolling into a non-null org now resolves the target
            // and requires a tenant match. A same-tenant org persists as before.
            organizationRepository.findById.mockResolvedValue({
                id: 'org-42',
                tenantId: 'tenant-a',
            });
            workRepository.update.mockResolvedValueOnce({ ...work, organizationId: 'org-42' });

            await service.updateWork(work.id, { organizationId: 'org-42' } as any, user);

            expect(organizationRepository.findById).toHaveBeenCalledWith('org-42');
            expect(workRepository.update).toHaveBeenCalledWith(
                work.id,
                expect.objectContaining({ organizationId: 'org-42' }),
            );
        });

        it('persists organizationId: null to clear the org membership', async () => {
            const work = baseWork({ organizationId: 'org-prior' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work });
            workRepository.update.mockResolvedValueOnce({ ...work, organizationId: null });

            await service.updateWork(work.id, { organizationId: null } as any, user);

            expect(workRepository.update).toHaveBeenCalledWith(
                work.id,
                expect.objectContaining({ organizationId: null }),
            );
        });

        it('leaves organizationId untouched when the DTO omits the field', async () => {
            const work = baseWork({ organizationId: 'org-prior' });
            ownershipService.ensureCanEdit.mockResolvedValue({ work });
            workRepository.update.mockResolvedValueOnce({ ...work });

            await service.updateWork(work.id, { name: 'renamed' } as any, user);

            const updateArg = workRepository.update.mock.calls[0][1];
            expect(updateArg).not.toHaveProperty('organizationId');
        });
    });

    it('rejects website template changes after website repository initialization', async () => {
        const work = {
            id: 'dir-1',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        await expect(
            service.updateWork(work.id, { websiteTemplateId: 'minimal' } as any, user),
        ).rejects.toThrow(
            'Website template cannot be changed after the website repository has been initialized.',
        );
    });

    it('returns a no-op switch mode when the selected template is already active', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        const result = await service.switchWebsiteTemplate(work.id, 'classic', user);

        expect(result.switchMode).toBe('no_change');
        expect(result.repositoryRecreated).toBe(false);
        expect(workRepository.update).not.toHaveBeenCalled();
        expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
    });

    it('resets the website repository from the selected template after initialization', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);

        const result = await service.switchWebsiteTemplate(work.id, 'minimal', user);

        expect(workRepository.update).toHaveBeenCalledWith(
            work.id,
            expect.objectContaining({
                websiteTemplateId: 'minimal',
                websiteTemplateLastCommit: null,
                websiteTemplateLastError: null,
                websiteTemplateLastUpdatedAt: null,
                websiteTemplateLastCheckedAt: null,
            }),
        );
        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        expect(websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(result.repositoryRecreated).toBe(false);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_reset');
        expect(result.websiteTemplateId).toBe('minimal');
    });

    it('recreates the website repository only when the existing website repo is missing', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);
        websiteUpdateService.updateRepository.mockRejectedValueOnce(
            new NotFoundException(
                "Website repository 'ever-works/test-work-website' does not exist",
            ),
        );

        const result = await service.switchWebsiteTemplate(work.id, 'minimal', user);

        expect(websiteUpdateService.updateRepository).toHaveBeenCalledWith(work, user);
        expect(websiteGenerator.initialize).toHaveBeenCalledWith(
            work,
            user,
            'create-using-template',
        );
        expect(result.repositoryRecreated).toBe(true);
        expect(result.previousWebsiteTemplateId).toBe('classic');
        expect(result.switchMode).toBe('repository_recreated');
    });

    it('does not persist the template switch when updating the existing website repo fails', async () => {
        const work = {
            id: 'dir-1',
            slug: 'test-work',
            name: 'Test Work',
            description: 'Test description',
            owner: 'ever-works',
            organization: false,
            readmeConfig: {},
            gitProvider: 'github',
            userId: user.id,
            website: 'https://example.com',
            websiteTemplateId: 'classic',
            websiteTemplateLastCommit: 'abc123',
            websiteTemplateLastError: 'old error',
            websiteTemplateLastUpdatedAt: new Date(),
            websiteTemplateLastCheckedAt: new Date(),
            getRepoOwner: jest.fn().mockReturnValue('ever-works'),
            getWebsiteRepo: jest.fn().mockReturnValue('test-work-website'),
        } as any;

        ownershipService.ensureCanEdit.mockResolvedValue({ work });
        websiteRepositoryState.isInitialized.mockResolvedValue(true);
        websiteUpdateService.updateRepository.mockRejectedValueOnce(new Error('sync failed'));

        await expect(service.switchWebsiteTemplate(work.id, 'minimal', user)).rejects.toThrow(
            'sync failed',
        );

        expect(workRepository.update).not.toHaveBeenCalled();
        expect(websiteGenerator.initialize).not.toHaveBeenCalled();
        expect(work.websiteTemplateId).toBe('classic');
        expect(work.websiteTemplateLastCommit).toBe('abc123');
        expect(work.websiteTemplateLastError).toBe('old error');
    });

    describe('transitionStatus (EW-665 Phase 13)', () => {
        it('updates status, saves, and emits work.status.changed with the right payload', async () => {
            const work = { id: 'w-1', userId: 'u1', kind: 'company', status: 'draft' } as any;
            workRepository.findById.mockResolvedValue(work);
            workRepository.update.mockResolvedValue({ ...work, status: 'registered' });

            const result = await service.transitionStatus('w-1', 'registered');

            expect(workRepository.update).toHaveBeenCalledWith('w-1', { status: 'registered' });
            expect(eventEmitter.emit).toHaveBeenCalledTimes(1);
            const [eventName, payload] = eventEmitter.emit.mock.calls[0];
            expect(eventName).toBe('work.status.changed');
            expect(payload).toMatchObject({
                workId: 'w-1',
                userId: 'u1',
                kind: 'company',
                previousStatus: 'draft',
                newStatus: 'registered',
            });
            expect(result.status).toBe('registered');
        });

        it('is a no-op (no update, no emit) when the status is unchanged', async () => {
            const work = { id: 'w-1', userId: 'u1', kind: 'company', status: 'registered' } as any;
            workRepository.findById.mockResolvedValue(work);

            const result = await service.transitionStatus('w-1', 'registered');

            expect(workRepository.update).not.toHaveBeenCalled();
            expect(eventEmitter.emit).not.toHaveBeenCalled();
            expect(result).toBe(work);
        });

        it('defaults kind to "default" in the payload when the Work has none', async () => {
            const work = { id: 'w-2', userId: 'u1', status: 'active' } as any;
            workRepository.findById.mockResolvedValue(work);
            workRepository.update.mockResolvedValue({ ...work, status: 'archived' });

            await service.transitionStatus('w-2', 'archived');

            const [, payload] = eventEmitter.emit.mock.calls[0];
            expect(payload).toMatchObject({ kind: 'default', newStatus: 'archived' });
        });

        it('throws NotFoundException when the Work does not exist', async () => {
            workRepository.findById.mockResolvedValue(null);
            await expect(service.transitionStatus('missing', 'registered')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(eventEmitter.emit).not.toHaveBeenCalled();
        });
    });

    describe('createCompanyWork (EW-665 Phase 13)', () => {
        it('persists a kind=company Work with the chosen status, no repo side-effects', async () => {
            const persisted = {
                id: 'w-9',
                kind: 'company',
                status: 'draft',
                name: 'Acme',
            } as any;
            workRepository.create.mockResolvedValue(persisted);

            const result = await service.createCompanyWork(user, {
                name: 'Acme',
                slug: 'acme-abc',
                companyName: 'Acme Inc.',
                status: 'draft',
            });

            expect(workRepository.create).toHaveBeenCalledTimes(1);
            const [dto] = workRepository.create.mock.calls[0];
            expect(dto).toMatchObject({
                kind: 'company',
                status: 'draft',
                slug: 'acme-abc',
                name: 'Acme',
                companyName: 'Acme Inc.',
                userId: user.id,
            });
            // EW-665: deployProvider must be null so the Ever Works
            // Deploy quota counter (WHERE deployProvider = 'ever-works')
            // never counts a registration-only Company Work. (Codex P2.)
            expect(dto.deployProvider).toBeNull();
            // No generator/git side-effects for a registration record.
            expect(dataGenerator.getItems).not.toHaveBeenCalled();
            expect(result).toBe(persisted);
        });

        it('defaults status to draft when omitted', async () => {
            workRepository.create.mockResolvedValue({ id: 'w-10' } as any);

            await service.createCompanyWork(user, { name: 'Globex', slug: 'globex-1' });

            const [dto] = workRepository.create.mock.calls[0];
            expect(dto.status).toBe('draft');
            expect(dto.kind).toBe('company');
        });
    });
});
