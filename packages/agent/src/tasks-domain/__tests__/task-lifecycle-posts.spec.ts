import {
    CHECKS_FAILED_NAMES_MAX,
    CHECK_NAME_MAX_CHARS,
    checksSettledPost,
    failingCheckNames,
    joinCheckNames,
    pullRequestOpenedPost,
    runStartedPost,
} from '../task-lifecycle-posts';
import { TaskLifecyclePostsService } from '../task-lifecycle-posts.service';
import { TaskRunDenormService } from '../task-run-denorm.service';
import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskWorkspaceService } from '../task-workspace.service';
import { TaskStatus, type Task } from '../../entities/task.entity';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { GitFacadeService } from '../../facades/git.facade';
import type { TaskThreadPoster } from '../task-thread-poster.port';

/**
 * APW-08 T26 / T54 (FR-43, ACC-08-24) — lane L7: the run-side Task-thread posts.
 *
 *  - the RULES (`task-lifecycle-posts.ts`): each post fires on a real transition of a recorded
 *    value — never on an unchanged re-read;
 *  - the POSTER (`TaskLifecyclePostsService`): App Work Tasks only; the run's Agent, else the
 *    Task's Agent, else `system`; keyed; never throws;
 *  - the three hooks in ORDER on one App Work Task, and NOTHING on any other Task.
 */

const red = (name: string) => ({ name, status: 'completed', conclusion: 'failure' });
const green = (name: string) => ({ name, status: 'completed', conclusion: 'success' });
const running = (name: string) => ({ name, status: 'in_progress', conclusion: null });

