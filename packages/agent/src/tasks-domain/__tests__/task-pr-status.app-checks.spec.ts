import { TaskPrStatusService } from '../task-pr-status.service';
import { TaskCiAutoResumeService, type CiCheckResultInput } from '../task-ci-auto-resume.service';
import { TaskLifecyclePostsService } from '../task-lifecycle-posts.service';
import { TaskAppChecksService } from '../../app-works/task-app-checks.service';
import { AppWorkRulesService } from '../../app-works/app-work-rules.service';
import { TaskStatus, type Task } from '../../entities/task.entity';
import type { TaskRepository } from '../../database/repositories/task.repository';
import type { WorkRepository } from '../../database/repositories/work.repository';
import type { AgentRunRepository } from '../../database/repositories/agent-run.repository';
import type { GitFacadeService } from '../../facades/git.facade';
import type { TaskMergeGateService } from '../task-merge-gate.service';
import type { TaskThreadPoster } from '../task-thread-poster.port';
import type { TaskTransitionService } from '../task-transition.service';
import type { AgentEscalationService } from '../../agents/agent-escalation.service';
import type { AppSpecService } from '../../app-spec/app-spec.service';

/**
 * APW-08 T16 (APW08-G04; FR-16, FR-17; ACC-08-09) — App checks decide the gate on a pull
 * request, through the real `TaskPrStatusService` → `TaskCiAutoResumeService` →
 * `TaskAppChecksService` → `AppWorkRulesService` chain. Only the repositories, the provider and
 * the run steering are doubles.
 *
 * The App spec at the PR base declares `type-check` (required) and `e2e` (`required: false`).
 * APW-05's workflow reports each as its own check run, `Ever Works check: {name}`.
 *
 *  - a red REQUIRED leg reds `ciState`, re-runs the Agent once per attempt up to the Work's
 *    gate-attempt budget — not `TASK_CI_AUTO_RESUME_MAX_ATTEMPTS` — then Blocks the Task and
 *    raises `gate-exhausted` instead of filing the Inbox notice;
 *  - a red ADVISORY leg leaves the gate where it was, whether the provider reports it as a pass
 *    (job-level `continue-on-error`) or as a failure (the unverified case — the fallback): no red
 *    roll-up, no **Checks failed** name, no fix loop, and the merge gate sees `passing`;
 *  - any other Work kind keeps the env-var budget and the Inbox notice.
 */
