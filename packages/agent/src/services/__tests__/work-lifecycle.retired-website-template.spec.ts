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
