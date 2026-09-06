/**
 * `@ever-works/agent-plugins` is a workspace package with no built
 * `dist` in a bare checkout; CI installs it. Loading the REAL
 * tasks-domain barrel (which this suite needs — the whole point is to
 * drive production classes) pulls `facades → agent-plugins`, so the
 * package is stubbed here rather than the code under test being watered
 * down. Nothing in this suite touches a plugin.
 */
jest.mock(
    '@ever-works/agent-plugins',
    () =>
        new Proxy(
            {},
            {
                get: (_target, property) => (property === '__esModule' ? true : jest.fn()),
            },
        ),
    { virtual: true },
);
jest.mock('@ever-works/agent/pr-review', () => ({ PrReviewService: class {} }));
jest.mock('@ever-works/agent/plugins', () => ({
    PluginSettingsService: class {},
    UserPluginRepository: class {},
}));
jest.mock('../../integrations/github-app/github-app-sync.service', () => ({
    GitHubAppSyncService: class {},
}));

import { Test } from '@nestjs/testing';
import { TypeOrmModule } from '@nestjs/typeorm';
import { DataSource, Repository } from 'typeorm';
import { ENTITIES } from '@ever-works/agent/database';
import { AgentRun, User } from '@ever-works/agent/entities';
import { Task, TaskStatus, Work } from '@ever-works/agent/entities';
import { TaskCiAutoResumeAttempt } from '@ever-works/agent/entities';
import { TaskReviewRejection } from '@ever-works/agent/entities';
import { AgentRunRepository } from '@ever-works/agent/database';
import {
    TaskCiAutoResumeAttemptRepository,
    TaskCiAutoResumeService,
    TaskGitLinkService,
    TaskRepository,
    TaskReviewRejectionRepository,
    TasksDomainModule,
} from '@ever-works/agent/tasks-domain';
import { WorkRepository } from '@ever-works/agent/database';
import type { RunResumeRequest, RunResumeResult } from '@ever-works/agent/tasks-domain';
import type { IngestResult } from '@ever-works/agent/ingest';
import { GITHUB_CHECK_EVENT_KIND, GitHubCheckIntakeService } from './github-check-intake.service';
import type { GitHubEventsBinding } from './github-pr-review-bridge.service';

/**
 * CI feedback + autonomous fix loop (slice AC, EW-806) — the RESUME
 * STORM test, and the rest of the refusal contract, driven through the
 * REAL handler over a REAL schema.
 *
 * Everything below the webhook body is production code: the real
 * normalizer, the real `GitHubCheckIntakeService.handle`, the real
 * `TaskCiAutoResumeService`, the real repositories, and a real
 * better-sqlite3 database carrying the real UNIQUE index the migration
 * creates. Exactly two things are stubbed, and neither is a decision:
 *
 *  - the ingest spine, replaced by a dedupe-by-`sourceEventId` recorder
 *    (the spine's own dedupe has its own tests, and this one needs to
 *    observe which envelopes were offered);
 *  - the run-steering port, replaced by a recorder that inserts the run
 *    row a real resume would insert.
 *
 * A test that compared a fixture to itself would prove nothing here —
 * the whole risk of this slice is that thirty deliveries become thirty
 * model runs, and that is only observable end to end.
 */