describe('task-lifecycle-posts — the rules', () => {
    describe('runStartedPost', () => {
        it('fires when the pointer moves to (this run, running) from anything else', () => {
            expect(runStartedPost(null, 'run-1')).toEqual({ key: 'deliveryPosts.runStarted' });
            expect(
                runStartedPost({ latestRunId: 'run-1', latestRunStatus: 'queued' }, 'run-1'),
            ).toEqual({ key: 'deliveryPosts.runStarted' });
            expect(
                runStartedPost({ latestRunId: 'run-0', latestRunStatus: 'running' }, 'run-1'),
            ).toEqual({ key: 'deliveryPosts.runStarted' });
            expect(runStartedPost({ latestRunId: null, latestRunStatus: null }, 'run-1')).toEqual({
                key: 'deliveryPosts.runStarted',
            });
        });

        it('a retry re-claiming a run already recorded running is no event', () => {
            expect(
                runStartedPost({ latestRunId: 'run-1', latestRunStatus: 'running' }, 'run-1'),
            ).toBeNull();
            expect(runStartedPost(null, '')).toBeNull();
        });
    });

    describe('pullRequestOpenedPost', () => {
        it('fires with the number when the recorded number changes', () => {
            expect(pullRequestOpenedPost(null, 12)).toEqual({
                key: 'deliveryPosts.prOpened',
                params: { number: 12 },
            });
            expect(pullRequestOpenedPost(undefined, 12)).not.toBeNull();
            expect(pullRequestOpenedPost(5, 12)).toEqual({
                key: 'deliveryPosts.prOpened',
                params: { number: 12 },
            });
        });

        it('the same number again, or no usable number, is no event', () => {
            expect(pullRequestOpenedPost(12, 12)).toBeNull();
            expect(pullRequestOpenedPost(null, null)).toBeNull();
            expect(pullRequestOpenedPost(null, 0)).toBeNull();
            expect(pullRequestOpenedPost(null, 1.5)).toBeNull();
        });
    });

    describe('checksSettledPost', () => {
        it('passed: once, when ciState becomes passing from anything else', () => {
            for (const before of [null, 'pending', 'unknown', 'failing']) {
                expect(
                    checksSettledPost(
                        { ciState: before, checks: [] },
                        { ciState: 'passing', checks: [green('lint')] },
                    ),
                ).toEqual({ key: 'deliveryPosts.checksPassed' });
            }
            expect(
                checksSettledPost(
                    { ciState: 'passing', checks: [green('lint')] },
                    { ciState: 'passing', checks: [green('lint')] },
                ),
            ).toBeNull();
        });

        it('failed: once, with the failing check names, when ciState becomes failing', () => {
            expect(
                checksSettledPost(
                    { ciState: 'pending', checks: [running('lint'), running('test')] },
                    { ciState: 'failing', checks: [red('lint'), green('build'), red('test')] },
                ),
            ).toEqual({ key: 'deliveryPosts.checksFailed', params: { names: 'lint, test' } });
            expect(
                checksSettledPost(
                    { ciState: 'passing', checks: [green('lint')] },
                    { ciState: 'failing', checks: [red('lint')] },
                ),
            ).toEqual({ key: 'deliveryPosts.checksFailed', params: { names: 'lint' } });
        });

        it('a steady red read is no event', () => {
            expect(
                checksSettledPost(
                    { ciState: 'failing', checks: [red('lint')] },
                    { ciState: 'failing', checks: [red('lint'), red('test')] },
                ),
            ).toBeNull();
        });

        it('a red the CI webhook recorded first (no failing check cached yet) is still posted once', () => {
            // The webhook writes `ciState = failing` and never the check list; the sweep's last
            // cached list was still running.
            const previous = { ciState: 'failing', checks: [running('lint')] };
            const next = { ciState: 'failing', checks: [red('lint')] };
            expect(checksSettledPost(previous, next)).toEqual({
                key: 'deliveryPosts.checksFailed',
                params: { names: 'lint' },
            });
            // …and the next read, with that list cached, is steady red.
            expect(checksSettledPost(next, next)).toBeNull();
        });

        it('a red with no failing check in the capped list says "Checks failed." — once', () => {
            const beyondCap = { ciState: 'failing', checks: [green('a'), running('b')] };
            expect(checksSettledPost({ ciState: 'pending', checks: [] }, beyondCap)).toEqual({
                key: 'deliveryPosts.checksFailedUnnamed',
            });
            expect(checksSettledPost(beyondCap, beyondCap)).toBeNull();
        });

        it('pending / unknown post nothing — the checks have not settled', () => {
            expect(
                checksSettledPost(
                    { ciState: null },
                    { ciState: 'pending', checks: [running('x')] },
                ),
            ).toBeNull();
            expect(checksSettledPost({ ciState: 'failing' }, { ciState: 'unknown' })).toBeNull();
            expect(checksSettledPost({ ciState: 'passing' }, { ciState: null })).toBeNull();
        });
    });

    describe('failingCheckNames / joinCheckNames', () => {
        it('lists failing checks once each, in order, cleaned to one line and capped in length', () => {
            const long = 'x'.repeat(CHECK_NAME_MAX_CHARS + 20);
            expect(
                failingCheckNames([
                    red('lint'),
                    { name: 'e2e\n(shard 1)', status: 'completed', conclusion: 'timed_out' },
                    red('lint'),
                    green('build'),
                    { name: 'neutral', status: 'completed', conclusion: 'neutral' },
                    { name: '   ', status: 'completed', conclusion: 'failure' },
                    red(long),
                ]),
            ).toEqual(['lint', 'e2e (shard 1)', `${'x'.repeat(CHECK_NAME_MAX_CHARS - 1)}…`]);
            expect(failingCheckNames(null)).toEqual([]);
        });

        it(`joins at most ${CHECKS_FAILED_NAMES_MAX} names and counts the rest`, () => {
            expect(joinCheckNames(['a', 'b'])).toBe('a, b');
            expect(joinCheckNames(['a', 'b', 'c', 'd', 'e', 'f', 'g'])).toBe('a, b, c, d, e, +2');
        });

        // APW-08 T16 (FR-16) — the names are the roll-up's own required/advisory split: an App
        // Work's ADVISORY leg (`advisory: true` on the cached row) never reds the gate, so it is
        // never named as a failure either.
        it('never names an advisory App leg, so the list matches the roll-up', () => {
            const advisory = { ...red('Ever Works check: e2e'), advisory: true };
            expect(
                failingCheckNames([red('Ever Works check: type-check'), advisory, red('lint')]),
            ).toEqual(['Ever Works check: type-check', 'lint']);
            expect(failingCheckNames([advisory])).toEqual([]);
            // `advisory: false` (or absent) is an ordinary check, named as before.
            expect(failingCheckNames([{ ...red('Ever Works check: e2e'), advisory: false }])).toEqual(
                ['Ever Works check: e2e'],
            );
        });

        it('a red read whose only failing checks are advisory legs names none of them', () => {
            const advisory = { ...red('Ever Works check: e2e'), advisory: true };
            expect(
                checksSettledPost(
                    { ciState: 'passing', checks: [] },
                    { ciState: 'failing', checks: [advisory] },
                ),
            ).toEqual(checksSettledPost({ ciState: 'passing' }, { ciState: 'failing', checks: [] }));
        });
    });
});

