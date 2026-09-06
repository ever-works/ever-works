import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { DataSource, Repository } from 'typeorm';
import type { GitPullRequestStatus } from '@ever-works/plugin';
import {
    PROMOTION_GATE_DECISION_GRACE_MS,
    PROMOTION_GATE_OVERRIDE_LABEL,
    PROMOTION_TASK_LABEL,
} from '@ever-works/contracts';
import { ReleasePromotion } from '@src/entities/release-promotion.entity';
import { ReleasePromotionRepository } from '@src/database/repositories/release-promotion.repository';
import { TaskStatus } from '@src/entities/task.entity';
import { ReleasePromotionService } from '../release-promotion.service';

/**
 * Release promotion lane (self-build slice AI, EW-808).
 *
 * The REAL `ReleasePromotionRepository` over a real (in-memory sqlite)
 * `release_promotions` table, so the UNIQUE `(workId, rung, laneKey)`
 * index — the whole anti-duplicate guarantee — is exercised rather than
 * mocked. Only the things at the edges of the process are stubbed: the git
 * provider, the Task writer and the Inbox.
 *
 * What this file is mostly about is REFUSALS. The happy path is three
 * tests; everything else is a way the lane must say no.
 */
describe('ReleasePromotionService', () => {
    let dataSource: DataSource;
    let rows: Repository<ReleasePromotion>;
    let promotions: ReleasePromotionRepository;

    const USER = 'user-1';
    const WORK = 'work-1';
    const AGENT = 'agent-1';
    const HEAD = 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa';
    const NEXT_HEAD = 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb';

    const LADDER = { integration: 'develop', staging: 'stage', production: 'main' };

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: [ReleasePromotion],
            synchronize: true,
        });
        await dataSource.initialize();
        rows = dataSource.getRepository(ReleasePromotion);
        promotions = new ReleasePromotionRepository(rows);
    });

    afterAll(async () => {
        await dataSource.destroy();
    });

    beforeEach(async () => {
        await rows.clear();
    });

    // ── Harness ───────────────────────────────────────────────────────

    function makeWork(overrides: Record<string, unknown> = {}) {
        return {
            id: WORK,
            slug: 'ever-works',
            userId: USER,
            gitProvider: 'github',
            tenantId: null,
            organizationId: null,
            releaseLadder: LADDER,
            getRepoOwner: () => 'ever-works',
            getDataRepo: () => 'ever-works',
            ...overrides,
        };
    }

    function makeTask(overrides: Record<string, unknown> = {}) {
        return {
            id: 'task-1',
            slug: 'T-7',
            userId: USER,
            agentId: AGENT,
            workId: WORK,
            labels: [PROMOTION_TASK_LABEL, 'release:promotion:develop-to-stage'],
            tenantId: null,
            organizationId: null,
            prNumber: 42,
            ...overrides,
        };
    }

    function build(
        opts: {
            work?: Record<string, unknown> | null;
            branches?: Array<{ name: string; commit: string }>;
            pullRequest?: Record<string, unknown>;
            livePullRequest?: Record<string, unknown> | null;
            workflowRun?: Record<string, unknown> | null;
            createPullRequestError?: Error;
            listBranchesError?: Error;
            workflowRunError?: Error;
            noGitFacade?: boolean;
            noInbox?: boolean;
            createTaskError?: Error;
            /** Pull requests already open on the provider, for the ADOPT path. */
            openPullRequests?: Array<Record<string, unknown>>;
            /** What `getPullRequestStatus` reports as the pull request's own head. */
            confirmedHead?: string | null;
            /** Make the writes that BIND the pull request to the Task fail. */
            bindError?: Error;
        } = {},
    ) {
        const created = makeTask();
        const works = {
            findById: jest.fn().mockResolvedValue(opts.work === null ? null : makeWork(opts.work)),
        };
        const tasks = {
            updateById: opts.bindError
                ? jest.fn().mockImplementation((_id: string, patch: Record<string, unknown>) =>
                      // Only the PR binding fails; the CANCELLED write that
                      // follows must still work, or the test would be
                      // asserting two failures at once.
                      'prNumber' in patch
                          ? Promise.reject(opts.bindError)
                          : Promise.resolve(undefined),
                  )
                : jest.fn().mockResolvedValue(undefined),
        };
        const tasksService = {
            create: opts.createTaskError
                ? jest.fn().mockRejectedValue(opts.createTaskError)
                : jest.fn().mockResolvedValue(created),
        };
        const chat = { create: jest.fn().mockResolvedValue(undefined) };
        const gitFacade = {
            listBranches: opts.listBranchesError
                ? jest.fn().mockRejectedValue(opts.listBranchesError)
                : jest.fn().mockResolvedValue(
                      opts.branches ?? [
                          { name: 'develop', commit: HEAD, isDefault: true },
                          {
                              name: 'stage',
                              commit: 'cccccccccccccccccccccccccccccccccccccccc',
                              isDefault: false,
                          },
                          {
                              name: 'main',
                              commit: 'dddddddddddddddddddddddddddddddddddddddd',
                              isDefault: false,
                          },
                      ],
                  ),
            createPullRequest: opts.createPullRequestError
                ? jest.fn().mockRejectedValue(opts.createPullRequestError)
                : jest.fn().mockImplementation((prOptions: { head: string; base: string }) => ({
                      number: 42,
                      url: 'https://github.com/ever-works/ever-works/pull/42',
                      // A well-behaved provider echoes what it was asked
                      // for. `opts.pullRequest` is how a test makes it
                      // misbehave.
                      head: prOptions.head,
                      base: prOptions.base,
                      state: 'open',
                      title: `release: ${prOptions.head} -> ${prOptions.base}`,
                      createdAt: '',
                      updatedAt: '',
                      ...opts.pullRequest,
                  })),
            getPullRequest: jest.fn().mockResolvedValue(
                opts.livePullRequest === null
                    ? null
                    : {
                          number: 42,
                          head: 'develop',
                          base: 'stage',
                          state: 'open',
                          labels: [],
                          ...opts.livePullRequest,
                      },
            ),
            // The ADOPT path: what is already open on the provider.
            listPullRequests: jest.fn().mockResolvedValue(opts.openPullRequests ?? []),
            // `GitPullRequest` carries no head SHA; this read is what
            // confirms the commit the pull request actually heads.
            getPullRequestStatus: jest.fn().mockResolvedValue(
                opts.confirmedHead === null
                    ? null
                    : {
                          number: 42,
                          state: 'open',
                          headSha: opts.confirmedHead ?? HEAD,
                      },
            ),
            getWorkflowRunForCommit: opts.workflowRunError
                ? jest.fn().mockRejectedValue(opts.workflowRunError)
                : jest.fn().mockResolvedValue(opts.workflowRun ?? null),
        };
        const inbox = { notice: jest.fn().mockResolvedValue(undefined) };

        const service = new ReleasePromotionService(
            works as never,
            tasks as never,
            promotions,
            tasksService as never,
            chat as never,
            opts.noGitFacade ? undefined : (gitFacade as never),
            opts.noInbox ? undefined : (inbox as never),
        );
        return { service, works, tasks, tasksService, chat, gitFacade, inbox, created };
    }

    function status(overrides: Partial<GitPullRequestStatus> = {}): GitPullRequestStatus {
        return {
            number: 42,
            state: 'open',
            merged: false,
            mergeable: true,
            headSha: HEAD,
            reviewDecision: null,
            ciState: 'passing',
            checks: [],
            checksComplete: true,
            url: 'https://github.com/ever-works/ever-works/pull/42',
            title: 'release: develop -> stage',
            ...overrides,
        } as GitPullRequestStatus;
    }

    // ── Opening ───────────────────────────────────────────────────────

    describe('openPromotion', () => {
        it('opens the pull request the LADDER names, not one the caller does', async () => {
            const { service, gitFacade } = build();
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });

            expect(result.outcome).toBe('opened');
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
            const [prOptions] = gitFacade.createPullRequest.mock.calls[0];
            expect(prOptions).toMatchObject({
                owner: 'ever-works',
                repo: 'ever-works',
                head: 'develop',
                base: 'stage',
            });
        });

        it('resolves the other rung off the same ladder', async () => {
            const { service, gitFacade } = build();
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'stage-to-main',
                agentId: AGENT,
            });
            expect(gitFacade.createPullRequest.mock.calls[0][0]).toMatchObject({
                head: 'stage',
                base: 'main',
            });
        });

        it('files the Task IN_REVIEW so the TODO fan-out can never dispatch a run against it', async () => {
            const { service, tasksService } = build();
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const [, input] = tasksService.create.mock.calls[0];
            expect(input.status).toBe(TaskStatus.IN_REVIEW);
            expect(input.labels).toContain(PROMOTION_TASK_LABEL);
            expect(input.workId).toBe(WORK);
            expect(input.agentId).toBe(AGENT);
        });

        it('binds the pull request to the Task, which is what puts it on the slice-AE merge path', async () => {
            const { service, tasks } = build();
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
                prNumber: 42,
                prUrl: 'https://github.com/ever-works/ever-works/pull/42',
            });
        });

        it('NEVER writes the release branch into task.branchRef — that slot is the branch reaper’s', async () => {
            // `branchRef` is what `discardBranch` (DELETE
            // /api/tasks/:id/branch) and the nightly
            // `findBranchCleanupCandidates` sweep hand to
            // `gitFacade.deleteBranch`, and what `runWorkspace` provisions
            // an agent run onto. Writing `develop` there aimed the branch
            // reaper at the integration branch and let a run push straight
            // to it with no pull request. A promotion owns no branch: it
            // moves two that already exist.
            const { service, tasks } = build();
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            for (const [, patch] of tasks.updateById.mock.calls) {
                expect(patch).not.toHaveProperty('branchRef');
                expect(patch).not.toHaveProperty('branchState');
            }
            // And the row therefore cannot match the GC query, whose first
            // clause is `task.branchRef IS NOT NULL`.
            const written = tasks.updateById.mock.calls.map(
                ([, patch]: [string, Record<string, unknown>]) => patch.branchRef,
            );
            expect(written.some((value: unknown) => value === 'develop')).toBe(false);
        });

        it('records the head it opened at', async () => {
            const { service } = build();
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const stored = await rows.findOne({
                where: { id: (result as { promotion: ReleasePromotion }).promotion.id },
            });
            expect(stored?.headSha).toBe(HEAD);
            expect(stored?.headBranch).toBe('develop');
            expect(stored?.baseBranch).toBe('stage');
            expect(stored?.state).toBe('open');
        });

        // ── Duplicates and races ──────────────────────────────────────

        it('refuses a SECOND promotion for the same rung — a re-run does not duplicate one', async () => {
            const { service, gitFacade } = build();
            const first = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const second = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });

            expect(first.outcome).toBe('opened');
            expect(second.outcome).toBe('already-open');
            expect((second as { promotion: ReleasePromotion }).promotion.id).toBe(
                (first as { promotion: ReleasePromotion }).promotion.id,
            );
            // The load-bearing assertion: no second pull request.
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        });

        it('opens ONE pull request when two merges to develop race', async () => {
            // Two callers, two service instances, one database — the shape
            // of the cron worker racing an operator. Only the UNIQUE index
            // can decide this; a read-then-write would open two.
            const a = build();
            const b = build({
                branches: [
                    { name: 'develop', commit: NEXT_HEAD },
                    { name: 'stage', commit: HEAD },
                ],
            });
            const [first, second] = await Promise.all([
                a.service.openPromotion({
                    userId: USER,
                    workId: WORK,
                    rung: 'develop-to-stage',
                    agentId: AGENT,
                }),
                b.service.openPromotion({
                    userId: USER,
                    workId: WORK,
                    rung: 'develop-to-stage',
                    agentId: AGENT,
                }),
            ]);

            const outcomes = [first.outcome, second.outcome].sort();
            expect(outcomes).toEqual(['already-open', 'opened']);
            const opened =
                a.gitFacade.createPullRequest.mock.calls.length +
                b.gitFacade.createPullRequest.mock.calls.length;
            expect(opened).toBe(1);
            expect(await rows.count()).toBe(1);
        });

        it('allows the OTHER rung to be open at the same time', async () => {
            const { service } = build();
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const other = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'stage-to-main',
                agentId: AGENT,
            });
            expect(other.outcome).toBe('opened');
        });

        // ── Refusals ──────────────────────────────────────────────────

        it('refuses a Work with no ladder rather than guessing main', async () => {
            const { service, gitFacade } = build({ work: { releaseLadder: null } });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'stage-to-main',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'ladder-not-configured' });
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(await rows.count()).toBe(0);
        });

        it('refuses a ladder that is not three distinct plain branch names', async () => {
            for (const ladder of [
                { integration: 'develop', staging: 'develop', production: 'main' },
                { integration: '../evil', staging: 'stage', production: 'main' },
                { integration: 'develop', staging: 'stage' },
            ]) {
                const { service } = build({ work: { releaseLadder: ladder } });
                const result = await service.openPromotion({
                    userId: USER,
                    workId: WORK,
                    rung: 'develop-to-stage',
                    agentId: AGENT,
                });
                expect(result).toMatchObject({ outcome: 'refused', code: 'ladder-not-configured' });
            }
            expect(await rows.count()).toBe(0);
        });

        it('refuses a Work owned by somebody else, with the same words as a missing one', async () => {
            const { service } = build({ work: { userId: 'someone-else' } });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'work-not-found' });
        });

        it('refuses when the head branch does not exist', async () => {
            const { service, gitFacade } = build({ branches: [{ name: 'stage', commit: HEAD }] });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'head-branch-missing' });
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
        });

        it('refuses when the base branch does not exist', async () => {
            const { service } = build({ branches: [{ name: 'develop', commit: HEAD }] });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'base-branch-missing' });
        });

        it('refuses when the head commit cannot be read', async () => {
            const { service } = build({
                branches: [
                    { name: 'develop', commit: 'not-a-sha' },
                    { name: 'stage', commit: HEAD },
                ],
            });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'head-sha-unknown' });
        });

        it('refuses when the branch listing itself fails, and claims no lane', async () => {
            const { service } = build({ listBranchesError: new Error('403 no scope') });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'head-sha-unknown' });
            expect(await rows.count()).toBe(0);
        });

        it('refuses when no git provider is wired', async () => {
            const { service } = build({ noGitFacade: true });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'no-git-provider' });
        });

        it('frees the lane when the pull request could not be opened', async () => {
            const { service } = build({
                createPullRequestError: new Error('422 no commits between'),
            });
            const first = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(first).toMatchObject({ outcome: 'refused', code: 'pull-request-failed' });
            // A failed attempt must not hold the lane hostage.
            const retry = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(retry.outcome).toBe('refused');
            const stored = await rows.find();
            expect(stored.every((row) => row.state === 'refused')).toBe(true);
        });

        it('leaves NO promotion-labelled Task behind when the pull request could not be opened', async () => {
            // The Task is filed before the pull request exists (the pull
            // request body names it). A failure used to leave it in
            // `in_review` wearing the promotion labels with nothing behind
            // it — indistinguishable on the board from a real promotion,
            // and one more per retry.
            const { service, tasks } = build({
                createPullRequestError: new Error('422 already exists'),
            });
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(tasks.updateById).toHaveBeenCalledWith('task-1', {
                status: TaskStatus.CANCELLED,
            });
        });

        // ── Adopting what a human already opened ──────────────────────

        it('ADOPTS the pull request already open for head → base instead of asking for a second', async () => {
            // The founder performs this promotion by hand today, so an open
            // `develop -> stage` is the NORMAL state of the world the first
            // time the lane runs. GitHub answers a second request for the
            // same pair with a 422.
            const { service, gitFacade } = build({
                openPullRequests: [
                    {
                        number: 99,
                        url: 'https://github.com/ever-works/ever-works/pull/99',
                        head: 'develop',
                        base: 'stage',
                        state: 'open',
                    },
                ],
            });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });

            expect(result.outcome).toBe('opened');
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect((await rows.find())[0].prNumber).toBe(99);
        });

        it('does not adopt an open pull request between OTHER branches', async () => {
            const { service, gitFacade } = build({
                openPullRequests: [
                    { number: 99, head: 'feature/x', base: 'stage', state: 'open' },
                    { number: 98, head: 'develop', base: 'main', state: 'open' },
                ],
            });
            await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        });

        // ── The head it claims is the head it has ─────────────────────

        it('records the PULL REQUEST’s head, not the branch tip it read a round trip earlier', async () => {
            // Two merges to `develop` seconds apart: the tip read before the
            // lane was claimed is already stale by the time the pull request
            // exists. Publishing the older commit names something that is
            // not what gets promoted, and costs a spurious "head moved"
            // report plus a fresh 20-minute grace window on the next sweep.
            const { service } = build({ confirmedHead: NEXT_HEAD });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const stored = await rows.findOne({
                where: { id: (result as { promotion: ReleasePromotion }).promotion.id },
            });
            expect(stored?.headSha).toBe(NEXT_HEAD);
        });

        it('falls back to the branch tip when the head cannot be confirmed, and SAYS it did', async () => {
            const { service, chat } = build({ confirmedHead: null });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            const stored = await rows.findOne({
                where: { id: (result as { promotion: ReleasePromotion }).promotion.id },
            });
            expect(stored?.headSha).toBe(HEAD);
            expect(chat.create.mock.calls.at(-1)?.[0].body).toMatch(/could not be read back/);
        });

        it('frees the lane — and adopts on retry — when the pull request opened but could not be recorded', async () => {
            // The window this used to wedge: a real pull request is open and
            // the platform cannot watch it, the lane is held by a row with
            // no `prNumber`, and nothing sweeps such a row.
            const { service, gitFacade } = build({ bindError: new Error('db gone') });
            const first = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(first).toMatchObject({ outcome: 'refused', code: 'promotion-not-recorded' });
            expect((await rows.find()).every((row) => row.state === 'refused')).toBe(true);

            // The lane is free, and a retry that can see the pull request
            // adopts it rather than opening a second one.
            const retry = build({
                openPullRequests: [{ number: 42, head: 'develop', base: 'stage', state: 'open' }],
            });
            const second = await retry.service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(second.outcome).toBe('opened');
            expect(retry.gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(gitFacade.createPullRequest).toHaveBeenCalledTimes(1);
        });

        it('frees the lane when the Task could not be filed', async () => {
            const { service, gitFacade } = build({
                createTaskError: new Error('Agent not found.'),
            });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result.outcome).toBe('refused');
            expect(gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect((await rows.find())[0].state).toBe('refused');
        });

        it('DISOWNS a pull request the provider opened between different branches', async () => {
            // PROMOTING THE WRONG THING. The provider is the authority on
            // what it created; if it is not the promotion we asked for, the
            // lane refuses instead of adopting it.
            const { service, chat } = build({ pullRequest: { head: 'develop', base: 'main' } });
            const result = await service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            expect(result).toMatchObject({ outcome: 'refused', code: 'branches-not-as-claimed' });
            expect((await rows.find())[0].refusalCode).toBe('branches-not-as-claimed');
            expect(chat.create.mock.calls.at(-1)?.[0].body).toMatch(
                /NOT managed by this promotion/,
            );
        });

        it('accepts a provider head qualified as owner:branch, and refuses a fork head', async () => {
            const same = build({ pullRequest: { head: 'ever-works:develop', base: 'stage' } });
            await expect(
                same.service.openPromotion({
                    userId: USER,
                    workId: WORK,
                    rung: 'develop-to-stage',
                    agentId: AGENT,
                }),
            ).resolves.toMatchObject({ outcome: 'opened' });

            await rows.clear();
            const fork = build({ pullRequest: { head: 'attacker:develop-x', base: 'stage' } });
            await expect(
                fork.service.openPromotion({
                    userId: USER,
                    workId: WORK,
                    rung: 'develop-to-stage',
                    agentId: AGENT,
                }),
            ).resolves.toMatchObject({ outcome: 'refused', code: 'branches-not-as-claimed' });
        });
    });

    // ── Watching ──────────────────────────────────────────────────────

    describe('onPullRequestStatusRefreshed', () => {
        async function openOne(harness: ReturnType<typeof build>) {
            const result = await harness.service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            return (result as { promotion: ReleasePromotion; task: { id: string } }).promotion;
        }

        it('ignores a Task that is not a promotion', async () => {
            const harness = build();
            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask({ labels: ['chore'] }) as never,
                status(),
            );
            expect(outcome).toEqual({ action: 'not-a-promotion' });
            expect(harness.gitFacade.getWorkflowRunForCommit).not.toHaveBeenCalled();
        });

        it.each([
            ['a completed success', { status: 'completed', conclusion: 'success' }, 'success'],
            ['a running gate', { status: 'in_progress', conclusion: null }, 'pending'],
            ['a failure', { status: 'completed', conclusion: 'failure' }, 'failure'],
            ['a cancelled run', { status: 'completed', conclusion: 'cancelled' }, 'cancelled'],
            ['a skipped run', { status: 'completed', conclusion: 'skipped' }, 'skipped'],
        ])(
            'records %s as %s, stamped with the commit it was about',
            async (_label, run, expected) => {
                const harness = build({
                    workflowRun: {
                        id: 1,
                        workflowPath: '.github/workflows/promotion-gate.yml',
                        headSha: HEAD,
                        ...run,
                    },
                });
                const promotion = await openOne(harness);
                await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());

                const stored = await rows.findOne({ where: { id: promotion.id } });
                expect(stored?.gateVerdict).toBe(expected);
                expect(stored?.gateVerdictSha).toBe(HEAD);
            },
        );

        it('records an ABSENT gate when the workflow has no run for the commit', async () => {
            const harness = build({ workflowRun: null });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'absent',
            );
        });

        it('records an UNREADABLE gate when the lookup throws — a broken gate is not a missing run', async () => {
            const harness = build({ workflowRunError: new Error('403 actions:read') });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'unreadable',
            );
        });

        it('asks the provider for the NAMED workflow and the LIVE head', async () => {
            const harness = build();
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.gitFacade.getWorkflowRunForCommit).toHaveBeenCalledWith(
                'ever-works',
                'ever-works',
                'promotion-gate.yml',
                HEAD,
                expect.objectContaining({ providerId: 'github', workId: WORK }),
            );
        });

        it('DROPS a recorded verdict when the head moves', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
            });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'success',
            );

            // New commit pushed to develop. The gate has not judged it.
            harness.gitFacade.getWorkflowRunForCommit.mockResolvedValue(null);
            await harness.service.onPullRequestStatusRefreshed(
                makeTask() as never,
                status({ headSha: NEXT_HEAD }),
            );
            const after = await rows.findOne({ where: { id: promotion.id } });
            expect(after?.headSha).toBe(NEXT_HEAD);
            expect(after?.gateVerdict).toBe('absent');
            expect(after?.gateVerdictSha).toBe(NEXT_HEAD);
        });

        it('REFUSES the promotion when the pull request is no longer between the branches it claims', async () => {
            const harness = build();
            const promotion = await openOne(harness);
            harness.gitFacade.getPullRequest.mockResolvedValue({
                number: 42,
                head: 'develop',
                base: 'main',
                state: 'open',
            });
            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask() as never,
                status(),
            );
            expect(outcome).toEqual({ action: 'refused', code: 'branches-moved' });
            const stored = await rows.findOne({ where: { id: promotion.id } });
            expect(stored?.state).toBe('refused');
            expect(stored?.refusalCode).toBe('branches-moved');
        });

        it('records UNREADABLE when the pull request cannot be re-read, rather than trusting the cache', async () => {
            const harness = build({ livePullRequest: null });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'unreadable',
            );
        });

        it('never throws — a provider hiccup must not fail the PR-status sweep', async () => {
            const harness = build();
            await openOne(harness);
            harness.gitFacade.getPullRequest.mockRejectedValue(new Error('socket hang up'));
            await expect(
                harness.service.onPullRequestStatusRefreshed(makeTask() as never, status()),
            ).resolves.toMatchObject({ action: 'observed' });
        });

        // ── THE no-cascade property ───────────────────────────────────

        it('frees the lane on merge and opens NOTHING — stage → main is a separate human act', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
            });
            const promotion = await openOne(harness);
            harness.gitFacade.createPullRequest.mockClear();
            harness.tasksService.create.mockClear();

            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask() as never,
                status({ state: 'merged', merged: true }),
            );

            expect(outcome).toEqual({ action: 'closed', state: 'merged' });
            // THE assertion this slice exists for.
            expect(harness.gitFacade.createPullRequest).not.toHaveBeenCalled();
            expect(harness.tasksService.create).not.toHaveBeenCalled();
            expect(await rows.count()).toBe(1);

            const stored = await rows.findOne({ where: { id: promotion.id } });
            expect(stored?.state).toBe('merged');
            // The lane is free for a human to open the next rung — later,
            // by hand.
            expect(stored?.laneKey).not.toBe('open');
            expect(harness.chat.create.mock.calls.at(-1)?.[0].body).toMatch(
                /not opened automatically/i,
            );
        });

        it('frees the lane when the promotion pull request is closed unmerged', async () => {
            const harness = build();
            const promotion = await openOne(harness);
            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask() as never,
                status({ state: 'closed' }),
            );
            expect(outcome).toEqual({ action: 'closed', state: 'closed' });
            expect((await rows.findOne({ where: { id: promotion.id } }))?.state).toBe('closed');
        });

        // ── The one Inbox item ────────────────────────────────────────

        it('files ONE Inbox notice per head, however many times the sweep runs', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
            });
            await openOne(harness);
            for (let i = 0; i < 5; i += 1) {
                await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            }
            expect(harness.inbox.notice).toHaveBeenCalledTimes(1);
            const [userId, item] = harness.inbox.notice.mock.calls[0];
            expect(userId).toBe(USER);
            expect(item.title).toMatch(/PASSED/);
            expect(item.taskId).toBe('task-1');
            expect(item.body).toMatch(/Nothing merges until you approve it/);
        });

        it('files a NEW notice for a NEW head', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'failure', headSha: HEAD },
            });
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            await harness.service.onPullRequestStatusRefreshed(
                makeTask() as never,
                status({ headSha: NEXT_HEAD }),
            );
            expect(harness.inbox.notice).toHaveBeenCalledTimes(2);
        });

        it('says plainly that a non-success gate blocks the merge', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'skipped', headSha: HEAD },
            });
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            const [, item] = harness.inbox.notice.mock.calls[0];
            expect(item.title).toMatch(/SKIPPED/);
            expect(item.body).toMatch(/will NOT be offered for merge/);
        });

        it('waits out the grace window before crying "no gate run"', async () => {
            const harness = build({ workflowRun: null });
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            // A run does not exist the instant a pull request opens.
            expect(harness.inbox.notice).not.toHaveBeenCalled();
        });

        it('does tell the human once an ABSENT gate has stayed absent past the grace window', async () => {
            const harness = build({ workflowRun: null });
            const promotion = await openOne(harness);
            await rows.update(
                { id: promotion.id },
                { headRecordedAt: new Date(Date.now() - PROMOTION_GATE_DECISION_GRACE_MS - 1000) },
            );
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.inbox.notice).toHaveBeenCalledTimes(1);
            expect(harness.inbox.notice.mock.calls[0][1].title).toMatch(/ABSENT/);
        });

        it('still files the DECIDING verdict after a stuck reading already used the commit’s slot', async () => {
            // The composition of the two tests above, which is where the
            // bug lived: keyed on the commit ALONE, the first post-grace
            // `pending`/`absent` consumed the one-notice slot and the
            // verdict that actually decided the promotion — including a
            // FAILURE — was suppressed for that commit. `pending` past
            // twenty minutes is routine on this gate (`node-contract` has a
            // 20-minute budget plus self-hosted ARC queue time), and one
            // transient 403 recorded as `unreadable` does the same.
            const harness = build({ workflowRun: null });
            const promotion = await openOne(harness);
            await rows.update(
                { id: promotion.id },
                { headRecordedAt: new Date(Date.now() - PROMOTION_GATE_DECISION_GRACE_MS - 1000) },
            );
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.inbox.notice.mock.calls[0][1].title).toMatch(/ABSENT/);

            harness.gitFacade.getWorkflowRunForCommit.mockResolvedValue({
                id: 1,
                status: 'completed',
                conclusion: 'failure',
                headSha: HEAD,
            });
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());

            expect(harness.inbox.notice).toHaveBeenCalledTimes(2);
            expect(harness.inbox.notice.mock.calls[1][1].title).toMatch(/FAILURE/);
        });

        it('collapses a pending → unreadable → pending flap into ONE notice', async () => {
            // The other half of the same key: every undecided reading
            // shares the `'stuck'` token, so a flapping gate is one item
            // rather than one per sweep.
            const harness = build({
                workflowRun: { id: 1, status: 'in_progress', conclusion: null, headSha: HEAD },
            });
            const promotion = await openOne(harness);
            await rows.update(
                { id: promotion.id },
                { headRecordedAt: new Date(Date.now() - PROMOTION_GATE_DECISION_GRACE_MS - 1000) },
            );
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            harness.gitFacade.getWorkflowRunForCommit.mockRejectedValueOnce(new Error('503'));
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            harness.gitFacade.getWorkflowRunForCommit.mockResolvedValue({
                id: 1,
                status: 'queued',
                conclusion: null,
                headSha: HEAD,
            });
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());

            expect(harness.inbox.notice).toHaveBeenCalledTimes(1);
        });

        // ── An overridden gate is not a green one ─────────────────────

        it('says the E2E leg was WAIVED when the override label is on the pull request', async () => {
            // `promotion-gate.yml` exits 0 on `override-e2e-gate` in all
            // four of its failure branches, and GitHub folds that into a
            // plain `success` run conclusion. Read from the run alone,
            // "green" and "somebody applied a label" are identical — and
            // this notice is the one artefact the founder reads before
            // deciding a production release.
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
                livePullRequest: { labels: [PROMOTION_GATE_OVERRIDE_LABEL] },
            });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());

            const [, item] = harness.inbox.notice.mock.calls[0];
            expect(item.title).toMatch(/WAIVED/);
            expect(item.title).not.toMatch(/^Promotion gate PASSED for/);
            expect(item.body).toMatch(/WAIVED, NOT GREEN/);
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateOverridden).toBe(
                true,
            );
        });

        it('files a SECOND notice when a red gate is overridden into a pass on the same commit', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'failure', headSha: HEAD },
            });
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.inbox.notice.mock.calls[0][1].title).toMatch(/FAILURE/);

            // A maintainer applies the label; the `labeled` trigger re-runs
            // the gate and it now concludes success.
            harness.gitFacade.getWorkflowRunForCommit.mockResolvedValue({
                id: 2,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            harness.gitFacade.getPullRequest.mockResolvedValue({
                number: 42,
                head: 'develop',
                base: 'stage',
                state: 'open',
                labels: [PROMOTION_GATE_OVERRIDE_LABEL],
            });
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());

            expect(harness.inbox.notice).toHaveBeenCalledTimes(2);
            expect(harness.inbox.notice.mock.calls[1][1].title).toMatch(/WAIVED/);
        });

        it('says which legs the rung actually evaluated, and the two rungs differ', async () => {
            // On `develop -> stage` the gate's `e2e-result` job SKIPS by
            // design (its `if:` requires a `stage` head), so the run
            // concludes `success` off `node-contract` alone. "PASSED" then
            // means something materially narrower than it does on the
            // second rung, and the operator reads the Inbox item, not the
            // runbook.
            const first = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
            });
            await openOne(first);
            await first.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(first.inbox.notice.mock.calls[0][1].body).toMatch(
                /node wire contract ONLY[\s\S]*NO end-to-end result was consulted/,
            );

            await rows.clear();
            const second = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'success', headSha: HEAD },
                livePullRequest: { head: 'stage', base: 'main' },
            });
            await second.service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'stage-to-main',
                agentId: AGENT,
            });
            await second.service.onPullRequestStatusRefreshed(
                makeTask({
                    labels: [PROMOTION_TASK_LABEL, 'release:promotion:stage-to-main'],
                }) as never,
                status(),
            );
            expect(second.inbox.notice.mock.calls[0][1].body).toMatch(
                /node wire contract AND stage’s own end-to-end result/,
            );
        });

        // ── The row, not the label, is the identity ───────────────────

        it('keeps watching a live promotion whose Task labels have been stripped', async () => {
            // Same PATCH as the guard test: clearing the labels used to
            // freeze the lane — no more gate readings, no more Inbox items
            // — while the row still said `open`.
            const harness = build({
                workflowRun: { id: 1, status: 'completed', conclusion: 'failure', headSha: HEAD },
            });
            const promotion = await openOne(harness);
            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask({ labels: [] }) as never,
                status(),
            );
            expect(outcome).toMatchObject({ action: 'observed', verdict: 'failure' });
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'failure',
            );
        });

        it('REFUSES when the Task’s pull request has been rebound away from the promotion', async () => {
            // An agent run on the promotion Task opens its own pull request
            // and overwrites `tasks.prNumber`. Everything downstream — the
            // head, the gate verdict, the merged/closed decision — comes
            // from the status read for THAT pull request, so the promotion
            // would end up recording promotion-gate.yml's answer about
            // somebody else's work.
            const harness = build();
            const promotion = await openOne(harness);
            const outcome = await harness.service.onPullRequestStatusRefreshed(
                makeTask({ prNumber: 77 }) as never,
                status({ number: 77 }),
            );
            expect(outcome).toEqual({ action: 'refused', code: 'pull-request-rebound' });
            const stored = await rows.findOne({ where: { id: promotion.id } });
            expect(stored?.state).toBe('refused');
            expect(stored?.refusalCode).toBe('pull-request-rebound');
        });

        it('ignores a gate run that belongs to a DIFFERENT pull request on the same commit', async () => {
            // A workflow run is keyed by COMMIT, and one commit can head
            // more than one pull request. The override label is per pull
            // request, so adopting the wrong run is exactly the case that
            // matters.
            const harness = build({
                workflowRun: {
                    id: 1,
                    status: 'completed',
                    conclusion: 'success',
                    headSha: HEAD,
                    pullRequestNumbers: [4242],
                },
            });
            const promotion = await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect((await rows.findOne({ where: { id: promotion.id } }))?.gateVerdict).toBe(
                'absent',
            );
        });

        it('reports a verdict CHANGE into the Task, and does not repeat itself', async () => {
            const harness = build({
                workflowRun: { id: 1, status: 'in_progress', conclusion: null, headSha: HEAD },
            });
            await openOne(harness);
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            const afterFirst = harness.chat.create.mock.calls.length;
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.chat.create.mock.calls.length).toBe(afterFirst);

            harness.gitFacade.getWorkflowRunForCommit.mockResolvedValue({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            expect(harness.chat.create.mock.calls.length).toBe(afterFirst + 1);
            expect(harness.chat.create.mock.calls.at(-1)?.[0].body).toMatch(/PASSED/);
        });
    });

    // ── The guard ─────────────────────────────────────────────────────

    describe('assessPromotionForMerge', () => {
        async function openAndObserve(run: Record<string, unknown> | null) {
            const harness = build({ workflowRun: run });
            const opened = await harness.service.openPromotion({
                userId: USER,
                workId: WORK,
                rung: 'develop-to-stage',
                agentId: AGENT,
            });
            await harness.service.onPullRequestStatusRefreshed(makeTask() as never, status());
            return { harness, promotion: (opened as { promotion: ReleasePromotion }).promotion };
        }

        it('leaves a non-promotion Task alone', async () => {
            const { service } = build();
            await expect(
                service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: ['chore'],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toEqual({ promotion: false });
        });

        it('allows a promotion whose gate said success for exactly this commit', async () => {
            const { harness, promotion } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toEqual({
                promotion: true,
                allowed: true,
                promotionId: promotion.id,
                // The promotion's OWN branches travel with the allowance —
                // the merge path's default base is the Work's
                // `taskIsolationBaseBranch`, which is right for every Task
                // pull request and wrong for every promotion.
                headBranch: 'develop',
                baseBranch: 'stage',
                prNumber: 42,
            });
        });

        it('is NOT disarmed by stripping the Task’s labels — the ROW is the identity', async () => {
            // `PATCH /api/tasks/:id {"labels":[]}` is available to any
            // owner (`TasksService.update` applies `input.labels`
            // verbatim). The guard used to short-circuit on the labels one
            // line ABOVE the row lookup, so one request turned a live
            // release pull request into an ordinary agent merge with the
            // promotion gate never consulted.
            const { harness } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'failure',
                headSha: HEAD,
            });
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toMatchObject({
                promotion: true,
                allowed: false,
                code: 'promotion-gate-not-success',
            });
        });

        it('refuses a pull request that is not the one the promotion opened', async () => {
            // An agent run on the promotion Task overwrites
            // `tasks.prNumber` with its own pull request. A verdict
            // recorded for one pull request must never authorise the merge
            // of another.
            const { harness } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 77,
                    headSha: HEAD,
                }),
            ).resolves.toMatchObject({
                promotion: true,
                allowed: false,
                code: 'promotion-pull-request-mismatch',
            });
        });

        it.each([
            ['pending', { id: 1, status: 'in_progress', conclusion: null, headSha: HEAD }],
            ['failure', { id: 1, status: 'completed', conclusion: 'failure', headSha: HEAD }],
            ['cancelled', { id: 1, status: 'completed', conclusion: 'cancelled', headSha: HEAD }],
            ['skipped', { id: 1, status: 'completed', conclusion: 'skipped', headSha: HEAD }],
            [
                'neutral (skipped)',
                { id: 1, status: 'completed', conclusion: 'neutral', headSha: HEAD },
            ],
            ['absent', null],
        ])('refuses a %s gate', async (_label, run) => {
            const { harness } = await openAndObserve(run as Record<string, unknown> | null);
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toMatchObject({
                promotion: true,
                allowed: false,
                code: 'promotion-gate-not-success',
            });
        });

        it('refuses a SUCCESS recorded for a different commit', async () => {
            // The verdict is about a commit. It is never inherited.
            const { harness } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: NEXT_HEAD,
                }),
            ).resolves.toMatchObject({ allowed: false, code: 'promotion-gate-stale' });
        });

        it('refuses an unusable head SHA', async () => {
            const { harness } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: 'refs/heads/develop',
                }),
            ).resolves.toMatchObject({ allowed: false, code: 'promotion-gate-stale' });
        });

        it('refuses a promotion Task with no promotion row behind it', async () => {
            const { service } = build();
            await expect(
                service.assessPromotionForMerge({
                    taskId: 'task-orphan',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toMatchObject({ allowed: false, code: 'promotion-row-missing' });
        });

        it('refuses once the promotion is no longer open', async () => {
            const { harness, promotion } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            await promotions.closeLane(promotion.id, 'merged');
            await expect(
                harness.service.assessPromotionForMerge({
                    taskId: 'task-1',
                    labels: [PROMOTION_TASK_LABEL],
                    prNumber: 42,
                    headSha: HEAD,
                }),
            ).resolves.toMatchObject({ allowed: false, code: 'promotion-not-open' });
        });

        it('has no verdict that permits a merge the ordinary path would refuse', async () => {
            // The guard can only ever say NO. `{ promotion: false }` leaves
            // the ordinary path alone; `allowed: true` only ever restores
            // it. Nothing here bypasses the slice-AE approval.
            const { harness } = await openAndObserve({
                id: 1,
                status: 'completed',
                conclusion: 'success',
                headSha: HEAD,
            });
            const verdict = await harness.service.assessPromotionForMerge({
                taskId: 'task-1',
                labels: [PROMOTION_TASK_LABEL],
                prNumber: 42,
                headSha: HEAD,
            });
            expect(Object.keys(verdict)).not.toContain('approved');
            expect(Object.keys(verdict)).not.toContain('merge');
        });
    });

    describe('ReleasePromotionRepository.findByTaskId', () => {
        it('prefers the OPEN row over a terminal one for the same Task', async () => {
            // The merge guard runs this lookup. Ordering the two together
            // by `laneKey` would lose the live promotion to a terminal one,
            // because `'closed:…'` and `'merged:…'` both sort before
            // `'open'` — and the guard would then refuse a perfectly good
            // promotion with `promotion-not-open`.
            await rows.save(
                rows.create({
                    userId: USER,
                    workId: WORK,
                    taskId: 'task-shared',
                    rung: 'develop-to-stage',
                    headBranch: 'develop',
                    baseBranch: 'stage',
                    gateWorkflow: 'promotion-gate.yml',
                    state: 'closed',
                    laneKey: 'closed:legacy',
                }),
            );
            const live = await rows.save(
                rows.create({
                    userId: USER,
                    workId: WORK,
                    taskId: 'task-shared',
                    rung: 'develop-to-stage',
                    headBranch: 'develop',
                    baseBranch: 'stage',
                    gateWorkflow: 'promotion-gate.yml',
                    state: 'open',
                    laneKey: 'open',
                }),
            );

            await expect(promotions.findByTaskId('task-shared')).resolves.toMatchObject({
                id: live.id,
                state: 'open',
            });
        });

        it('falls back to the newest terminal row when nothing is open', async () => {
            await rows.save(
                rows.create({
                    userId: USER,
                    workId: WORK,
                    taskId: 'task-done',
                    rung: 'stage-to-main',
                    headBranch: 'stage',
                    baseBranch: 'main',
                    gateWorkflow: 'promotion-gate.yml',
                    state: 'merged',
                    laneKey: 'merged:done',
                }),
            );
            await expect(promotions.findByTaskId('task-done')).resolves.toMatchObject({
                state: 'merged',
            });
        });

        it('returns null for a Task that has no promotion', async () => {
            await expect(promotions.findByTaskId('task-ordinary')).resolves.toBeNull();
        });
    });

    describe('ReleasePromotionRepository.recordGateVerdict — who gets to narrate', () => {
        async function seed() {
            return rows.save(
                rows.create({
                    userId: USER,
                    workId: WORK,
                    taskId: 'task-cas',
                    rung: 'develop-to-stage',
                    headBranch: 'develop',
                    baseBranch: 'stage',
                    gateWorkflow: 'promotion-gate.yml',
                    state: 'open',
                    laneKey: 'open',
                }),
            );
        }

        it('reports `changed` from the DATABASE, so two replicas cannot both narrate one transition', async () => {
            // `observe()` used to decide this with a read-then-write on its
            // own in-memory row. The two-minute cron sweep and an on-demand
            // `?refresh=true` run in DIFFERENT processes: both would hold
            // the same stale row, both would compute "this is new", and the
            // Task thread — this promotion's audit trail — would show the
            // same line twice, and again for every later transition.
            const row = await seed();
            const patch = {
                gateVerdict: 'success' as const,
                gateVerdictSha: HEAD,
                gateCheckedAt: new Date(),
                gateRunUrl: null,
                gateOverridden: false,
            };

            await expect(promotions.recordGateVerdict(row.id, patch)).resolves.toEqual({
                changed: true,
            });
            // The SECOND caller holding the same stale row loses.
            await expect(
                promotions.recordGateVerdict(row.id, { ...patch, gateCheckedAt: new Date() }),
            ).resolves.toEqual({ changed: false });
        });

        it('treats an override appearing on the SAME verdict and commit as a change', async () => {
            // A maintainer applying `override-e2e-gate` re-runs the gate and
            // flips a red run to `success`. If the waiver were not part of
            // the compare-and-set, a `success → success (waived)` transition
            // would be silent — and "waived" is the whole difference the
            // person deciding a release needs to see.
            const row = await seed();
            const base = {
                gateVerdict: 'success' as const,
                gateVerdictSha: HEAD,
                gateRunUrl: null,
            };
            await promotions.recordGateVerdict(row.id, {
                ...base,
                gateCheckedAt: new Date(),
                gateOverridden: false,
            });
            await expect(
                promotions.recordGateVerdict(row.id, {
                    ...base,
                    gateCheckedAt: new Date(),
                    gateOverridden: true,
                }),
            ).resolves.toEqual({ changed: true });
            expect((await rows.findOne({ where: { id: row.id } }))?.gateOverridden).toBe(true);
        });

        it('still stamps "last looked at" when nothing changed', async () => {
            const row = await seed();
            const patch = {
                gateVerdict: 'pending' as const,
                gateVerdictSha: HEAD,
                gateRunUrl: null,
                gateOverridden: false,
            };
            await promotions.recordGateVerdict(row.id, { ...patch, gateCheckedAt: new Date(1) });
            const later = new Date(2_000_000);
            await promotions.recordGateVerdict(row.id, { ...patch, gateCheckedAt: later });
            const stored = await rows.findOne({ where: { id: row.id } });
            expect(new Date(stored!.gateCheckedAt!).getTime()).toBe(later.getTime());
        });
    });

    it('contains no merge call, and no successor-rung call, at all', () => {
        // The strongest statement available here: a promotion cannot merge
        // itself and cannot chain, because the service has nothing to do
        // either WITH. Read from source rather than asserted behaviourally
        // so that ADDING one fails, not just exercising one.
        const source = readFileSync(join(__dirname, '..', 'release-promotion.service.ts'), 'utf8');
        // Call sites, not mentions: the class docblock names
        // `GitFacadeService.mergePullRequest` when explaining that the
        // slice-AE path is where a promotion is landed, and that sentence
        // is worth keeping.
        expect(source).not.toMatch(/\.mergePullRequest\(/);
        expect(source).not.toMatch(/attemptMergeForOpenPullRequest\(/);
        expect(source).not.toMatch(/attemptAgentMerge\(/);
        // No self-call to openPromotion anywhere but the public entry point.
        expect(source.match(/openPromotion\(/g)).toHaveLength(1);
    });
});
