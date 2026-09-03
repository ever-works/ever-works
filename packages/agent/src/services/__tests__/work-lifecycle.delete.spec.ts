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
import type { User } from '@src/entities/user.entity';
import type { DeleteWorkDto } from '@src/items-generator/dto';

/**
 * `WorkLifecycleService.deleteWork` — which repositories a delete may reach.
 *
 * The P1 this pins (self-build slice D, EW-766): a Repository Work's data
 * repository is the user's own code repository, and its `work` / `website`
 * roles were never provisioned — but the entity's derived fallbacks
 * (`<slug>`, `<slug>-website`) resolve to real names under the third-party
 * owner. Deleting the Work row must therefore never call the git provider's
 * delete for the kind, whatever the DTO says, and must never `rm` a local
 * checkout it did not make. Every other kind keeps today's behaviour, with
 * one refinement: a role the kind never provisions is skipped instead of
 * attempted against a repository that does not exist.
 */
const user = { id: 'owner-1', username: 'owner' } as User;

interface Mocks {
    workRepository: { delete: jest.Mock };
    dataGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    markdownGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    websiteGenerator: { removeRepository: jest.Mock; cleanup: jest.Mock };
    everWorksDns: { removeWorkSubdomain: jest.Mock };
}

function makeService(work: Record<string, unknown>): {
    service: WorkLifecycleService;
    mocks: Mocks;
} {
    const mocks: Mocks = {
        workRepository: { delete: jest.fn().mockResolvedValue(undefined) },
        dataGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        markdownGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        websiteGenerator: {
            removeRepository: jest.fn().mockResolvedValue(undefined),
            cleanup: jest.fn().mockResolvedValue(undefined),
        },
        everWorksDns: { removeWorkSubdomain: jest.fn().mockResolvedValue(undefined) },
    };
    const ownership = { ensureIsOwner: jest.fn().mockResolvedValue({ work }) };

    const service = new WorkLifecycleService(
        mocks.workRepository as never,
        {} as never,
        mocks.dataGenerator as never,
        mocks.markdownGenerator as never,
        mocks.websiteGenerator as never,
        {} as never,
        ownership as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        {} as never,
        mocks.everWorksDns as never,
        {} as never,
        { emit: jest.fn(), emitAsync: jest.fn() } as never,
        {} as never,
        {} as never,
    );
    return { service, mocks };
}

/**
 * The shape `applyRepositoryWorkSource` persists for
 * `https://github.com/ever-works/ever-works`, with the slug the web form
 * derives by default — i.e. the case where `getMainRepo()`'s `<slug>`
 * fallback names the wrapped repository itself.
 */
function repositoryWork(): Record<string, unknown> {
    return {
        id: 'w-repo',
        kind: 'repo',
        name: 'Platform',
        slug: 'ever-works',
        owner: 'ever-works',
        userId: user.id,
        gitProvider: 'github',
        deployProvider: null,
        sourceRepository: {
            type: 'link_existing',
            owner: 'ever-works',
            repo: 'ever-works',
            relatedRepositories: { data: { owner: 'ever-works', repo: 'ever-works' } },
        },
        getRepoOwner: () => 'ever-works',
        getDataRepo: () => 'ever-works',
        getMainRepo: () => 'ever-works',
        getWebsiteRepo: () => 'ever-works-website',
    };
}

function directoryWork(kind = 'directory'): Record<string, unknown> {
    return {
        id: 'w-dir',
        kind,
        name: 'Best Tools',
        slug: 'best-tools',
        owner: 'acme',
        userId: user.id,
        gitProvider: 'github',
        deployProvider: 'vercel',
        getRepoOwner: () => 'acme',
        getDataRepo: () => 'best-tools-data',
        getMainRepo: () => 'best-tools',
        getWebsiteRepo: () => 'best-tools-website',
    };
}

const ALL_ON: DeleteWorkDto = {
    delete_data_repository: true,
    delete_markdown_repository: true,
    delete_website_repository: true,
};

