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

import { BadRequestException } from '@nestjs/common';
import { WorkLifecycleService } from '../work-lifecycle.service';
import { CreateWorkDto } from '@src/dto/create-work.dto';
import type { User } from '@src/entities/user.entity';
import { TemplateCatalogService } from '@src/template-catalog/template-catalog.service';
import { WebsiteTemplateResolverService } from '@src/generators/website-generator/website-template-resolver.service';

/**
 * A RETIRED website-template row (templates-catalog FR-5 c: an App Blueprint
 * such as ever-works/cal-template that an earlier discovery saved as a
 * website template) stays active so the Works already on it keep resolving,
 * but no Work may newly select it. Greptile P1 #1 on
 * https://github.com/ever-works/ever-works/pull/2511: while the row was kept
 * for old Works, new Works could still pick it.
 *
 * Every Work-side write path that takes a website template id funnels through
 * `resolveValidatedWebsiteTemplateSelection`: create, the settings update, and
 * the template switch. Each refuses a retired row with a 400 that names it an
 * App Blueprint, EXCEPT when the id is the one the Work already has — a
 * settings save that re-sends the current id, or a no-op switch, is not a new
 * selection and must keep working for those Works.
 */

const user = { id: 'u-1', email: 'u@example.com' } as User;

const retiredCatalogItem = {
    id: 'cal-template',
    kind: 'website',
    sourceType: 'built_in',
    name: 'Cal Template',
    repositoryOwner: 'ever-works',
    repositoryName: 'cal-template',
    isActive: true,
    retiredReason: 'app_blueprint',
};

const listedCatalogItem = (id: string) => ({
    id,
    kind: 'website',
    sourceType: 'built_in',
    name: id,
    repositoryOwner: 'ever-works',
    repositoryName: `${id}-template`,
    isActive: true,
    retiredReason: null,
});

const blueprintRefusal = /"cal-template".*is an App Blueprint, not a website template/;

function makeService(work?: Record<string, unknown>) {
    const workRepo = {
        create: jest.fn(async (data: Record<string, unknown>) => ({
            id: (data.id as string) ?? 'w-1',
            ...data,
            getRepoOwner: () => (data.owner as string) ?? 'evereq',
        })),
        update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
            ...work,
            ...data,
        })),
        updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
        findRepositoryWorksWrapping: jest.fn().mockResolvedValue([]),
    };
    const userRepo = {
        findById: jest.fn().mockResolvedValue({ id: user.id, onboardingState: null }),
    };
    const templateCatalog = {
        getVisibleTemplateForUser: jest.fn(async (_kind: string, templateId: string) =>
            templateId === 'cal-template' ? retiredCatalogItem : listedCatalogItem(templateId),
        ),
        getDefaultTemplateIdForUser: jest.fn().mockResolvedValue(null),
    };
    const ownership = { ensureCanEdit: jest.fn().mockResolvedValue({ work }) };
    const websiteRepositoryState = { isInitialized: jest.fn().mockResolvedValue(false) };
    const websiteUpdateService = { updateRepository: jest.fn() };
    const websiteGenerator = { initialize: jest.fn() };

    const service = new WorkLifecycleService(
        workRepo as never,
        userRepo as never,
        { getItems: jest.fn().mockResolvedValue([]) } as never,
        {} as never,
        websiteGenerator as never,
        websiteUpdateService as never,
        ownership as never,
        {} as never,
        templateCatalog as never,
        websiteRepositoryState as never,
        { assertWithinQuota: jest.fn().mockResolvedValue(undefined) } as never,
        { isEnabled: jest.fn().mockReturnValue(false), createRepository: jest.fn() } as never,
        {
            getProvider: jest.fn().mockReturnValue(null),
            ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
            removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
            ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
        } as never,
        { emit: jest.fn() } as never,
        { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) } as never,
        {} as never,
        { hasRepositoryAccess: jest.fn().mockResolvedValue(true) } as never,
    );

    return { service, workRepo, templateCatalog, websiteUpdateService, websiteGenerator };
}

