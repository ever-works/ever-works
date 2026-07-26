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
jest.mock('@ever-works/agent/pr-review', () => ({
    __esModule: true,
    PrReviewService: class {},
}));
jest.mock('@ever-works/agent/ingest', () => ({
    __esModule: true,
    IngestedEventRepository: class {},
}));

import { ForbiddenException, NotFoundException } from '@nestjs/common';
import {
    WorkPullRequestsController,
    PR_DIFF_FILE_PATCH_MAX_BYTES,
    PR_DIFF_TOTAL_PATCH_MAX_BYTES,
} from './work-pull-requests.controller';

/**
 * Wave 7 feature h — the in-platform PR review surface. Two load-bearing
 * guards: `ensureAccess` MUST gate the Work before any git call runs
 * (cross-user Works 404, no existence leak), and every per-PR route MUST
 * additionally confirm `owner/repo` is one of the Work's OWN repos —
 * otherwise the platform's git credentials read diffs from, and post AI
 * reviews onto, any repository a caller can name.
 */
describe('WorkPullRequestsController', () => {
    const auth = { userId: 'u1' } as any;
    const workId = '00000000-0000-0000-0000-0000000000dd';

    const PR = { number: 7, title: 'Add page', state: 'open', url: 'https://git/pr/7' };

    let ownership: any;
    let workRepository: any;
    let gitFacade: any;
    let prReview: any;
    let events: any;
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
        gitFacade = {
            listPullRequests: jest.fn().mockResolvedValue([PR]),
            getPullRequest: jest.fn().mockResolvedValue(PR),
            getPullRequestFiles: jest.fn().mockResolvedValue([]),
        };
        prReview = { reviewPullRequest: jest.fn().mockResolvedValue({ status: 'posted' }) };
        events = { findRecentByWork: jest.fn().mockResolvedValue([]) };
        controller = new WorkPullRequestsController(
            ownership,
            workRepository,
            gitFacade,
            prReview,
            events,
        );
    });

    describe('listPullRequests', () => {
        it('gates the Work through ensureAccess with the ACTING user before any git call', async () => {
            ownership.ensureAccess.mockRejectedValue(new NotFoundException());
            await expect(controller.listPullRequests(auth, workId)).rejects.toThrow(
                NotFoundException,
            );
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

    describe('getPullRequestDiff', () => {
        it('refuses a repo the Work does not declare, before any git call', async () => {
            await expect(
                controller.getPullRequestDiff(auth, workId, 'someone', 'private-repo', 7),
            ).rejects.toThrow(ForbiddenException);
            expect(gitFacade.getPullRequest).not.toHaveBeenCalled();
        });

        it('gates the Work through ensureAccess before anything else', async () => {
            ownership.ensureAccess.mockRejectedValue(new NotFoundException());
            await expect(
                controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7),
            ).rejects.toThrow(NotFoundException);
            expect(gitFacade.getPullRequest).not.toHaveBeenCalled();
        });

        it('404s when the pull request itself is gone', async () => {
            gitFacade.getPullRequest.mockResolvedValue(null);
            await expect(
                controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7),
            ).rejects.toThrow(NotFoundException);
        });

        it('returns the PR plus its per-file patches', async () => {
            gitFacade.getPullRequestFiles.mockResolvedValue([
                {
                    filename: 'src/a.ts',
                    status: 'modified',
                    additions: 3,
                    deletions: 1,
                    patch: '@@ -1 +1 @@\n-a\n+b',
                },
            ]);
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            expect(res.pullRequest).toBe(PR);
            expect(res.files).toHaveLength(1);
            expect(res.files[0]).toMatchObject({ filename: 'src/a.ts', truncated: false });
            expect(res.truncated).toBe(false);
        });

        it('caps an oversized single patch and flags it truncated', async () => {
            gitFacade.getPullRequestFiles.mockResolvedValue([
                {
                    filename: 'huge.lock',
                    status: 'modified',
                    additions: 9999,
                    deletions: 0,
                    patch: 'x'.repeat(PR_DIFF_FILE_PATCH_MAX_BYTES + 500),
                },
            ]);
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            expect(res.files[0].patch).toHaveLength(PR_DIFF_FILE_PATCH_MAX_BYTES);
            expect(res.files[0].truncated).toBe(true);
            expect(res.truncated).toBe(true);
        });

        it('spends a total byte budget across files and lists the rest counts-only', async () => {
            const bigPatch = 'y'.repeat(PR_DIFF_FILE_PATCH_MAX_BYTES);
            const fileCount =
                Math.ceil(PR_DIFF_TOTAL_PATCH_MAX_BYTES / PR_DIFF_FILE_PATCH_MAX_BYTES) + 2;
            gitFacade.getPullRequestFiles.mockResolvedValue(
                Array.from({ length: fileCount }, (_unused, i) => ({
                    filename: `f${i}.ts`,
                    status: 'modified',
                    additions: 1,
                    deletions: 0,
                    patch: bigPatch,
                })),
            );
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            const totalBytes = res.files.reduce((sum, f) => sum + (f.patch?.length ?? 0), 0);
            expect(totalBytes).toBeLessThanOrEqual(PR_DIFF_TOTAL_PATCH_MAX_BYTES);
            expect(res.files.at(-1)?.patch).toBeUndefined();
            expect(res.files.at(-1)?.truncated).toBe(true);
            expect(res.truncated).toBe(true);
        });

        it('renders the PR header when the provider refuses the diff', async () => {
            gitFacade.getPullRequestFiles.mockRejectedValue(new Error('diff too large'));
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            expect(res.files).toEqual([]);
            expect(res.pullRequest).toBe(PR);
        });

        it("reads back only this PR's recorded agent reviews off the ingest spine", async () => {
            events.findRecentByWork.mockResolvedValue([
                {
                    id: 'e1',
                    kind: 'github.pr.review',
                    occurredAt: new Date('2026-07-25T10:00:00.000Z'),
                    sourceUrl: 'https://git/pr/7',
                    payload: {
                        owner: 'Octo',
                        repo: 'ACME',
                        prNumber: 7,
                        summary: 'Looks good',
                        commentCount: 2,
                        posted: true,
                    },
                },
                // Different PR — must not leak into this response.
                {
                    id: 'e2',
                    kind: 'github.pr.review',
                    occurredAt: new Date(),
                    sourceUrl: null,
                    payload: { owner: 'octo', repo: 'acme', prNumber: 8, summary: 'Other' },
                },
                // Different kind — not a review.
                {
                    id: 'e3',
                    kind: 'github.pr',
                    occurredAt: new Date(),
                    sourceUrl: null,
                    payload: { owner: 'octo', repo: 'acme', prNumber: 7 },
                },
            ]);
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            expect(res.reviews).toHaveLength(1);
            expect(res.reviews[0]).toMatchObject({
                id: 'e1',
                summary: 'Looks good',
                commentCount: 2,
                posted: true,
            });
        });

        it('degrades to no review history when the spine read fails', async () => {
            events.findRecentByWork.mockRejectedValue(new Error('db down'));
            const res = await controller.getPullRequestDiff(auth, workId, 'octo', 'acme', 7);
            expect(res.reviews).toEqual([]);
        });
    });

    describe('requestReview', () => {
        it('refuses a repo the Work does not declare, before any review runs', async () => {
            await expect(
                controller.requestReview(auth, workId, 'someone', 'private-repo', 7),
            ).rejects.toThrow(ForbiddenException);
            expect(prReview.reviewPullRequest).not.toHaveBeenCalled();
        });

        it('runs the SAME Work-aware reviewer the webhook bridge uses', async () => {
            const res = await controller.requestReview(auth, workId, 'octo', 'acme', 7);
            expect(prReview.reviewPullRequest).toHaveBeenCalledWith({
                userId: 'u1',
                owner: 'octo',
                repo: 'acme',
                prNumber: 7,
                workId,
                providerId: 'github',
            });
            expect(res).toEqual({ status: 'posted' });
        });
    });
});
