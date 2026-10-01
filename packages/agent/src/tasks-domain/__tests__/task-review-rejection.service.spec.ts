import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { TaskReviewRejectionService } from '../task-review-rejection.service';

/**
 * The write half of the rejection loop (orchestration M9).
 *
 * `RunSteeringService` reads these rows; this service is every way one
 * gets produced. Two properties matter most: a human-review rejection is
 * OWNER-SCOPED (404-no-leak), and a PR rejection is BEST-EFFORT (its
 * caller is a webhook that must answer 200 whatever happens).
 */
describe('TaskReviewRejectionService (M9)', () => {
    let tasks: any;
    let rejections: any;
    let reviewers: any;
    let works: any;

    const task = {
        id: 'task-1',
        userId: 'u1',
        workId: 'work-1',
        organizationId: 'org-1',
        prNumber: 42,
    };

    function makeSvc(): TaskReviewRejectionService {
        const svc = new TaskReviewRejectionService(tasks, rejections, reviewers, works);
        for (const level of ['warn', 'log'] as const) {
            jest.spyOn(
                (svc as never as { logger: Record<string, () => void> }).logger,
                level,
            ).mockImplementation(() => undefined);
        }
        return svc;
    }

    beforeEach(() => {
        tasks = {
            findByIdAndUser: jest.fn().mockResolvedValue({ ...task }),
            findByWorkAndPrNumber: jest.fn().mockResolvedValue({ ...task }),
        };
        rejections = { record: jest.fn().mockResolvedValue({ id: 'rej-1' }) };
        reviewers = {
            findByTaskId: jest.fn().mockResolvedValue([]),
            setState: jest.fn().mockResolvedValue(undefined),
        };
        // The repo matcher reads a Work's repo roles through its accessor
        // methods, so the fixture speaks that interface rather than guessing
        // at column names. `acme/widgets` is the Work's DATA repository —
        // where its Tasks open pull requests, and so the only repository a
        // pull request review can be about (see the two-Works cases below).
        works = {
            findByUser: jest.fn().mockResolvedValue([
                {
                    id: 'work-1',
                    getRepoOwner: () => 'acme',
                    getMainRepo: () => 'widgets-main',
                    getWebsiteRepo: () => null,
                    getDataRepo: () => 'widgets',
                },
            ]),
        };
    });

    afterEach(() => jest.restoreAllMocks());

    describe('rejectTask', () => {
        it('persists the feedback against the Task', async () => {
            await makeSvc().rejectTask('u1', 'task-1', '  needs a migration  ');
            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    taskId: 'task-1',
                    source: 'task-review',
                    feedback: 'needs a migration',
                    workId: 'work-1',
                    reviewerUserId: 'u1',
                }),
            );
        });

        it('⭐ is owner-scoped — a foreign Task is indistinguishable from a missing one', async () => {
            // No existence oracle (architecture/security §9): the same 404
            // whether the row is absent or someone else's.
            tasks.findByIdAndUser.mockResolvedValue(null);
            await expect(makeSvc().rejectTask('u1', 'task-x', 'nope')).rejects.toBeInstanceOf(
                NotFoundException,
            );
            expect(rejections.record).not.toHaveBeenCalled();
        });

        it('refuses an empty rejection — it would prepend an empty block to the next run', async () => {
            await expect(makeSvc().rejectTask('u1', 'task-1', '   ')).rejects.toBeInstanceOf(
                ForbiddenException,
            );
            expect(rejections.record).not.toHaveBeenCalled();
        });

        it('⭐ finally writes task_reviewers.reviewState, the signal that had no writer', async () => {
            // The advisory reviewer state existed with zero production
            // writers. Rejecting through this service is what makes the two
            // records agree instead of drifting.
            reviewers.findByTaskId.mockResolvedValue([
                { id: 'rev-1', reviewerType: 'user', reviewerId: 'u1' },
            ]);
            await makeSvc().rejectTask('u1', 'task-1', 'needs work');
            expect(reviewers.setState).toHaveBeenCalledWith('rev-1', 'requested-changes', 'task-1');
        });

        it('still records the rejection when the reviewer-state sync fails', async () => {
            reviewers.findByTaskId.mockRejectedValue(new Error('db blip'));
            await expect(makeSvc().rejectTask('u1', 'task-1', 'needs work')).resolves.toEqual({
                id: 'rej-1',
            });
        });

        it('leaves reviewer rows belonging to other people alone', async () => {
            reviewers.findByTaskId.mockResolvedValue([
                { id: 'rev-other', reviewerType: 'user', reviewerId: 'someone-else' },
                { id: 'rev-agent', reviewerType: 'agent', reviewerId: 'u1' },
            ]);
            await makeSvc().rejectTask('u1', 'task-1', 'needs work');
            expect(reviewers.setState).not.toHaveBeenCalled();
        });
    });

    describe('recordPullRequestRejection', () => {
        const input = {
            userId: 'u1',
            owner: 'acme',
            repo: 'widgets',
            prNumber: 42,
            feedback: 'the migration has no down()',
            reviewerLabel: 'octocat',
        };

        it('maps the PR to a Work, then to a Task, and records', async () => {
            const row = await makeSvc().recordPullRequestRejection(input);
            expect(row).toEqual({ id: 'rej-1' });
            expect(tasks.findByWorkAndPrNumber).toHaveBeenCalledWith('work-1', 42);
            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    source: 'pull-request',
                    prNumber: 42,
                    reviewerLabel: 'octocat',
                }),
            );
        });

        it('records nothing for a pull request in a repository that is not the Work’s Task repository', async () => {
            // #9 in the Work's MAIN repository is not the pull request its Task
            // #9 opened in the data repository.
            await expect(
                makeSvc().recordPullRequestRejection({ ...input, repo: 'widgets-main' }),
            ).resolves.toBeNull();
            expect(tasks.findByWorkAndPrNumber).not.toHaveBeenCalled();
            expect(rejections.record).not.toHaveBeenCalled();
        });

        /**
         * One account can register a repository as two Works: here an App Work
         * wraps a directory Work's generated website repository `acme/site`.
         * The App Work's Tasks open their pull requests THERE; the directory
         * Work's Task #7 opened #7 in `acme/site-data`, a different pull
         * request. The recorder used to take whichever Work the database
         * listed first, in ANY role — while the resume path reads the review
         * back only from the Work whose Task repository this is.
         */
        const directory = {
            id: 'dir-1',
            kind: 'directory',
            getRepoOwner: () => 'acme',
            getMainRepo: () => 'site-main',
            getWebsiteRepo: () => 'site',
            getDataRepo: () => 'site-data',
        };
        const app = {
            id: 'app-1',
            kind: 'app',
            getRepoOwner: () => 'acme',
            getMainRepo: () => 'site-app-main',
            getWebsiteRepo: () => 'site',
            getDataRepo: () => 'site-app-data',
        };

        it.each([
            ['the directory Work first', () => [directory, app]],
            ['the App Work first', () => [app, directory]],
        ])('records the review on the App Work’s Task with %s', async (_order, list) => {
            works.findByUser = jest.fn().mockResolvedValue(list());
            tasks.findByWorkAndPrNumber = jest.fn(async (workId: string) =>
                workId === 'app-1'
                    ? { id: 'app-task', prNumber: 7 }
                    : { id: 'dir-task', prNumber: 7 },
            );

            await makeSvc().recordPullRequestRejection({ ...input, repo: 'site', prNumber: 7 });

            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({ taskId: 'app-task', workId: 'app-1' }),
            );
            expect(tasks.findByWorkAndPrNumber).not.toHaveBeenCalledWith('dir-1', 7);
        });

        it('returns null when the repo matches no Work', async () => {
            works.findByUser.mockResolvedValue([]);
            await expect(makeSvc().recordPullRequestRejection(input)).resolves.toBeNull();
            expect(rejections.record).not.toHaveBeenCalled();
        });

        it('returns null when the PR maps to no Task', async () => {
            tasks.findByWorkAndPrNumber.mockResolvedValue(null);
            await expect(makeSvc().recordPullRequestRejection(input)).resolves.toBeNull();
        });

        it('⭐ never throws — its caller is a webhook that must answer 200', async () => {
            // A failed rejection record must not turn into a webhook
            // delivery failure and a GitHub retry storm.
            works.findByUser.mockRejectedValue(new Error('db down'));
            await expect(makeSvc().recordPullRequestRejection(input)).resolves.toBeNull();
        });

        it('ignores an empty review body without touching the database', async () => {
            await expect(
                makeSvc().recordPullRequestRejection({ ...input, feedback: '  ' }),
            ).resolves.toBeNull();
            expect(works.findByUser).not.toHaveBeenCalled();
        });

        it('persists the reviewer kind and severity of a trusted-bot finding (R16)', async () => {
            await makeSvc().recordPullRequestRejection({
                ...input,
                reviewerLabel: 'coderabbitai[bot]',
                reviewerKind: 'bot',
                severity: 'major',
            });
            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({
                    source: 'pull-request',
                    reviewerLabel: 'coderabbitai[bot]',
                    reviewerKind: 'bot',
                    severity: 'major',
                }),
            );
        });

        it('stores NULL kind and severity when the caller states none', async () => {
            await makeSvc().recordPullRequestRejection(input);
            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({ reviewerKind: null, severity: null }),
            );
        });
    });

    describe('recordGateRejection', () => {
        it('persists machine feedback so a LATER resume can replay it', async () => {
            // The iterate loop already fed this to the run that was
            // executing — but that run is terminal and its context is gone.
            await makeSvc().recordGateRejection({
                taskId: 'task-1',
                workId: 'work-1',
                runId: 'run-1',
                feedback: 'Quality gate: build failed',
            });
            expect(rejections.record).toHaveBeenCalledWith(
                expect.objectContaining({ source: 'gate', runId: 'run-1' }),
            );
        });
    });
});