describe('TaskLifecyclePostsService — who gets a post, and who speaks', () => {
    const task = { id: 'task-1', userId: 'user-1', workId: 'work-1', agentId: 'agent-task' };

    function harness(kind: string | null = 'app') {
        const chat = { post: jest.fn().mockResolvedValue({ id: 'm1' }) };
        const works = {
            findById: jest.fn().mockResolvedValue(kind ? { id: 'work-1', kind } : null),
        };
        const runs = {
            findById: jest.fn().mockResolvedValue({ id: 'run-1', agentId: 'agent-run' }),
        };
        const poster = new TaskLifecyclePostsService(
            works as unknown as WorkRepository,
            runs as unknown as AgentRunRepository,
            chat as unknown as TaskThreadPoster,
        );
        return { chat, works, runs, poster };
    }

    it('posts a keyed message as the run’s Agent, with the English in body', async () => {
        const { chat, poster } = harness();
        await expect(
            poster.post({
                task,
                post: { key: 'deliveryPosts.prOpened', params: { number: 7 } },
                runId: 'run-1',
            }),
        ).resolves.toBe(true);
        expect(chat.post).toHaveBeenCalledWith('user-1', {
            taskId: 'task-1',
            authorType: 'agent',
            authorId: 'agent-run',
            body: 'Opened pull request #7.',
            messageKey: 'deliveryPosts.prOpened',
            messageParams: { number: 7 },
        });
    });

    it('an explicit agent wins; with no run it is the Task’s Agent', async () => {
        const { chat, runs, poster } = harness();
        await poster.post({ task, post: { key: 'deliveryPosts.runStarted' }, agentId: 'agent-x' });
        await poster.post({ task, post: { key: 'deliveryPosts.checksPassed' } });
        expect(runs.findById).not.toHaveBeenCalled();
        expect(chat.post.mock.calls.map((call) => call[1].authorId)).toEqual([
            'agent-x',
            'agent-task',
        ]);
    });

    it('a Task with no Agent (and a run with none) gets a system post with no author id', async () => {
        const { chat, runs, poster } = harness();
        runs.findById.mockResolvedValue(null);
        await poster.post({
            task: { ...task, agentId: null },
            post: { key: 'deliveryPosts.checksPassed' },
            runId: 'run-gone',
        });
        expect(chat.post).toHaveBeenCalledWith('user-1', {
            taskId: 'task-1',
            authorType: 'system',
            authorId: null,
            body: 'Checks passed.',
            messageKey: 'deliveryPosts.checksPassed',
            messageParams: null,
        });
    });

    it.each([['website'], ['project'], [null]])(
        'a Task whose Work is not an App Work (%s) gets NO post',
        async (kind) => {
            const { chat, poster } = harness(kind);
            await expect(
                poster.post({ task, post: { key: 'deliveryPosts.runStarted' } }),
            ).resolves.toBe(false);
            await expect(
                poster.post({
                    task: { ...task, workId: null },
                    post: { key: 'deliveryPosts.runStarted' },
                }),
            ).resolves.toBe(false);
            expect(chat.post).not.toHaveBeenCalled();
        },
    );

    it('a kind the caller already read skips the Work read', async () => {
        const { chat, works, poster } = harness();
        await poster.post({
            task,
            post: { key: 'deliveryPosts.runStarted' },
            workKind: 'directory',
        });
        await poster.post({ task, post: { key: 'deliveryPosts.runStarted' }, workKind: 'app' });
        expect(works.findById).not.toHaveBeenCalled();
        expect(chat.post).toHaveBeenCalledTimes(1);
    });

    it('never throws: a refused post or a failed Work read answers false', async () => {
        const { chat, works, poster } = harness();
        chat.post.mockRejectedValueOnce(new Error('db down'));
        await expect(
            poster.post({ task, post: { key: 'deliveryPosts.runStarted' } }),
        ).resolves.toBe(false);
        works.findById.mockRejectedValueOnce(new Error('rpc'));
        await expect(
            poster.post({ task, post: { key: 'deliveryPosts.runStarted' } }),
        ).resolves.toBe(false);
    });

    it('without a bound chat port nothing is posted', async () => {
        const poster = new TaskLifecyclePostsService(
            { findById: jest.fn() } as unknown as WorkRepository,
            { findById: jest.fn() } as unknown as AgentRunRepository,
        );
        await expect(
            poster.post({ task, post: { key: 'deliveryPosts.runStarted' } }),
        ).resolves.toBe(false);
    });
});

