// Short-circuit the transitive `@ever-works/agent/*` import chains so the
// test doesn't pull `@src/entities` (which only resolves inside apps/api)
// through the agent-package barrels. House pattern — mirrors
// work-runs.controller.spec.ts.
jest.mock('@ever-works/agent/facades', () => ({
    __esModule: true,
    GitFacadeService: class {},
}));
jest.mock('@ever-works/agent/database', () => ({
    __esModule: true,
    WorkRepository: class {},
}));
jest.mock('@ever-works/agent/services', () => ({
    __esModule: true,
    WorkOwnershipService: class {},
}));

import { NotFoundException } from '@nestjs/common';
import { WorkPullRequestsController } from './work-pull-requests.controller';

/**
 * Wave 7 feature h (v1) — per-Work open-PR listing. The scope-guard
 * test is the load-bearing one: `ensureAccess` MUST gate the Work
 * before any git call runs (cross-user Works 404, no existence leak).
 */
describe('WorkPullRequestsController', () => {
    const auth = { userId: 'u1' } as any;
    const workId = '00000000-0000-0000-0000-0000000000dd';

    const PR = { number: 7, title: 'Add page', state: 'open' };

    let ownership: any;
    let workRepository: any;
    let gitFacade: any;
    let controller: WorkPullRequestsController;

    beforeEach(() => {
        ownership = { ensureAccess: jest.fn().mockResolvedValue({ work: { id: workId } }) };
        workRepository = {
            findById: jest.fn().mockResolvedValue({
                id: workId,
                gitProvider: 'github',
                getRepoOwner: (_role?: string) => 'octo',
                getMainRepo: () => 'acme',
                getWebsiteRepo: () => 'acme-website',
                getDataRepo: () => 'acme-data',
            }),
        };
        gitFacade = { listPullRequests: jest.fn().mockResolvedValue([PR]) };
        controller = new WorkPullRequestsController(ownership, workRepository, gitFacade);
    });

    it('gates the Work through ensureAccess with the ACTING user before any git call', async () => {
        ownership.ensureAccess.mockRejectedValue(new NotFoundException());
        await expect(controller.listPullRequests(auth, workId)).rejects.toThrow(NotFoundException);
        expect(gitFacade.listPullRequests).not.toHaveBeenCalled();
    });

    it('lists open PRs for every distinct repo role, workId-scoped for token resolution', async () => {
        const result = await controller.listPullRequests(auth, workId);
        expect(result.repos).toHaveLength(3);
        expect(result.repos.map((r) => `${r.role}:${r.owner}/${r.repo}`)).toEqual([
            'work:octo/acme',
            'website:octo/acme-website',
            'data:octo/acme-data',
        ]);
        expect(gitFacade.listPullRequests).toHaveBeenCalledWith(
            'octo',
            'acme',
            { state: 'open', perPage: 30 },
            expect.objectContaining({ providerId: 'github', userId: 'u1', workId }),
        );
    });

    it('dedupes repo roles that collapse to the same repository', async () => {
        workRepository.findById.mockResolvedValue({
            id: workId,
            gitProvider: 'github',
            getRepoOwner: () => 'octo',
            getMainRepo: () => 'acme',
            getWebsiteRepo: () => 'acme',
            getDataRepo: () => 'acme-data',
        });
        const result = await controller.listPullRequests(auth, workId);
        expect(result.repos).toHaveLength(2);
    });

    it('degrades a single failing repo to an error entry instead of failing the response', async () => {
        gitFacade.listPullRequests
            .mockResolvedValueOnce([PR])
            .mockRejectedValueOnce(new Error('repo not generated yet'))
            .mockResolvedValueOnce([]);
        const result = await controller.listPullRequests(auth, workId);
        expect(result.repos[0].pullRequests).toEqual([PR]);
        expect(result.repos[1].error).toBe('repo not generated yet');
        expect(result.repos[1].pullRequests).toEqual([]);
        expect(result.repos[2].pullRequests).toEqual([]);
    });
});
