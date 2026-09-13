import { TaskReviewApprovalService } from '../task-review-approval.service';

/**
 * Merge approval (self-build slice AE, EW-805) — the provider-side human
 * review recorder.
 *
 * The property that matters is WHICH COMMIT gets stamped. An approval
 * recorded against the branch head at delivery time rather than against
 * the commit the reviewer opened would silently turn "I read this diff"
 * into "I read whatever is there now" — the same class of bug the merge
 * gate's head pin exists to prevent, one layer earlier.
 */
describe('TaskReviewApprovalService', () => {
    const REVIEWED = 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678';

    function build(over: { work?: unknown; task?: unknown; updated?: boolean } = {}) {
        const tasks = {
            findByWorkAndPrNumber: jest
                .fn()
                .mockResolvedValue('task' in over ? over.task : { id: 'task-1', prNumber: 9 }),
            recordPullRequestReviewApproval: jest.fn().mockResolvedValue(over.updated ?? true),
            clearPullRequestReviewApproval: jest.fn().mockResolvedValue(over.updated ?? true),
        };
        const works = {
            findByUser: jest.fn().mockResolvedValue(
                'work' in over
                    ? over.work
                    : [
                          {
                              id: 'work-1',
                              repositoryUrl: 'https://github.com/acme/site-data',
                              getRepoOwner: () => 'acme',
                              getDataRepo: () => 'site-data',
                          },
                      ],
            ),
        };
        return {
            service: new TaskReviewApprovalService(tasks as never, works as never),
            tasks,
            works,
        };
    }

    const INPUT = {
        userId: 'user-1',
        owner: 'acme',
        repo: 'site-data',
        prNumber: 9,
        headSha: REVIEWED,
        reviewerLabel: 'octocat',
        approvedAt: new Date('2026-09-01T10:00:00Z'),
    };

    it('stamps the approval onto the Task with the commit the reviewer saw', async () => {
        const { service, tasks } = build();
        await expect(service.recordPullRequestApproval(INPUT)).resolves.toBe(true);
        expect(tasks.recordPullRequestReviewApproval).toHaveBeenCalledWith('task-1', 9, {
            headSha: REVIEWED,
            approvedAt: new Date('2026-09-01T10:00:00Z'),
            approvedBy: 'octocat',
        });
    });

    it('normalises the commit id so it matches what the merge gate compares against', async () => {
        const { service, tasks } = build();
        await service.recordPullRequestApproval({ ...INPUT, headSha: REVIEWED.toUpperCase() });
        expect(tasks.recordPullRequestReviewApproval.mock.calls[0][2].headSha).toBe(REVIEWED);
    });

    it.each([
        ['nothing', null],
        ['a branch name', 'main'],
        ['an abbreviation', 'a1b2c3'],
    ])('records NOTHING when the review names %s as its commit', async (_label, headSha) => {
        // An approval that cannot be attached to a commit is an approval of
        // nothing in particular; guessing the branch head instead is the
        // exact laundering this guards against.
        const { service, tasks } = build();
        await expect(service.recordPullRequestApproval({ ...INPUT, headSha })).resolves.toBe(false);
        expect(tasks.recordPullRequestReviewApproval).not.toHaveBeenCalled();
    });

    it('records nothing when the repository maps to no Work', async () => {
        const { service, tasks } = build({ work: [] });
        await expect(service.recordPullRequestApproval(INPUT)).resolves.toBe(false);
        expect(tasks.recordPullRequestReviewApproval).not.toHaveBeenCalled();
    });

    it('records nothing when the pull request maps to no Task', async () => {
        const { service, tasks } = build({ task: null });
        await expect(service.recordPullRequestApproval(INPUT)).resolves.toBe(false);
        expect(tasks.recordPullRequestReviewApproval).not.toHaveBeenCalled();
    });

    it('reports false rather than throwing when the write loses its row', async () => {
        // `findByWorkAndPrNumber` is newest-first, not unique, so the row it
        // returns may no longer carry this pull request by the time the
        // update runs; the repository re-asserts `prNumber` in its WHERE.
        const { service } = build({ updated: false });
        await expect(service.recordPullRequestApproval(INPUT)).resolves.toBe(false);
    });

    it('caps an absurdly long reviewer login to the column width', async () => {
        const { service, tasks } = build();
        await service.recordPullRequestApproval({ ...INPUT, reviewerLabel: 'x'.repeat(400) });
        expect(tasks.recordPullRequestReviewApproval.mock.calls[0][2].approvedBy).toHaveLength(128);
    });

    it('stores a null reviewer rather than an empty string', async () => {
        const { service, tasks } = build();
        await service.recordPullRequestApproval({ ...INPUT, reviewerLabel: '   ' });
        expect(tasks.recordPullRequestReviewApproval.mock.calls[0][2].approvedBy).toBeNull();
    });

    it('swallows a store fault — a webhook must still answer 200', async () => {
        const { service, works } = build();
        works.findByUser.mockRejectedValue(new Error('db down'));
        await expect(service.recordPullRequestApproval(INPUT)).resolves.toBe(false);
    });

    // ── the reviewer takes it back ────────────────────────────────────
    //
    // The head-SHA binding covers "the code changed under the approval".
    // It does NOT cover "the reviewer changed their mind about the same
    // commit", which is exactly the case where a person read the diff
    // again and decided against it — and nothing else in the tree ever
    // cleared these three columns, so the merge Inbox kept reporting a
    // withdrawn sign-off as current human attestation.

    describe('clearPullRequestApproval', () => {
        const WITHDRAW = {
            userId: 'user-1',
            owner: 'acme',
            repo: 'site-data',
            prNumber: 9,
            reviewerLabel: 'octocat',
        };

        it('clears the record for the reviewer who withdrew it', async () => {
            const { service, tasks } = build();
            await expect(service.clearPullRequestApproval(WITHDRAW)).resolves.toBe(true);
            expect(tasks.clearPullRequestReviewApproval).toHaveBeenCalledWith(
                'task-1',
                9,
                'octocat',
            );
        });

        it('clears NOTHING when the delivery names no reviewer', async () => {
            // Unattributable: it cannot be matched to the stored approver,
            // and clearing on a nameless delivery would let one malformed
            // webhook erase the record for good.
            const { service, tasks } = build();
            await expect(
                service.clearPullRequestApproval({ ...WITHDRAW, reviewerLabel: '  ' }),
            ).resolves.toBe(false);
            expect(tasks.clearPullRequestReviewApproval).not.toHaveBeenCalled();
        });

        it('clears nothing when the repository maps to no Work', async () => {
            const { service, tasks } = build({ work: [] });
            await expect(service.clearPullRequestApproval(WITHDRAW)).resolves.toBe(false);
            expect(tasks.clearPullRequestReviewApproval).not.toHaveBeenCalled();
        });

        it('reports false when the stored approver is somebody else', async () => {
            // The repository guards on the recorded login, so Bob
            // requesting changes does not unmake the fact that Alice read
            // the diff.
            const { service } = build({ updated: false });
            await expect(service.clearPullRequestApproval(WITHDRAW)).resolves.toBe(false);
        });

        it('swallows a store fault — a webhook must still answer 200', async () => {
            const { service, works } = build();
            works.findByUser.mockRejectedValue(new Error('db down'));
            await expect(service.clearPullRequestApproval(WITHDRAW)).resolves.toBe(false);
        });
    });
});