/**
 * ACC-08-24 — one App Work Task through the three hooks: run claimed (and retried), pull request
 * opened, checks pending → failing → failing → passing → passing. One post per EVENT, in order;
 * a non-App Work Task through the same sequence gets nothing.
 */
describe('run-side thread posts across the three hooks (ACC-08-24)', () => {
    const PR_URL = 'https://github.com/acme/bookings/pull/12';

    function makeWork(kind: string) {
        return {
            id: 'work-1',
            kind,
            gitProvider: 'github',
            taskIsolationBaseBranch: null,
            organizationId: null,
            tenantId: null,
            getRepoOwner: () => 'acme',
            getDataRepo: () => 'bookings',
        };
    }

    async function runSequence(kind: string) {
        // One Task row, shared by every double the way the database would hold it.
        const row: Record<string, unknown> = {
            id: 'task-1',
            slug: 'T-118',
            title: 'Add an SMS reminder',
            userId: 'user-1',
            workId: 'work-1',
            agentId: 'agent-wren',
            status: TaskStatus.IN_PROGRESS,
            branchRef: null,
            branchState: null,
            prNumber: null,
            prUrl: null,
            prState: null,
            ciState: null,
            prChecks: null,
            latestRunId: 'run-1',
            latestRunStatus: 'queued',
        };
        const snapshot = () => ({ ...row }) as unknown as Task;
        const work = makeWork(kind);
        const chat = { post: jest.fn().mockResolvedValue({ id: 'm' }) };
        const works = { findById: jest.fn().mockResolvedValue(work) };
        const runs = {
            findById: jest.fn().mockResolvedValue({ id: 'run-1', agentId: 'agent-wren' }),
            updateTelemetry: jest.fn().mockResolvedValue(undefined),
        };
        const tasks = {
            findById: jest.fn(async () => snapshot()),
            updateLatestRun: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
                Object.assign(row, patch);
                return true;
            }),
            updateById: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
                Object.assign(row, patch);
            }),
            updatePrStatusCache: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
                Object.assign(row, patch);
            }),
            recordCiHead: jest.fn().mockResolvedValue(true),
            findDuePrStatusSync: jest.fn(async () => [snapshot()]),
        };
        const lifecycle = new TaskLifecyclePostsService(
            works as unknown as WorkRepository,
            runs as unknown as AgentRunRepository,
            chat as unknown as TaskThreadPoster,
        );
        const denorm = new TaskRunDenormService(
            tasks as unknown as TaskRepository,
            undefined,
            lifecycle,
        );
        const workspaceArgs = new Array(14).fill(undefined) as unknown[];
        workspaceArgs[0] = works;
        workspaceArgs[1] = tasks;
        workspaceArgs[2] = runs;
        const createPullRequest = jest.fn().mockResolvedValue({ number: 12, url: PR_URL });
        workspaceArgs[4] = {
            getRepository: jest.fn().mockResolvedValue({ defaultBranch: 'main' }),
            createPullRequest,
        };
        workspaceArgs[13] = lifecycle;
        const workspace = new (TaskWorkspaceService as unknown as new (
            ...args: unknown[]
        ) => TaskWorkspaceService)(...workspaceArgs);
        const statuses: Array<{ ciState: string; checks: unknown[] }> = [];
        const git = {
            getPullRequestStatus: jest.fn(async () => ({
                number: 12,
                state: 'open',
                headSha: 'c'.repeat(40),
                ...statuses.shift(),
            })),
        };
        const prStatus = new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works as unknown as WorkRepository,
            git as unknown as GitFacadeService,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            undefined,
            lifecycle,
        );

        // Run claimed, then the worker retries the same claim.
        await denorm.recordStarted('task-1', 'run-1');
        await denorm.recordStarted('task-1', 'run-1');
        // The fleet node pushed; the platform opens the pull request.
        await workspace.finalizeRemotePush({
            task: snapshot(),
            userId: 'user-1',
            agentId: 'agent-wren',
            agentCanOpenPullRequests: true,
            branch: 'task/t-118',
            headSha: 'b'.repeat(40),
        });
        // Five sweeps: pending, failing, failing (unchanged), passing, passing (unchanged).
        statuses.push(
            { ciState: 'pending', checks: [running('lint'), running('test')] },
            { ciState: 'failing', checks: [red('lint'), green('test')] },
            { ciState: 'failing', checks: [red('lint'), green('test')] },
            { ciState: 'passing', checks: [green('lint'), green('test')] },
            { ciState: 'passing', checks: [green('lint'), green('test')] },
        );
        for (let sweep = 0; sweep < 5; sweep += 1) {
            await prStatus.syncDuePrStatuses({ staleSeconds: 0 });
        }
        return {
            posts: chat.post.mock.calls.map(([userId, message]) => ({ userId, ...message })),
            // Every hook really ran — an empty thread is the rule, not a skipped path.
            ran: {
                claims: tasks.updateLatestRun.mock.calls.length,
                prOpened: createPullRequest.mock.calls.length,
                providerReads: git.getPullRequestStatus.mock.calls.length,
                cacheWrites: tasks.updatePrStatusCache.mock.calls.length,
            },
        };
    }

    const RAN = { claims: 2, prOpened: 1, providerReads: 5, cacheWrites: 5 };

    it('an App Work Task gets one post per event, in order, as the run’s Agent', async () => {
        const { posts, ran } = await runSequence('app');
        expect(ran).toEqual(RAN);
        expect(posts.map((post) => [post.messageKey, post.messageParams, post.body])).toEqual([
            ['deliveryPosts.runStarted', null, 'Run started.'],
            ['deliveryPosts.prOpened', { number: 12 }, 'Opened pull request #12.'],
            ['deliveryPosts.checksFailed', { names: 'lint' }, 'Checks failed: lint.'],
            ['deliveryPosts.checksPassed', null, 'Checks passed.'],
        ]);
        for (const post of posts) {
            expect(post).toMatchObject({
                userId: 'user-1',
                taskId: 'task-1',
                authorType: 'agent',
                authorId: 'agent-wren',
            });
        }
    });

    it.each([['website'], ['default']])(
        'a %s Work Task through the same sequence gets NO new message',
        async (kind) => {
            const { posts, ran } = await runSequence(kind);
            expect(ran).toEqual(RAN);
            expect(posts).toEqual([]);
        },
    );
});