const existingWork = (websiteTemplateId: string | null) => ({
    id: 'w-1',
    slug: 'my-work',
    name: 'My Work',
    description: 'A description',
    owner: 'evereq',
    organization: false,
    readmeConfig: {},
    gitProvider: 'github',
    userId: user.id,
    websiteTemplateId,
    websiteTemplateLastCommit: null,
    websiteTemplateLastError: null,
    websiteTemplateLastUpdatedAt: null,
    websiteTemplateLastCheckedAt: null,
    getRepoOwner: jest.fn().mockReturnValue('evereq'),
    getWebsiteRepo: jest.fn().mockReturnValue('my-work-website'),
});

describe('WorkLifecycleService — a retired website template is never a new selection', () => {
    describe('createWork', () => {
        const dto = {
            slug: 'my-work',
            name: 'My Work',
            description: 'A description',
            organization: false,
            gitProvider: 'github',
        } as CreateWorkDto;

        it('refuses a retired row with a 400 that names it an App Blueprint, before persisting anything', async () => {
            const { service, workRepo } = makeService();

            const attempt = service.createWork({ ...dto, websiteTemplateId: 'cal-template' }, user);

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(blueprintRefusal);
            expect(workRepo.create).not.toHaveBeenCalled();
        });

        it('still accepts a listed website template', async () => {
            const { service, workRepo } = makeService();

            await service.createWork({ ...dto, websiteTemplateId: 'classic' }, user);

            expect(workRepo.create).toHaveBeenCalledTimes(1);
            expect(workRepo.create.mock.calls[0][0]).toEqual(
                expect.objectContaining({ websiteTemplateId: 'classic' }),
            );
        });
    });

    describe('switchWebsiteTemplate', () => {
        it('refuses switching a Work onto a retired row, and changes nothing', async () => {
            const work = existingWork('classic');
            const { service, workRepo, websiteUpdateService, websiteGenerator } = makeService(work);

            const attempt = service.switchWebsiteTemplate('w-1', 'cal-template', user);

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(blueprintRefusal);
            expect(workRepo.update).not.toHaveBeenCalled();
            expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
            expect(websiteGenerator.initialize).not.toHaveBeenCalled();
            expect(work.websiteTemplateId).toBe('classic');
        });

        it('lets a Work already on the retired row re-select it (no change)', async () => {
            const { service, workRepo } = makeService(existingWork('cal-template'));

            const result = await service.switchWebsiteTemplate('w-1', 'cal-template', user);

            expect(result.switchMode).toBe('no_change');
            expect(result.websiteTemplateId).toBe('cal-template');
            expect(workRepo.update).not.toHaveBeenCalled();
        });

        it('lets a Work on the retired row move to a listed website template', async () => {
            const { service, workRepo } = makeService(existingWork('cal-template'));

            const result = await service.switchWebsiteTemplate('w-1', 'classic', user);

            expect(result.websiteTemplateId).toBe('classic');
            expect(workRepo.update).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ websiteTemplateId: 'classic' }),
            );
        });
    });

    describe('updateWork', () => {
        it('refuses changing a Work to a retired row', async () => {
            const { service, workRepo } = makeService(existingWork('classic'));

            const attempt = service.updateWork(
                'w-1',
                { websiteTemplateId: 'cal-template' } as never,
                user,
            );

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(blueprintRefusal);
            expect(workRepo.update).not.toHaveBeenCalled();
        });

        it('accepts a settings save that re-sends the retired id the Work already has', async () => {
            const { service, workRepo } = makeService(existingWork('cal-template'));

            await service.updateWork(
                'w-1',
                { name: 'Renamed', websiteTemplateId: 'cal-template' } as never,
                user,
            );

            expect(workRepo.update).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ name: 'Renamed', websiteTemplateId: 'cal-template' }),
            );
        });
    });
});

/**
 * A retired row the user saved as their website DEFAULT while it was still
 * listed (templates-catalog FR-5 f). Review follow-up on
 * https://github.com/ever-works/ever-works/pull/2511: the selection guards
 * above only see a template id, but every Create-Work form starts on
 * "use my default" and sends none, and the switch and settings forms send
 * null for it. A Work storing null inherits the saved default, and the
 * resolver resolves a retired row, so those paths put NEW Works — and Works
 * newly choosing "use my default" — on the App Blueprint.
 *
 * Wired end to end: the real TemplateCatalogService and the real
 * WebsiteTemplateResolverService over one template store and one preference
 * store, so "the Work resolves to X" is what generation would actually use.
 */