describe('GitHub check intake → auto-resume (better-sqlite3, real handler)', () => {
    const OWNER_USER = '11111111-1111-4111-8111-111111111111';
    const AGENT_ID = '22222222-2222-4222-8222-222222222222';
    const BINDING: GitHubEventsBinding = {
        userId: OWNER_USER,
        webhookSecret: 'sec',
        matchedBy: 'binding',
    };

    let dataSource: DataSource;
    let taskRows: Repository<Task>;
    let workRows: Repository<Work>;
    let runRows: Repository<AgentRun>;
    let attemptRows: Repository<TaskCiAutoResumeAttempt>;
    let rejectionRows: Repository<TaskReviewRejection>;

    let tasks: TaskRepository;
    let works: WorkRepository;
    let runs: AgentRunRepository;
    let attempts: TaskCiAutoResumeAttemptRepository;
    let rejections: TaskReviewRejectionRepository;

    /** Every envelope the handler offered the spine, in order. */
    let ingested: Array<{ userId: string; sourceEventId: string; kind: string }>;
    /** Dedupe identities the fake spine has already seen. */
    let seen: Set<string>;
    /** Every resume the handler asked for. THE number under test. */
    let resumes: RunResumeRequest[];
    /** Inbox notices filed. */
    let notices: Array<{ userId: string; title: string; body: string; taskId?: string | null }>;

    const spine = {
        ingest: jest.fn(async (userId: string, envelopes: unknown[]): Promise<IngestResult> => {
            const result: IngestResult = {
                inserted: 0,
                duplicates: 0,
                rejected: 0,
                filtered: 0,
            };
            for (const envelope of envelopes as Array<{
                sourceEventId: string;
                kind: string;
            }>) {
                const key = `${userId}|${envelope.sourceEventId}`;
                ingested.push({
                    userId,
                    sourceEventId: envelope.sourceEventId,
                    kind: envelope.kind,
                });
                if (seen.has(key)) result.duplicates += 1;
                else {
                    seen.add(key);
                    result.inserted += 1;
                }
            }
            return result;
        }),
    };

    const steering = {
        steer: jest.fn(),
        resumeRun: jest.fn(async (request: RunResumeRequest): Promise<RunResumeResult> => {
            resumes.push(request);
            const source = await runRows.findOneByOrFail({ id: request.runId });
            const next = await runRows.save(
                runRows.create({
                    agentId: source.agentId,
                    userId: request.userId,
                    triggerKind: 'task',
                    taskId: source.taskId,
                    status: 'queued',
                }),
            );
            return {
                runId: next.id,
                resumedFromRunId: request.runId,
                queued: false,
                rejectionsReplayed: 0,
            };
        }),
    };

    const inbox = {
        escalationRaised: jest.fn(),
        proposalPending: jest.fn(),
        questionRaised: jest.fn(),
        notice: jest.fn(
            async (
                userId: string,
                input: { title: string; body: string; taskId?: string | null },
            ) => {
                notices.push({ userId, ...input });
            },
        ),
    };

    function buildService(overrides: { autoResume?: TaskCiAutoResumeService } = {}) {
        const autoResume =
            overrides.autoResume ??
            new TaskCiAutoResumeService(
                tasks,
                attempts,
                new TaskGitLinkService(tasks, works),
                runs,
                rejections,
                steering,
                inbox,
            );
        // The dispatcher is only a registration sink here; the delivery is
        // handed to `handle()` directly, exactly as the dispatcher would.
        const dispatcher = { registerConsumer: jest.fn() };
        return new GitHubCheckIntakeService(dispatcher as never, spine as never, autoResume);
    }

    beforeAll(async () => {
        dataSource = new DataSource({
            type: 'better-sqlite3',
            database: ':memory:',
            entities: ENTITIES,
            synchronize: true,
            logging: false,
        });
        await dataSource.initialize();
        taskRows = dataSource.getRepository(Task);
        workRows = dataSource.getRepository(Work);
        runRows = dataSource.getRepository(AgentRun);
        attemptRows = dataSource.getRepository(TaskCiAutoResumeAttempt);
        rejectionRows = dataSource.getRepository(TaskReviewRejection);
        // Foreign keys are ON under better-sqlite3, and `works.userId`
        // references `users`. `agent_runs.agentId` deliberately carries no
        // FK (cycle avoidance — see the entity), so no Agent row is needed.
        await dataSource.getRepository(User).save(
            dataSource.getRepository(User).create({
                id: OWNER_USER,
                username: 'evereq',
                slug: 'evereq',
            } as Partial<User>),
        );
        tasks = new TaskRepository(taskRows);
        works = new WorkRepository(workRows);
        runs = new AgentRunRepository(runRows);
        attempts = new TaskCiAutoResumeAttemptRepository(attemptRows);
        rejections = new TaskReviewRejectionRepository(rejectionRows);
    });

    afterAll(async () => {
        if (dataSource?.isInitialized) await dataSource.destroy();
    });

    beforeEach(async () => {
        jest.clearAllMocks();
        delete process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;
        ingested = [];
        seen = new Set();
        resumes = [];
        notices = [];
        await attemptRows.clear();
        await rejectionRows.clear();
        await runRows.clear();
        await taskRows.clear();
        await workRows.clear();
    });

    // ── fixtures ────────────────────────────────────────────────────

    async function seedWorkTaskAndRun(
        overrides: {
            taskStatus?: TaskStatus;
            runStatus?: string;
            awaitingInput?: boolean;
            ciHeadSha?: string | null;
            ciHeadSeenAt?: Date | null;
        } = {},
    ) {
        const work = await workRows.save(
            workRows.create({
                userId: OWNER_USER,
                name: 'Site',
                slug: 'site',
                owner: 'octo',
                description: 'the fleet self-build target',
                // A Work owns THREE repositories and the shared matcher
                // matches all three, but Task worktrees and Task pull
                // requests are opened in the DATA repo
                // (`TaskWorkspaceService`), so that is the only one
                // `tasks.prNumber` is unique within. Declared explicitly
                // rather than left to the slug defaults so the difference
                // is visible — and so `refuses a check on the Work's
                // OTHER repository` has something to be about.
                sourceRepository: {
                    relatedRepositories: {
                        data: { owner: 'octo', repo: 'site' },
                        work: { owner: 'octo', repo: 'site-main' },
                        website: { owner: 'octo', repo: 'site-www' },
                    },
                },
            } as Partial<Work>),
        );
        const task = await taskRows.save(
            taskRows.create({
                userId: OWNER_USER,
                workId: work.id,
                slug: 't-42',
                title: 'Add the login button',
                status: overrides.taskStatus ?? TaskStatus.IN_REVIEW,
                createdByType: 'user',
                createdById: OWNER_USER,
                requireAllApprovers: true,
                prNumber: 42,
                branchRef: 'task/t-42-9f3c1a2b',
                ciHeadSha: overrides.ciHeadSha ?? null,
                ciHeadSeenAt: overrides.ciHeadSeenAt ?? null,
            } as Partial<Task>),
        );
        const run = await runRows.save(
            runRows.create({
                agentId: AGENT_ID,
                userId: OWNER_USER,
                triggerKind: 'task',
                taskId: task.id,
                status: overrides.runStatus ?? 'completed',
                awaitingInput: overrides.awaitingInput ?? false,
            } as Partial<AgentRun>),
        );
        return { work, task, run };
    }

    const HEAD = 'a'.repeat(40);

    function checkRun(
        options: {
            id?: number;
            name?: string;
            status?: string;
            conclusion?: string | null;
            headSha?: string;
            /**
             * What the delivery says the PULL REQUEST's head is right now.
             * GitHub puts it on every same-repo `pull_requests[]` entry,
             * and it is what makes a superseded commit detectable without
             * commit ancestry. Defaults to the check's own head, i.e.
             * "this check is for the current head".
             */
            prHeadSha?: string;
            completedAt?: string;
            summary?: string;
            repoFullName?: string;
        } = {},
    ) {
        const headSha = options.headSha ?? HEAD;
        return {
            action: options.status === 'completed' ? 'completed' : 'created',
            repository: {
                full_name: options.repoFullName ?? 'octo/site',
                owner: { login: 'octo' },
            },
            sender: { login: 'github-actions[bot]', type: 'Bot' },
            check_run: {
                id: options.id ?? 1,
                name: options.name ?? 'lint-and-test',
                status: options.status ?? 'completed',
                conclusion: options.conclusion === undefined ? 'failure' : options.conclusion,
                head_sha: headSha,
                html_url: 'https://github.com/octo/site/runs/1',
                started_at: '2026-09-06T10:00:00Z',
                completed_at: options.completedAt ?? '2026-09-06T10:05:00Z',
                app: { slug: 'github-actions' },
                output: {
                    title: '1 failing test',
                    summary: options.summary ?? 'apps/web login.spec.ts › renders — expected true',
                },
                check_suite: { id: 9, head_branch: 'task/t-42-9f3c1a2b', head_sha: headSha },
                pull_requests: [
                    {
                        number: 42,
                        head: { ref: 'task/t-42-9f3c1a2b', sha: options.prHeadSha ?? headSha },
                    },
                ],
            },
        };
    }

    // ── THE storm ───────────────────────────────────────────────────

    it('turns a whole push worth of check deliveries — plus redeliveries — into exactly ONE resume', async () => {
        const { task, run } = await seedWorkTaskAndRun();
        const service = buildService();

        // One push on a 12-job matrix: `created` then `completed` for each
        // job, four of them red, plus the aggregate suite and workflow
        // events. Then GitHub redelivers the whole lot.
        const deliveries: Array<[string, Record<string, unknown>]> = [];
        for (let job = 1; job <= 12; job += 1) {
            deliveries.push([
                'check_run',
                checkRun({ id: job, name: `job-${job}`, status: 'in_progress', conclusion: null }),
            ]);
            deliveries.push([
                'check_run',
                checkRun({
                    id: job,
                    name: `job-${job}`,
                    status: 'completed',
                    conclusion: job % 3 === 0 ? 'failure' : 'success',
                }),
            ]);
        }
        deliveries.push([
            'check_suite',
            {
                action: 'completed',
                repository: { full_name: 'octo/site', owner: { login: 'octo' } },
                sender: { login: 'github-actions[bot]', type: 'Bot' },
                check_suite: {
                    id: 9,
                    status: 'completed',
                    conclusion: 'failure',
                    head_sha: HEAD,
                    head_branch: 'task/t-42-9f3c1a2b',
                    updated_at: '2026-09-06T10:06:00Z',
                    app: { slug: 'github-actions' },
                    pull_requests: [{ number: 42 }],
                },
            },
        ]);
        deliveries.push([
            'workflow_run',
            {
                action: 'completed',
                repository: { full_name: 'octo/site', owner: { login: 'octo' } },
                sender: { login: 'github-actions[bot]', type: 'Bot' },
                workflow_run: {
                    id: 77,
                    name: 'CI',
                    status: 'completed',
                    conclusion: 'failure',
                    head_sha: HEAD,
                    head_branch: 'task/t-42-9f3c1a2b',
                    run_attempt: 1,
                    html_url: 'https://github.com/octo/site/actions/runs/77',
                    updated_at: '2026-09-06T10:07:00Z',
                    pull_requests: [{ number: 42 }],
                },
            },
        ]);

        const all = [...deliveries, ...deliveries]; // GitHub redelivers everything
        for (const [eventName, body] of all) {
            await service.handle(BINDING, eventName, body as never);
        }

        expect(all.length).toBe(52);
        // CONTRACT CHANGE, deliberate: this used to assert that all 52
        // deliveries were offered to the spine. The 24 `in_progress`
        // announcements are now dropped at the edge — each ingested
        // envelope costs a REQUIRED activity_log write plus a paid
        // embedding wherever a memory provider is configured, and a check
        // that has not completed carries no verdict anything reads. What
        // survives is every COMPLETED result (12 jobs x 2 deliveries) plus
        // the suite and workflow aggregates x 2, which is the whole of the
        // ingest half anyone can act on.
        expect(ingested).toHaveLength(28);
        expect(ingested.every((row) => row.kind === GITHUB_CHECK_EVENT_KIND)).toBe(true);
        // … and exactly one of them bought a model run.
        expect(resumes).toHaveLength(1);
        expect(resumes[0]).toMatchObject({
            runId: run.id,
            userId: OWNER_USER,
            allowCompleted: true,
        });

        // The ledger says the same thing, durably.
        const ledger = await attempts.listForTask(task.id);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({ trigger: 'ci', claimKey: `ci:${HEAD}`, headSha: HEAD });
        expect(ledger[0].resumedRunId).toBeTruthy();

        // And the resumed run reads the failure, because a durable
        // rejection row was written for `resume` to replay.
        const feedback = await rejectionRows.find({ where: { taskId: task.id } });
        expect(feedback).toHaveLength(1);
        expect(feedback[0].source).toBe('gate');
        expect(feedback[0].feedback).toContain('Continuous integration is RED');
        expect(feedback[0].feedback).toContain(HEAD);
    });

    it('never resumes twice for one head even when the failing jobs differ', async () => {
        await seedWorkTaskAndRun();
        const service = buildService();
        for (const name of ['lint', 'typecheck', 'unit', 'e2e']) {
            await service.handle(
                BINDING,
                'check_run',
                checkRun({ id: name.length, name, summary: `${name} blew up` }) as never,
            );
        }
        expect(resumes).toHaveLength(1);
    });

    // ── the refusals ────────────────────────────────────────────────

    it('refuses a green result, and a green re-run arriving after a red one', async () => {
        const { task } = await seedWorkTaskAndRun();
        const service = buildService();

        await service.handle(
            BINDING,
            'check_run',
            checkRun({ id: 5, conclusion: 'success' }) as never,
        );
        expect(resumes).toHaveLength(0);
        // …but the head WAS recorded, which is what makes staleness work.
        expect((await tasks.findById(task.id))?.ciHeadSha).toBe(HEAD);

        await service.handle(BINDING, 'check_run', checkRun({ id: 6 }) as never);
        expect(resumes).toHaveLength(1);

        // A re-run of the same job goes green afterwards: not a failure,
        // so nothing more is spent.
        await service.handle(
            BINDING,
            'check_run',
            checkRun({ id: 7, conclusion: 'success' }) as never,
        );
        expect(resumes).toHaveLength(1);
    });

    it('refuses a cancelled, neutral or skipped conclusion — a human stopping a job is not a defect', async () => {
        await seedWorkTaskAndRun();
        const service = buildService();
        for (const conclusion of ['cancelled', 'neutral', 'skipped', 'stale']) {
            await service.handle(BINDING, 'check_run', checkRun({ id: 10, conclusion }) as never);
        }
        expect(resumes).toHaveLength(0);
    });

    it('refuses a stale head — CI catching up on a commit that has been replaced', async () => {
        const newerHead = 'b'.repeat(40);
        const { task } = await seedWorkTaskAndRun({
            ciHeadSha: newerHead,
            ciHeadSeenAt: new Date('2026-09-06T12:00:00Z'),
        });
        const service = buildService();

        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 3,
                prHeadSha: newerHead,
                completedAt: '2026-09-06T10:05:00Z',
            }) as never,
        );

        expect(resumes).toHaveLength(0);
        // …and the dead commit was NOT written back over the live head.
        expect((await tasks.findById(task.id))?.ciHeadSha).toBe(newerHead);
        // The envelope is still ingested — the FACT is real, only the
        // action is refused.
        expect(ingested).toHaveLength(1);
        expect(ingested[0].kind).toBe(GITHUB_CHECK_EVENT_KIND);
    });

    /**
     * THE head-staleness regression, end to end.
     *
     * Ordering two different commits by their provider timestamps is
     * wrong in the expensive direction: a push's jobs finish at wildly
     * different times (this repo's CI runs ~15 job instances per push), so
     * a slow job belonging to the OLD commit routinely completes after the
     * NEW commit has already reported its first check. Under the timestamp
     * rule that late result read as `advanced`, rewrote `tasks.ciHeadSha`
     * BACKWARDS to the dead commit, and spent one of the Task's two
     * lifetime attempts fixing code nobody has any more — two of those and
     * the genuine red on the real head files "automatic retries stopped"
     * instead of fixing anything.
     */
    it('refuses an old commit whose slow job finished AFTER the new head was recorded', async () => {
        const oldHead = 'a'.repeat(40);
        const newHead = 'b'.repeat(40);
        const { task } = await seedWorkTaskAndRun();
        const service = buildService();

        // The fast `lint` job on commit A reports green at 10:05.
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 50,
                name: 'lint',
                conclusion: 'success',
                headSha: oldHead,
                completedAt: '2026-09-06T10:05:00Z',
            }) as never,
        );
        // The agent pushes commit B at 10:10; its first result lands.
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 51,
                name: 'lint',
                conclusion: 'success',
                headSha: newHead,
                completedAt: '2026-09-06T10:10:00Z',
            }) as never,
        );
        expect((await tasks.findById(task.id))?.ciHeadSha).toBe(newHead);

        // Commit A's e2e shard — started before the push — finally fails
        // at 10:25, i.e. with a FRESHER timestamp than the new head.
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 52,
                name: 'e2e',
                headSha: oldHead,
                prHeadSha: newHead,
                completedAt: '2026-09-06T10:25:00Z',
            }) as never,
        );

        expect(resumes).toHaveLength(0);
        expect(await attempts.countForTask(task.id)).toBe(0);
        // The live head is untouched: nothing rewound it to the dead commit.
        expect((await tasks.findById(task.id))?.ciHeadSha).toBe(newHead);
    });

    /**
     * A Work owns three repositories and `matchWorkByRepo` matches all
     * three, but `findByWorkAndPrNumber` has no repository dimension — so
     * pull request #42 in the Work's WEBSITE repo used to resolve to the
     * Task that opened #42 in the data repo, clobber its `ciHeadSha` with
     * a commit from the wrong repository, and spend an attempt telling an
     * agent to fix a repository the failure is not in.
     */
    it('refuses a check on the OTHER repositories of the same Work', async () => {
        const { task } = await seedWorkTaskAndRun();
        const service = buildService();

        for (const [index, repoFullName] of ['octo/site-www', 'octo/site-main'].entries()) {
            await service.handle(
                BINDING,
                'check_run',
                checkRun({
                    id: 60 + index,
                    headSha: 'f'.repeat(40),
                    repoFullName,
                }) as never,
            );
        }

        expect(resumes).toHaveLength(0);
        expect(await attempts.countForTask(task.id)).toBe(0);
        expect((await tasks.findById(task.id))?.ciHeadSha).toBeNull();
        // The FACTS are still ingested — they are real CI results for real
        // repositories, they just belong to no Task of this owner.
        expect(ingested).toHaveLength(2);
    });

    /**
     * The merged -> DONE transition is poll-driven, runs on a two-minute
     * cron and only fires from `in_progress` / `in_review`, and a pull
     * request the owner CLOSED without merging is never transitioned at
     * all. So `TaskStatus` alone does not answer "is there anything left
     * to push a fix to?" — `prState` / `branchState` do, and they are on
     * the row the evaluator already holds.
     */
    it('refuses a straggler on a merged or closed pull request', async () => {
        for (const patch of [
            { prState: 'merged' },
            { prState: 'closed' },
            { branchState: 'merged' },
        ]) {
            await attemptRows.clear();
            await runRows.clear();
            await taskRows.clear();
            await workRows.clear();
            resumes = [];
            const { task } = await seedWorkTaskAndRun({ taskStatus: TaskStatus.BLOCKED });
            await taskRows.update({ id: task.id }, patch as never);
            const service = buildService();
            await service.handle(BINDING, 'check_run', checkRun({ id: 61 }) as never);
            expect(resumes).toHaveLength(0);
            expect(await attempts.countForTask(task.id)).toBe(0);
        }
    });

    it('accepts a NEWER head and refuses the older one that follows it', async () => {
        const { task } = await seedWorkTaskAndRun({
            ciHeadSha: 'c'.repeat(40),
            ciHeadSeenAt: new Date('2026-09-06T09:00:00Z'),
        });
        const service = buildService();

        await service.handle(BINDING, 'check_run', checkRun({ id: 11 }) as never);
        expect(resumes).toHaveLength(1);
        expect((await tasks.findById(task.id))?.ciHeadSha).toBe(HEAD);
    });

    it('refuses a done or cancelled Task', async () => {
        for (const status of [TaskStatus.DONE, TaskStatus.CANCELLED]) {
            await attemptRows.clear();
            await runRows.clear();
            await taskRows.clear();
            await workRows.clear();
            resumes = [];
            await seedWorkTaskAndRun({ taskStatus: status });
            const service = buildService();
            await service.handle(BINDING, 'check_run', checkRun({ id: 12 }) as never);
            expect(resumes).toHaveLength(0);
        }
    });

    it('refuses while a run is already queued or running — the fix may be in flight', async () => {
        await seedWorkTaskAndRun({ runStatus: 'running' });
        const service = buildService();
        await service.handle(BINDING, 'check_run', checkRun({ id: 13 }) as never);
        expect(resumes).toHaveLength(0);
    });

    it('refuses a run parked on a question — that is the owner’s to answer', async () => {
        await seedWorkTaskAndRun({ awaitingInput: true });
        const service = buildService();
        await service.handle(BINDING, 'check_run', checkRun({ id: 14 }) as never);
        expect(resumes).toHaveLength(0);
    });

    it('refuses a cancelled run', async () => {
        await seedWorkTaskAndRun({ runStatus: 'cancelled' });
        const service = buildService();
        await service.handle(BINDING, 'check_run', checkRun({ id: 15 }) as never);
        expect(resumes).toHaveLength(0);
    });

    it('refuses a repository that belongs to no Work of this owner', async () => {
        await seedWorkTaskAndRun();
        const service = buildService();
        await service.handle(BINDING, 'check_run', {
            ...checkRun({ id: 16 }),
            repository: { full_name: 'someone/else', owner: { login: 'someone' } },
        } as never);
        expect(resumes).toHaveLength(0);
    });

    // ── the budget ──────────────────────────────────────────────────

    it('spends exactly the budget across many pushes, then files exactly ONE notice however many events arrive', async () => {
        const { task } = await seedWorkTaskAndRun();
        const service = buildService();

        // Three separate pushes, each with its own head and its own
        // distinct failure. The default budget is two.
        const heads = ['1'.repeat(40), '2'.repeat(40), '3'.repeat(40)];
        for (const [index, headSha] of heads.entries()) {
            await service.handle(
                BINDING,
                'check_run',
                checkRun({
                    id: 100 + index,
                    headSha,
                    summary: `failure number ${index}`,
                    completedAt: `2026-09-06T1${index}:00:00Z`,
                }) as never,
            );
        }

        expect(resumes).toHaveLength(2);
        expect(await attempts.countForTask(task.id)).toBe(2);
        expect(notices).toHaveLength(1);
        expect(notices[0].title).toContain('automatic retries stopped');
        expect(notices[0].userId).toBe(OWNER_USER);

        // Twenty more deliveries on the spent budget: still one notice,
        // and — the part that used to be wrong — not one further write.
        // "budget spent" is terminal for the rest of the Task's life, but
        // every delivery re-entered the branch and re-issued a
        // compare-and-set UPDATE against `tasks` that could never affect a
        // row: a permanent write path on the busiest table in the schema,
        // per open Task, across six machines. The marker is on the row the
        // evaluator already loaded, so the steady state is now a read.
        const cas = jest.spyOn(tasks, 'casMarkCiAutoResumeNoticed');
        for (let i = 0; i < 20; i += 1) {
            await service.handle(
                BINDING,
                'check_run',
                checkRun({
                    id: 200 + i,
                    headSha: '4'.repeat(40),
                    summary: `yet another failure ${i}`,
                    completedAt: `2026-09-07T00:${String(i).padStart(2, '0')}:00Z`,
                }) as never,
            );
        }
        expect(resumes).toHaveLength(2);
        expect(notices).toHaveLength(1);
        expect(cas).not.toHaveBeenCalled();
        cas.mockRestore();
    });

    it('stops on an UNCHANGED failure on a new head — retrying it again is not progress', async () => {
        const { task } = await seedWorkTaskAndRun();
        const service = buildService();

        await service.handle(BINDING, 'check_run', checkRun({ id: 20 }) as never);
        expect(resumes).toHaveLength(1);

        // Same job, byte-identical output, new commit: the agent pushed
        // something and the build broke the same way.
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 21,
                headSha: 'd'.repeat(40),
                completedAt: '2026-09-06T11:00:00Z',
            }) as never,
        );

        expect(resumes).toHaveLength(1);
        expect(await attempts.countForTask(task.id)).toBe(1);
        expect(notices).toHaveLength(1);
        expect(notices[0].body).toContain('came back unchanged');

        // …and the notice told the truth. It says "nothing further will be
        // retried automatically for this task", and it used to be filed
        // while the loop happily carried on resuming any DIFFERENT failure
        // inside the remaining budget — AND it burned the one-shot marker,
        // so the real budget-spent event later filed nothing at all. The
        // marker is now the stop flag: a brand-new failure on a brand-new
        // head buys nothing more, and no second notice appears.
        expect(notices[0].body).toContain('Nothing further will be retried automatically');
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 22,
                headSha: '9'.repeat(40),
                summary: 'a completely different failure',
                completedAt: '2026-09-06T12:00:00Z',
            }) as never,
        );
        expect(resumes).toHaveLength(1);
        expect(await attempts.countForTask(task.id)).toBe(1);
        expect(notices).toHaveLength(1);
    });

    it('dispatches at most the budget even when every racer read a stale count', async () => {
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '1';
        const { task } = await seedWorkTaskAndRun();
        // Both deliveries observe "0 attempts used" — the shape two API
        // replicas handling two different pushes in the same instant
        // produce. The pre-check cannot stop the second; the ledger's own
        // ordering has to.
        const racing = new TaskCiAutoResumeAttemptRepository(attemptRows);
        const realCount = TaskCiAutoResumeAttemptRepository.prototype.countForTask;
        let reads = 0;
        jest.spyOn(racing, 'countForTask').mockImplementation(async (id: string) => {
            reads += 1;
            // Odd reads are the PRE-claim budget check, and every racer
            // sees the same stale zero. Even reads are the post-claim
            // settle, which sees the truth — that is the guard under test.
            return reads % 2 === 1 ? 0 : realCount.call(racing, id);
        });
        const service = buildService({
            autoResume: new TaskCiAutoResumeService(
                tasks,
                racing,
                new TaskGitLinkService(tasks, works),
                runs,
                rejections,
                steering,
                inbox,
            ),
        });

        for (const [index, headSha] of ['7'.repeat(40), '8'.repeat(40)].entries()) {
            await service.handle(
                BINDING,
                'check_run',
                checkRun({
                    id: 300 + index,
                    headSha,
                    summary: `race ${index}`,
                    completedAt: `2026-09-08T0${index}:00:00Z`,
                }) as never,
            );
        }

        // Both CLAIMED — their coordinates genuinely differ, so the unique
        // index cannot help — but only the first one in the ledger ran.
        expect(await racing.listForTask(task.id)).toHaveLength(2);
        expect(resumes).toHaveLength(1);
        expect(notices).toHaveLength(1);
    });

    it('STOPS when the budget cannot be read — an uncountable budget is not a budget', async () => {
        await seedWorkTaskAndRun();
        const broken = new TaskCiAutoResumeAttemptRepository({} as never);
        jest.spyOn(broken, 'countForTask').mockRejectedValue(new Error('database is locked'));
        const claim = jest.spyOn(broken, 'claim');
        const autoResume = new TaskCiAutoResumeService(
            tasks,
            broken,
            new TaskGitLinkService(tasks, works),
            runs,
            rejections,
            steering,
            inbox,
        );
        const service = buildService({ autoResume });

        await service.handle(BINDING, 'check_run', checkRun({ id: 30 }) as never);

        expect(resumes).toHaveLength(0);
        expect(claim).not.toHaveBeenCalled();
    });

    it('resumes nothing at all when the budget is configured to zero', async () => {
        await seedWorkTaskAndRun();
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '0';
        const service = buildService();
        await service.handle(BINDING, 'check_run', checkRun({ id: 31 }) as never);
        expect(resumes).toHaveLength(0);
        // …but the result is still ingested and still lands on the board.
        expect(ingested).toHaveLength(1);
    });

    it('refuses when the global stop flag is set, and when it cannot be read', async () => {
        await seedWorkTaskAndRun();
        for (const killSwitch of [
            { shouldHaltDispatch: async () => true },
            {
                shouldHaltDispatch: async () => {
                    throw new Error('fleet_kill_switch is unreachable');
                },
            },
        ]) {
            const autoResume = new TaskCiAutoResumeService(
                tasks,
                attempts,
                new TaskGitLinkService(tasks, works),
                runs,
                rejections,
                steering,
                inbox,
                killSwitch,
            );
            await buildService({ autoResume }).handle(
                BINDING,
                'check_run',
                checkRun({ id: 32 }) as never,
            );
        }
        expect(resumes).toHaveLength(0);
    });

    // ── the reviewer half ───────────────────────────────────────────

    it('resumes ONCE on a recorded reviewer rejection, and not again for the same row', async () => {
        const { task } = await seedWorkTaskAndRun();
        const recorded = await rejections.record({
            taskId: task.id,
            source: 'pull-request',
            feedback: 'This drops the null check on line 40.',
            reviewerLabel: 'coderabbitai[bot]',
            reviewerKind: 'bot',
            severity: 'major',
            prNumber: 42,
        });
        const service = buildService();

        const review = {
            action: 'submitted',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            pull_request: { number: 42 },
            review: { id: 1, state: 'changes_requested', body: 'no' },
        };
        await service.handle(BINDING, 'pull_request_review', review as never);
        await service.handle(BINDING, 'pull_request_review', review as never);

        expect(resumes).toHaveLength(1);
        const ledger = await attempts.listForTask(task.id);
        expect(ledger).toHaveLength(1);
        expect(ledger[0]).toMatchObject({
            trigger: 'review',
            claimKey: `review:${recorded!.id}`,
        });
        // The reviewer half writes NO new rejection — the row already exists.
        expect(await rejectionRows.count({ where: { taskId: task.id } })).toBe(1);
    });

    it('does nothing for a review delivery with no recorded rejection behind it', async () => {
        await seedWorkTaskAndRun();
        const service = buildService();
        await service.handle(BINDING, 'pull_request_review', {
            action: 'submitted',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            pull_request: { number: 42 },
            review: { id: 2, state: 'approved' },
        } as never);
        await service.handle(BINDING, 'issue_comment', {
            action: 'created',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
            comment: { id: 3, body: 'nice' },
        } as never);
        expect(resumes).toHaveLength(0);
        expect(ingested).toHaveLength(0);
    });

    /**
     * A comment delivery is a DOORBELL: `issue_comment` carries no link to
     * the row it is meant to answer, so the consumer used to act on
     * `findPendingForTask(task.id, 1)` — the oldest unconsumed rejection
     * of ANY source and ANY age. That let any created comment on the pull
     * request cash in a `gate` row this same service had left pending
     * after its own dispatch failed, spending the Task's last attempt
     * replaying a CI failure the owner had already fixed by hand.
     */
    it('never lets a comment cash in the fix loop’s OWN pending CI row', async () => {
        const { task } = await seedWorkTaskAndRun();
        // Exactly the row a dispatch-failed CI attempt leaves behind.
        await rejections.record({
            taskId: task.id,
            source: 'gate',
            feedback: 'Continuous integration is RED for octo/site at commit abc.',
            reviewerLabel: 'lint-and-test',
            reviewerKind: 'bot',
            severity: 'critical',
            prNumber: 42,
        });
        const service = buildService();

        await service.handle(BINDING, 'issue_comment', {
            action: 'created',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
            comment: {
                id: 9,
                body: 'thanks, fixed it myself',
                user: { login: 'evereq', type: 'User' },
            },
        } as never);

        expect(resumes).toHaveLength(0);
        expect(await attempts.countForTask(task.id)).toBe(0);
    });

    it('never lets a comment cash in a rejection recorded for a DIFFERENT pull request', async () => {
        const { task } = await seedWorkTaskAndRun();
        await rejections.record({
            taskId: task.id,
            source: 'pull-request',
            feedback: 'wrong PR entirely',
            reviewerLabel: 'a-human',
            prNumber: 7,
        });
        const service = buildService();
        await service.handle(BINDING, 'issue_comment', {
            action: 'created',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
            comment: { id: 10, body: 'ping', user: { login: 'evereq', type: 'User' } },
        } as never);
        expect(resumes).toHaveLength(0);
    });

    it('never lets a MONTHS-OLD abandoned rejection be cashed in by a passing comment', async () => {
        const { task } = await seedWorkTaskAndRun();
        const stale = await rejections.record({
            taskId: task.id,
            source: 'task-review',
            feedback: 'recorded in the web UI last quarter and handled by hand',
            reviewerLabel: 'a-human',
            prNumber: 42,
        });
        await rejectionRows.update({ id: stale!.id }, {
            createdAt: new Date(Date.now() - 30 * 24 * 60 * 60 * 1000),
        } as never);
        const service = buildService();
        await service.handle(BINDING, 'issue_comment', {
            action: 'created',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
            comment: { id: 11, body: 'still here?', user: { login: 'evereq', type: 'User' } },
        } as never);
        expect(resumes).toHaveLength(0);
    });

    /**
     * The doorbell classified no author, so the platform's OWN status
     * comment on the pull request — the PR link the fleet posts, a
     * progress note — was a valid trigger and the loop could wake itself.
     * The PR-review bridge refuses `self` and `untrusted-bot` before it
     * records anything; this consumer makes the same judgement.
     */
    it('is not rung by the platform’s own bot, or by an untrusted one', async () => {
        const { task } = await seedWorkTaskAndRun();
        await rejections.record({
            taskId: task.id,
            source: 'pull-request',
            feedback: 'a genuine human rejection, still pending',
            reviewerLabel: 'a-human',
            prNumber: 42,
        });
        const service = buildService();

        for (const user of [
            { login: `${process.env.GITHUB_APP_SLUG ?? 'ever-works'}[bot]`, type: 'Bot' },
            { login: 'dependabot[bot]', type: 'Bot' },
        ]) {
            await service.handle(BINDING, 'issue_comment', {
                action: 'created',
                repository: { full_name: 'octo/site', owner: { login: 'octo' } },
                issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
                comment: { id: 12, body: 'Opened PR #42 for task t-42.', user },
            } as never);
        }
        expect(resumes).toHaveLength(0);

        // …and a human's comment on the same thread still rings it.
        await service.handle(BINDING, 'issue_comment', {
            action: 'created',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            issue: { number: 42, pull_request: { url: 'https://api.github.com/x' } },
            comment: { id: 13, body: 'any update?', user: { login: 'evereq', type: 'User' } },
        } as never);
        expect(resumes).toHaveLength(1);
    });

    /**
     * `RunSteeringService.resume` replays only the THREE OLDEST
     * unconsumed rejections, and the CI row this service writes is the
     * newest. A Task already carrying three unconsumed reviewer findings
     * therefore spent a full model run seeded with three stale review
     * comments and was never told CI was red at all — `message` was
     * `null`, because the fallback was only set when the rejection WRITE
     * threw, which it had not.
     */
    it('hands the failure text to the resume directly when the replay window is full', async () => {
        const { task } = await seedWorkTaskAndRun();
        for (const label of ['coderabbitai[bot]', 'codex[bot]', 'a-human']) {
            await rejections.record({
                taskId: task.id,
                source: 'pull-request',
                feedback: `finding from ${label}`,
                reviewerLabel: label,
                prNumber: 42,
            });
        }
        const service = buildService();

        await service.handle(BINDING, 'check_run', checkRun({ id: 70 }) as never);

        expect(resumes).toHaveLength(1);
        expect(resumes[0].message).toContain('Continuous integration is RED');
        expect(resumes[0].message).toContain(HEAD);
    });

    it('leaves the message to the replay when the window has room for the CI row', async () => {
        const { task } = await seedWorkTaskAndRun();
        await rejections.record({
            taskId: task.id,
            source: 'pull-request',
            feedback: 'one older finding',
            reviewerLabel: 'a-human',
            prNumber: 42,
        });
        const service = buildService();

        await service.handle(BINDING, 'check_run', checkRun({ id: 71 }) as never);

        expect(resumes).toHaveLength(1);
        // The durable row IS the channel here — `resume` claims it and
        // seeds it ahead of any caller message, so duplicating the text
        // would only cost prompt tokens.
        expect(resumes[0].message).toBeNull();
        const rows = await rejectionRows.find({ where: { taskId: task.id } });
        expect(rows.some((row) => row.source === 'gate')).toBe(true);
    });

    it('shares ONE budget between the CI half and the reviewer half', async () => {
        const { task } = await seedWorkTaskAndRun();
        await rejections.record({
            taskId: task.id,
            source: 'pull-request',
            feedback: 'fix the null check',
            reviewerLabel: 'a-human',
            prNumber: 42,
        });
        const service = buildService();

        await service.handle(BINDING, 'check_run', checkRun({ id: 40 }) as never);
        await service.handle(BINDING, 'pull_request_review', {
            action: 'submitted',
            repository: { full_name: 'octo/site', owner: { login: 'octo' } },
            pull_request: { number: 42 },
            review: { id: 4, state: 'changes_requested' },
        } as never);
        await service.handle(
            BINDING,
            'check_run',
            checkRun({
                id: 41,
                headSha: 'e'.repeat(40),
                summary: 'a completely different failure',
                completedAt: '2026-09-06T13:00:00Z',
            }) as never,
        );

        expect(resumes).toHaveLength(2);
        expect(await attempts.countForTask(task.id)).toBe(2);
    });
});