describe('TaskPrStatusService — App checks decide the gate (APW-08 T16)', () => {
    const BASE_SHA = 'b'.repeat(40);
    const red = (name: string) => ({
        name,
        status: 'completed',
        conclusion: 'failure',
        appSlug: 'github-actions',
    });
    const green = (name: string) => ({
        name,
        status: 'completed',
        conclusion: 'success',
        appSlug: 'github-actions',
    });
    const TYPE_CHECK = 'Ever Works check: type-check';
    const E2E = 'Ever Works check: e2e';

    let row: Record<string, unknown>;
    let work: Record<string, unknown>;
    let tasks: Record<string, jest.Mock>;
    let git: { getPullRequestStatus: jest.Mock; getLatestCommit: jest.Mock };
    let specs: { getEffectiveSpec: jest.Mock };
    let mergeGate: { onPullRequestStatusRefreshed: jest.Mock };
    let chat: { post: jest.Mock };
    let attempts: Record<string, jest.Mock>;
    // The attempts ledger, faithfully: one row per claim, with its trigger and failure fingerprint.
    let ledger: Array<{ claimKey: string; trigger: string; failureKey: string | null }>;
    let worksRepo: { findById: jest.Mock };
    let steering: { resumeRun: jest.Mock };
    let inbox: { notice: jest.Mock };
    let transitions: { transition: jest.Mock };
    let escalations: { record: jest.Mock };
    let heads: number;
    const previousEnv = process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;

    const snapshot = () => ({ ...row }) as unknown as Task;

    /** One provider read of the pull request, at a NEW head commit (a fresh push). */
    function read(ciState: string, checks: unknown[]) {
        heads += 1;
        git.getPullRequestStatus.mockResolvedValueOnce({
            number: 12,
            state: 'open',
            headSha: String(heads).padStart(40, 'c'),
            baseRef: 'main',
            ciState,
            checks,
        });
    }

    function build(): TaskPrStatusService {
        worksRepo = { findById: jest.fn(async () => work) };
        const works = worksRepo as unknown as WorkRepository;
        const rules = new AppWorkRulesService(specs as unknown as AppSpecService);
        const appChecks = new TaskAppChecksService(
            works,
            rules,
            git as unknown as GitFacadeService,
            transitions as unknown as TaskTransitionService,
            escalations as unknown as AgentEscalationService,
            tasks as unknown as TaskRepository,
            attempts as never,
        );
        const runs = {
            findLatestForTask: jest.fn(async () => ({
                id: 'run-1',
                agentId: 'agent-wren',
                status: 'completed',
                awaitingInput: false,
                delegationScope: null,
            })),
            findRecentForTask: jest.fn(async () => []),
        };
        const links = {
            findByPullRequests: jest.fn(async () => ({
                taskId: 'task-1',
                prNumber: 12,
                isTaskRepo: true,
            })),
            findByBranch: jest.fn(async () => null),
        };
        const rejections = {
            findPendingForTask: jest.fn(async () => []),
            record: jest.fn(async () => ({ id: 'rej' })),
        };
        const autoResume = new TaskCiAutoResumeService(
            tasks as unknown as TaskRepository,
            attempts as never,
            links as never,
            runs as never,
            rejections as never,
            steering as never,
            inbox as never,
            undefined,
            undefined,
            undefined,
            appChecks,
        );
        const poster = new TaskLifecyclePostsService(
            works,
            { findById: jest.fn() } as unknown as AgentRunRepository,
            chat as unknown as TaskThreadPoster,
        );
        return new TaskPrStatusService(
            tasks as unknown as TaskRepository,
            works,
            git as unknown as GitFacadeService,
            undefined,
            mergeGate as unknown as TaskMergeGateService,
            autoResume,
            undefined,
            undefined,
            undefined,
            poster,
            appChecks,
        );
    }

    const sweep = (svc: TaskPrStatusService) => svc.syncDuePrStatuses({ staleSeconds: 0 });
    const posts = () => chat.post.mock.calls.map((call) => call[1].body as string);
    const lastMergeGateCiState = () =>
        mergeGate.onPullRequestStatusRefreshed.mock.calls.at(-1)?.[1]?.ciState;

    beforeEach(() => {
        heads = 0;
        ledger = [];
        // The PLATFORM budget is 5 — the Work's is 2. Every count below is the Work's.
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '5';
        row = {
            id: 'task-1',
            userId: 'user-1',
            slug: 'T-118',
            title: 'Add a dark mode toggle',
            workId: 'work-app',
            agentId: 'agent-wren',
            status: TaskStatus.IN_REVIEW,
            branchRef: 'task/t-118',
            branchState: 'pr-open',
            prNumber: 12,
            prUrl: 'https://github.com/member/cal-fork/pull/12',
            prState: 'open',
            ciState: null,
            prChecks: null,
            ciCheckedAt: null,
            ciHeadSha: null,
            ciAutoResumeNoticedAt: null,
        };
        work = {
            id: 'work-app',
            kind: 'app',
            name: 'Cal',
            userId: 'user-1',
            gitProvider: 'github',
            taskIsolationBaseBranch: 'main',
            maxGateAttempts: 2,
            getRepoOwner: () => 'member',
            getDataRepo: () => 'cal-fork',
        };
        tasks = {
            findDuePrStatusSync: jest.fn(async () => [snapshot()]),
            findByIdAndUser: jest.fn(async () => snapshot()),
            findById: jest.fn(async () => snapshot()),
            updatePrStatusCache: jest.fn(async (_id: string, patch: Record<string, unknown>) => {
                Object.assign(row, patch);
            }),
            updateById: jest.fn().mockResolvedValue(undefined),
            recordCiHead: jest.fn(async (input: { headSha: string; failing: boolean }) => {
                row.ciHeadSha = input.headSha;
                return true;
            }),
            casMarkCiAutoResumeNoticed: jest.fn(async () => {
                if (row.ciAutoResumeNoticedAt) return false;
                row.ciAutoResumeNoticedAt = new Date();
                return true;
            }),
            casClearCiAutoResumeNoticed: jest.fn(async () => {
                if (!row.ciAutoResumeNoticedAt) return false;
                row.ciAutoResumeNoticedAt = null;
                return true;
            }),
        };
        git = {
            getPullRequestStatus: jest.fn(),
            getLatestCommit: jest.fn(async () => ({ sha: BASE_SHA })),
        };
        specs = {
            getEffectiveSpec: jest.fn(async () => ({
                status: 'valid',
                spec: {
                    kind: 'app',
                    checks: [
                        { name: 'type-check', command: 'pnpm type-check' },
                        { name: 'e2e', command: 'pnpm e2e', required: false },
                    ],
                },
            })),
        };
        mergeGate = { onPullRequestStatusRefreshed: jest.fn(async () => ({ action: 'skipped' })) };
        chat = { post: jest.fn(async () => ({ id: 'm' })) };
        attempts = {
            countForTask: jest.fn(
                async (_taskId: string, trigger?: string) =>
                    ledger.filter((entry) => !trigger || entry.trigger === trigger).length,
            ),
            // REAL fingerprints (review of #3038): the sweep's key is names-only, so the same red
            // `type-check` on every push repeats it — exactly what the App rule must not stop on.
            hasFailureKey: jest.fn(async (_taskId: string, key: string) =>
                ledger.some((entry) => entry.failureKey === key),
            ),
            claim: jest.fn(
                async (input: { claimKey: string; trigger: string; failureKey: string | null }) => {
                    if (ledger.some((entry) => entry.claimKey === input.claimKey)) return null;
                    ledger.push({
                        claimKey: input.claimKey,
                        trigger: input.trigger,
                        failureKey: input.failureKey,
                    });
                    return { id: `attempt-${ledger.length}` };
                },
            ),
            stampResumedRun: jest.fn().mockResolvedValue(undefined),
        };
        steering = {
            resumeRun: jest.fn(async () => ({ runId: `run-resumed-${ledger.length}` })),
        };
        inbox = { notice: jest.fn().mockResolvedValue(undefined) };
        transitions = {
            transition: jest.fn(async (task: Task, to: TaskStatus) => {
                row.status = to;
                return { ...task, status: to };
            }),
        };
        escalations = { record: jest.fn(async () => ({ id: 'esc-1' })) };
    });

    afterAll(() => {
        if (previousEnv === undefined) delete process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS;
        else process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = previousEnv;
    });

    /** One CI webhook delivery through the same fix loop the sweep uses. */
    const deliver = (svc: TaskPrStatusService, over: Partial<CiCheckResultInput>) =>
        (svc as unknown as { autoResume: TaskCiAutoResumeService }).autoResume.onCheckResult({
            userId: 'user-1',
            owner: 'member',
            repo: 'cal-fork',
            headSha: 'd'.repeat(40),
            headBranch: 'task/t-118',
            prNumbers: [12],
            prHeads: [{ number: 12, headSha: 'd'.repeat(40) }],
            observedAt: new Date(),
            verdict: 'failing',
            granularity: 'check_run',
            appSlug: 'github-actions',
            checkName: E2E,
            conclusion: 'failure',
            url: null,
            outputTitle: null,
            outputSummary: null,
            failureKey: null,
            ...over,
        });

    it('a red required leg reds the gate, re-runs the Agent per attempt up to the Work budget, then Blocks with gate-exhausted (ACC-08-09)', async () => {
        const svc = build();
        for (let attempt = 0; attempt < 4; attempt += 1) {
            read('failing', [red(TYPE_CHECK), green(E2E)]);
            await sweep(svc);
            expect(row.ciState).toBe('failing');
        }

        // Twice — the Work's `maxGateAttempts` — and never the env var's five.
        expect(steering.resumeRun).toHaveBeenCalledTimes(2);
        expect(transitions.transition).toHaveBeenCalledTimes(1);
        expect(transitions.transition).toHaveBeenCalledWith(
            expect.objectContaining({ id: 'task-1' }),
            TaskStatus.BLOCKED,
            { actorType: 'agent' },
        );
        expect(row.status).toBe(TaskStatus.BLOCKED);
        expect(escalations.record).toHaveBeenCalledTimes(1);
        expect(escalations.record).toHaveBeenCalledWith(
            expect.objectContaining({
                reasonCode: 'gate-exhausted',
                taskId: 'task-1',
                workId: 'work-app',
                dedupKey: 'app-ci-gate-exhausted:task-1',
            }),
        );
        expect(escalations.record.mock.calls[0][0].summary).toContain('after 2 of 2');
        // Instead of the Inbox notice, not as well as it.
        expect(inbox.notice).not.toHaveBeenCalled();
        // The failing name is the REQUIRED leg's, posted once.
        expect(posts()).toEqual([`Checks failed: ${TYPE_CHECK}.`]);
        // The rules were read at the BASE tip, never the branch under review.
        expect(git.getLatestCommit).toHaveBeenCalledWith(
            'member',
            'cal-fork',
            'main',
            expect.objectContaining({ workId: 'work-app' }),
        );
        expect(specs.getEffectiveSpec).toHaveBeenCalledWith('work-app', BASE_SHA);
    });

    it('the budget comes from the Work, not from the env var — and the SAME red check is retried to it', async () => {
        work.maxGateAttempts = 3;
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '1';
        const svc = build();
        for (let attempt = 0; attempt < 5; attempt += 1) {
            read('failing', [red(TYPE_CHECK)]);
            await sweep(svc);
        }
        // One fingerprint for every attempt — the repeat-failure stop would have ended it at one.
        expect(new Set(ledger.map((entry) => entry.failureKey)).size).toBe(1);
        expect(ledger.every((entry) => entry.failureKey !== null)).toBe(true);
        expect(steering.resumeRun).toHaveBeenCalledTimes(3);
        expect(row.status).toBe(TaskStatus.BLOCKED);
        expect(inbox.notice).not.toHaveBeenCalled();
        expect(escalations.record).toHaveBeenCalledTimes(1);
        expect(escalations.record.mock.calls[0][0].summary).toContain('after 3 of 3');
    });

    it('a red advisory leg leaves the gate unchanged when the provider reports it as passing', async () => {
        // GitHub's documented `continue-on-error` semantics: the leg's run is not a failure.
        const svc = build();
        read('passing', [green(TYPE_CHECK), green(E2E)]);
        await sweep(svc);
        expect(row.ciState).toBe('passing');
        expect(lastMergeGateCiState()).toBe('passing');
        expect(steering.resumeRun).not.toHaveBeenCalled();
    });

    it('a provider that reports the advisory leg as FAILED still leaves the gate unchanged (the fallback)', async () => {
        const svc = build();
        read('failing', [green(TYPE_CHECK), red(E2E)]);
        await sweep(svc);

        // The roll-up, the cache and the live status the merge gate is handed all read green.
        expect(row.ciState).toBe('passing');
        expect(lastMergeGateCiState()).toBe('passing');
        // The leg is still REPORTED, with its real conclusion, marked advisory.
        expect(row.prChecks).toEqual([
            expect.objectContaining({ name: TYPE_CHECK, conclusion: 'success' }),
            expect.objectContaining({ name: E2E, conclusion: 'failure', advisory: true }),
        ]);
        expect((row.prChecks as Array<Record<string, unknown>>)[0]).not.toHaveProperty('advisory');
        // No fix loop, no Block, no escalation, and the thread says the checks PASSED.
        expect(steering.resumeRun).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
        expect(posts()).toEqual(['Checks passed.']);
    });

    it('a red advisory leg beside a red required leg: the gate is red, and only the required leg is named', async () => {
        const svc = build();
        read('failing', [red(TYPE_CHECK), red(E2E)]);
        await sweep(svc);
        expect(row.ciState).toBe('failing');
        expect(posts()).toEqual([`Checks failed: ${TYPE_CHECK}.`]);
        expect(steering.resumeRun).toHaveBeenCalledTimes(1);
    });

    it('an advisory leg delivered red by the CI webhook does not mark the head red or resume', async () => {
        const svc = build();
        const outcome = await deliver(svc, { checkName: E2E });
        expect(outcome.reason).toBe('not-a-failure');
        expect(steering.resumeRun).not.toHaveBeenCalled();
        expect(tasks.recordCiHead).toHaveBeenCalledWith(
            expect.objectContaining({ failing: false }),
        );
    });

    it('an unreadable App spec at the base classifies nothing advisory: a red advisory leg stays red', async () => {
        specs.getEffectiveSpec.mockResolvedValue({ status: 'unreadable', spec: null });
        const svc = build();
        read('failing', [green(TYPE_CHECK), red(E2E)]);
        await sweep(svc);
        expect(row.ciState).toBe('failing');
        expect(lastMergeGateCiState()).toBe('failing');
    });

    it('a capped check list cannot prove the advisory leg was the only failure, so the roll-up stays red', async () => {
        const svc = build();
        const many = Array.from({ length: 19 }, (_, index) => green(`job-${index}`));
        read('failing', [...many, red(E2E)]);
        await sweep(svc);
        expect(row.ciState).toBe('failing');
        // …but the advisory leg is still never handed to the fix loop.
        expect(steering.resumeRun).not.toHaveBeenCalled();
    });

    it('reads the advisory rules at the base the webhook names for this pull request', async () => {
        const svc = build();
        await deliver(svc, { checkName: E2E, prBaseRefs: [{ number: 12, baseRef: 'release' }] });
        expect(git.getLatestCommit).toHaveBeenCalledWith(
            'member',
            'cal-fork',
            'release',
            expect.objectContaining({ workId: 'work-app' }),
        );
    });

    it.each([
        ['check_suite', 'github-actions'],
        ['workflow_run', 'Ever Works build'],
    ] as const)(
        'a red %s delivery on an App Work Task never reds the head or spends an attempt',
        async (granularity, checkName) => {
            const svc = build();
            const outcome = await deliver(svc, { granularity, checkName });
            expect(outcome.reason).toBe('not-a-failure');
            expect(tasks.recordCiHead).toHaveBeenCalledWith(
                expect.objectContaining({ failing: false }),
            );
            expect(attempts.claim).not.toHaveBeenCalled();
            expect(steering.resumeRun).not.toHaveBeenCalled();
            expect(transitions.transition).not.toHaveBeenCalled();
        },
    );

    it('a red check_suite delivery on any other kind still acts, unchanged', async () => {
        work.kind = 'directory';
        const svc = build();
        const outcome = await deliver(svc, {
            granularity: 'check_suite',
            checkName: 'github-actions',
        });
        expect(outcome.reason).toBe('resumed');
        expect(tasks.recordCiHead).toHaveBeenCalledWith(expect.objectContaining({ failing: true }));
    });

    it('a stopped Task of another kind stays a pure read: no Work read for a red check run', async () => {
        work.kind = 'directory';
        row.ciAutoResumeNoticedAt = new Date();
        const svc = build();
        const outcome = await deliver(svc, { checkName: 'lint' });
        expect(outcome.reason).toBe('stopped');
        expect(worksRepo.findById).not.toHaveBeenCalled();
    });

    it('reviewer-triggered attempts do not spend the App Work CI budget', async () => {
        ledger.push({ claimKey: 'review:rej-1', trigger: 'review', failureKey: null });
        const svc = build();
        for (let attempt = 0; attempt < 3; attempt += 1) {
            read('failing', [red(TYPE_CHECK)]);
            await sweep(svc);
        }
        expect(steering.resumeRun).toHaveBeenCalledTimes(2);
        expect(escalations.record.mock.calls[0][0].summary).toContain('after 2 of 2');
    });

    it('unblocking after raising the budget reopens the loop; unblocking without it does not', async () => {
        const svc = build();
        for (let attempt = 0; attempt < 3; attempt += 1) {
            read('failing', [red(TYPE_CHECK)]);
            await sweep(svc);
        }
        expect(row.status).toBe(TaskStatus.BLOCKED);
        expect(steering.resumeRun).toHaveBeenCalledTimes(2);

        // The owner unblocks WITHOUT raising the budget: nothing reopens.
        row.status = TaskStatus.IN_REVIEW;
        read('failing', [red(TYPE_CHECK)]);
        await sweep(svc);
        expect(steering.resumeRun).toHaveBeenCalledTimes(2);
        expect(row.ciAutoResumeNoticedAt).not.toBeNull();

        // …then raises it to 3, as the escalation says: the Agent is sent back once more.
        work.maxGateAttempts = 3;
        read('failing', [red(TYPE_CHECK)]);
        await sweep(svc);
        expect(tasks.casClearCiAutoResumeNoticed).toHaveBeenCalledWith('task-1');
        expect(steering.resumeRun).toHaveBeenCalledTimes(3);
        expect(escalations.record.mock.calls[0][0].decisionNeeded).toContain(
            "raise this Work's gate-attempt budget and unblock the Task",
        );
    });

    it('any other Work kind keeps the repeat-failure stop and its Inbox notice, unchanged', async () => {
        work.kind = 'directory';
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '3';
        const svc = build();
        for (let attempt = 0; attempt < 3; attempt += 1) {
            read('failing', [red(TYPE_CHECK)]);
            await sweep(svc);
        }
        // The same fingerprint comes back after one retry: EW-806 stops and files the notice.
        expect(steering.resumeRun).toHaveBeenCalledTimes(1);
        expect(inbox.notice).toHaveBeenCalledTimes(1);
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
    });

    it('any other Work kind keeps the env-var budget and the Inbox notice, unchanged', async () => {
        work.kind = 'directory';
        work.maxGateAttempts = 1;
        process.env.TASK_CI_AUTO_RESUME_MAX_ATTEMPTS = '2';
        const svc = build();
        // A DIFFERENT failure each push, so only the budget can stop the loop.
        for (const failing of [TYPE_CHECK, E2E, 'lint']) {
            read('failing', [red(failing)]);
            await sweep(svc);
        }
        expect(steering.resumeRun).toHaveBeenCalledTimes(2);
        expect(inbox.notice).toHaveBeenCalledTimes(1);
        expect(transitions.transition).not.toHaveBeenCalled();
        expect(escalations.record).not.toHaveBeenCalled();
        // No rules read, no leg reclassified, no flag cached.
        expect(specs.getEffectiveSpec).not.toHaveBeenCalled();
        expect(
            (row.prChecks as Array<Record<string, unknown>>).some((check) => 'advisory' in check),
        ).toBe(false);
        expect(attempts.countForTask.mock.calls.every((call) => call.length === 1)).toBe(true);
    });
});
