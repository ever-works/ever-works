// Mock the agent-package barrels so importing the resolver doesn't
// pull in the real WorkRepository / GitFacadeService runtime trees
// (which depend on TypeORM, plugin registry, NestJS module wiring).
// Mirrors the convention in `activity-log.controller.spec.ts`.
jest.mock('@ever-works/agent/database', () => ({}));
jest.mock('@ever-works/agent/facades', () => ({}));

// Mock global fetch so the branch-probing path doesn't hit github.com.
const fetchMock = jest.fn();
global.fetch = fetchMock as unknown as typeof fetch;
function mockProbeResponse(body: unknown, init?: ResponseInit) {
    fetchMock.mockResolvedValueOnce({
        ok: !init?.status || init.status < 400,
        status: init?.status ?? 200,
        statusText: init?.statusText ?? 'OK',
        json: async () => body,
    } as unknown as Response);
}
function mockProbeError(err: Error) {
    fetchMock.mockRejectedValueOnce(err);
}

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
        fetchMock.mockReset();
        delete process.env.GITHUB_STORAGE_DATA_REPO_BRANCH;
        resolver = new WorkRepoResolverService(
            workRepo as unknown as WorkRepository,
            gitFacade as unknown as GitFacadeService,
        );
    });

    it('probes the repo default branch via the GitHub REST API when no env override is set', async () => {
        workRepo.findById.mockResolvedValueOnce(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValueOnce('ghp_token_123');
        mockProbeResponse({ default_branch: 'master' });
        const out = await resolver.resolve(workId);
        expect(out).toEqual({
            owner: 'acme',
            repo: 'docs-site-data',
            branch: 'master',
            token: 'ghp_token_123',
        });
        expect(fetchMock).toHaveBeenCalledWith(
            'https://api.github.com/repos/acme/docs-site-data',
            expect.objectContaining({
                headers: expect.objectContaining({
                    Authorization: 'Bearer ghp_token_123',
                }),
            }),
        );
    });

    it('skips the probe and uses the env override when GITHUB_STORAGE_DATA_REPO_BRANCH is set', async () => {
        process.env.GITHUB_STORAGE_DATA_REPO_BRANCH = 'release';
        workRepo.findById.mockResolvedValueOnce(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValueOnce('ghp_token_123');
        const out = await resolver.resolve(workId);
        expect(out.branch).toBe('release');
        expect(fetchMock).not.toHaveBeenCalled();
    });

    it('falls back to main and logs a warning when the probe fails', async () => {
        workRepo.findById.mockResolvedValueOnce(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValueOnce('ghp_token_123');
        mockProbeError(new Error('502 from upstream'));
        const out = await resolver.resolve(workId);
        expect(out.branch).toBe('main');
    });

    it('caches the probed branch per <owner>/<repo>', async () => {
        // Two consecutive resolves on the same Work should call fetch
        // exactly once. The second hit reads the cache.
        workRepo.findById.mockResolvedValue(makeWork() as never);
        gitFacade.getAccessToken.mockResolvedValue('ghp_token_123');
        mockProbeResponse({ default_branch: 'master' });
        const a = await resolver.resolve(workId);
        const b = await resolver.resolve(workId);
        expect(a.branch).toBe('master');
        expect(b.branch).toBe('master');
        expect(fetchMock).toHaveBeenCalledTimes(1);
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
