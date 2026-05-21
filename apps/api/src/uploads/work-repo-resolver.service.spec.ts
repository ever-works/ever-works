// Mock the agent-package barrels so importing the resolver doesn't
// pull in the real WorkRepository / GitFacadeService runtime trees
// (which depend on TypeORM, plugin registry, NestJS module wiring).
// Mirrors the convention in `activity-log.controller.spec.ts`.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

import { WorkRepoResolverService } from './work-repo-resolver.service';
import type { WorkRepository } from '@ever-works/agent/database';
import type { GitFacadeService } from '@ever-works/agent/facades';

type MockWorkRepository = jest.Mocked<Pick<WorkRepository, 'findById'>>;
type MockGitFacade = jest.Mocked<Pick<GitFacadeService, 'getAccessToken'>>;

const workId = '11111111-2222-3333-4444-555555555555';

function makeWork(
    overrides?: Partial<{ owner: string | undefined; slug: string; userId: string }>,
) {
    const owner = overrides?.owner ?? 'acme';
    const slug = overrides?.slug ?? 'docs-site';
    const userId = overrides?.userId ?? 'user-42';
    // We only need the helper methods + userId field. The real Work
    // entity has many more, but the resolver only touches these.
    return {
        id: workId,
        userId,
        getRepoOwner: jest.fn().mockReturnValue(owner),
        getDataRepo: jest.fn().mockReturnValue(`${slug}-data`),
    };
}

describe('WorkRepoResolverService (EW-644)', () => {
    let workRepo: MockWorkRepository;
    let gitFacade: MockGitFacade;
    let resolver: WorkRepoResolverService;

    beforeEach(() => {
        workRepo = { findById: jest.fn() } as MockWorkRepository;
        gitFacade = { getAccessToken: jest.fn() } as MockGitFacade;
        resolver = new WorkRepoResolverService(
            workRepo as unknown as WorkRepository,
            gitFacade as unknown as GitFacadeService,
        );
    });

    it('returns owner/repo/branch/token for a Work with a connected GitHub account', async () => {
        workRepo.findById.mockResolvedValueOnce(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValueOnce('ghp_token_123');
        const out = await resolver.resolve(workId);
        expect(out).toEqual({
            owner: 'acme',
            repo: 'docs-site-data',
            branch: 'main',
            token: 'ghp_token_123',
        });
        expect(gitFacade.getAccessToken).toHaveBeenCalledWith({
            userId: 'user-42',
            providerId: 'github',
            workId,
        });
    });

    it('throws a clear error when the Work is not found', async () => {
        workRepo.findById.mockResolvedValueOnce(null);
        await expect(resolver.resolve(workId)).rejects.toThrow(/Work not found/);
        expect(gitFacade.getAccessToken).not.toHaveBeenCalled();
    });

    it('throws a clear error when the Work has no resolvable repo coordinates', async () => {
        const work = makeWork({ owner: '' });
        work.getDataRepo = jest.fn().mockReturnValue('');
        workRepo.findById.mockResolvedValueOnce(work as never);
        await expect(resolver.resolve(workId)).rejects.toThrow(/no resolvable data repo/);
    });

    it('throws when no GitHub token can be resolved for the Work owner', async () => {
        workRepo.findById.mockResolvedValueOnce(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValueOnce(null);
        await expect(resolver.resolve(workId)).rejects.toThrow(
            /no GitHub token available for user/,
        );
    });
});
