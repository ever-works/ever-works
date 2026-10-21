import { buildPrReviewTools, notAWorkRepositoryError } from '../agent-pr-review-tools';
import type { PrReviewResult } from '../pr-review.types';

const RESULT: PrReviewResult = {
    status: 'posted',
    owner: 'octo',
    repo: 'site',
    prNumber: 7,
    summary: 'Verdict: ship it.',
    comments: [],
    commentId: 101,
    prUrl: 'https://example.com/octo/site/pull/7',
    context: { work: true, kb: true, memory: false },
};

describe('buildPrReviewTools', () => {
    function createTools() {
        const prReviewService = {
            reviewPullRequest: jest.fn().mockResolvedValue(RESULT),
            // Owner-scoped repo→Work match; `octo/site` is one of user-1's Works.
            matchWorkForRepo: jest.fn(async (_userId: string, owner: string, repo: string) =>
                `${owner}/${repo}`.toLowerCase() === 'octo/site' ? { id: 'work-1' } : null,
            ),
        };
        const tools = buildPrReviewTools({ userId: 'user-1', prReviewService });
        return { tools, prReviewService };
    }

    it('exposes the review_pull_request tool with required repo coordinates', () => {
        const { tools } = createTools();
        expect(tools).toHaveLength(1);
        expect(tools[0].name).toBe('review_pull_request');
        expect(tools[0].parameters.required).toEqual(['owner', 'repo', 'prNumber']);
    });

    it('invokes the reviewer as the bound user and returns the result', async () => {
        const { tools, prReviewService } = createTools();
        const result = await tools[0].invoke({
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            instruction: 'focus on the migration',
        });
        expect(prReviewService.matchWorkForRepo).toHaveBeenCalledWith('user-1', 'octo', 'site');
        expect(prReviewService.reviewPullRequest).toHaveBeenCalledWith({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            instruction: 'focus on the migration',
            workId: 'work-1',
        });
        expect(result).toEqual(RESULT);
    });

    /**
     * The review POSTS A COMMENT as the owner on whatever pull request the
     * owner's token can reach — upstream projects included, and "the
     * platform never comments upstream". The model picks the coordinates,
     * so they must name a repository of one of the user's own Works.
     */
    it('⭐ refuses a repository that belongs to none of the user’s Works — nothing fetched, nothing posted', async () => {
        const { tools, prReviewService } = createTools();
        for (const [owner, repo] of [
            ['nodejs', 'node'],
            ['someone-else', 'site'],
        ]) {
            const result = await tools[0].invoke({ owner, repo, prNumber: 7 });
            expect(result).toEqual({ error: notAWorkRepositoryError(owner, repo) });
        }
        expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
    });

    it('fails closed when the Work lookup itself fails', async () => {
        const { tools, prReviewService } = createTools();
        prReviewService.matchWorkForRepo.mockRejectedValue(new Error('db down'));
        const result = await tools[0].invoke({ owner: 'octo', repo: 'site', prNumber: 7 });
        expect(result).toEqual({ error: 'db down' });
        expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
    });

    it('rejects malformed arguments without calling the service', async () => {
        const { tools, prReviewService } = createTools();
        const result = await tools[0].invoke({ owner: 'octo', repo: 'site', prNumber: -1 });
        expect(result).toEqual({
            error: 'owner, repo and a positive integer prNumber are required',
        });
        expect(prReviewService.reviewPullRequest).not.toHaveBeenCalled();
    });

    it('maps a thrown service error into the tool error shape', async () => {
        const { tools, prReviewService } = createTools();
        prReviewService.reviewPullRequest.mockRejectedValue(new Error('no git credentials'));
        const result = await tools[0].invoke({ owner: 'octo', repo: 'site', prNumber: 7 });
        expect(result).toEqual({ error: 'no git credentials' });
    });
});