describe('WorkLifecycleService — a retired saved default is never newly inherited', () => {
    const builtIn = (id: string, extra: Record<string, unknown> = {}) => ({
        id,
        kind: 'website',
        sourceType: 'built_in',
        ownerUserId: null,
        name: id,
        description: `${id} template`,
        framework: null,
        previewImageUrl: null,
        repositoryUrl: `https://github.com/ever-works/${id}-template`,
        repositoryOwner: 'ever-works',
        repositoryName: `${id}-template`,
        branch: 'main',
        syncBranches: ['main'],
        betaBranch: null,
        isActive: true,
        metadata: {},
        ...extra,
    });
    const retiredRow = builtIn('cal-template', {
        name: 'Cal Template',
        repositoryUrl: 'https://github.com/ever-works/cal-template',
        repositoryName: 'cal-template',
        metadata: {
            discoveredFromOrganization: 'ever-works',
            fullName: 'ever-works/cal-template',
            retiredReason: 'app_blueprint',
            retiredAt: '2026-09-26T00:00:00.000Z',
        },
    });
    const listedDiscoveredRow = builtIn('astro-blog-template', {
        repositoryName: 'astro-blog-template',
        metadata: { discoveredFromOrganization: 'ever-works' },
    });
    const defaultRefusal =
        /default website template "cal-template" \(ever-works\/cal-template\) is an App Blueprint/;

    function makeWiredService(options: {
        savedDefault: string | null;
        work?: ReturnType<typeof existingWork>;
        websiteRepoInitialized?: boolean;
    }) {
        const store = new Map<string, any>(
            [
                builtIn('classic'),
                builtIn('minimal'),
                builtIn('web'),
                listedDiscoveredRow,
                retiredRow,
            ].map((row) => [row.id, row]),
        );
        const visible = (row: any) => row?.sourceType === 'built_in' && row.isActive;
        const templateRepository = {
            findById: jest.fn(async (id: string) => store.get(id) ?? null),
            findVisibleById: jest.fn(async (id: string) =>
                visible(store.get(id)) ? store.get(id) : null,
            ),
            findVisibleByKind: jest.fn(async (kind: string) =>
                [...store.values()].filter((row) => row.kind === kind && visible(row)),
            ),
            hasRecentDiscoveredBuiltInTemplates: jest.fn().mockResolvedValue(true),
        };
        const preferenceRepository = {
            findByUserAndKind: jest.fn(async (userId: string, kind: string) =>
                options.savedDefault && userId === user.id && kind === 'website'
                    ? { userId, kind, templateId: options.savedDefault }
                    : null,
            ),
        };
        const catalog = new TemplateCatalogService(
            templateRepository as never,
            { findLatestForTemplates: jest.fn().mockResolvedValue(new Map()) } as never,
            preferenceRepository as never,
            {} as never,
            {} as never,
        );
        const resolver = new WebsiteTemplateResolverService(
            templateRepository as never,
            preferenceRepository as never,
        );

        const work = options.work;
        const workRepo = {
            create: jest.fn(async (data: Record<string, unknown>) => ({
                id: (data.id as string) ?? 'w-new',
                ...data,
                getRepoOwner: () => (data.owner as string) ?? 'evereq',
            })),
            update: jest.fn(async (_id: string, data: Record<string, unknown>) => ({
                ...work,
                ...data,
            })),
            updateGenerateStatus: jest.fn().mockResolvedValue(undefined),
            findRepositoryWorksWrapping: jest.fn().mockResolvedValue([]),
        };
        // What the website repository would be generated or reset from, read
        // when the generator is invoked, from the Work in hand at that moment.
        const resolvedAtReset: string[] = [];
        const recordResolved = async (target: { userId: string }) => {
            resolvedAtReset.push((await resolver.resolveForWork(target as never)).id);
        };
        const websiteUpdateService = { updateRepository: jest.fn(recordResolved) };
        const websiteGenerator = { initialize: jest.fn(recordResolved) };

        const service = new WorkLifecycleService(
            workRepo as never,
            {
                findById: jest.fn().mockResolvedValue({ id: user.id, onboardingState: null }),
            } as never,
            { getItems: jest.fn().mockResolvedValue([]) } as never,
            {} as never,
            websiteGenerator as never,
            websiteUpdateService as never,
            { ensureCanEdit: jest.fn().mockResolvedValue({ work }) } as never,
            {} as never,
            catalog as never,
            {
                isInitialized: jest.fn().mockResolvedValue(options.websiteRepoInitialized ?? false),
            } as never,
            { assertWithinQuota: jest.fn().mockResolvedValue(undefined) } as never,
            { isEnabled: jest.fn().mockReturnValue(false), createRepository: jest.fn() } as never,
            {
                getProvider: jest.fn().mockReturnValue(null),
                ensureWorkSubdomain: jest.fn().mockResolvedValue(undefined),
                removeWorkSubdomain: jest.fn().mockResolvedValue(undefined),
                ingressHostFor: jest.fn((slug: string) => `${slug}.ever.works`),
            } as never,
            { emit: jest.fn() } as never,
            { emit: jest.fn(), emitAsync: jest.fn().mockResolvedValue([]) } as never,
            {} as never,
            { hasRepositoryAccess: jest.fn().mockResolvedValue(true) } as never,
        );

        // What a Work stored with this data resolves to, i.e. what its website
        // would be generated from.
        const resolveStored = async (data: Record<string, unknown>) =>
            (
                await resolver.resolveForWork({
                    userId: user.id,
                    websiteTemplateId: data.websiteTemplateId as string | null,
                    kind: (data.kind as string | undefined) ?? 'default',
                })
            ).id;

        return {
            service,
            workRepo,
            websiteUpdateService,
            websiteGenerator,
            resolvedAtReset,
            resolveStored,
        };
    }

    describe('createWork without a template', () => {
        const dto = {
            slug: 'my-work',
            name: 'My Work',
            description: 'A description',
            organization: false,
            gitProvider: 'github',
        } as CreateWorkDto;

        it('does not land a new Work on a retired saved default: it gets the system default, pinned', async () => {
            const { service, workRepo, resolveStored } = makeWiredService({
                savedDefault: 'cal-template',
            });

            await service.createWork(dto, user);

            const stored = workRepo.create.mock.calls[0][0];
            expect(stored.websiteTemplateId).toBe('classic');
            await expect(resolveStored(stored)).resolves.toBe('classic');
        });

        it("pins the Work kind's default when the kind has one, as for a user with no saved default", async () => {
            const { service, workRepo, resolveStored } = makeWiredService({
                savedDefault: 'cal-template',
            });

            await service.createWork({ ...dto, kind: 'website' } as CreateWorkDto, user);

            const stored = workRepo.create.mock.calls[0][0];
            expect(stored.websiteTemplateId).toBe('web');
            await expect(resolveStored(stored)).resolves.toBe('web');
        });

        it('still lets a new Work inherit a saved default that is listed (stores null)', async () => {
            const { service, workRepo, resolveStored } = makeWiredService({
                savedDefault: 'astro-blog-template',
            });

            await service.createWork(dto, user);

            const stored = workRepo.create.mock.calls[0][0];
            expect(stored.websiteTemplateId).toBeNull();
            await expect(resolveStored(stored)).resolves.toBe('astro-blog-template');
        });

        it('still stores null for a user with no saved default', async () => {
            const { service, workRepo } = makeWiredService({ savedDefault: null });

            await service.createWork(dto, user);

            expect(workRepo.create.mock.calls[0][0].websiteTemplateId).toBeNull();
        });
    });

    it('createDraftWork does not land a draft on a retired saved default either', async () => {
        const { service, workRepo, resolveStored } = makeWiredService({
            savedDefault: 'cal-template',
        });

        await service.createDraftWork(user, { name: 'Draft', slug: 'draft' });

        const stored = workRepo.create.mock.calls[0][0];
        expect(stored.websiteTemplateId).toBe('classic');
        await expect(resolveStored(stored)).resolves.toBe('classic');
    });

    describe('switchWebsiteTemplate to "use my default" (null)', () => {
        it('refuses it for a Work on another template, and neither resets the repository nor saves', async () => {
            const work = existingWork('classic');
            const { service, workRepo, websiteUpdateService, websiteGenerator, resolvedAtReset } =
                makeWiredService({
                    savedDefault: 'cal-template',
                    work,
                    websiteRepoInitialized: true,
                });

            const attempt = service.switchWebsiteTemplate('w-1', null, user);

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(defaultRefusal);
            expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
            expect(websiteGenerator.initialize).not.toHaveBeenCalled();
            expect(resolvedAtReset).toEqual([]);
            expect(workRepo.update).not.toHaveBeenCalled();
            expect(work.websiteTemplateId).toBe('classic');
        });

        it('refuses it for a Work whose repository is not created yet, and saves nothing', async () => {
            const work = existingWork('minimal');
            const { service, workRepo } = makeWiredService({
                savedDefault: 'cal-template',
                work,
            });

            await expect(service.switchWebsiteTemplate('w-1', '', user)).rejects.toThrow(
                defaultRefusal,
            );
            expect(workRepo.update).not.toHaveBeenCalled();
            expect(work.websiteTemplateId).toBe('minimal');
        });

        it('is still a no-op for a Work that already inherits the retired default', async () => {
            const { service, workRepo, websiteUpdateService } = makeWiredService({
                savedDefault: 'cal-template',
                work: existingWork(null),
                websiteRepoInitialized: true,
            });

            const result = await service.switchWebsiteTemplate('w-1', null, user);

            expect(result.switchMode).toBe('no_change');
            expect(workRepo.update).not.toHaveBeenCalled();
            expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        });

        it('still lets a Work already on the retired row inherit it instead (same template, no reset)', async () => {
            const { service, workRepo, websiteUpdateService } = makeWiredService({
                savedDefault: 'cal-template',
                work: existingWork('cal-template'),
                websiteRepoInitialized: true,
            });

            const result = await service.switchWebsiteTemplate('w-1', null, user);

            expect(result.switchMode).toBe('no_change');
            expect(workRepo.update).toHaveBeenCalledWith('w-1', { websiteTemplateId: null });
            expect(websiteUpdateService.updateRepository).not.toHaveBeenCalled();
        });

        it('still switches to a listed saved default', async () => {
            const { service, workRepo, resolvedAtReset } = makeWiredService({
                savedDefault: 'astro-blog-template',
                work: existingWork('classic'),
                websiteRepoInitialized: true,
            });

            const result = await service.switchWebsiteTemplate('w-1', null, user);

            expect(result.websiteTemplateId).toBe('astro-blog-template');
            expect(resolvedAtReset).toEqual(['astro-blog-template']);
            expect(workRepo.update).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ websiteTemplateId: null }),
            );
        });
    });

    describe('updateWork with websiteTemplateId null ("use my default")', () => {
        it('refuses it for a Work on another template, and saves nothing', async () => {
            const { service, workRepo } = makeWiredService({
                savedDefault: 'cal-template',
                work: existingWork('minimal'),
            });

            const attempt = service.updateWork('w-1', { websiteTemplateId: null } as never, user);

            await expect(attempt).rejects.toThrow(BadRequestException);
            await expect(attempt).rejects.toThrow(defaultRefusal);
            expect(workRepo.update).not.toHaveBeenCalled();
        });

        it('still accepts a settings save for a Work that already inherits the retired default', async () => {
            const { service, workRepo } = makeWiredService({
                savedDefault: 'cal-template',
                work: existingWork(null),
            });

            await service.updateWork(
                'w-1',
                { name: 'Renamed', websiteTemplateId: null } as never,
                user,
            );

            expect(workRepo.update).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ name: 'Renamed', websiteTemplateId: null }),
            );
        });

        it('still accepts it when the saved default is listed', async () => {
            const { service, workRepo } = makeWiredService({
                savedDefault: 'astro-blog-template',
                work: existingWork('minimal'),
            });

            await service.updateWork('w-1', { websiteTemplateId: null } as never, user);

            expect(workRepo.update).toHaveBeenCalledWith(
                'w-1',
                expect.objectContaining({ websiteTemplateId: null }),
            );
        });
    });
});