describe('WorkLifecycleService.deleteWork — Repository Work never reaches the git provider', () => {
    it.each<[string, DeleteWorkDto]>([
        ['an empty DTO (the MCP delete_work default)', {}],
        [
            'every flag explicitly false',
            {
                ...ALL_ON,
                delete_data_repository: false,
                delete_markdown_repository: false,
                delete_website_repository: false,
            },
        ],
        [
            'the work + website flags on (data left unticked)',
            { delete_markdown_repository: true, delete_website_repository: true },
        ],
    ])(
        'deletes only the row with %s — zero removeRepository calls, zero cleanup',
        async (_label, dto) => {
            const { service, mocks } = makeService(repositoryWork());

            const result = await service.deleteWork('w-repo', dto, user);

            expect(result.status).toBe('success');
            expect(result.deleted_repositories).toEqual([]);
            expect(mocks.workRepository.delete).toHaveBeenCalledWith('w-repo');
            expect(mocks.dataGenerator.removeRepository).not.toHaveBeenCalled();
            expect(mocks.markdownGenerator.removeRepository).not.toHaveBeenCalled();
            expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
            // The shared `owner/repo` checkout is not this Work's to remove.
            expect(mocks.dataGenerator.cleanup).not.toHaveBeenCalled();
            expect(mocks.markdownGenerator.cleanup).not.toHaveBeenCalled();
            expect(mocks.websiteGenerator.cleanup).not.toHaveBeenCalled();
            // `deployProvider` is null for the kind, so no CNAME teardown either.
            expect(mocks.everWorksDns.removeWorkSubdomain).not.toHaveBeenCalled();
        },
    );

    it('refuses an EXPLICIT delete_data_repository with a 400 before deleting anything', async () => {
        const { service, mocks } = makeService(repositoryWork());

        await expect(
            service.deleteWork('w-repo', { delete_data_repository: true }, user),
        ).rejects.toBeInstanceOf(BadRequestException);

        expect(mocks.dataGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.markdownGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(mocks.workRepository.delete).not.toHaveBeenCalled();
    });

    it('names the wrapped repository in the refusal so the caller knows what was protected', async () => {
        const { service } = makeService(repositoryWork());

        await expect(
            service.deleteWork('w-repo', { delete_data_repository: true }, user),
        ).rejects.toMatchObject({
            response: expect.objectContaining({
                message: expect.stringMatching(/is a Repository Work.*ever-works\/ever-works/),
            }),
        });
    });
});

describe('WorkLifecycleService.deleteWork — other kinds keep their behaviour', () => {
    it('a directory Work still deletes all three repositories when asked and cleans up its checkouts', async () => {
        const { service, mocks } = makeService(directoryWork());

        const result = await service.deleteWork('w-dir', ALL_ON, user);

        expect(result.deleted_repositories).toEqual([
            'acme/best-tools-data',
            'acme/best-tools',
            'acme/best-tools-website',
        ]);
        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.dataGenerator.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.cleanup).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.cleanup).toHaveBeenCalledTimes(1);
    });

    it('the awesome-repo kind is NOT a Repository Work — its data repository is deletable', async () => {
        // Guards against a lazy substring check on the kind name.
        const { service, mocks } = makeService(directoryWork('awesome-repo'));

        await service.deleteWork('w-dir', { delete_data_repository: true }, user);

        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
    });

    it('skips a role the kind never provisions instead of deleting a derived name (company → no website repo)', async () => {
        const { service, mocks } = makeService(directoryWork('company'));

        const result = await service.deleteWork('w-dir', ALL_ON, user);

        expect(mocks.dataGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.markdownGenerator.removeRepository).toHaveBeenCalledTimes(1);
        expect(mocks.websiteGenerator.removeRepository).not.toHaveBeenCalled();
        expect(result.deleted_repositories).toEqual(['acme/best-tools-data', 'acme/best-tools']);
    });
});