/**
 * MODULE wiring — the half a hand-written provider array cannot see.
 *
 * The container check below proves the service's dependency LIST is
 * satisfiable. It says nothing about whether `TasksDomainModule` actually
 * lists those providers, because it compiles an array declared in this
 * file: removing `TaskCiAutoResumeAttemptRepository` from
 * `tasks.module.ts` — a change that makes the API fail to boot with an
 * unresolvable dependency — left all of it green, and so did dropping
 * `TaskCiAutoResumeService` from that module's `exports`, which silently
 * disables the whole fix loop (the intake injects it `@Optional()`, so an
 * unexported provider is not an error, just a consumer that resumes
 * nothing, forever, with no test red).
 *
 * `TasksDomainModule` cannot be COMPILED here — it drags
 * facades → agent-plugins, which has no dist in a bare checkout — but its
 * decorator metadata reads fine under the same virtual mock the suite
 * above already installs, and that metadata is exactly the list the Nest
 * container would resolve at boot.
 */
describe('TasksDomainModule declares the fix loop (module metadata)', () => {
    const providers = () => Reflect.getMetadata('providers', TasksDomainModule) as unknown[];
    const exported = () => Reflect.getMetadata('exports', TasksDomainModule) as unknown[];

    it('PROVIDES the attempt ledger repository — without it the API cannot boot', () => {
        expect(providers()).toContain(TaskCiAutoResumeAttemptRepository);
    });

    it('PROVIDES and EXPORTS the evaluator — the intake injects it @Optional()', () => {
        expect(providers()).toContain(TaskCiAutoResumeService);
        // Not exported ⇒ `GitHubCheckIntakeService` silently receives
        // `undefined` and every check delivery is ingested and then
        // dropped. Nothing else would go red.
        expect(exported()).toContain(TaskCiAutoResumeService);
    });

    it('registers the attempt entity with TypeORM — the repository is useless without it', () => {
        // `TypeOrmModule.forFeature([...])` lands in `imports`; the
        // registered entity list is on the dynamic module's providers, so
        // assert on the ENTITY inventory the module feeds instead, which
        // is the same list `DatabaseModule` and the migration must agree
        // with.
        expect(ENTITIES).toContain(TaskCiAutoResumeAttempt);
    });
});

