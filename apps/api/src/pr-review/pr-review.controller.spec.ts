import 'reflect-metadata';
import { NotFoundException } from '@nestjs/common';
import { validate } from 'class-validator';
import { plainToInstance } from 'class-transformer';

jest.mock('@ever-works/agent/pr-review', () => ({
    PrReviewService: class {},
    PR_REVIEW_INSTRUCTION_MAX_CHARS: 4000,
}));
jest.mock('@ever-works/agent/services', () => ({ WorkOwnershipService: class {} }));

import { PrReviewController } from './pr-review.controller';
import { ReviewPullRequestDto } from './dto/review-pull-request.dto';
import { IS_PUBLIC_KEY } from '../auth/decorators/public.decorator';

const AUTH = { userId: 'user-1' } as never;

/**
 * `POST /api/pr-review` — the REST operation the manifest-driven web tool
 * registry needs before `review_pull_request` can exist on the web side.
 *
 * The endpoint pulls a diff with the caller's git credentials and posts a
 * comment, so the ownership gate is the whole point: a repository that is
 * not connected to one of the CALLER's own Works is refused before any
 * provider call happens.
 */
describe('PrReviewController (POST /api/pr-review)', () => {
    function createController(work: unknown = { id: 'work-1' }) {
        const prReview = {
            matchWorkForRepo: jest.fn().mockResolvedValue(work),
            reviewPullRequest: jest.fn().mockResolvedValue({
                status: 'posted',
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
                summary: 'Looks good.',
                comments: [],
                commentId: 42,
                context: { work: true, kb: false, memory: false },
            }),
        };
        const ownership = { ensureAccess: jest.fn().mockResolvedValue(undefined) };
        return {
            controller: new PrReviewController(prReview as never, ownership as never),
            prReview,
            ownership,
        };
    }

    it('runs the review as the authenticated user and returns the result', async () => {
        const { controller, prReview } = createController();

        const result = await controller.reviewPullRequest(AUTH, {
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
        });

        expect(prReview.reviewPullRequest).toHaveBeenCalledWith({
            userId: 'user-1',
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            workId: 'work-1',
        });
        expect(result).toEqual(expect.objectContaining({ status: 'posted', commentId: 42 }));
    });

    it('forwards an optional instruction', async () => {
        const { controller, prReview } = createController();

        await controller.reviewPullRequest(AUTH, {
            owner: 'octo',
            repo: 'site',
            prNumber: 7,
            instruction: 'focus on the migration',
        });

        expect(prReview.reviewPullRequest).toHaveBeenCalledWith(
            expect.objectContaining({ instruction: 'focus on the migration' }),
        );
    });

    describe('cross-user PRs are refused', () => {
        it('404s a repository not connected to any Work the caller owns', async () => {
            const { controller, prReview } = createController(null);

            await expect(
                controller.reviewPullRequest(AUTH, {
                    owner: 'stranger',
                    repo: 'private-thing',
                    prNumber: 1,
                }),
            ).rejects.toThrow(NotFoundException);

            // Refused BEFORE any diff is fetched or comment posted.
            expect(prReview.reviewPullRequest).not.toHaveBeenCalled();
        });

        it('scopes the repo→Work match to the caller, never to a client-supplied id', async () => {
            const { controller, prReview } = createController();

            await controller.reviewPullRequest(AUTH, {
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
            });

            expect(prReview.matchWorkForRepo).toHaveBeenCalledWith('user-1', 'octo', 'site');
        });

        it('ownership-checks an explicit workId through WorkOwnershipService first', async () => {
            const { controller, ownership, prReview } = createController();
            ownership.ensureAccess.mockRejectedValue(new NotFoundException('Work not found'));

            await expect(
                controller.reviewPullRequest(AUTH, {
                    owner: 'octo',
                    repo: 'site',
                    prNumber: 7,
                    workId: '11111111-1111-4111-8111-111111111111',
                }),
            ).rejects.toThrow(NotFoundException);

            expect(ownership.ensureAccess).toHaveBeenCalledWith(
                '11111111-1111-4111-8111-111111111111',
                'user-1',
            );
            expect(prReview.matchWorkForRepo).not.toHaveBeenCalled();
            expect(prReview.reviewPullRequest).not.toHaveBeenCalled();
        });

        it('refuses one of the caller’s own Work ids paired with somebody else’s repository', async () => {
            const { controller, prReview } = createController(null);

            await expect(
                controller.reviewPullRequest(AUTH, {
                    owner: 'stranger',
                    repo: 'private-thing',
                    prNumber: 1,
                    workId: '11111111-1111-4111-8111-111111111111',
                }),
            ).rejects.toThrow(NotFoundException);
            expect(prReview.reviewPullRequest).not.toHaveBeenCalled();
        });
    });

    it('is NOT @Public() — an unauthenticated call is 401ed by the global auth guard', () => {
        expect(Reflect.getMetadata(IS_PUBLIC_KEY, PrReviewController)).toBeUndefined();
        expect(
            Reflect.getMetadata(IS_PUBLIC_KEY, PrReviewController.prototype.reviewPullRequest),
        ).toBeUndefined();
    });

    describe('ReviewPullRequestDto', () => {
        it('accepts a minimal valid body', async () => {
            const dto = plainToInstance(ReviewPullRequestDto, {
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
            });
            expect(await validate(dto)).toHaveLength(0);
        });

        it('rejects a missing coordinate and a non-positive PR number', async () => {
            const missing = plainToInstance(ReviewPullRequestDto, { owner: 'octo' });
            const missingErrors = await validate(missing);
            expect(missingErrors.map((e) => e.property).sort()).toEqual(['prNumber', 'repo']);

            const zero = plainToInstance(ReviewPullRequestDto, {
                owner: 'octo',
                repo: 'site',
                prNumber: 0,
            });
            expect((await validate(zero)).map((e) => e.property)).toEqual(['prNumber']);
        });

        it('caps the instruction at the reviewer’s own limit', async () => {
            const dto = plainToInstance(ReviewPullRequestDto, {
                owner: 'octo',
                repo: 'site',
                prNumber: 7,
                instruction: 'x'.repeat(4001),
            });
            expect((await validate(dto)).map((e) => e.property)).toEqual(['instruction']);
        });
    });
});
