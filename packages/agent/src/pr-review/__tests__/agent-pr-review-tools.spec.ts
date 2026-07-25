import { buildPrReviewTools } from '../agent-pr-review-tools';
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
        const prReviewService = { reviewPullRequest: jest.fn().mockResolvedValue(RESULT) };
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
        expect(prReviewService.reviewPullRequest).toHaveBeenCalledWith({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            instruction: 'focus on the migration',
        });
        expect(result).toEqual(RESULT);
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