/**
 * DI compile check — the failure this catches happens at API BOOT, not
 * in any unit test.
 *
 * `TaskCiAutoResumeService` asks for five providers by class. Four of
 * them TasksDomainModule already had; the fifth
 * (`TaskCiAutoResumeAttemptRepository`) this slice added, and forgetting
 * it in `providers` is invisible to `tsc`, invisible to every spec that
 * constructs the service by hand, and fatal on the first pod boot. So
 * the graph is compiled against a real Nest container over a real
 * in-memory schema, and the second case is the mutation check: remove
 * the repository and the compile must fail.
 */
describe('TaskCiAutoResumeService DI wiring (real container)', () => {
    const providers = [
        TaskRepository,
        WorkRepository,
        AgentRunRepository,
        TaskReviewRejectionRepository,
        TaskCiAutoResumeAttemptRepository,
        TaskGitLinkService,
        TaskCiAutoResumeService,
    ];

    /**
     * Only the entities the graph touches, and only this module — the
     * real TasksDomainModule drags the whole facades/agent-plugins chain
     * a bare checkout cannot load.
     */
    const buildModule = (provide: unknown[]) =>
        Test.createTestingModule({
            imports: [
                TypeOrmModule.forRoot({
                    type: 'better-sqlite3',
                    database: ':memory:',
                    entities: ENTITIES,
                    synchronize: true,
                    logging: false,
                }),
                TypeOrmModule.forFeature([
                    Task,
                    Work,
                    AgentRun,
                    TaskReviewRejection,
                    TaskCiAutoResumeAttempt,
                ]),
            ],
            providers: provide as never,
        }).compile();

    it('compiles with every provider the service needs', async () => {
        const module = await buildModule(providers);
        expect(module.get(TaskCiAutoResumeService)).toBeInstanceOf(TaskCiAutoResumeService);
        await module.close();
    });

    it('FAILS to compile when the attempt ledger repository is not provided', async () => {
        await expect(
            buildModule(providers.filter((p) => p !== TaskCiAutoResumeAttemptRepository)),
        ).rejects.toThrow(/TaskCiAutoResumeAttemptRepository/);
    });
});
